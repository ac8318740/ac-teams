import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VERSION, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { createMemberLabels, readState, stateLabels, teamsHome } from "../team/snapshot.ts";
import { handoverPrompt, teamEntryType, type TeamEntry } from "../members/main-terminal.ts";
import { isMain, memberName, taskName, type TeamState, type AgentArgs, type UserAction } from "../types.ts";
import { Coordinator } from "../team/coordinator.ts";
import { Connection } from "../team/connection.ts";
import { policy } from "../settings/config.ts";
import { providerRoutes } from "../sandbox/egress.ts";
import { readTelemetry } from "../ui/telemetry.ts";
import { cleanText } from "../ui/render.ts";
import { createNotices } from "./notices.ts";
import { createReloadPause } from "./reload.ts";
import { setTimeout as delay } from "node:timers/promises";

const reloadEntryType = "ac-teams-reload";
import { validate } from "../team/requests.ts";
import type { extensionInventory } from "../settings/worker-extensions.ts";

interface SessionLifecycle {
  close(): void;
  joined(ctx: ExtensionContext): void;
  switched(): void;
}

export function createSession(pi: ExtensionAPI, extension: string, loadedPaths: () => string[] | undefined,
  parentInventory: () => ReturnType<typeof extensionInventory>, lifecycle: SessionLifecycle) {
  const environment = [process.env.AC_TEAMS_SOCKET, process.env.AC_TEAMS_MEMBER, process.env.AC_TEAMS_TOKEN];
  const child = environment.some(Boolean);
  let coordinator: Coordinator | undefined;
  let opening: Promise<Coordinator> | undefined;
  let connection: Connection | undefined;
  let context: ExtensionContext | undefined;
  let exiting = false;
  let inputCount = 0;
  let reloadCommand = false;
  const reloadPause = createReloadPause(pi, () => inputCount > 0);
  /** This main session's team, from its transcript's team entry; a session with no entry leads its own team as "root". */
  let team: TeamEntry | undefined;
  /** Why team tools are off in this session, if they are. */
  let disabled: string | undefined;
  let linking: Promise<void> | undefined;
  let linkedSession: string | undefined;
  const teamTools = ["team_agent", "team_task", "team_message"];
  const memberId = () => child ? environment[1]! : team?.member ?? "root";
  const teamId = (ctx: ExtensionContext) => team?.team ?? ctx.sessionManager.getSessionId();
  const cachedLabels = createMemberLabels();
  function memberLabels(): Record<string, string> {
    try {
      if (coordinator) return stateLabels(coordinator.store.state);
      return cachedLabels(child ? dirname(environment[0]!) : join(teamsHome(), teamId(context!)));
    } catch { return { root: "Main" }; } // A transcript can render before its team is available.
  }
  /** Warnings this extension showed, so a folded team block can absorb its own (Pi prints them as "Warning: ..."). */
  const ownWarnings = new Set<string>();
  const warn = (message: string) => { ownWarnings.add(`Warning: ${message}`); context?.ui.notify(message, "warning"); };
  const receiptIdentity = () => ({ team: coordinator?.store.state.id ?? (child ? basename(dirname(environment[0]!)) : teamId(context!)), member: memberId() });
  const notices = createNotices(pi, receiptIdentity, memberLabels, warn, () => {
    const client = connection, owner = coordinator;
    if (client) return { remote: true, ack: async (through: number) => { await client.request("ack", { through }); } };
    if (owner) return { remote: false, ack: (through: number) => owner.ack(owner.self, through) };
  });
  const { notify, reconcile, reset: resetReceipts, receiveAttention, setAttention } = notices;
  function disable(reason: string) {
    disabled = reason;
    pi.setActiveTools(pi.getActiveTools().filter(name => !teamTools.includes(name)));
  }
  function enable() {
    disabled = undefined;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...teamTools])]);
  }
  function remember(entry: TeamEntry) {
    team = entry;
    pi.appendEntry(teamEntryType, entry);
  }
  /** Runs a native command sent by the coordinator: members get these from their parent, main sessions from other mains. */
  function onCommand(ctx: ExtensionContext, link: Connection) {
    return (command: { id: string; command: string; args: Record<string, unknown> }) => {
      void (async () => {
        let data: unknown = {}, error: string | undefined;
        try {
          if (command.command === "get_state") {
            data = {
              sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
              model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, name: ctx.model.name } : undefined,
              contextUsage: readTelemetry(ctx).contextUsage, isStreaming: !ctx.isIdle(),
            };
          } else if (command.command === "prompt") {
            if (typeof command.args.message !== "string" || !command.args.message.trim() || command.args.message.length > 16000) throw new Error("Invalid native prompt");
            pi.sendUserMessage(command.args.message, { deliverAs: "followUp" });
          } else if (command.command === "prepare_reload") data = reloadPause.prepare(ctx);
          else if (command.command === "cancel_reload") reloadPause.cancel(ctx);
          else if (command.command === "shutdown_reload") {
            data = reloadPause.state(ctx);
            if (!(data as { ready: boolean }).ready) throw new Error("Member is no longer ready for reload; no shutdown requested");
          } else if (command.command === "abort") ctx.abort();
          else if (command.command !== "shutdown") throw new Error("Unsupported native command");
        } catch (failure) { error = String(failure).slice(0, 2000); }
        try { await link.request("control_result", { id: command.id, data, error }); }
        catch { return; }
        if ((command.command === "shutdown" || command.command === "shutdown_reload") && !error) {
          if (command.command === "shutdown_reload" && !reloadPause.state(ctx).ready) {
            warn("New input arrived before shutdown; this member was left running");
            return;
          }
          exiting = true;
          ctx.shutdown();
        }
      })();
    };
  }
  /** Connects to a running coordinator as a main-session client; false when none is listening. */
  async function connectMain(ctx: ExtensionContext): Promise<boolean> {
    const dir = join(teamsHome(), teamId(ctx)), socket = join(dir, "coordinator.sock");
    if (!existsSync(socket)) return false;
    const record = readState(dir).members[memberId()];
    if (!isMain(record)) throw new Error("This session is no longer a main session of its team; use /teams join");
    const link = new Connection(socket, record.id, record.token);
    try { await link.open(); } catch { return false; }
    link.on("notice", (through, messages) => notify(through, messages));
    link.on("attention", receiveAttention);
    link.on("command", onCommand(ctx, link));
    link.on("disconnect", () => {
      if (connection !== link) return;
      connection = undefined;
      receiveAttention({ busy: false, blocked: false });
      if (!exiting) void takeover(ctx);
    });
    try { await link.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted(), extensionPaths: loadedPaths() }); }
    catch (error) { link.close(); throw error; }
    connection = link;
    linkedSession = ctx.sessionManager.getSessionId();
    if (!team) remember({ team: teamId(ctx), member: record.id });
    return true;
  }
  /** The coordinator owner went away: one main session takes the owner lock, the rest reconnect to it. */
  async function takeover(ctx: ExtensionContext) {
    warn("The team coordinator stopped; taking over or reconnecting");
    for (let attempt = 0; attempt < 40 && !exiting; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
      try {
        await link(ctx);
        warn(coordinator ? "This session now runs the team coordinator" : "Reconnected to the team coordinator");
        return;
      } catch { /* The new owner may still be starting. */ }
    }
    if (!exiting) warn("Could not reach or take over the team coordinator; team tools will retry on next use");
  }
  /** Makes this session an owner or client of its team's coordinator. */
  async function link(ctx: ExtensionContext): Promise<void> {
    if (child) {
      if (!connection) throw new Error("Team coordinator is not connected");
      return;
    }
    if (exiting) throw new Error("Team is stopping");
    if (disabled) throw new Error(disabled);
    if (connection || coordinator) return;
    linking ??= (async () => {
      if (await connectMain(ctx)) return;
      try { await root(ctx); }
      catch (error) {
        // Another main session won the owner lock first; join it as a client.
        if (String(error).includes("live owner lock") && await connectMain(ctx)) return;
        throw error;
      }
    })().finally(() => { linking = undefined; });
    return linking;
  }
  async function root(ctx: ExtensionContext, join?: { id: string; member: string }): Promise<Coordinator> {
    if (exiting) throw new Error("Team is stopping");
    context = ctx;
    opening ??= Coordinator.open({
      id: join?.id ?? teamId(ctx), self: join?.member ?? memberId(), join: join !== undefined, sessionId: ctx.sessionManager.getSessionId(),
      shutdown: () => { exiting = true; ctx.shutdown(); },
      cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(), sessionDir: ctx.sessionManager.getSessionDir(),
      ...policy(ctx.cwd, pi.getFlag("teams-project-config") === true, { limit: pi.getFlag("teams-limit") as string | undefined, depth: pi.getFlag("teams-depth") as string | undefined }),
      extension, notice: notify, warning: warn, piVersion: VERSION,
      projectConfig: pi.getFlag("teams-project-config") === true, extensions: parentInventory,
      status: setAttention,
      credentials: async (provider, modelId) => {
        // Only providers whose request shape was verified are brokered; anything else fails closed.
        const registry = (context ?? ctx).modelRegistry, model = registry.find(provider, modelId), route = providerRoutes[provider];
        if (!model || !route || model.api !== route.api || model.baseUrl !== route.baseUrl || !registry.isUsingOAuth(model)) throw new Error(`Enforced access supports only OAuth ${Object.keys(providerRoutes).join("/")} models at their default endpoints, not ${provider}/${modelId}`);
        const auth = await registry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(auth.error);
        if (!auth.apiKey || auth.baseUrl || Object.keys(auth.headers ?? {}).length || Object.keys(auth.env ?? {}).length) throw new Error(`Unsupported credential shape for ${provider}`);
        // The member gets the token's real expiry; an unknown expiry is kept short so the parent's rewrite stays ahead of it.
        const stored = readStoredCredential(provider) as { type?: string; access?: string; expires?: number } | undefined;
        const expires = stored?.type === "oauth" && stored.access === auth.apiKey && typeof stored.expires === "number" ? stored.expires : Date.now() + 10 * 60000;
        return { token: auth.apiKey, expires };
      },
      interactive: ctx.mode === "tui", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel(),
    }).then(value => {
      coordinator = value;
      linkedSession = ctx.sessionManager.getSessionId();
      if (!team) remember({ team: value.store.state.id, member: value.self });
      if (ctx.isIdle?.() === false) value.recordEvent(value.self, { type: "agent_start" });
      if (inputCount > 0) value.recordEvent(value.self, { type: "blocked", active: true });
      return value;
    }, error => { opening = undefined; throw error; });
    return opening;
  }
  async function handle(operation: "agent" | "task" | "message", value: unknown, ctx: ExtensionContext): Promise<unknown> {
    validate(operation, value);
    let args = value;
    if (operation === "agent") {
      const agent = { ...(value as AgentArgs) };
      if (agent.action === "launch" || agent.action === "resume") {
        agent.model ??= ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        agent.thinking ??= pi.getThinkingLevel();
      }
      args = agent;
    }
    await link(ctx);
    // shortcut: client main sessions cannot approve a ceiling above 10, only the owner can; add a confirmation relay if needed.
    if (connection) return connection.request(operation, args);
    let authorized = false;
    if (operation === "agent" && (args as AgentArgs).action === "limits" && ((args as AgentArgs).limit ?? 0) > 10) {
      if (!ctx.hasUI || !await ctx.ui.confirm("Raise team ceiling?", `Allow up to ${(args as AgentArgs).limit} live Pi members, including idle members? This increases possible model costs.`)) throw new Error("Ceiling increase was not explicitly approved");
      authorized = true;
    }
    return coordinator!.handle(coordinator!.self, operation, args, authorized);
  }
  async function close() {
    exiting = true;
    resetReceipts();
    lifecycle.close();
    connection?.close();
    connection = undefined;
    if (opening) await (await opening).close();
    receiveAttention({ busy: false, blocked: false });
    coordinator = undefined;
    opening = undefined;
    linkedSession = undefined;
  }
  /** A resumed main session reconnects to its team, or offers to run the coordinator and resume the team's members. */
  async function rejoin(ctx: ExtensionContext, automatic = false) {
    try {
      if (await connectMain(ctx)) return;
      const dir = join(teamsHome(), teamId(ctx));
      if (!existsSync(join(dir, "state.json"))) return;
      const state = readState(dir);
      if (!isMain(state.members[memberId()])) {
        disable("This session is no longer a main session of its team; use /teams join");
        return;
      }
      if (automatic) { await link(ctx); return; }
      const others = Object.values(state.members).filter(member => member.id !== memberId() && member.role);
      if (!ctx.hasUI || !others.length) return;
      if (await ctx.ui.confirm("Run the team coordinator?", `This is a main session of a team with ${others.length} other member(s), and no coordinator is running. Run it here and resume the members that were working?`)) await link(ctx);
      else disable("You declined to run the team coordinator; team tools are off in this session. Resume the session again to take over.");
    } catch (error) { warn(cleanText(String(error))); }
  }
  async function repository(cwd: string): Promise<string> {
    try { return (await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 })).stdout.trim(); }
    catch { return cwd; }
  }
  /** /teams join [team-id]: adds this session to another team in the same project as a main session. */
  async function joinTeam(ctx: ExtensionContext, id?: string) {
    if (child) throw new Error("A member cannot join another team");
    if (!id && !ctx.hasUI) throw new Error("/teams join requires an interactive session or an explicit team ID");
    const sessionId = ctx.sessionManager.getSessionId(), home = teamsHome();
    const current = existsSync(join(home, teamId(ctx), "state.json")) ? readState(join(home, teamId(ctx))) : undefined;
    if (current && Object.values(current.members).some(member => member.id !== memberId() && member.role)) throw new Error("This session is already in a team with other members; use /teams leave first");
    const repo = await repository(ctx.cwd), teams: TeamState[] = [];
    for (const name of existsSync(home) ? readdirSync(home) : []) {
      try {
        const state = readState(join(home, name)), main = Object.values(state.members).find(isMain);
        if (state.id !== current?.id && main && await repository(main.cwd) === repo) teams.push(state);
      } catch { /* Unreadable or foreign team folders are not offered. */ }
    }
    if (id && !teams.some(state => state.id === id)) throw new Error("No team with that ID in this project");
    if (!teams.length) {
      ctx.ui.notify("No other teams in this project", "info");
      return;
    }
    const describe = (state: TeamState) => {
      const members = Object.values(state.members);
      return `${members.filter(isMain).map(memberName).join(", ")} · ${members.filter(member => member.role === "member").length} member(s) · ${Object.values(state.tasks).filter(task => task.status !== "done").length} open task(s) · ${state.id.slice(0, 8)}`;
    };
    const labels = teams.map(describe);
    const chosen = id ? teams.find(state => state.id === id) : teams[labels.indexOf(await ctx.ui.select("Join which team?", labels) ?? "")];
    if (!chosen) return;
    if (Object.values(chosen.members).some(member => member.sessionId === sessionId)) throw new Error("This session is already in that team");
    await close();
    exiting = false;
    enable();
    const dir = join(home, chosen.id), probe = new Connection(join(dir, "coordinator.sock"), "join", chosen.key);
    let running = false;
    try { await probe.open(); running = true; } catch { /* No coordinator: this session runs it. */ }
    if (running) {
      try {
        const added = await probe.request("add_main", { sessionId, sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd }) as { id: string };
        remember({ team: chosen.id, member: added.id });
      } finally { probe.close(); }
      if (!await connectMain(ctx)) throw new Error("The team coordinator stopped while joining; resume this session to retry");
    } else {
      const member = randomUUID().slice(0, 16);
      await root(ctx, { id: chosen.id, member });
      remember({ team: chosen.id, member });
    }
    lifecycle.joined(ctx);
    const state = readState(dir), name = (id?: string) => id ? memberName(state.members[id] ?? { id }) : "unowned";
    const open = Object.values(state.tasks).filter(task => task.status !== "done");
    const recent = state.messages.slice(-5);
    pi.sendMessage({ customType: "ac-teams", display: true, details: { team: state.id, member: team!.member, joined: { team: state.id, member: team!.member, sessionId }, through: state.messages.at(-1)?.seq ?? 0, messages: recent }, content: [
      `Joined team ${state.id} as ${name(team!.member)}, a main session.`,
      open.length ? `Open tasks:\n${open.map(task => `- ${taskName(task)} (${task.status}, ${name(task.owner)})`).join("\n")}` : "No open tasks.",
      recent.length ? `Recent messages:\n${recent.map(message => `- ${name(message.from)}: ${message.summary.split("\n")[0].slice(0, 200)}`).join("\n")}` : "No messages yet.",
    ].join("\n\n") }, { triggerTurn: false });
  }
  /** /teams leave: hands this session's work back and drops its main-session role. */
  async function leaveTeam(ctx: ExtensionContext) {
    if (child) throw new Error("A member cannot leave its team; its parent stops it");
    await link(ctx);
    const left = { team: teamId(ctx), member: memberId(), left: true };
    const result = connection ? await connection.request("ui", { action: "leave" }) : await coordinator!.handle(coordinator!.self, "ui", { action: "leave" });
    pi.appendEntry(teamEntryType, left);
    team = undefined;
    await close();
    exiting = false;
    disable("This session left its team; use /teams join to join one");
    ctx.ui.notify(String(result), "info");
  }
  /** Explicitly requested refresh; ordinary /reload retains its normal recovery prompt. */
  async function reload(ctx: ExtensionCommandContext) {
    if (reloadCommand) throw new Error("Team reload is already preparing");
    if (!child && connection) throw new Error("Run /teams reload in the main session hosting the coordinator");
    reloadCommand = true;
    const cancel = new AbortController(), dialog = new AbortController();
    try {
      reloadPause.prepare(ctx);
      if (ctx.hasUI) void ctx.ui.select("Waiting for running tools and queued input before reload", ["Cancel reload"], { signal: dialog.signal })
        .then(() => { if (!dialog.signal.aborted) cancel.abort(); }, () => { if (!dialog.signal.aborted) cancel.abort(); });
      if (coordinator) await coordinator.prepareReload(cancel.signal, () => reloadPause.state(ctx).ready);
      else while (!reloadPause.state(ctx).ready) await delay(100, undefined, { signal: cancel.signal });
      cancel.signal.throwIfAborted();
      dialog.abort();
      if (!reloadPause.state(ctx).ready) throw new Error("New input arrived before reload; no shutdown requested");
      if (coordinator) await coordinator.finishReload();
      if (!reloadPause.state(ctx).ready) throw new Error("New input arrived during reload preparation");
      pi.appendEntry(reloadEntryType, { session: ctx.sessionManager.getSessionId(), rejoin: Boolean(coordinator), resume: reloadPause.state(ctx).resume });
    } catch (error) {
      await coordinator?.cancelReload();
      reloadPause.cancel(ctx);
      ctx.ui.notify(cancel.signal.aborted ? "Team reload cancelled" : `Team reload failed: ${String(error)}`, cancel.signal.aborted ? "info" : "error");
      reloadCommand = false;
      return;
    } finally { dialog.abort(); }
    await ctx.reload();
  }
  async function start(ctx: ExtensionContext) {
    if (!child && linkedSession && linkedSession !== ctx.sessionManager.getSessionId()) {
      await close();
      lifecycle.switched();
    }
    context = ctx;
    exiting = false;
    inputCount = 0;
    resetReceipts();
    const reloadEntry = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === reloadEntryType).at(-1);
    const reload = reloadEntry?.type === "custom" ? reloadEntry.data as { session?: string; rejoin?: boolean; resume?: boolean } : undefined;
    const refreshing = reload?.session === ctx.sessionManager.getSessionId();
    if (refreshing) pi.appendEntry(reloadEntryType, {});
    if (child) {
      if (environment.some(value => !value)) throw new Error("Incomplete AC_TEAMS membership environment; refusing independent-root fallback");
      const link = new Connection(environment[0]!, environment[1]!, environment[2]!);
      connection = link;
      link.on("notice", (through, messages) => notify(through, messages));
      link.on("attention", receiveAttention);
      link.on("disconnect", () => {
        receiveAttention({ busy: false, blocked: false });
        warn("Team coordinator disconnected; this member is shutting down");
        ctx.abort();
        ctx.shutdown();
      });
      link.on("command", onCommand(ctx, link));
      await link.open();
      await link.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted(), extensionPaths: loadedPaths() });
    } else if (!linkedSession) {
      const entry = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === teamEntryType).at(-1);
      const data = entry?.type === "custom" ? entry.data as TeamEntry : undefined;
      team = data && !data.left ? { team: data.team, member: data.member } : undefined;
      disabled = undefined;
      if (data?.left) disable("This session left its team; use /teams join to join one");
      else if (team) await rejoin(ctx, refreshing && reload?.rejoin === true);
    }
    // Notices persisted before a crash or reconnect count as delivered; acknowledge them so they are not shown twice.
    reconcile(ctx);
    if (refreshing && reload?.resume) pi.sendUserMessage(handoverPrompt, { deliverAs: "followUp" });
  }
  async function userAction(ctx: ExtensionContext, args: UserAction): Promise<string> {
    const value = { ...args, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel() };
    await link(ctx);
    if (connection) return connection.request("ui", value) as Promise<string>;
    return coordinator!.handle(coordinator!.self, "ui", value) as Promise<string>;
  }
  function report(ctx: ExtensionContext, event: { type: string; text?: string; active?: boolean }) {
    if (exiting) return;
    if (connection && (!child || ctx.mode === "tui")) void connection.request("event", event).catch(error => warn(cleanText(String(error))));
    else coordinator?.recordEvent(coordinator.self, event);
  }
  async function publish(event: ReturnType<typeof readTelemetry>) {
    if (connection) await connection.request("event", event);
    else coordinator?.recordEvent(coordinator.self, event);
  }
  function blocked(active: boolean) {
    inputCount = Math.max(0, inputCount + (active ? 1 : -1));
    if (!context) return;
    const event = { type: "blocked", active: inputCount > 0 };
    if (connection) void connection.request("event", event).catch(error => warn(cleanText(String(error))));
    else coordinator?.recordEvent(coordinator.self, event);
  }
  return {
    child, memberId, memberLabels, teamId, notices, warn, ownWarnings,
    link, handle, userAction, start, close, joinTeam, leaveTeam, report, publish, blocked, reload,
    reloadStarted() { reloadPause.started(); },
    reloadBoundary(ctx: ExtensionContext, hasTools: boolean) { reloadPause.boundary(ctx, hasTools); },
    reloadSettled(ctx: ExtensionContext) { reloadPause.settled(ctx); },
    setContext(ctx: ExtensionContext) { context = ctx; },
    clearBlocked() { inputCount = 0; },
    get context() { return context; },
    get needsInput() { return inputCount > 0; },
    get stopping() { return exiting; },
    get disabled() { return disabled; },
    get connected() { return Boolean(connection || coordinator); },
    get started() { return Boolean(child || opening || connection); },
    get liveCount() { return coordinator?.live().length ?? 0; },
    get switchBlocked() { return Boolean(child || coordinator?.live().length || connection); },
  };
}

export type TeamSession = ReturnType<typeof createSession>;
