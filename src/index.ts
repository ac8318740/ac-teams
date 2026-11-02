import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { AgentSchema, TaskSchema, MessageSchema, validate } from "./schemas.ts";
import type { AgentArgs, Message, TaskView, UserAction } from "./types.ts";
import type { PanelHost, TeamSnapshot } from "./ui-types.ts";
import { installTeamFooter, visitMember, showDisplayConfig } from "./terminal-ui.ts";
import { readTelemetry } from "./telemetry.ts";
import { resolveTeammate, teamsCompletions } from "./commands.ts";
import { showTeamsPanel } from "./panel.ts";
import { teamToolRenderers, renderTeamMessage, cleanText } from "./render.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { readState, teamsHome } from "./store.ts";
import { teamEntryType, type TeamEntry } from "./mains.ts";
import { isMain, memberName, taskName, type TeamState } from "./types.ts";
import { Coordinator, assistantEvent, taskRequestGuidance } from "./coordinator.ts";
import { Connection, isRecord } from "./connection.ts";
import { policy, readDisplaySettings, defaultDisplaySettings } from "./config.ts";
import { providerRoutes } from "./egress.ts";
import { VERSION, readStoredCredential } from "@earendil-works/pi-coding-agent";

export default function teams(pi: ExtensionAPI) {
  pi.registerFlag("teams-limit", { description: "Explicit maximum live ac-teams members (default 10, idle members count)", type: "string" });
  pi.registerFlag("teams-depth", { description: "Maximum descendant depth (root is 0, default 2)", type: "string" });
  pi.registerFlag("teams-project-config", { description: "Trust .pi/ac-teams.json policy in the current project", type: "boolean", default: false });
  const environment = [process.env.AC_TEAMS_SOCKET, process.env.AC_TEAMS_MEMBER, process.env.AC_TEAMS_TOKEN];
  const child = environment.some(Boolean);
  let coordinator: Coordinator | undefined;
  let opening: Promise<Coordinator> | undefined;
  let connection: Connection | undefined;
  let context: ExtensionContext | undefined;
  let warned = false;
  let exiting = false;
  let disposeUI: (() => void) | undefined;
  let telemetryTimer: NodeJS.Timeout | undefined;
  let inputCount = 0;
  /** This main session's team, from its transcript's team entry; a session with no entry leads its own team as "root". */
  let team: TeamEntry | undefined;
  /** Why team tools are off in this session, if they are. */
  let disabled: string | undefined;
  let linking: Promise<void> | undefined;
  let linkedSession: string | undefined;
  const drafts = new Map<string, string>();
  const display = { ...defaultDisplaySettings };
  const teamTools = ["team_agent", "team_task", "team_message"];
  const memberId = () => child ? environment[1]! : team?.member ?? "root";
  const teamId = (ctx: ExtensionContext) => team?.team ?? ctx.sessionManager.getSessionId();
  pi.registerMessageRenderer("ac-teams", renderTeamMessage);
  const warn = (message: string) => context?.ui.notify(message, "warning");
  const notify = (through: number, messages: Message[] = []) => {
    pi.sendMessage({ customType: "ac-teams", content: `New team messages through sequence ${through}. Read team_message history after your last cursor. Reply only with useful updates, not acknowledgements.`, display: true, details: { through, messages } }, { deliverAs: "followUp", triggerTurn: true });
    if (connection) void connection.request("ack", { through }).catch(error => warn(String(error)));
    else coordinator?.ack(coordinator.self, through);
  };
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
          if (command.command === "get_state") data = { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, name: ctx.model.name } : undefined, contextUsage: readTelemetry(ctx).contextUsage, isStreaming: !ctx.isIdle() };
          else if (command.command === "prompt") {
            if (typeof command.args.message !== "string" || !command.args.message.trim() || command.args.message.length > 16000) throw new Error("Invalid native prompt");
            pi.sendUserMessage(command.args.message, { deliverAs: "followUp" });
          } else if (command.command === "abort") ctx.abort();
          else if (command.command !== "shutdown") throw new Error("Unsupported native command");
        } catch (failure) { error = String(failure).slice(0, 2000); }
        try { await link.request("control_result", { id: command.id, data, error }); }
        catch { return; }
        if (command.command === "shutdown" && !error) { exiting = true; ctx.shutdown(); }
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
    link.on("command", onCommand(ctx, link));
    link.on("disconnect", () => {
      if (connection !== link) return;
      connection = undefined;
      if (!exiting) void takeover(ctx);
    });
    try { await link.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted() }); }
    catch (error) { link.close(); throw error; }
    connection = link; linkedSession = ctx.sessionManager.getSessionId();
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
    if (child) { if (!connection) throw new Error("Team coordinator is not connected"); return; }
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
      extension: fileURLToPath(import.meta.url), notice: notify, warning: warn, piVersion: VERSION,
      status: (kind, active) => pi.events.emit(`herdr:${kind}`, { active, source: "ac-teams" }),
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
      coordinator = value; linkedSession = ctx.sessionManager.getSessionId();
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
  async function snapshot(ctx: ExtensionContext): Promise<TeamSnapshot> {
    if (!child && !opening && !connection) return { members: [{ id: "root", cwd: ctx.cwd, depth: 0, status: ctx.isIdle() ? "idle" : "busy", notified: 0, needsInput: inputCount > 0 }], tasks: [], messages: [], limit: 10, depth: 2 };
    const status = await handle("agent", { action: "list" }, ctx) as Pick<TeamSnapshot, "members" | "limit" | "depth"> & { lastMessage: number };
    const tasks: TaskView[] = [];
    let total = 0;
    do {
      const page = await handle("task", { action: "list", offset: tasks.length, limit: 100 }, ctx) as { tasks: TaskView[]; total: number };
      tasks.push(...page.tasks); total = page.total;
      if (!page.tasks.length) break;
    } while (tasks.length < total);
    const messages = await handle("message", { action: "history", after: Math.max(0, status.lastMessage - 100), limit: 100 }, ctx) as Message[];
    return { members: status.members, limit: status.limit, depth: status.depth, tasks, messages };
  }
  function host(ctx: ExtensionContext): PanelHost {
    const userAction = async (args: UserAction): Promise<string> => {
      const value = { ...args, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel() };
      await link(ctx);
      if (connection) return await connection.request("ui", value) as string;
      return await coordinator!.handle(coordinator!.self, "ui", value) as string;
    };
    const api: PanelHost = {
      self: memberId(), child, drafts, snapshot: () => snapshot(ctx),
      visit: async id => {
        if (id === memberId()) return;
        if (!child) await link(ctx);
        const socket = child ? process.env.AC_TEAMS_TERMINAL_SOCKET : join(teamsHome(), teamId(ctx), "t.sock");
        if (!socket) throw new Error("This member has no live terminal transport");
        await visitMember(ctx, api, socket, id);
      },
      requestTask: text => userAction({ action: "task_request", text }),
      feedback: (task, text) => userAction({ action: "feedback", id: task.id, text }),
      resume: async id => { await userAction({ action: "resume", id }); },
      promote: async id => {
        const member = (await snapshot(ctx)).members.find(member => member.id === id);
        const confirmed = member?.access ? await ctx.ui.confirm("Promote a sandboxed member?", `${memberName(member)} will leave its sandbox and run as a main session with your full access.`) : false;
        if (member?.access && !confirmed) return;
        ctx.ui.notify(await userAction({ action: "promote", id, confirmed }), "info");
      },
    };
    return api;
  }
  function report(ctx: ExtensionContext, event: { type: string; text?: string; active?: boolean }) {
    if (exiting) return;
    if (connection && (!child || ctx.mode === "tui")) void connection.request("event", event).catch(error => warn(cleanText(String(error))));
    else coordinator?.recordEvent(coordinator.self, event);
  }
  function startTelemetry(ctx: ExtensionContext) {
    clearInterval(telemetryTimer);
    let previous = "", pending = false;
    const publish = async () => {
      if (exiting || pending || (!connection && !coordinator)) return;
      pending = true;
      try {
        const event = readTelemetry(ctx), encoded = JSON.stringify(event);
        if (encoded === previous) return;
        if (connection) await connection.request("event", event);
        else coordinator?.recordEvent(coordinator.self, event);
        previous = encoded;
      } catch (error) { if (!exiting) warn(cleanText(String(error))); }
      finally { pending = false; }
    };
    telemetryTimer = setInterval(() => void publish(), 1000);
    telemetryTimer.unref();
    void publish();
  }
  pi.events.on("herdr:blocked", (data: unknown) => {
    // Main already receives this signal locally; relay only across the team socket.
    if (!isRecord(data) || typeof data.active !== "boolean" || data.source === "ac-teams") return;
    inputCount = Math.max(0, inputCount + (data.active ? 1 : -1));
    if (context) {
      const event = { type: "blocked", active: inputCount > 0 };
      if (connection) void connection.request("event", event).catch(error => warn(cleanText(String(error))));
      else coordinator?.recordEvent(coordinator.self, event);
    }
  });
  pi.on("agent_start", (_event, ctx) => report(ctx, { type: "agent_start" }));
  pi.on("agent_settled", (_event, ctx) => { inputCount = 0; report(ctx, { type: "agent_settled" }); });
  pi.on("tool_execution_start", (event, ctx) => report(ctx, { type: "activity", text: `Running ${event.toolName}`.slice(0, 500) }));
  pi.on("message_end", (event, ctx) => {
    const change = assistantEvent(event.message);
    if (change) report(ctx, change);
  });
  function output(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data }; }
  const guidance = "Team launches use real long-lived Pi sessions. Idle members count against the shared ceiling. Use stable member/task IDs; query status and history instead of acknowledging notifications. Limits cover only ac-teams, not other launchers or shell commands.";
  const taskTrackingGuidance = "Before delegating a deliverable through team_agent, create or reuse a team_task and include its ID in the member's brief. Track independently owned outcomes, not tool calls or procedural steps; do not create one task per teammate by default. Skip tasks for quick lookups, clarification, and brief second opinions unless results need coordination or follow-up. Task owners claim and start their work, then complete it after checking acceptance criteria or report blockers.";
  pi.registerTool({
    name: "team_agent", label: "Team agent", description: "Launch/resume Pi members, list/status, stop owned subtrees, change root limits, and explicitly clean stopped worktrees. Create or reuse team_task entries for delegated deliverables; quick lookups need no task unless results need coordination or follow-up.",
    promptGuidelines: [guidance, taskTrackingGuidance, "Delegation needs the user's authorization. Give each new member a unique descriptive name (one or two lowercase words, hyphenated if two), plus a bounded brief. Names remain stable on resume. Avoid concurrent writers in the same cwd. Worktrees are opt-in."],
    parameters: AgentSchema,
    ...teamToolRenderers("team_agent"),
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("agent", args, ctx)); },
  });
  pi.registerTool({
    name: "team_task", label: "Team task", description: "Track delegated deliverables, not every agent or action. Create or reuse tasks before delegation; quick lookups need no task unless results need coordination or follow-up. Manage shared tasks: create/list/read/edit, claim a reservation, start work, complete, release ownership, or explicitly reopen. Progress is todo/in_progress/done; blockedBy is derived from unfinished dependencies. Mutations support revision checks.",
    promptGuidelines: [taskTrackingGuidance, taskRequestGuidance, "Give every task a concise 1–3-word label, alongside its full title and acceptance criteria. Stable team-local numbers are assigned automatically; use UUIDs for API references. Interim and final goals are ordinary tasks. Add dependencies only for real prerequisites, never merely to connect the diagram.", "Claim reserves a to-do task even if blocked; start requires ownership and all dependencies done. Complete requires in-progress work and acceptance=true after checking the criteria. Release clears ownership, returns in-progress work to todo, and leaves done work done. Reopen is explicit and cannot invalidate active or done dependents."],
    parameters: TaskSchema,
    ...teamToolRenderers("team_task"),
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("task", args, ctx)); },
  });
  pi.registerTool({
    name: "team_message", label: "Team message", description: "Send a persistent direct/team message or read cursor-paged history. New messages queue a compact follow-up notification for each recipient.",
    parameters: MessageSchema,
    ...teamToolRenderers("team_message"),
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("message", args, ctx)); },
  });
  async function close() {
    exiting = true;
    clearInterval(telemetryTimer); telemetryTimer = undefined;
    disposeUI?.(); disposeUI = undefined;
    connection?.close(); connection = undefined;
    if (opening) await (await opening).close();
    coordinator = undefined; opening = undefined; linkedSession = undefined;
  }
  /** A resumed main session reconnects to its team, or offers to run the coordinator and resume the team's members. */
  async function rejoin(ctx: ExtensionContext) {
    try {
      if (await connectMain(ctx)) return;
      const dir = join(teamsHome(), teamId(ctx));
      if (!existsSync(join(dir, "state.json"))) return;
      const state = readState(dir);
      if (!isMain(state.members[memberId()])) { disable("This session is no longer a main session of its team; use /teams join"); return; }
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
  /** /teams join: adds this session to another team in the same project as a main session. */
  async function joinTeam(ctx: ExtensionContext) {
    if (child) throw new Error("A member cannot join another team");
    if (!ctx.hasUI) throw new Error("/teams join requires an interactive session");
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
    if (!teams.length) { ctx.ui.notify("No other teams in this project", "info"); return; }
    const describe = (state: TeamState) => {
      const members = Object.values(state.members);
      return `${members.filter(isMain).map(memberName).join(", ")} · ${members.filter(member => member.role === "member").length} member(s) · ${Object.values(state.tasks).filter(task => task.status !== "done").length} open task(s) · ${state.id.slice(0, 8)}`;
    };
    const labels = teams.map(describe), choice = await ctx.ui.select("Join which team?", labels);
    const chosen = teams[labels.indexOf(choice ?? "")];
    if (!chosen) return;
    if (Object.values(chosen.members).some(member => member.sessionId === sessionId)) throw new Error("This session is already in that team");
    await close(); exiting = false; enable();
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
    const state = readState(dir), name = (id?: string) => id ? memberName(state.members[id] ?? { id }) : "unowned";
    const open = Object.values(state.tasks).filter(task => task.status !== "done");
    const recent = state.messages.slice(-5);
    pi.sendMessage({ customType: "ac-teams", display: true, details: { through: state.messages.at(-1)?.seq ?? 0, messages: recent }, content: [
      `Joined team ${state.id} as ${name(team!.member)}, a main session.`,
      open.length ? `Open tasks:\n${open.map(task => `- ${taskName(task)} (${task.status}, ${name(task.owner)})`).join("\n")}` : "No open tasks.",
      recent.length ? `Recent messages:\n${recent.map(message => `- ${name(message.from)}: ${message.text.split("\n")[0].slice(0, 200)}`).join("\n")}` : "No messages yet.",
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
    await close(); exiting = false;
    disable("This session left its team; use /teams join to join one");
    ctx.ui.notify(String(result), "info");
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!child && linkedSession && linkedSession !== ctx.sessionManager.getSessionId()) { await close(); drafts.clear(); }
    context = ctx; exiting = false; inputCount = 0;
    if (child) {
      if (environment.some(value => !value)) throw new Error("Incomplete AC_TEAMS membership environment; refusing independent-root fallback");
      const link = new Connection(environment[0]!, environment[1]!, environment[2]!);
      connection = link;
      link.on("notice", (through, messages) => notify(through, messages));
      link.on("disconnect", () => { warn("Team coordinator disconnected; this member is shutting down"); ctx.abort(); ctx.shutdown(); });
      link.on("command", onCommand(ctx, link));
      await link.open();
      await link.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted() });
    } else if (!linkedSession) {
      const entry = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === teamEntryType).at(-1);
      const data = entry?.type === "custom" ? entry.data as TeamEntry : undefined;
      team = data && !data.left ? { team: data.team, member: data.member } : undefined;
      disabled = undefined;
      if (data?.left) disable("This session left its team; use /teams join to join one");
      else if (team) await rejoin(ctx);
    }
    startTelemetry(ctx);
    if (!warned) {
      warned = true;
      const competitors = pi.getAllTools().filter(tool => ["Agent", "SubagentWorkflow", "subagent"].includes(tool.name));
      if (competitors.length) warn(`Other delegation tools are active (${competitors.map(tool => tool.name).join(", ")}). ac-teams limits do not cover them; disable competing launchers for a single team authority.`);
    }
  });
  // CLI-loaded teammates run session_start before other extensions install their editors.
  pi.on("resources_discover", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try { Object.assign(display, readDisplaySettings()); }
    catch (error) { Object.assign(display, defaultDisplaySettings); warn(String(error)); }
    disposeUI?.(); disposeUI = installTeamFooter(pi, ctx, host(ctx), display);
  });
  pi.on("session_shutdown", close);
  const switchGuard = () => {
    if (child || coordinator?.live().length || connection) {
      warn("Stop team members before switching/forking/traversing sessions (team_agent stop, or /teams stop)");
      return { cancel: true as const };
    }
  };
  pi.on("session_before_switch", switchGuard);
  pi.on("session_before_fork", switchGuard);
  pi.on("session_before_tree", switchGuard);
  // Pi 1.4.0 has no supported veto hook. Pi builds with the upstream hook use this typed compatibility cast.
  type BeforeExit = (event: { type: "session_before_exit" }, ctx: ExtensionContext) => Promise<{ cancel: true } | undefined>;
  // SAFETY: Pi's runtime stores arbitrary event names; only patched Pi emits this hook with the standard event/context signature.
  (pi.on as unknown as (event: "session_before_exit", handler: BeforeExit) => void)("session_before_exit", async (_event, ctx) => {
    const count = coordinator?.live().length ?? 0;
    if (!count) return;
    if (!ctx.hasUI || !await ctx.ui.confirm("Stop active team and exit?", `${count} live member(s), including idle members, will be stopped. Worktrees and native sessions are retained.`)) return { cancel: true };
  });
  if (child) pi.registerShortcut("ctrl+shift+left", {
    description: "Return to Main",
    handler: async ctx => { if (ctx.mode === "tui") await host(ctx).visit("root"); },
  });
  pi.registerCommand("teams", {
    description: "Team panel; /teams teammate <name-or-id>, config, back, stop, status, join, or leave",
    async getArgumentCompletions(prefix) {
      if (!prefix.includes(" ")) return teamsCompletions(prefix, []);
      if (!context) return null;
      try {
        const members = child || opening || connection ? (await handle("agent", { action: "list" }, context) as Pick<TeamSnapshot, "members">).members : [{ id: "root", status: "idle" as const }];
        return teamsCompletions(prefix, members);
      } catch { return null; }
    },
    async handler(args, ctx) {
      context = ctx;
      if (args.trim() === "config") {
        if (ctx.mode !== "tui") { ctx.ui.notify("/teams config requires an interactive terminal", "error"); return; }
        try { Object.assign(display, readDisplaySettings()); await showDisplayConfig(ctx, display); }
        catch (error) { ctx.ui.notify(cleanText(String(error)), "error"); }
        return;
      }
      if (args.trim() === "join" || args.trim() === "leave") {
        try { await (args.trim() === "join" ? joinTeam(ctx) : leaveTeam(ctx)); }
        catch (error) { ctx.ui.notify(cleanText(String(error instanceof Error ? error.message : error)), "error"); }
        return;
      }
      if (args.trim() === "stop") {
        if (child) throw new Error("A member can only stop its descendants using team_agent");
        await link(ctx);
        // Main sessions keep running; /teams stop stops members only.
        const { members } = await handle("agent", { action: "list" }, ctx) as Pick<TeamSnapshot, "members">;
        for (const member of members.filter(member => member.role === "member" && !member.parent && ["starting", "busy", "idle"].includes(member.status))) await handle("agent", { action: "stop", id: member.id }, ctx);
      }
      if (ctx.mode === "tui" && args.trim() !== "stop" && args.trim() !== "status") {
        if (!child) await link(ctx);
        const api = host(ctx);
        if (args.trim() === "back") await api.visit("root");
        else if (/^(teammate|open)\s+/.test(args.trim())) {
          const value = args.trim().replace(/^(teammate|open)\s+/, "");
          const members = (await api.snapshot()).members;
          const id = resolveTeammate(members, value);
          if (id) await api.visit(id);
          else ctx.ui.notify(`Unknown teammate: ${cleanText(value)}. Use autocomplete or /teams panel.`, "error");
        }
        else if (!args.trim() || args.trim() === "panel") await showTeamsPanel(ctx, api);
        else ctx.ui.notify("Usage: /teams [panel|teammate <name-or-id>|config|back|stop|status|join|leave]", "info");
      } else {
        const status = await handle("agent", { action: "list" }, ctx);
        ctx.ui.notify(JSON.stringify(status, null, 2), "info");
      }
    },
  });
}
