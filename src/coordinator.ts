import { createServer, type Server, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNarrower, assertStableGrants, mountSet, within, containerProblems, dockerCreateArgs, sandboxMounts, maxSandboxed, memberImage, packageRoot, readable, resolveAccess, sandboxStatus, type Access, type SandboxPlan, type SandboxStatus } from "./access.ts";
import { Egress, egressPort, providerRoutes, type Credentials } from "./egress.ts";
import { Store, processAlive, processIdentity } from "./store.ts";
import { stateRoot } from "./config.ts";
import { RpcAgent } from "./rpc-agent.ts";
import { TerminalAgent, tmux } from "./terminal-agent.ts";
import { authentic, isRecord, readLines, send } from "./connection.ts";
import { validate } from "./schemas.ts";
import { createWorktree, removeWorktree } from "./worktrees.ts";
import { isDescendant, isLive, taskName, type AgentArgs, type Member, type MessageArgs, type TaskArgs, type TeamState, type UserAction, type Message, type ContextUsage } from "./types.ts";

export const taskRequestGuidance = [
  "Treat user task requests as proposals to assess, not commands to create tasks.",
  "Review the agreed scope and current task list (page as needed); read relevant descriptions, acceptance criteria, statuses, owners, and dependencies.",
  "If an existing task already covers the request, cite its number/name and explain why; do not add a duplicate.",
  "If a coherent extension is the smallest complete solution, update the existing task only when its state and ownership allow it; otherwise coordinate with its owner.",
  "Create a task only for genuinely distinct, in-scope work. Ask for clarification when ambiguity or a scope conflict prevents a sound decision.",
  "Respect completion checks and add only real dependencies. Explain the decision and any actual task changes to the user.",
].join(" ");

export function assistantEvent(message: unknown): { type: string; text: string } | undefined {
  if (!isRecord(message) || message.role !== "assistant") return;
  if (message.stopReason === "error") return { type: "model_error", text: String(message.errorMessage || "Model request failed").slice(0, 2000) };
  if (message.stopReason !== "stop" || !Array.isArray(message.content)) return;
  const text = message.content.filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string").map(part => part.text).join(" ").trim().split("\n")[0].slice(0, 500);
  return text ? { type: "summary", text } : undefined;
}
export interface CoordinatorOptions {
  id: string; cwd: string; sessionFile?: string; limit: number; depth: number;
  extension: string; home?: string; command?: string;
  interactive?: boolean; model?: string; thinking?: string;
  /** Version of the running Pi; members use the image built for it. Defaults to the `pi` on PATH. */
  piVersion?: string;
  /** Test hook: provider token refresh interval (default one minute). */
  refreshMs?: number;
  /** Test hook: runs after a member container passes all checks and before it starts. */
  beforeStart?: (member: string) => Promise<void>;
  /** Main's session directory; member transcripts live under <it>/ac-teams/<team>/<member>. */
  sessionDir?: string;
  /** Parent-side provider credentials for sandboxed members; without it enforced access is unavailable. */
  credentials?: Credentials;
  notice: (through: number, messages: Message[]) => void;
  warning: (message: string) => void;
  status?: (kind: "busy" | "blocked", active: boolean) => void;
}
export class Coordinator {
  readonly store: Store;
  readonly socketPath: string;
  private server?: Server;
  private agents = new Map<string, RpcAgent | TerminalAgent>();
  private controls = new Map<string, { member: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sockets = new Map<string, Socket>();
  private connections = new Set<Socket>();
  private cleaning = new Set<string>();
  private ready = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private notices = new Map<string, NodeJS.Timeout>();
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  private status = { busy: false, blocked: false };
  private closePromise?: Promise<void>;
  private sandboxes = new Map<string, { egress: Egress; grants: { path: string; fd: number; dev: number; ino: number }[]; release: (go: boolean) => void; refresh: NodeJS.Timeout; token: string }>();
  private plans = new Map<string, SandboxPlan>();
  private releasing = new Map<string, Promise<void>>();
  private sessionDirs = new Map<string, string>();
  private sandbox?: { status: SandboxStatus; at: number };

  private options: CoordinatorOptions;
  private constructor(options: CoordinatorOptions) {
    this.options = options;
    const root: Member = { id: "root", depth: 0, token: randomUUID(), cwd: options.cwd, status: "idle", notified: 0, sessionId: options.id, sessionFile: options.sessionFile, model: options.model, thinking: options.thinking };
    const initial: TeamState = { version: 3, id: options.id, root: "root", limit: options.limit, depth: options.depth, members: { root }, tasks: {}, messages: [] };
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
        const names = new Set(Object.values(state.members).map(member => member.name));
        let number = 0;
        for (const member of Object.values(state.members)) if (member.id !== "root" && !member.name) {
          do { number++; } while (names.has(`teammate-${number}`) || Object.hasOwn(state.members, `teammate-${number}`));
          member.name = `teammate-${number}`; names.add(member.name);
        }
        state.members.root.status = "idle";
        state.members.root.sessionFile = options.sessionFile;
        state.members.root.model = options.model;
        state.members.root.thinking = options.thinking;
        for (const member of Object.values(state.members)) {
          delete member.needsInput;
          if (member.id !== "root" && isLive(member)) member.status = "interrupted";
        }
      });
      // Owner lock held and no member process alive: containers left by a killed coordinator are orphans of this store.
      for (const member of Object.values(coordinator.store.state.members)) if (member.access) {
        const name = coordinator.containerName(member.id);
        const owner = await docker(["inspect", "--format", '{{index .Config.Labels "ac-teams.store"}}', name]).catch(() => "");
        if (owner.trim() === coordinator.store.dir) await docker(["rm", "-f", name]).catch(error => options.warning(`Cannot remove orphaned member container ${name}: ${String(error)}`));
        rmSync(memberConfigDir(member.id), { recursive: true, force: true });
      }
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
    socket.on("close", () => {
      this.connections.delete(socket);
      if (bound && this.sockets.get(bound) === socket) {
        this.sockets.delete(bound);
        if (!this.closed) {
          this.store.update(state => { delete state.members[bound!].needsInput; });
          this.publishStatus();
        }
        for (const [id, pending] of this.controls) if (pending.member === bound) {
          clearTimeout(pending.timer); this.controls.delete(id); pending.reject(new Error("Native member disconnected"));
        }
      }
    });
    readLines(socket, value => {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 128 || typeof value.member !== "string" || typeof value.token !== "string" || typeof value.operation !== "string") { socket.destroy(); return; }
      const member = this.store.state.members[value.member];
      if ((this.closed && value.operation !== "control_result") || !member || !isLive(member) || !authentic(value.token, member.token) || member.id === "root" || (bound && bound !== member.id)) { socket.destroy(); return; }
      bound = member.id;
      const operation = value.operation;
      const run = async () => {
        if (operation === "join") {
          const previous = this.sockets.get(member.id);
          if (previous && previous !== socket && !previous.destroyed) throw new Error("Member already connected");
          const args = value.args;
          if (!isRecord(args) || typeof args.sessionId !== "string" || typeof args.sessionFile !== "string" || !Array.isArray(args.tools) || !["team_agent", "team_task", "team_message"].every(name => Array.isArray(args.tools) && args.tools.includes(name))) throw new Error("Incomplete ac-teams readiness handshake");
          // The session file chooses a host mount on resume, so it must stay in the directory ac-teams assigned.
          const assigned = this.sessionDirs.get(member.id) ?? this.memberSessionDir(member.id);
          if (!assigned || !within(resolve(args.sessionFile as string), assigned)) throw new Error("Member session file is outside its assigned directory");
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
        if (operation === "control_result") {
          if (!isRecord(value.args) || typeof value.args.id !== "string") throw new Error("Invalid native command response");
          const pending = this.controls.get(value.args.id);
          if (!pending || pending.member !== member.id) throw new Error("Unknown native command response");
          clearTimeout(pending.timer); this.controls.delete(value.args.id);
          if (typeof value.args.error === "string") pending.reject(new Error(value.args.error.slice(0, 2000)));
          else pending.resolve(value.args.data);
          return {};
        }
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
  private control(member: string, command: string, args: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    const socket = this.sockets.get(member);
    if (!socket || socket.destroyed) return Promise.reject(new Error("Native member is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(`Native ${command} timed out`)); }, timeout);
      this.controls.set(id, { member, resolve, reject, timer });
      send(socket, { type: "command", id, command, args });
    });
  }
  private publishStatus(): void {
    const members = this.live().filter(member => member.status !== "stopping");
    const next = {
      busy: members.some(member => member.status === "starting" || member.status === "busy"),
      blocked: members.some(member => member.needsInput),
    };
    for (const kind of ["busy", "blocked"] as const) if (next[kind] !== this.status[kind]) {
      this.status[kind] = next[kind];
      this.options.status?.(kind, next[kind]);
    }
  }
  recordEvent(actor: string, value: unknown): void {
    validate("event", value);
    if (this.closed) return;
    const event = value as { type: string; active?: boolean; text?: string; model?: string; modelName?: string; contextUsage?: ContextUsage | null };
    const member = this.store.state.members[actor];
    if (!member || !isLive(member) || (member.status === "stopping" && event.type !== "model_error")) return;
    this.store.update(next => {
      const current = next.members[actor];
      if (event.type === "blocked") { if (event.active) current.needsInput = true; else delete current.needsInput; }
      else if (event.type === "telemetry") {
        current.model = event.model ?? current.model;
        current.modelName = event.modelName;
        current.contextUsage = event.contextUsage ?? undefined;
      }
      else if (event.type === "agent_start") { current.status = "busy"; current.activity = "Working"; delete current.error; delete current.summary; }
      else if (event.type === "agent_settled") { delete current.needsInput; current.status = "idle"; current.activity = current.error ? "Model request failed" : current.summary || "Available for follow-up"; }
      else if (event.type === "activity") current.activity = event.text;
      else if (event.type === "summary") current.summary = event.text?.slice(0, 500);
      else if (event.type === "model_error") current.error = event.text || "Model request failed";
    });
    this.publishStatus();
    if (event.type === "model_error" && actor !== "root" && member.status !== "stopping") {
      const recipient = member.parent && isLive(this.store.state.members[member.parent]) ? member.parent : "root";
      this.store.message(actor, { action: "send", recipients: [recipient], text: `Member ${actor} model error: ${event.text || "Model request failed"}` });
      this.notify(recipient);
    }
  }
  private async userAction(actor: string, args: UserAction): Promise<string> {
    if (!this.options.interactive) throw new Error("User team actions require an interactive root");
    const resume = async (id: string) => {
      const member = this.store.state.members[id];
      if (!member) throw new Error("Unknown member ID");
      if (member.status === "stopping") throw new Error("Member is stopping; retry after it stops");
      if (isLive(member)) return;
      const launch = this.launch("root", { action: "resume", id, brief: "Resume the native session without replaying work.", model: member.model ?? args.model, thinking: member.thinking ?? args.thinking }, false);
      this.operations.add(launch);
      try { await launch; } finally { this.operations.delete(launch); }
    };
    if (args.action === "resume") {
      if (!args.id) throw new Error("A member ID is required");
      await resume(args.id); return `Resumed ${args.id}`;
    }
    if (!args.text?.trim()) throw new Error("Write a request or feedback before sending");
    let recipient = "root", fallback = "";
    let text = `User task request (review before changing tasks):\n${taskRequestGuidance}\n\nRequest:\n${args.text}`;
    if (args.action === "feedback") {
      const task = this.store.state.tasks[args.id ?? ""];
      if (!task) throw new Error("Unknown task ID");
      recipient = task.creator ?? "root";
      text = `User feedback on task ${taskName(task)} [${task.id}] (${task.title}):\n${args.text}`;
      if (!isLive(this.store.state.members[recipient]) || this.store.state.members[recipient].status === "stopping") {
        try { await resume(recipient); }
        catch (error) { fallback = `Creator ${recipient} could not resume (${String(error)}); delivered to Main instead. `; recipient = "root"; }
      }
    }
    const message = this.store.message(actor, { action: "send", recipients: [recipient], text }, true) as Message;
    this.notify(recipient);
    return `${fallback}Sent to ${recipient === "root" ? "Main" : recipient} · message ${message.seq}`;
  }
  private publicMember(member: Member) {
    const { token: _token, identity: _identity, ...view } = member;
    return view;
  }
  sandboxStatus(): SandboxStatus {
    if (!this.options.credentials) return { available: false, backend: "docker", reason: "This Pi root cannot broker provider credentials" };
    // Cache success; recheck failures so a fixed host is noticed without restarting.
    if (!this.sandbox || (!this.sandbox.status.available && Date.now() - this.sandbox.at > 30000)) {
      let status: SandboxStatus;
      try { status = sandboxStatus(this.image()); } catch (error) { status = { available: false, backend: "docker", reason: String(error) }; }
      this.sandbox = { status, at: Date.now() };
    }
    return this.sandbox.status;
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
        if (id === "root") this.options.notice(through, pending.slice(-5));
        else { const socket = this.sockets.get(id); if (socket) send(socket, { type: "notice", through, messages: pending.slice(-5) }); }
      } catch (error) { this.options.warning(`Team notification remains in history: ${String(error)}`); }
    }, 50));
  }
  async handle(actor: string, operation: string, args: unknown, authorizedLimit = false): Promise<unknown> {
    if (this.closed) throw new Error("Team is stopping");
    const member = this.store.state.members[actor];
    if (!member || !isLive(member)) throw new Error("Member is not active");
    validate(operation, args);
    if (operation === "event") return this.recordEvent(actor, args);
    if (operation === "ui") {
      // User actions can resume any member as Main, so sandboxed members cannot send them.
      if (member.access) throw new Error("Sandboxed members cannot send user team actions; use Main");
      return this.userAction(actor, args as UserAction);
    }
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
    if (args.action === "list") return { team: state.id, limit: state.limit, depth: state.depth, sandbox: this.sandboxStatus(), lastMessage: state.messages.at(-1)?.seq ?? 0, members: Object.values(state.members).map(member => this.publicMember(member)) };
    if (args.action === "limits") {
      if (actor !== "root") throw new Error("Only the root can change team limits");
      if ((args.limit ?? state.limit) > 10 && !authorizedLimit) throw new Error("A ceiling above 10 requires explicit user confirmation or --teams-limit");
      this.store.update(next => { next.limit = args.limit ?? next.limit; next.depth = args.depth ?? next.depth; });
      return { limit: this.store.state.limit, depth: this.store.state.depth, sandbox: this.sandboxStatus() };
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
      if (state.members[actor].access) throw new Error("Sandboxed members cannot remove worktrees");
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
  private async launch(actor: string, args: AgentArgs, prompt = true): Promise<unknown> {
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
    if (!resumed && (args.name === "main" || args.name === "root" || Object.values(state.members).some(member => member.name === args.name || member.id === args.name))) throw new Error("Teammate name is already in use or reserved");
    const id = resumed?.id ?? randomUUID().slice(0, 16);
    const cwd = realpathSync(resolve(args.cwd ?? resumed?.cwd ?? parent.cwd));
    if (!statSync(cwd).isDirectory()) throw new Error("Agent cwd must be a directory");
    // An access request without a network policy keeps the requester's; only an unsandboxed requester's default is public.
    const access = resumed ? resumed.access : args.access ? resolveAccess({ ...args.access, network: args.access.network ?? parent.access?.network }, cwd) : parent.access;
    assertNarrower(parent.access, access);
    if (access) {
      if (!readable(access, cwd)) throw new Error("The member cwd must be inside its granted directories");
      if (args.worktree) throw new Error("Worktrees cannot be combined with enforced access");
      // Container memory caps must stay within host RAM in total; unsandboxed members are not limited.
      if (this.live().filter(other => other.access && other.id !== resumed?.id).length >= maxSandboxed()) throw new Error(`At most ${maxSandboxed()} enforced members can run at once on this host`);
      const status = this.sandboxStatus();
      if (!status.available) throw new Error(`Enforced access is unavailable: ${status.reason}`);
    }
    // The provider endpoint bypasses the allowlist, so a restricted member keeps its provider and its children inherit it.
    const provider = args.model.slice(0, args.model.indexOf("/"));
    const locked = resumed ? resumed.provider : parent.access?.network.allow ? parent.provider : undefined;
    if (access?.network.allow && locked && provider !== locked) throw new Error(`A member with restricted network access can only use ${locked} models`);
    const member: Member = resumed ? { ...resumed, token: randomUUID(), status: "starting", error: undefined, contextUsage: undefined, modelName: undefined } : { id, name: args.name, parent: actor, depth, token: randomUUID(), cwd, status: "starting", notified: 0, access, provider: access ? provider : undefined };
    // Reserve synchronously before the first await so concurrent launches cannot oversubscribe.
    this.store.update(next => { next.members[id] = member; });
    this.publishStatus();
    member.model = args.model; member.thinking = args.thinking ?? "off";
    member.terminal = this.options.interactive === true;
    this.store.update(next => { next.members[id] = member; });
    let agent: RpcAgent | TerminalAgent | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (args.worktree && !resumed) {
        member.worktree = await createWorktree(cwd, state.id, id, args.base, args.target);
        member.cwd = member.worktree.path;
        this.store.update(next => { next.members[id].worktree = member.worktree; next.members[id].cwd = member.cwd; });
      }
      if (this.closed || this.store.state.members[id].status !== "starting") throw new Error("Launch was stopped before startup");
      const readiness = new Promise<void>((done, fail) => {
        this.ready.set(id, { resolve: done, reject: fail });
        // Enforced members start with an empty compile cache, so Pi recompiles TypeScript extensions (about 20 s here).
        timer = setTimeout(() => fail(new Error("ac-teams child readiness timed out")), access ? 90000 : 20000);
      });
      // Attach immediately: a spawn error must not leave a rejected readiness promise unobserved.
      void readiness.catch(() => {});
      const slash = args.model.indexOf("/");
      const modelId = args.model.slice(slash + 1);
      // Each member gets its own transcript directory, so a sandboxed member cannot read or alter others.
      const sessions = resumed?.sessionFile ? dirname(resumed.sessionFile) : this.memberSessionDir(id);
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      this.sessionDirs.set(id, sessions);
      const rpcArgs = [...(this.options.interactive ? [] : ["--mode", "rpc"]), "--session-dir", sessions, "-e", this.options.extension, "--provider", provider, "--model", modelId, "--thinking", args.thinking ?? "off"];
      if (resumed?.sessionFile) rpcArgs.push("--session", resumed.sessionFile);
      const identity = { HERDR_ENV: "0", AC_TEAMS_SOCKET: this.socketPath, AC_TEAMS_MEMBER: id, AC_TEAMS_TOKEN: member.token, AC_TEAMS_ACCESS: JSON.stringify(access ? { enforced: true, ...access } : { enforced: false }) };
      const spawnOptions = access
        ? await this.sandboxed(id, access, member.cwd, provider, modelId, rpcArgs, identity, sessions)
        : { cwd: member.cwd, args: rpcArgs, command: this.options.command, env: { ...process.env, ...identity, AC_TEAMS_TERMINAL_SOCKET: join(this.store.dir, "t.sock") } };
      agent = this.options.interactive
        ? new TerminalAgent({ ...spawnOptions, id, dir: this.store.dir, request: (type, fields, timeout) => this.control(id, type, fields, timeout) })
        : new RpcAgent(spawnOptions);
      this.agents.set(id, agent);
      agent.on("failure", error => this.options.warning(`Member ${id}: ${(error as Error).message}`));
      agent.on("forced", signal => this.options.warning(`Member ${id} required ${signal}`));
      agent.on("event", event => {
        if (this.closed) return;
        if (event.type === "agent_start" || event.type === "agent_settled") this.recordEvent(id, { type: event.type });
        if (event.type === "tool_execution_start") this.recordEvent(id, { type: "activity", text: `Running ${String(event.toolName ?? "tool").slice(0, 100)}` });
        if (event.type === "message_end") {
          const change = assistantEvent(event.message);
          if (change) this.recordEvent(id, change);
        }
      });
      agent.once("exit", () => {
        this.agents.delete(id);
        // Tracked so close() waits for container removal.
        const release = this.releaseSandbox(id).catch(error => this.options.warning(String(error)));
        this.operations.add(release); this.releasing.set(id, release);
        void release.finally(() => { this.operations.delete(release); if (this.releasing.get(id) === release) this.releasing.delete(id); });
        if (this.closed) return;
        this.store.update(next => { next.members[id].status = next.members[id].status === "stopping" ? "stopped" : "interrupted"; delete next.members[id].needsInput; });
        this.publishStatus();
        void this.stopDescendants(id).catch(error => this.options.warning(String(error)));
      });
      if (agent instanceof TerminalAgent) await agent.start();
      member.pid = agent.process.pid;
      member.identity = member.pid ? processIdentity(member.pid) : undefined;
      this.store.update(next => { next.members[id].pid = member.pid; next.members[id].identity = member.identity; });
      if (access) await this.releaseMember(id);
      try {
        await Promise.race([readiness, agent.exited.then(() => { throw new Error("Child exited before readiness"); })]);
      } finally { if (timer) clearTimeout(timer); this.ready.delete(id); }
      const rpcState = await agent.request("get_state");
      if (!isRecord(rpcState) || !isRecord(rpcState.model) || rpcState.model.provider !== args.model.slice(0, slash) || rpcState.model.id !== args.model.slice(slash + 1)) throw new Error("Pi did not select the requested model");
      if (rpcState.model.name !== undefined || rpcState.contextUsage !== undefined) this.recordEvent(id, { type: "telemetry", model: args.model, modelName: rpcState.model.name, contextUsage: rpcState.contextUsage ?? null });
      this.store.update(next => { if (next.members[id].status === "starting") next.members[id].status = prompt ? "busy" : "idle"; });
      this.publishStatus();
      if (prompt) await agent.request("prompt", { message: args.brief, streamingBehavior: "followUp" });
      return this.publicMember(this.store.state.members[id]);
    } catch (error) {
      clearTimeout(timer); this.ready.delete(id);
      if (agent) await agent.stop();
      // The exit handler may already own the container removal; wait for it so a failed launch leaves nothing running.
      await this.releaseSandbox(id); await this.releasing.get(id);
      this.store.update(next => { next.members[id].status = "interrupted"; delete next.members[id].needsInput; next.members[id].error = error instanceof Error ? error.message : "Startup failed"; });
      this.publishStatus();
      throw error;
    }
  }
  private image() {
    return memberImage(this.options.piVersion ?? JSON.parse(readFileSync(join(packageRoot(command("pi")), "package.json"), "utf8")).version);
  }
  /** Transcript root: Main's session directory, without any ac-teams nesting if Main itself resumed a member transcript. */
  private memberSessionDir(id: string): string {
    const root = resolve(this.options.sessionDir ?? join(this.store.dir, "sessions")).replace(/\/ac-teams\/[^/]+\/[^/]+$/, "");
    return join(root, "ac-teams", this.store.state.id, id);
  }
  private containerName(id: string): string { return `ac-teams-${this.store.state.id}-${id}`; }
  /** Prepares a member container whose only outside channels are the coordinator socket and this member's egress proxy. */
  private async sandboxed(id: string, access: Access, cwd: string, provider: string, model: string, args: string[], identity: Record<string, string>, sessionDir: string) {
    const credentials = this.options.credentials, route = providerRoutes[provider];
    if (!credentials || !route) throw new Error(`Enforced access supports only ${Object.keys(providerRoutes).join("/")} models with Main's Pi login`);
    const first = await credentials(provider, model); // Fails closed for unsupported providers before anything starts.
    // A resume reuses the member ID, so the previous run's cleanup must finish before its files are recreated.
    await this.releasing.get(id);
    const home = homedir(), agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"));
    const dir = memberConfigDir(id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const read = (name: string) => { try { return JSON.parse(readFileSync(join(agentDir, name), "utf8")) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } };
    const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // WebSocket clients may ignore proxy settings, so pin the SSE transport.
    write("settings.json", { ...read("settings.json"), transport: "sse" });
    // Only the selected provider's current access token: no refresh token and no other providers. The parent refreshes it.
    const auth = (credential: { token: string; expires: number }) => ({ [provider]: { type: "oauth", access: credential.token, refresh: "", expires: credential.expires } });
    write("auth.json", auth(first));
    // Only trust decisions for the member's cwd and its ancestors; the full file lists every trusted project.
    write("trust.json", Object.fromEntries(Object.entries(read("trust.json")).filter(([path]) => cwd === path || cwd.startsWith(path.endsWith("/") ? path : path + "/"))));
    // pi-web-access ignores proxy environment variables but honours its own proxy setting. The container has no DNS,
    // so it must leave address checks to the proxy, which refuses private and host addresses itself.
    const proxy = `http://127.0.0.1:${egressPort}`, search = read("web-search.json");
    write("web-search.json", { ...search, proxy, ssrf: { ...(search.ssrf as object | undefined), trustEnvProxy: true } });
    // The image's Pi runs members; a test command is mounted from its own package instead.
    const custom = this.options.command ?? process.env.AC_TEAMS_PI;
    const pi = custom ? command(custom) : "pi";
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...identity,
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1",
      // billion-context's spawned proxy reads its own upstream setting rather than the inherited environment.
      BILI_UPSTREAM_PROXY: proxy };
    for (const key of ["USER", "LANG", "LC_ALL", "TERM", "COLORTERM"]) if (process.env[key]) env[key] = process.env[key]!;
    const launch = join(dir, "launch.json");
    // The bridge waits on this before running any member code; it opens only after the mounts are verified.
    let release!: (go: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const egress = await Egress.open(join(this.store.dir, `e-${id}.sock`), access.network, { host: new URL(route.baseUrl).hostname, port: 443 }, gate);
    // Rewrites in place (same inode), because the file is bind-mounted; the member never sees the refresh token.
    const refresh = setInterval(() => void credentials(provider, model).then(next => {
      const current = this.sandboxes.get(id);
      if (current && next.token !== current.token) { writeFileSync(join(dir, "auth.json"), JSON.stringify(auth(next), null, 2) + "\n"); current.token = next.token; }
    }, () => this.options.warning(`Member ${id}: provider credential refresh failed`)), this.options.refreshMs ?? 60000);
    refresh.unref();
    const entry = { egress, grants: [] as { path: string; fd: number; dev: number; ino: number }[], release, refresh, token: first.token };
    this.sandboxes.set(id, entry);
    // Registered first so releaseSandbox closes the proxy if this fails. The coordinator token travels in this private file, never in container configuration that docker inspect shows.
    write("launch.json", { socket: egress.socket, port: egressPort, command: pi, args, env });
    // Hold each grant open so the started container's mounts can be compared with exactly these directories.
    for (const path of [...access.read, ...access.write]) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      entry.grants.push({ path, fd, ...(({ dev, ino }) => ({ dev, ino }))(fstatSync(fd)) });
      if (readlinkSync(`/proc/self/fd/${fd}`) !== path) throw new Error(`Grant ${path} changed while opening`);
    }
    const plan: SandboxPlan = {
      name: this.containerName(id), labels: { "ac-teams.team": this.store.state.id, "ac-teams.member": id, "ac-teams.store": this.store.dir },
      image: this.image().tag, access, cwd, home, terminal: this.options.interactive === true, agentDir, configDir: dir, sessionDir,
      coordinatorSocket: this.socketPath, egressSocket: egress.socket, launch,
      runtime: [...new Set([packageRoot(this.options.extension), packageRoot(fileURLToPath(import.meta.url)), ...(custom ? [packageRoot(pi)] : [])])],
      bridge: fileURLToPath(new URL("./sandbox-bridge.mjs", import.meta.url)),
    };
    this.plans.set(id, plan);
    await docker(["rm", "-f", plan.name]).catch(() => {});
    const created = (await docker(dockerCreateArgs(plan))).trim();
    // Register first, then check. Grants are identity-checked at start, but runtime, transcript, and socket mounts are
    // not, so none may sit strictly inside another live member's writable grant, and no writable grant may strictly
    // contain another member's such mounts, across all teams.
    const others = (await docker(["ps", "-aq", "--no-trunc", "--filter", "label=ac-teams.member", ...["created", "running", "paused", "restarting"].flatMap(state => ["--filter", `status=${state}`])])).trim().split("\n").filter(other => other && other !== created);
    const sets = others.length ? (JSON.parse(await docker(["inspect", ...others])) as { Mounts?: { Type: string; Source: string; RW: boolean }[]; Config: { Labels?: Record<string, string> } }[])
      .map(container => mountSet((container.Mounts ?? []).filter(mount => mount.Type === "bind").map(mount => ({ source: mount.Source, rw: mount.RW })), JSON.parse(container.Config.Labels?.["ac-teams.grants"] ?? "[]"))) : [];
    assertStableGrants(mountSet(sandboxMounts(plan).map(mount => ({ source: mount.source, rw: !mount.readonly })), [...access.read, ...access.write]), sets);
    // Admission across every coordinator on this host: count after creating, so concurrent launches cannot both slip under the cap.
    const admitted = (await docker(["ps", "-aq", "--filter", "label=ac-teams.member", "--filter", "status=created", "--filter", "status=running"])).trim().split("\n").filter(Boolean).length;
    if (admitted > maxSandboxed()) throw new Error(`At most ${maxSandboxed()} enforced members can run at once on this host`);
    await this.verifyContainer(id, false);
    await this.options.beforeStart?.(id);
    return { cwd, command: "docker", args: ["start", "--attach", "--interactive", plan.name], env: { ...process.env } };
  }
  /** Refuses to run a container whose effective configuration differs from the policy. */
  private async verifyContainer(id: string, started: boolean): Promise<void> {
    const plan = this.plans.get(id)!;
    const [inspect] = JSON.parse(await docker(["inspect", plan.name]));
    const problems = containerProblems(inspect, plan, started);
    if (problems.length) throw new Error(`Member container failed policy checks: ${problems.join("; ")}`);
  }
  /**
   * After start, before any member code runs: each grant mounted in the container must be the directory held open
   * before creation. Docker resolves bind sources at start, so this is what pins grants against symlink swaps.
   */
  private async releaseMember(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id)!, plan = this.plans.get(id)!;
    try {
      let pid = 0;
      for (const end = Date.now() + 30000; !pid; await new Promise(done => setTimeout(done, 100))) {
        if (Date.now() > end) throw new Error("Member container did not start");
        const [inspect] = JSON.parse(await docker(["inspect", plan.name]));
        if (inspect?.State?.Running) pid = inspect.State.Pid;
        else if (inspect?.State?.Status === "exited") throw new Error("Member container exited before release");
      }
      await this.verifyContainer(id, true);
      for (const grant of sandbox.grants) {
        const mounted = lstatSync(`/proc/${pid}/root${grant.path}`);
        if (mounted.dev !== grant.dev || mounted.ino !== grant.ino) throw new Error(`Grant ${grant.path} is not the directory that was checked`);
      }
      sandbox.release(true);
    } catch (error) { sandbox.release(false); throw error; }
    finally { for (const grant of sandbox.grants) closeSync(grant.fd); sandbox.grants = []; }
  }
  private async releaseSandbox(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id), plan = this.plans.get(id);
    this.sandboxes.delete(id); this.plans.delete(id);
    if (sandbox) {
      sandbox.release(false); clearInterval(sandbox.refresh);
      // releaseMember may still hold this entry; emptying the list keeps it from closing reused descriptors.
      for (const grant of sandbox.grants) closeSync(grant.fd);
      sandbox.grants = [];
    }
    if (plan) await docker(["rm", "-f", plan.name]).catch(error => this.options.warning(`Cannot remove member container ${plan.name}: ${String(error)}`));
    await sandbox?.egress.close();
    // The member's files hold its coordinator token and provider access token.
    rmSync(memberConfigDir(id), { recursive: true, force: true });
  }
  private async stopDescendants(id: string): Promise<void> {
    const descendants = this.live().filter(member => isDescendant(this.store.state, member.id, id)).sort((a, b) => b.depth - a.depth);
    for (const member of descendants) await this.stopOne(member.id);
  }
  private async stopOne(id: string): Promise<void> {
    const member = this.store.state.members[id];
    if (!isLive(member)) return;
    this.store.update(next => { next.members[id].status = "stopping"; delete next.members[id].needsInput; });
    this.publishStatus();
    const agent = this.agents.get(id);
    // A stopped member's container and credential files are gone before stop returns.
    if (agent) { await agent.stop(); await this.releasing.get(id); }
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
    for (const id of [...this.sandboxes.keys()]) await this.releaseSandbox(id);
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(new Error("Team stopped")); }
    this.controls.clear();
    if (this.options.interactive) {
      const socket = join(this.store.dir, "t.sock");
      await tmux(socket, ["kill-server"]).catch(() => {});
      try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.store.close();
  }
}

const memberConfigDir = (id: string) => join(stateRoot(), "agents", id);

function command(name: string): string {
  if (name.includes("/")) return realpathSync(name);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return realpathSync(join(dir, name));
  }
  throw new Error(`Cannot find ${name} on PATH`);
}

const execFileAsync = promisify(execFile);
async function docker(args: string[]): Promise<string> {
  return (await execFileAsync("docker", args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
