import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Store, processAlive, processIdentity } from "./store.ts";
import { RpcAgent } from "./rpc-agent.ts";
import { authentic, isRecord, readLines, send } from "./connection.ts";
import { validate } from "./schemas.ts";
import { createWorktree, removeWorktree } from "./worktrees.ts";
import { isDescendant, isLive, type AgentArgs, type Member, type MessageArgs, type TaskArgs, type TeamState } from "./types.ts";

export interface CoordinatorOptions {
  id: string; cwd: string; sessionFile?: string; limit: number; depth: number;
  extension: string; home?: string; command?: string;
  notice: (through: number) => void;
  warning: (message: string) => void;
}
export class Coordinator {
  readonly store: Store;
  readonly socketPath: string;
  private server?: Server;
  private agents = new Map<string, RpcAgent>();
  private sockets = new Map<string, Socket>();
  private connections = new Set<Socket>();
  private cleaning = new Set<string>();
  private ready = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private notices = new Map<string, NodeJS.Timeout>();
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise?: Promise<void>;

  private options: CoordinatorOptions;
  private constructor(options: CoordinatorOptions) {
    this.options = options;
    const root: Member = { id: "root", depth: 0, token: randomUUID(), cwd: options.cwd, status: "idle", notified: 0, sessionId: options.id, sessionFile: options.sessionFile };
    const initial: TeamState = { version: 2, id: options.id, root: "root", limit: options.limit, depth: options.depth, members: { root }, tasks: {}, messages: [] };
    this.store = new Store(initial, options.home);
    this.socketPath = join(this.store.dir, "coordinator.sock");
  }
  static async open(options: CoordinatorOptions): Promise<Coordinator> {
    const coordinator = new Coordinator(options);
    try {
      for (const member of Object.values(coordinator.store.state.members)) {
        if (member.id !== "root" && isLive(member) && member.pid && processAlive(member.pid, member.identity)) {
          throw new Error(`Previous member ${member.id} is still live or uncertain; stop it explicitly before recovery`);
        }
      }
      coordinator.store.update(state => {
        state.limit = options.limit; state.depth = options.depth;
        for (const member of Object.values(state.members)) if (member.id !== "root" && isLive(member)) member.status = "interrupted";
      });
      try { unlinkSync(coordinator.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      coordinator.server = createServer(socket => coordinator.accept(socket));
      await new Promise<void>((done, fail) => {
        coordinator.server!.once("error", fail);
        coordinator.server!.listen(coordinator.socketPath, () => { chmodSync(coordinator.socketPath, 0o600); done(); });
      });
      coordinator.server.on("error", error => options.warning(error.message));
      coordinator.notify("root");
      return coordinator;
    } catch (error) { coordinator.server?.close(); coordinator.store.close(); throw error; }
  }
  private accept(socket: Socket): void {
    socket.on("error", () => {});
    if (this.closed) { socket.destroy(); return; }
    this.connections.add(socket);
    let bound: string | undefined;
    socket.on("close", () => { this.connections.delete(socket); if (bound && this.sockets.get(bound) === socket) this.sockets.delete(bound); });
    readLines(socket, value => {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 128 || typeof value.member !== "string" || typeof value.token !== "string" || typeof value.operation !== "string") { socket.destroy(); return; }
      const member = this.store.state.members[value.member];
      if (this.closed || !member || !isLive(member) || !authentic(value.token, member.token) || member.id === "root" || (bound && bound !== member.id)) { socket.destroy(); return; }
      bound = member.id;
      const operation = value.operation;
      const run = async () => {
        if (operation === "join") {
          const previous = this.sockets.get(member.id);
          if (previous && previous !== socket && !previous.destroyed) throw new Error("Member already connected");
          const args = value.args;
          if (!isRecord(args) || typeof args.sessionId !== "string" || typeof args.sessionFile !== "string" || !Array.isArray(args.tools) || !["team_agent", "team_task", "team_message"].every(name => Array.isArray(args.tools) && args.tools.includes(name))) throw new Error("Incomplete ac-teams readiness handshake");
          if (args.trusted !== true) throw new Error("Pi skipped protected project resources. Approve the member cwd with Pi's /trust command before retrying; ac-teams never auto-approves a project.");
          this.store.update(state => {
            state.members[member.id].sessionId = args.sessionId as string;
            state.members[member.id].sessionFile = args.sessionFile as string;
          });
          this.sockets.set(member.id, socket);
          this.ready.get(member.id)?.resolve();
          this.notify(member.id);
          return { id: this.store.state.id, member: this.publicMember(this.store.state.members[member.id]), limit: this.store.state.limit, depth: this.store.state.depth };
        }
        if (this.sockets.get(member.id) !== socket) throw new Error("Join before making team requests");
        if (operation === "ack") {
          if (!isRecord(value.args) || !Number.isSafeInteger(value.args.through)) throw new Error("Invalid notification acknowledgement");
          this.ack(member.id, Number(value.args.through)); return {};
        }
        return this.handle(member.id, operation, value.args);
      };
      void run().then(data => send(socket, { id: value.id, data }), error => {
        if (operation === "join") this.ready.get(member.id)?.reject(error instanceof Error ? error : new Error("Member readiness failed"));
        send(socket, { id: value.id, error: error instanceof Error ? error.message : "Team request failed" });
      });
    });
  }
  private publicMember(member: Member) {
    const { token: _token, identity: _identity, ...view } = member;
    return view;
  }
  live(): Member[] { return Object.values(this.store.state.members).filter(member => member.id !== "root" && isLive(member)); }
  ack(id: string, through: number): void {
    const last = this.store.state.messages.at(-1)?.seq ?? 0;
    if (!Number.isSafeInteger(through) || through < 0 || through > last) throw new Error("Invalid notification cursor");
    this.store.update(state => { state.members[id].notified = Math.max(state.members[id].notified, through); });
  }
  private notify(id: string): void {
    if (this.closed || this.notices.has(id)) return;
    this.notices.set(id, setTimeout(() => {
      this.notices.delete(id);
      const member = this.store.state.members[id];
      if (!member || !isLive(member)) return;
      const pending = this.store.state.messages.filter(message => message.seq > member.notified && message.recipients.includes(id));
      const through = pending.at(-1)?.seq;
      if (!through) return;
      try {
        if (id === "root") this.options.notice(through);
        else { const socket = this.sockets.get(id); if (socket) send(socket, { type: "notice", through }); }
      } catch (error) { this.options.warning(`Team notification remains in history: ${String(error)}`); }
    }, 50));
  }
  async handle(actor: string, operation: string, args: unknown, authorizedLimit = false): Promise<unknown> {
    if (this.closed) throw new Error("Team is stopping");
    const member = this.store.state.members[actor];
    if (!member || !isLive(member)) throw new Error("Member is not active");
    validate(operation, args);
    if (operation === "task") return this.store.task(actor, args as TaskArgs);
    if (operation === "message") {
      const result = this.store.message(actor, args as MessageArgs);
      if ((args as MessageArgs).action === "send") for (const id of Object.keys(this.store.state.members)) this.notify(id);
      return result;
    }
    return this.agent(actor, args as AgentArgs, authorizedLimit);
  }
  private async agent(actor: string, args: AgentArgs, authorizedLimit: boolean): Promise<unknown> {
    const state = this.store.state;
    if (args.action === "list") return { team: state.id, limit: state.limit, depth: state.depth, members: Object.values(state.members).map(member => this.publicMember(member)) };
    if (args.action === "limits") {
      if (actor !== "root") throw new Error("Only the root can change team limits");
      if ((args.limit ?? state.limit) > 10 && !authorizedLimit) throw new Error("A ceiling above 10 requires explicit user confirmation or --teams-limit");
      this.store.update(next => { next.limit = args.limit ?? next.limit; next.depth = args.depth ?? next.depth; });
      return { limit: this.store.state.limit, depth: this.store.state.depth };
    }
    if (args.action === "launch" || args.action === "resume") {
      const launch = this.launch(actor, args);
      this.operations.add(launch);
      try { return await launch; } finally { this.operations.delete(launch); }
    }
    const member = args.id ? state.members[args.id] : undefined;
    if (!member) throw new Error("Unknown member ID");
    if (args.action === "status") return this.publicMember(member);
    if (member.id === "root" || !isDescendant(state, member.id, actor)) throw new Error("Only a member's ancestor can stop or clean it up");
    if (args.action === "cleanup") {
      if (isLive(member)) throw new Error("Stop the member before worktree cleanup");
      if (!member.worktree) throw new Error("Member has no worktree");
      if (this.cleaning.has(member.id)) throw new Error("Member cleanup is already running");
      this.cleaning.add(member.id);
      const worktree = member.worktree;
      const cleanup = (async () => {
        await removeWorktree(worktree);
        this.store.update(next => { delete next.members[member.id].worktree; });
        return { removed: true, branchRetained: worktree.branch };
      })();
      this.operations.add(cleanup);
      try { return await cleanup; } finally { this.cleaning.delete(member.id); this.operations.delete(cleanup); }
    }
    await this.stopTree(member.id);
    return this.publicMember(this.store.state.members[member.id]);
  }
  private async launch(actor: string, args: AgentArgs): Promise<unknown> {
    const state = this.store.state;
    const parent = state.members[actor];
    if (!args.brief?.trim()) throw new Error("A launch or resume brief is required");
    if (!args.model || !args.model.includes("/")) throw new Error("A provider/model is required (normally inherited from the requesting member)");
    const resumed = args.action === "resume" ? state.members[args.id ?? ""] : undefined;
    if (args.action === "resume" && (!resumed || resumed.id === "root" || !resumed.sessionFile || !isDescendant(state, resumed.id, actor))) throw new Error("Resume requires a stopped descendant with a native session file");
    if (resumed && this.cleaning.has(resumed.id)) throw new Error("Worktree cleanup is running; cannot resume this member");
    if (resumed && (isLive(resumed) || (resumed.pid && processAlive(resumed.pid, resumed.identity)))) throw new Error("Cannot resume a live or uncertain member");
    const depth = resumed ? resumed.depth : parent.depth + 1;
    if (depth > state.depth || this.live().length >= state.limit) throw new Error("Team depth or live-member ceiling reached (idle members count)");
    const id = resumed?.id ?? randomUUID().slice(0, 16);
    const cwd = realpathSync(resolve(args.cwd ?? resumed?.cwd ?? parent.cwd));
    if (!statSync(cwd).isDirectory()) throw new Error("Agent cwd must be a directory");
    const member: Member = resumed ? { ...resumed, token: randomUUID(), status: "starting", error: undefined } : { id, parent: actor, depth, token: randomUUID(), cwd, status: "starting", notified: 0 };
    // Reserve synchronously before the first await so concurrent launches cannot oversubscribe.
    this.store.update(next => { next.members[id] = member; });
    let agent: RpcAgent | undefined;
    try {
      if (args.worktree && !resumed) {
        member.worktree = await createWorktree(cwd, state.id, id, args.base, args.target);
        member.cwd = member.worktree.path;
        this.store.update(next => { next.members[id].worktree = member.worktree; next.members[id].cwd = member.cwd; });
      }
      if (this.closed || this.store.state.members[id].status !== "starting") throw new Error("Launch was stopped before startup");
      let timer: NodeJS.Timeout | undefined;
      const readiness = new Promise<void>((done, fail) => {
        this.ready.set(id, { resolve: done, reject: fail });
        timer = setTimeout(() => fail(new Error("ac-teams child readiness timed out")), 20000);
      });
      // Attach immediately: a spawn error must not leave a rejected readiness promise unobserved.
      void readiness.catch(() => {});
      const slash = args.model.indexOf("/");
      mkdirSync(join(this.store.dir, "sessions"), { recursive: true, mode: 0o700 });
      chmodSync(join(this.store.dir, "sessions"), 0o700);
      const rpcArgs = ["--mode", "rpc", "--session-dir", join(this.store.dir, "sessions"), "-e", this.options.extension, "--provider", args.model.slice(0, slash), "--model", args.model.slice(slash + 1), "--thinking", args.thinking ?? "off"];
      if (resumed?.sessionFile) rpcArgs.push("--session", resumed.sessionFile);
      agent = new RpcAgent({ cwd: member.cwd, args: rpcArgs, command: this.options.command, env: { ...process.env, AC_TEAMS_SOCKET: this.socketPath, AC_TEAMS_MEMBER: id, AC_TEAMS_TOKEN: member.token } });
      this.agents.set(id, agent);
      agent.on("failure", error => this.options.warning(`Member ${id}: ${(error as Error).message}`));
      agent.on("forced", signal => this.options.warning(`Member ${id} required ${signal}`));
      agent.on("event", event => {
        if (this.closed) return;
        if (event.type === "agent_start" || event.type === "agent_settled") this.store.update(next => {
          const current = next.members[id];
          if (current.status !== "stopping") current.status = event.type === "agent_start" ? "busy" : "idle";
          if (event.type === "agent_start") delete current.error;
        });
        if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant" && event.message.stopReason === "error") {
          const error = typeof event.message.errorMessage === "string" ? event.message.errorMessage.slice(0, 2000) : "Model request failed";
          this.store.update(next => { next.members[id].error = error; });
          const recipient = member.parent && isLive(this.store.state.members[member.parent]) ? member.parent : "root";
          this.store.message(id, { action: "send", recipients: [recipient], text: `Member ${id} model error: ${error}` });
          this.notify(recipient);
        }
      });
      agent.once("exit", () => {
        this.agents.delete(id);
        if (this.closed) return;
        this.store.update(next => { next.members[id].status = next.members[id].status === "stopping" ? "stopped" : "interrupted"; });
        void this.stopDescendants(id).catch(error => this.options.warning(String(error)));
      });
      member.pid = agent.process.pid;
      member.identity = member.pid ? processIdentity(member.pid) : undefined;
      this.store.update(next => { next.members[id] = member; });
      try {
        await Promise.race([readiness, agent.exited.then(() => { throw new Error("Child exited before readiness"); })]);
      } finally { if (timer) clearTimeout(timer); this.ready.delete(id); }
      const rpcState = await agent.request("get_state");
      if (!isRecord(rpcState) || !isRecord(rpcState.model) || rpcState.model.provider !== args.model.slice(0, slash) || rpcState.model.id !== args.model.slice(slash + 1)) throw new Error("Pi did not select the requested model");
      this.store.update(next => { if (next.members[id].status === "starting") next.members[id].status = "busy"; });
      await agent.request("prompt", { message: args.brief, streamingBehavior: "followUp" });
      return this.publicMember(this.store.state.members[id]);
    } catch (error) {
      if (agent) await agent.stop();
      this.store.update(next => { next.members[id].status = "interrupted"; next.members[id].error = error instanceof Error ? error.message : "Startup failed"; });
      throw error;
    }
  }
  private async stopDescendants(id: string): Promise<void> {
    const descendants = this.live().filter(member => isDescendant(this.store.state, member.id, id)).sort((a, b) => b.depth - a.depth);
    for (const member of descendants) await this.stopOne(member.id);
  }
  private async stopOne(id: string): Promise<void> {
    const member = this.store.state.members[id];
    if (!isLive(member)) return;
    this.store.update(next => { next.members[id].status = "stopping"; });
    const agent = this.agents.get(id);
    if (agent) await agent.stop();
    else if (member.pid && processAlive(member.pid, member.identity)) throw new Error("No owned transport for live process; refusing to kill by PID");
    this.store.update(next => { next.members[id].status = "stopped"; });
  }
  async stopTree(id: string): Promise<void> { await this.stopDescendants(id); await this.stopOne(id); }
  close(): Promise<void> { this.closePromise ??= this.closeOnce(); return this.closePromise; }
  private async closeOnce(): Promise<void> {
    this.closed = true;
    for (const timer of this.notices.values()) clearTimeout(timer);
    for (const member of this.live().sort((a, b) => b.depth - a.depth)) await this.stopOne(member.id);
    // Finish recording worktree operations already in flight before the store closes.
    await Promise.allSettled([...this.operations]);
    for (const socket of this.connections) socket.destroy();
    if (this.server) await new Promise<void>(done => this.server!.close(() => done()));
    try { unlinkSync(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.store.close();
  }
}
