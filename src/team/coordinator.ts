import { createServer, type Server } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type SandboxStatus } from "../sandbox/policy.ts";
import { SandboxRuntime } from "../sandbox/runtime.ts";
import { Store } from "./store.ts";
import { processAlive } from "../process.ts";
import { RpcAgent } from "../members/rpc-agent.ts";
import { TerminalAgent, tmux } from "../members/terminal-agent.ts";
import { validate } from "./requests.ts";
import { removeWorktree } from "../members/worktrees.ts";
import { handoverPrompt } from "../members/main-terminal.ts";
import { canControl, isDescendant, isLive, isMain, memberName, taskName, type AgentArgs, type Member, type MessageArgs, type TaskArgs, type TeamState, type UserAction, type Message } from "../types.ts";

export const taskRequestGuidance = [
  "Assess user task requests against the agreed scope and existing work before changing shared tasks.",
  "Review the agreed scope and current task list (page as needed); read relevant descriptions, acceptance criteria, statuses, owners, and dependencies.",
  "If an existing task already covers the request, cite its number/name and explain why; do not add a duplicate.",
  "If a coherent extension is the smallest complete solution, update the existing task only when its state and ownership allow it; otherwise coordinate with its owner.",
  "Create a task only for genuinely distinct, in-scope work. Ask for clarification when ambiguity or a scope conflict prevents a sound decision.",
  "Respect completion checks and add only real dependencies. Explain the decision and any actual task changes to the user.",
].join(" ");

export type { CoordinatorOptions } from "./options.ts";
import type { CoordinatorOptions } from "./options.ts";
import { TeamProtocol } from "./protocol.ts";
import { TeamActivity, assistantEvent } from "./activity.ts";
export { assistantEvent } from "./activity.ts";
import { MemberLaunch } from "./launch.ts";
import { TeamSessions, addMain } from "./sessions.ts";

export class Coordinator {
  readonly store: Store;
  readonly socketPath: string;
  private server?: Server;
  private protocol: TeamProtocol;
  private sessions: TeamSessions;
  private launcher: MemberLaunch;
  private agents = new Map<string, RpcAgent | TerminalAgent>();
  private cleaning = new Set<string>();
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  private activity: TeamActivity;
  private closePromise?: Promise<void>;
  private sandboxRuntime: SandboxRuntime;
  private releasing = new Map<string, Promise<void>>();

  private options: CoordinatorOptions;
  /** The main session hosting this coordinator. */
  readonly self: string;
  private constructor(options: CoordinatorOptions) {
    this.options = options;
    this.self = options.self ?? "root";
    const root: Member = { id: "root", role: "main", depth: 0, token: randomUUID(), cwd: options.cwd, status: "idle", notified: 0, sessionId: options.id, sessionFile: options.sessionFile, model: options.model, thinking: options.thinking };
    const initial: TeamState = { version: 5, id: options.id, key: randomUUID(), limit: options.limit, depth: options.depth, members: { root }, tasks: {}, messages: [] };
    this.store = new Store(initial, options.home);
    this.socketPath = join(this.store.dir, "coordinator.sock");
    this.sandboxRuntime = new SandboxRuntime({ id: this.store.state.id, dir: this.store.dir, socketPath: this.socketPath }, options);
    this.protocol = new TeamProtocol(this.self, this.store, options, {
      closed: () => this.closed,
      changed: force => this.activity.publish(force),
      disconnected: id => { this.activity.statuses.delete(id); },
      sessionDir: id => this.launcher.sessionDir(id),
      publicMember: member => this.launcher.view(member),
      handle: (actor, operation, args) => this.handle(actor, operation, args),
    });
    this.activity = new TeamActivity(this.store, this.self, options, this.protocol, () => this.closed);
    this.sessions = new TeamSessions(this.store, this.self, options, this.protocol, id => this.stopOne(id), () => this.live());
    this.launcher = new MemberLaunch(this.store, this.self, options, this.protocol, this.sandboxRuntime, {
      closed: () => this.closed,
      changed: () => this.activity.publish(),
      event: (id, event) => this.activity.record(id, event),
      started: (id, agent) => this.attachAgent(id, agent),
      resumeMain: id => this.sessions.resumeMain(id),
      cleaning: id => this.cleaning.has(id),
    });
  }
  static async open(options: CoordinatorOptions): Promise<Coordinator> {
    const coordinator = new Coordinator(options);
    try {
      for (const member of Object.values(coordinator.store.state.members)) {
        if (!isMain(member) && isLive(member) && member.pid && processAlive(member.pid, member.identity)) {
          throw new Error(`Previous member ${member.id} is still live or uncertain; stop it explicitly before recovery`);
        }
      }
      coordinator.store.update(state => {
        state.limit = options.limit; state.depth = options.depth;
        const names = new Set(Object.values(state.members).map(member => member.name));
        let number = 0;
        if (options.join) addMain(state, coordinator.self, options.sessionId ?? options.id, options.sessionFile, options.cwd);
        const self = state.members[coordinator.self];
        if (!isMain(self)) throw new Error("This session is not a main session of the team");
        for (const member of Object.values(state.members)) if (member.id !== "root" && !member.name) {
          do { number++; } while (names.has(`teammate-${number}`) || Object.hasOwn(state.members, `teammate-${number}`));
          member.name = `teammate-${number}`; names.add(member.name);
        }
        self.status = "idle"; delete self.error;
        self.sessionFile = options.sessionFile ?? self.sessionFile;
        self.model = options.model;
        self.thinking = options.thinking;
        for (const member of Object.values(state.members)) {
          delete member.needsInput;
          // Other main sessions reconnect as clients; until then they are not running here.
          if (member.id !== coordinator.self && isLive(member)) member.status = "interrupted";
        }
      });
      // A promotion cut short by a crash: return the member to where it started.
      for (const member of Object.values(coordinator.store.state.members)) if (member.promotion) coordinator.sessions.rollback(member.id, "Promotion was interrupted");
      // Owner lock held and no member process alive: containers left by a killed coordinator are orphans of this store.
      for (const member of Object.values(coordinator.store.state.members)) if (member.access) {
        await coordinator.sandboxRuntime.recover(member.id);
      }
      try { unlinkSync(coordinator.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      coordinator.server = createServer(socket => coordinator.protocol.accept(socket));
      await new Promise<void>((done, fail) => {
        coordinator.server!.once("error", fail);
        coordinator.server!.listen(coordinator.socketPath, () => { chmodSync(coordinator.socketPath, 0o600); done(); });
      });
      coordinator.server.on("error", error => options.warning(error.message));
      coordinator.activity.publish();
      coordinator.protocol.notify(coordinator.self);
      const pass = coordinator.resumePass();
      coordinator.operations.add(pass);
      void pass.finally(() => coordinator.operations.delete(pass));
      return coordinator;
    } catch (error) { coordinator.server?.close(); coordinator.store.close(); throw error; }
  }
  private async userAction(actor: string, args: UserAction): Promise<string> {
    if (!this.options.interactive) throw new Error("User team actions require an interactive root");
    const resume = async (id: string) => {
      const member = this.store.state.members[id];
      if (!member) throw new Error("Unknown member ID");
      if (member.status === "stopping") throw new Error("Member is stopping; retry after it stops");
      if (isLive(member)) return;
      const launch = this.launcher.run(this.self, { action: "resume", id, brief: "Resume the native session without replaying work.", model: member.model ?? args.model, thinking: member.thinking ?? args.thinking }, false);
      this.operations.add(launch);
      try { await launch; } finally { this.operations.delete(launch); }
    };
    if (args.action === "resume") {
      if (!args.id) throw new Error("A member ID is required");
      await resume(args.id); return `Resumed ${args.id}`;
    }
    // Promoting and leaving change authority, so only the user, from a main session's TUI, can do them.
    if (args.action === "promote" || args.action === "leave") {
      if (!isMain(this.store.state.members[actor])) throw new Error("Only a main session can promote members or leave the team");
      const run = args.action === "promote" ? this.sessions.promote(args.id ?? "", args.confirmed === true) : Promise.resolve(this.sessions.leave(actor));
      this.operations.add(run);
      try { return await run; } finally { this.operations.delete(run); }
    }
    if (!args.text?.trim()) throw new Error("Write a request or feedback before sending");
    const main = isMain(this.store.state.members[actor]) ? actor : this.self;
    let recipient = main, fallback = "";
    let text = `User task request (review before changing tasks):\n${taskRequestGuidance}\n\nRequest:\n${args.text}`;
    if (args.action === "feedback") {
      const task = this.store.state.tasks[args.id ?? ""];
      if (!task) throw new Error("Unknown task ID");
      recipient = task.creator && this.store.state.members[task.creator]?.role ? task.creator : main;
      text = `User feedback on task ${taskName(task)} [${task.id}] (${task.title}):\n${args.text}`;
      if (!isLive(this.store.state.members[recipient]) || this.store.state.members[recipient].status === "stopping") {
        try { await resume(recipient); }
        catch (error) { fallback = `Creator ${recipient} could not resume (${String(error)}); delivered to ${memberName(this.store.state.members[main])} instead. `; recipient = main; }
      }
    }
    const message = this.store.message(actor, { action: "send", recipients: [recipient], summary: text }, true) as Message;
    this.protocol.notify(recipient);
    return `${fallback}Sent to ${isMain(this.store.state.members[recipient]) ? memberName(this.store.state.members[recipient]) : recipient} · message ${message.seq}`;
  }
  sandboxStatus(): SandboxStatus { return this.sandboxRuntime.status(); }
  /** Live members this coordinator runs; main sessions run in their own terminals and never count. */
  live(): Member[] { return Object.values(this.store.state.members).filter(member => !isMain(member) && isLive(member)); }
  recordEvent(actor: string, value: unknown): void { this.activity.record(actor, value); }
  ack(id: string, through: number): void { this.protocol.ack(id, through); }
  async handle(actor: string, operation: string, args: unknown, authorizedLimit = false): Promise<unknown> {
    if (this.closed) throw new Error("Team is stopping");
    const member = this.store.state.members[actor];
    if (!member || !isLive(member)) throw new Error("Member is not active");
    validate(operation, args);
    if (operation === "event") return this.activity.record(actor, args);
    if (operation === "ui") {
      // User actions can resume any member as Main, so sandboxed members cannot send them.
      if (member.access) throw new Error("Sandboxed members cannot send user team actions; use Main");
      return this.userAction(actor, args as UserAction);
    }
    if (operation === "task" || operation === "message") {
      const last = this.store.state.messages.at(-1)?.seq ?? 0;
      const result = operation === "task" ? this.store.task(actor, args as TaskArgs) : this.store.message(actor, args as MessageArgs);
      if (operation === "message" && (args as MessageArgs).action === "wait" && Array.isArray(result) && !result.length) {
        this.store.update(next => { next.members[actor].attention = "waiting"; });
        this.activity.publish();
      }
      for (const message of this.store.state.messages.filter(message => message.seq > last)) for (const id of message.recipients) this.protocol.notify(id);
      return result;
    }
    return this.agent(actor, args as AgentArgs, authorizedLimit);
  }
  private async agent(actor: string, args: AgentArgs, authorizedLimit: boolean): Promise<unknown> {
    const state = this.store.state;
    if (args.action === "list") return { team: state.id, limit: state.limit, depth: state.depth, sandbox: this.sandboxStatus(), resources: this.launcher.resources(), lastMessage: state.messages.at(-1)?.seq ?? 0, members: Object.values(state.members).map(member => this.launcher.view(member)) };
    if (args.action === "limits") {
      if (!isMain(state.members[actor])) throw new Error("Only a main session can change team limits");
      if ((args.limit ?? state.limit) > 10 && !authorizedLimit) throw new Error("A ceiling above 10 requires explicit user confirmation or --teams-limit");
      this.store.update(next => { next.limit = args.limit ?? next.limit; next.depth = args.depth ?? next.depth; });
      return { limit: this.store.state.limit, depth: this.store.state.depth, sandbox: this.sandboxStatus(), resources: this.launcher.resources() };
    }
    if (args.action === "launch" || args.action === "resume") {
      const launch = this.launcher.run(actor, args);
      this.operations.add(launch);
      try { return await launch; } finally { this.operations.delete(launch); }
    }
    const member = args.id ? state.members[args.id] : undefined;
    if (!member) throw new Error("Unknown member ID");
    if (args.action === "status") return this.launcher.view(member);
    if (!canControl(state, actor, member.id)) throw new Error("Only a main session or a member's ancestor can stop or clean it up");
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
    if (isMain(member)) await this.sessions.stopMain(member.id);
    else await this.stopTree(member.id);
    return this.launcher.view(this.store.state.members[member.id]);
  }
  private attachAgent(id: string, agent: RpcAgent | TerminalAgent): void {
      this.agents.set(id, agent);
      agent.on("failure", error => this.options.warning(`Member ${id}: ${(error as Error).message}`));
      agent.on("forced", signal => this.options.warning(`Member ${id} required ${signal}`));
      agent.on("event", event => {
        if (this.closed) return;
        if (event.type === "agent_start" || event.type === "agent_settled") this.activity.record(id, { type: event.type });
        if (event.type === "tool_execution_start") this.activity.record(id, { type: "activity", text: `Running ${String(event.toolName ?? "tool").slice(0, 100)}` });
        if (event.type === "message_end") {
          const change = assistantEvent(event.message);
          if (change) this.activity.record(id, change);
        }
      });
      agent.once("exit", () => {
        this.agents.delete(id);
        // Tracked so close() waits for container removal.
        const release = this.sandboxRuntime.release(id).catch(error => this.options.warning(String(error)));
        this.operations.add(release); this.releasing.set(id, release);
        void release.finally(() => { this.operations.delete(release); if (this.releasing.get(id) === release) this.releasing.delete(id); });
        if (this.closed) return;
        this.store.update(next => { next.members[id].status = next.members[id].status === "stopping" ? "stopped" : "interrupted"; delete next.members[id].needsInput; });
        this.activity.publish();
        const member = this.store.state.members[id];
        if (member.status === "interrupted") {
          const parent = member.parent && this.store.state.members[member.parent];
          const recipient = parent && isLive(parent) && parent.status !== "stopping" ? parent.id : this.self;
          this.store.message(id, { action: "send", recipients: [recipient], summary: `Member ${memberName(member)} (${id}) exited unexpectedly. Its work may be incomplete; inspect its status and resume or reassign as needed.` });
          this.protocol.notify(recipient);
        }
        // A promoted member keeps its descendants.
        if (!this.store.state.members[id].promotion) void this.stopDescendants(id).catch(error => this.options.warning(String(error)));
      });
  }
  /** Restores members a previous owner stopped to the state it recorded. */
  private async resumePass(): Promise<void> {
    for (const member of Object.values(this.store.state.members)) {
      const state = member.handover;
      if (!state || isLive(member)) continue;
      try {
        if (!member.model) throw new Error("no recorded model");
        await this.launcher.run(this.self, { action: "resume", id: member.id, brief: state === "busy" ? handoverPrompt : "Resume the native session without replaying work.", model: member.model, thinking: member.thinking }, state === "busy");
        if (state === "input") this.activity.record(member.id, { type: "blocked", active: true });
      } catch (error) {
        if (this.closed) return;
        this.options.warning(`Could not resume ${memberName(member)} after the coordinator handover: ${error instanceof Error ? error.message : String(error)}`);
        if (this.store.state.members[member.id]?.handover) this.store.update(next => { delete next.members[member.id].handover; });
      }
    }
  }
  private async stopDescendants(id: string): Promise<void> {
    const descendants = this.live().filter(member => isDescendant(this.store.state, member.id, id)).sort((a, b) => b.depth - a.depth);
    for (const member of descendants) await this.stopOne(member.id);
  }
  private async stopOne(id: string): Promise<void> {
    const member = this.store.state.members[id];
    if (!isLive(member)) return;
    this.store.update(next => { next.members[id].status = "stopping"; delete next.members[id].needsInput; });
    this.activity.publish();
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
    this.protocol.cancelNotices();
    // The next owner's resume pass restores each member to the state recorded here.
    this.store.update(state => {
      for (const member of Object.values(state.members)) if (!isMain(member) && isLive(member) && member.status !== "stopping") {
        member.handover = member.needsInput ? "input" : member.status === "idle" ? "idle" : "busy";
      }
      if (state.members[this.self]?.status !== undefined && isLive(state.members[this.self])) state.members[this.self].status = "stopped";
    });
    for (const member of this.live().sort((a, b) => b.depth - a.depth)) await this.stopOne(member.id);
    // Finish recording worktree operations already in flight before the store closes.
    await Promise.allSettled([...this.operations]);
    this.protocol.close();
    if (this.server) await new Promise<void>(done => this.server!.close(() => done()));
    try { unlinkSync(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await this.sandboxRuntime.close();
    if (this.options.interactive) {
      const socket = join(this.store.dir, "t.sock");
      await tmux(socket, ["kill-server"]).catch(() => {});
      try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.store.close();
  }
}
