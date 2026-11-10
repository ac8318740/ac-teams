import { createServer, type Server } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  private reloading = false;
  private reloadExits = new Set<string>();
  private sandboxRuntime: SandboxRuntime;
  private releasing = new Map<string, Promise<void>>();
  private idleSince = new Map<string, number>();
  private idleSweep?: NodeJS.Timeout;

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
    this.activity = new TeamActivity(this.store, this.self, options, this.protocol, () => this.closed, id => this.settled(id));
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
      const idleStopMs = options.idleStopMs ?? 5 * 60_000;
      coordinator.idleSweep = setInterval(() => coordinator.sweepIdle(idleStopMs), Math.min(30_000, idleStopMs));
      coordinator.idleSweep.unref();
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
      if (this.reloading) throw new Error("Team reload is preparing; cancel it before changing the team");
      // User actions can resume any member as Main, so sandboxed members cannot send them.
      if (member.access) throw new Error("Sandboxed members cannot send user team actions; use Main");
      return this.userAction(actor, args as UserAction);
    }
    if (operation === "task" || operation === "message") {
      const last = this.store.state.messages.at(-1)?.seq ?? 0;
      const direct = operation === "message" && (args as MessageArgs).action === "send" ? (args as MessageArgs).recipients ?? [] : [];
      const result = operation === "task" ? this.store.task(actor, args as TaskArgs) : this.store.message(actor, args as MessageArgs);
      if (operation === "message" && (args as MessageArgs).action === "wait" && Array.isArray(result) && !result.length) {
        this.store.update(next => { next.members[actor].attention = "waiting"; });
        this.activity.publish();
      }
      for (const message of this.store.state.messages.filter(message => message.seq > last)) for (const id of message.recipients) {
        this.protocol.notify(id);
        const member = this.store.state.members[id];
        // Only direct messages, replies to its own post, and posts that trigger its watches wake a stopped member.
        const replied = message.replyTo !== undefined && this.store.state.messages.find(original => original.id === message.replyTo)?.from === id;
        const watched = member?.watches?.some(watch => watch.task === message.task && (watch.seq === message.seq || (watch.event === "edited" && message.kind === "edited")));
        if (member && !isMain(member) && member.status === "stopped" && (direct.includes(id) || direct.includes(member.name ?? "") || replied || watched)) this.wake(id, actor);
      }
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
      if (this.reloading) throw new Error("Team reload is preparing; cancel it before launching members");
      const launch = this.launcher.run(actor, args);
      this.operations.add(launch);
      try { return await launch; } finally { this.operations.delete(launch); }
    }
    if (!args.id) throw new Error(`team_agent ${args.action} requires id, the member ID`);
    const member = state.members[args.id];
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
        this.store.update(next => { next.members[id].status = next.members[id].status === "stopping" || this.reloadExits.has(id) ? "stopped" : "interrupted"; delete next.members[id].needsInput; });
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
  /** Tells the parent a member went idle; it may stop it, and a direct message or watched-task post wakes it. */
  private settled(id: string): void {
    this.idleSince.set(id, Date.now());
    const state = this.store.state, member = state.members[id];
    // Stopping a member stops its descendants, so a member with live children is not done.
    if (this.live().some(other => other.parent === id)) return;
    const parent = member.parent && state.members[member.parent];
    const recipient = parent && isLive(parent) && parent.status !== "stopping" ? parent.id : this.self;
    const watched = [...new Set((member.watches ?? []).filter(watch => watch.seq === undefined && watch.event !== "edited").map(watch => watch.task))].filter(task => state.tasks[task]);
    const waiting = watched.length ? `waiting on task ${watched.map(task => taskName(state.tasks[task])).join(", ")}` : "not waiting on any task";
    this.store.message(id, { action: "send", recipients: [recipient], summary: `${memberName(member)} (${id}) is idle and ${waiting}. Stop it with team_agent stop id=${id} unless you will send it more work within a couple of minutes. A direct message, or a post on a task it watches, resumes it.` });
    this.protocol.notify(recipient);
  }
  /** Failsafe for idle members nobody stopped; a direct message or watched-task post resumes them. */
  private sweepIdle(idleStopMs: number): void {
    if (this.closed || this.reloading) return;
    const now = Date.now(), live = this.live();
    for (const id of this.idleSince.keys()) if (!live.some(member => member.id === id)) this.idleSince.delete(id);
    for (const member of live) {
      if (member.status !== "idle" || live.some(other => other.parent === member.id)) { this.idleSince.delete(member.id); continue; }
      const since = this.idleSince.get(member.id) ?? now;
      this.idleSince.set(member.id, since);
      if (now - since < idleStopMs) continue;
      this.idleSince.delete(member.id);
      const stop = this.stopOne(member.id).catch(error => this.options.warning(`Could not stop idle ${memberName(member)}: ${String(error)}`));
      this.operations.add(stop);
      void stop.finally(() => this.operations.delete(stop));
    }
  }
  private wake(id: string, sender: string): void {
    const member = this.store.state.members[id];
    if (this.closed || this.reloading || !member.model || !member.sessionFile) return;
    const run = this.launcher.run(this.self, { action: "resume", id, brief: "Resume the native session without replaying work.", model: member.model, thinking: member.thinking }, false).catch(error => {
      if (this.closed || sender === id) return;
      this.store.message(id, { action: "send", recipients: [sender], summary: `${memberName(member)} (${id}) is stopped and could not resume (${error instanceof Error ? error.message : String(error)}). Your post waits until it is resumed.` });
      this.protocol.notify(sender);
    });
    this.operations.add(run);
    void run.finally(() => this.operations.delete(run));
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
  /** Prepare without interrupting tools; each member acknowledges only once its run has settled. */
  async prepareReload(signal: AbortSignal, selfReady: () => boolean): Promise<void> {
    if (this.reloading) throw new Error("Team reload is already preparing");
    this.reloading = true;
    try {
      while (this.operations.size) await delay(100, undefined, { signal });
      const members = this.live();
      for (;;) {
        signal.throwIfAborted();
        for (const member of members) if (!isLive(this.store.state.members[member.id])) throw new Error(`${memberName(member)} exited while preparing reload`);
        const results = await Promise.allSettled(members.map(member => this.protocol.control(member.id, "prepare_reload")));
        let ready = selfReady();
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === "rejected") throw result.reason;
          const value = result.value as { ready?: boolean; resume?: boolean };
          if (typeof value?.ready !== "boolean" || typeof value.resume !== "boolean") throw new Error(`Invalid reload response from ${memberName(members[i])}`);
          ready = ready && value.ready;
        }
        if (ready) { signal.throwIfAborted(); return; }
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      await this.cancelReload();
      throw error;
    }
  }
  async cancelReload(): Promise<void> {
    if (!this.reloading) return;
    const members = this.live();
    const results = await Promise.allSettled(members.map(member => this.protocol.control(member.id, "cancel_reload")));
    this.reloading = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") this.options.warning(`Could not cancel reload for ${memberName(members[i])}: ${String(result.reason)}`);
    }
  }
  /** Explicit reload never escalates to signals or calls the ordinary aborting stop path. */
  async finishReload(): Promise<void> {
    if (!this.reloading) throw new Error("Team reload was not prepared");
    for (const member of this.live().sort((a, b) => b.depth - a.depth)) {
      const agent = this.agents.get(member.id);
      if (!agent) throw new Error(`No owned transport for ${memberName(member)}`);
      this.reloadExits.add(member.id);
      let timer: NodeJS.Timeout | undefined;
      try {
        const value = await this.protocol.control(member.id, "shutdown_reload") as { ready?: boolean; resume?: boolean };
        if (value?.ready !== true || typeof value.resume !== "boolean") throw new Error(`Invalid shutdown response from ${memberName(member)}`);
        this.store.update(state => {
          state.members[member.id].handover = value.resume ? "busy" : "idle";
        });
        await Promise.race([agent.exited, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${memberName(member)} did not shut down for reload; no signal was sent`)), 10000);
        })]);
        await this.releasing.get(member.id);
        this.store.update(state => { state.members[member.id].status = "stopped"; delete state.members[member.id].needsInput; });
      } finally { clearTimeout(timer); this.reloadExits.delete(member.id); }
    }
  }
  close(): Promise<void> { this.closePromise ??= this.closeOnce(); return this.closePromise; }
  private async closeOnce(): Promise<void> {
    this.closed = true;
    clearInterval(this.idleSweep);
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
