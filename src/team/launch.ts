import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNarrower, maxSandboxed, readable, resolveAccess } from "../sandbox/policy.ts";
import type { SandboxRuntime } from "../sandbox/runtime.ts";
import { Store } from "./store.ts";
import { processAlive, processIdentity } from "../process.ts";
import { workerConfiguration } from "../settings/config.ts";
import { projectTrusted, selectedExtensionArgs, selectExtensions, workerNodeOptions } from "../settings/worker-extensions.ts";
import { analysisPolicy } from "../settings/analysis.ts";
import { hostResources } from "../members/resources.ts";
import { RpcAgent } from "../members/rpc-agent.ts";
import { TerminalAgent } from "../members/terminal-agent.ts";
import { createWorktree } from "../members/worktrees.ts";
import { isRecord } from "./connection.ts";
import { canControl, isLive, isMain, memberName, taskName, type AgentArgs, type Member } from "../types.ts";
import type { CoordinatorOptions } from "./options.ts";
import type { TeamProtocol } from "./protocol.ts";

interface LaunchHooks {
  closed(): boolean;
  changed(): void;
  event(id: string, event: unknown): void;
  started(id: string, agent: RpcAgent | TerminalAgent): void;
  resumeMain(id: string): Promise<string>;
  cleaning(id: string): boolean;
}

export const liveMembers = (store: Store): Member[] => Object.values(store.state.members).filter(member => !isMain(member) && isLive(member));

/** Reserves capacity and task ownership, starts a native member, and rolls failed starts back. */
export class MemberLaunch {
  private analysisPolicies = new Map<string, ReturnType<typeof analysisPolicy>>();
  private extensionNudges = new Set<string>();

  private store: Store;
  private self: string;
  private options: CoordinatorOptions;
  private protocol: TeamProtocol;
  private sandboxRuntime: SandboxRuntime;
  private hooks: LaunchHooks;

  constructor(store: Store, self: string, options: CoordinatorOptions, protocol: TeamProtocol, sandboxRuntime: SandboxRuntime, hooks: LaunchHooks) {
    this.store = store;
    this.self = self;
    this.options = options;
    this.protocol = protocol;
    this.sandboxRuntime = sandboxRuntime;
    this.hooks = hooks;
  }
  view(member: Member) {
    const { token: _token, identity: _identity, ...view } = member;
    return member.role === "member" ? { ...view, analysis: member.analysis ?? "auto", analysisPolicy: this.analysisPolicies.get(member.id) } : view;
  }
  resources() {
    const sample = (this.options.resources ?? hostResources)();
    const live = liveMembers(this.store);
    const startingMembers = live.filter(member => member.status === "starting").length;
    const warnings = [...sample.warnings];
    if (startingMembers) warnings.push(`${startingMembers} teammate(s) still starting; their full memory cost is not yet reflected in host headroom.`);
    return { ...sample, liveMembers: live.length, startingMembers, warnings };
  }
  /** Transcript root: Main's session directory, without any ac-teams nesting if Main itself resumed a member transcript. */
  sessionDir(id: string): string {
    const root = resolve(this.options.sessionDir ?? join(this.store.dir, "sessions")).replace(/\/ac-teams\/[^/]+\/[^/]+$/, "");
    return join(root, "ac-teams", this.store.state.id, id);
  }
  async run(actor: string, args: AgentArgs, prompt = true): Promise<unknown> {
    const state = this.store.state;
    const parent = state.members[actor];
    if (!args.brief?.trim()) throw new Error("A launch or resume brief is required");
    if (!args.model || !args.model.includes("/")) throw new Error("A provider/model is required (normally inherited from the requesting member)");
    const resumed = args.action === "resume" ? state.members[args.id ?? ""] : undefined;
    if (args.action === "resume" && (!resumed || !resumed.sessionFile || !canControl(state, actor, resumed.id))) throw new Error("Resume requires a stopped member you control with a native session file");
    if (resumed && isMain(resumed)) {
      if (args.analysis !== undefined) throw new Error("Analysis can only be set for teammate launches; a main session keeps its own environment");
      return this.hooks.resumeMain(resumed.id);
    }
    if (resumed && this.hooks.cleaning(resumed.id)) throw new Error("Worktree cleanup is running; cannot resume this member");
    if (resumed && (isLive(resumed) || (resumed.pid && processAlive(resumed.pid, resumed.identity)))) throw new Error("Cannot resume a live or uncertain member");
    const depth = resumed ? resumed.depth : parent.depth + 1;
    if (depth > state.depth || liveMembers(this.store).length >= state.limit) throw new Error("Team depth or live-member ceiling reached (idle members count)");
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
      if (liveMembers(this.store).filter(other => other.access && other.id !== resumed?.id).length >= maxSandboxed()) throw new Error(`At most ${maxSandboxed()} enforced members can run at once on this host`);
      const status = this.sandboxRuntime.status();
      if (!status.available) throw new Error(`Enforced access is unavailable: ${status.reason}`);
    }
    // The provider endpoint bypasses the allowlist, so a restricted member keeps its provider and its children inherit it.
    const provider = args.model.slice(0, args.model.indexOf("/"));
    const locked = resumed ? resumed.provider : parent.access?.network.allow ? parent.provider : undefined;
    if (access?.network.allow && locked && provider !== locked) throw new Error(`A member with restricted network access can only use ${locked} models`);
    const member: Member = resumed ? { ...resumed, token: randomUUID(), status: "starting", error: undefined, contextUsage: undefined, modelName: undefined, handover: undefined } : { id, name: args.name, role: "member", parent: actor, depth, token: randomUUID(), cwd, status: "starting", notified: 0, access, provider: access ? provider : undefined };
    member.analysis = args.analysis ?? resumed?.analysis ?? "auto";
    const policy = analysisPolicy(member);
    const resources = this.resources();
    for (const warning of resources.warnings) this.options.warning(warning);
    const assigned = args.task === undefined ? undefined : state.tasks[args.task];
    if (args.task !== undefined && (!assigned || assigned.status !== "todo" || (assigned.owner && assigned.owner !== actor))) throw new Error("A launch task must be an existing to-do task that is unowned or yours");
    // Reserve synchronously before the first await so concurrent launches cannot oversubscribe or double-assign.
    this.store.update(next => {
      next.members[id] = member;
      if (next.members[actor].attention === "handoff") delete next.members[actor].attention;
      if (assigned) Object.assign(next.tasks[assigned.id], { owner: id, delegator: actor, revision: next.tasks[assigned.id].revision + 1 });
    });
    this.analysisPolicies.set(id, policy);
    const contact = `Your delegator is ${memberName(parent)} (recipient ID: ${actor}). Use that exact ID for direct coordination; task-linked posts already reach the task's delegator.`;
    const brief = `${args.brief}\n\n${contact}${assigned ? `\nYou own team task ${taskName(assigned)} [${assigned.id}]. Start it only when its prerequisites are done, and finish with team_task complete and an outcome summary; that one call reports back. Complete when your assigned acceptance checks pass; separately assigned review gates parent integration, not your task, unless your criteria require it.` : ""}`;
    this.hooks.changed();
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
      if (this.hooks.closed() || this.store.state.members[id].status !== "starting") throw new Error("Launch was stopped before startup");
      const slash = args.model.indexOf("/");
      const modelId = args.model.slice(slash + 1);
      // Each member gets its own transcript directory, so a sandboxed member cannot read or alter others.
      const sessions = resumed?.sessionFile ? dirname(resumed.sessionFile) : this.sessionDir(id);
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      this.protocol.sessionDirs.set(id, sessions);
      const { config } = workerConfiguration(member.cwd, this.options.projectConfig === true && projectTrusted(member.cwd));
      const inventory = actor === this.self ? await this.options.extensions?.() : this.protocol.extensionInventories.get(actor);
      if (!inventory) throw new Error("Actual parent extensions are unavailable. Reload Pi on a supported version; ac-teams will not substitute discovered extensions.");
      // Without a configured policy, preserve the parent's capabilities, never discover extra code in the child cwd.
      const implicit = { defaultPreset: "parent", required: [], presets: { parent: { extensions: "all" as const } } };
      const selection = selectExtensions(inventory, config ?? (args.extensions ? undefined : implicit), args.extensions, resumed?.extensions, parent.extensions?.required)!;
      this.protocol.extensionInventories.set(id, { ...inventory, entries: inventory.entries.map(entry => ({ ...entry, enabled: entry.enabled && selection.ids.includes(entry.id) })) });
      const nudge = !config || (inventory && config.reviewed?.[member.cwd] !== inventory.fingerprint);
      const nudgeKey = `${member.cwd}:${inventory?.fingerprint ?? "legacy"}`;
      if (nudge && !this.extensionNudges.has(nudgeKey)) {
        this.extensionNudges.add(nudgeKey);
        this.options.warning(config ? "Worker extension inventory changed or is unreviewed. Run /teams config; preset definitions are unchanged. 'all' includes newly enabled IDs. Launch results report selected/excluded IDs." : "Worker extension presets are not configured. Workers retain the actual parent extension set; run /teams config to configure lean workers.");
      }
      for (const warning of selection?.warnings ?? []) this.options.warning(warning);
      member.extensions = selection;
      this.store.update(next => { next.members[id].extensions = selection; });
      if (this.hooks.closed() || this.store.state.members[id].status !== "starting") throw new Error("Launch was stopped before extension selection completed");
      const rpcArgs = [...(this.options.interactive ? [] : ["--mode", "rpc"]), "--session-dir", sessions, ...(selection && inventory ? selectedExtensionArgs(selection, inventory, this.options.extension) : []), "-e", this.options.extension, "--provider", provider, "--model", modelId, "--thinking", args.thinking ?? "off"];
      if (resumed?.sessionFile) rpcArgs.push("--session", resumed.sessionFile);
      // ACSTACK_AGENT_ROLE tells ACStack hooks this is not a main session; children inherit it.
      const identity = { ...(selection?.heapMb ? { NODE_OPTIONS: workerNodeOptions(process.env.NODE_OPTIONS, selection.heapMb) } : {}), PI_LENS_WARM_ATTACH: policy.warmAttach, HERDR_ENV: "0", ACSTACK_AGENT_ROLE: "member", AC_TEAMS_SOCKET: join(this.store.dir, "coordinator.sock"), AC_TEAMS_MEMBER: id, AC_TEAMS_TOKEN: member.token, AC_TEAMS_ACCESS: JSON.stringify(access ? { enforced: true, ...access } : { enforced: false }) };
      const spawnOptions = access
        ? await this.sandboxRuntime.prepare(id, access, member.cwd, provider, modelId, rpcArgs, identity, sessions)
        : { cwd: member.cwd, args: rpcArgs, command: this.options.command, env: { ...process.env, ...identity, AC_TEAMS_TERMINAL_SOCKET: join(this.store.dir, "t.sock") } };
      const readiness = new Promise<void>((done, fail) => {
        this.protocol.ready.set(id, { resolve: done, reject: fail });
        // Enforced members start with an empty compile cache, so Pi recompiles TypeScript extensions (about 20 s here).
        timer = setTimeout(() => fail(new Error("ac-teams child readiness timed out")), access ? 90000 : 20000);
      });
      // Attach immediately: a spawn error must not leave a rejected readiness promise unobserved.
      void readiness.catch(() => {});
      agent = this.options.interactive
        ? new TerminalAgent({ ...spawnOptions, id, dir: this.store.dir, request: (type, fields, timeout) => this.protocol.control(id, type, fields, timeout) })
        : new RpcAgent(spawnOptions);
      this.hooks.started(id, agent);
      if (agent instanceof TerminalAgent) await agent.start();
      member.pid = agent.process.pid;
      member.identity = member.pid ? processIdentity(member.pid) : undefined;
      this.store.update(next => { next.members[id].pid = member.pid; next.members[id].identity = member.identity; });
      if (access) await this.sandboxRuntime.start(id);
      try {
        await Promise.race([readiness, agent.exited.then(() => { throw new Error("Child exited before readiness"); })]);
      } finally { if (timer) clearTimeout(timer); this.protocol.ready.delete(id); }
      const rpcState = await agent.request("get_state");
      if (!isRecord(rpcState) || !isRecord(rpcState.model) || rpcState.model.provider !== args.model.slice(0, slash) || rpcState.model.id !== args.model.slice(slash + 1)) throw new Error("Pi did not select the requested model");
      if (rpcState.model.name !== undefined || rpcState.contextUsage !== undefined) this.hooks.event(id, { type: "telemetry", model: args.model, modelName: rpcState.model.name, contextUsage: rpcState.contextUsage ?? null });
      this.store.update(next => { if (next.members[id].status === "starting") next.members[id].status = prompt ? "busy" : "idle"; });
      this.hooks.changed();
      if (prompt) await agent.request("prompt", { message: brief, streamingBehavior: "followUp" });
      return { ...this.view(this.store.state.members[id]), resources };
    } catch (error) {
      clearTimeout(timer); this.protocol.ready.delete(id);
      if (agent) await agent.stop();
      // The exit handler may already own the container removal; wait for it so a failed launch leaves nothing running.
      await this.sandboxRuntime.release(id);
      this.store.update(next => {
        next.members[id].status = "interrupted"; delete next.members[id].needsInput; next.members[id].error = error instanceof Error ? error.message : "Startup failed";
        // A failed launch returns its untouched reservation.
        const task = assigned && next.tasks[assigned.id];
        if (task && task.owner === id && task.status === "todo") { delete task.owner; delete task.delegator; task.revision++; }
      });
      this.hooks.changed();
      throw error;
    }
  }
}
