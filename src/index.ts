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
import { Coordinator, assistantEvent, taskRequestGuidance } from "./coordinator.ts";
import { Connection, isRecord } from "./connection.ts";
import { policy, readDisplaySettings, defaultDisplaySettings } from "./config.ts";

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
  const drafts = new Map<string, string>();
  const display = { ...defaultDisplaySettings };
  const self = environment[1] ?? "root";
  pi.registerMessageRenderer("ac-teams", renderTeamMessage);
  const warn = (message: string) => context?.ui.notify(message, "warning");
  const notify = (through: number, messages: Message[] = []) => {
    pi.sendMessage({ customType: "ac-teams", content: `New team messages through sequence ${through}. Read team_message history after your last cursor. Reply only with useful updates, not acknowledgements.`, display: true, details: { through, messages } }, { deliverAs: "followUp", triggerTurn: true });
    if (connection) void connection.request("ack", { through }).catch(error => warn(String(error)));
    else coordinator?.ack("root", through);
  };
  async function root(ctx: ExtensionContext): Promise<Coordinator> {
    if (exiting) throw new Error("Team is stopping");
    context = ctx;
    opening ??= Coordinator.open({
      id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile(),
      ...policy(ctx.cwd, pi.getFlag("teams-project-config") === true, { limit: pi.getFlag("teams-limit") as string | undefined, depth: pi.getFlag("teams-depth") as string | undefined }),
      extension: fileURLToPath(import.meta.url), notice: notify, warning: warn,
      status: (kind, active) => pi.events.emit(`herdr:${kind}`, { active, source: "ac-teams" }),
      interactive: ctx.mode === "tui", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel(),
    }).then(value => {
      coordinator = value;
      if (ctx.isIdle?.() === false) value.recordEvent("root", { type: "agent_start" });
      if (inputCount > 0) value.recordEvent("root", { type: "blocked", active: true });
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
    if (child) {
      if (!connection) throw new Error("Team coordinator is not connected");
      return connection.request(operation, args);
    }
    let authorized = false;
    if (operation === "agent" && (args as AgentArgs).action === "limits" && ((args as AgentArgs).limit ?? 0) > 10) {
      if (!ctx.hasUI || !await ctx.ui.confirm("Raise team ceiling?", `Allow up to ${(args as AgentArgs).limit} live Pi members, including idle members? This increases possible model costs.`)) throw new Error("Ceiling increase was not explicitly approved");
      authorized = true;
    }
    return (await root(ctx)).handle("root", operation, args, authorized);
  }
  async function snapshot(ctx: ExtensionContext): Promise<TeamSnapshot> {
    if (!child && !opening) return { members: [{ id: "root", cwd: ctx.cwd, depth: 0, status: ctx.isIdle() ? "idle" : "busy", notified: 0, needsInput: inputCount > 0 }], tasks: [], messages: [], limit: 10, depth: 2 };
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
      if (child) {
        if (!connection) throw new Error("Team coordinator is not connected");
        return await connection.request("ui", value) as string;
      }
      return await (await root(ctx)).handle("root", "ui", value) as string;
    };
    const api: PanelHost = {
      self, drafts, snapshot: () => snapshot(ctx),
      visit: async id => {
        if (id === self) return;
        const socket = child ? process.env.AC_TEAMS_TERMINAL_SOCKET : join((await root(ctx)).store.dir, "t.sock");
        if (!socket) throw new Error("This member has no live terminal transport");
        await visitMember(ctx, api, socket, id);
      },
      requestTask: text => userAction({ action: "task_request", text }),
      feedback: (task, text) => userAction({ action: "feedback", id: task.id, text }),
      resume: async id => { await userAction({ action: "resume", id }); },
    };
    return api;
  }
  function report(ctx: ExtensionContext, event: { type: string; text?: string; active?: boolean }) {
    if (exiting) return;
    if (child && ctx.mode === "tui") void connection?.request("event", event).catch(error => warn(cleanText(String(error))));
    else if (!child) coordinator?.recordEvent("root", event);
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
        if (child) await connection?.request("event", event);
        else coordinator?.recordEvent("root", event);
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
      if (child) void connection?.request("event", event).catch(error => warn(cleanText(String(error))));
      else coordinator?.recordEvent("root", event);
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
  pi.registerTool({
    name: "team_agent", label: "Team agent", description: "Launch/resume Pi members, list/status, stop owned subtrees, change root limits, and explicitly clean stopped worktrees.",
    promptGuidelines: [guidance, "Delegation needs the user's authorization. Give each new member a unique descriptive name (one or two lowercase words, hyphenated if two), plus a bounded brief. Names remain stable on resume. Avoid concurrent writers in the same cwd. Worktrees are opt-in."],
    parameters: AgentSchema,
    ...teamToolRenderers("team_agent"),
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("agent", args, ctx)); },
  });
  pi.registerTool({
    name: "team_task", label: "Team task", description: "Manage shared tasks: create/list/read/edit, claim a reservation, start work, complete, release ownership, or explicitly reopen. Progress is todo/in_progress/done; blockedBy is derived from unfinished dependencies. Mutations support revision checks.",
    promptGuidelines: [taskRequestGuidance, "Give every task a concise 1–3-word label, alongside its full title and acceptance criteria. Stable team-local numbers are assigned automatically; use UUIDs for API references. Interim and final goals are ordinary tasks. Add dependencies only for real prerequisites, never merely to connect the diagram.", "Claim reserves a to-do task even if blocked; start requires ownership and all dependencies done. Complete requires in-progress work and acceptance=true after checking the criteria. Release clears ownership, returns in-progress work to todo, and leaves done work done. Reopen is explicit and cannot invalidate active or done dependents."],
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
    coordinator = undefined; opening = undefined;
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!child && coordinator && coordinator.store.state.id !== ctx.sessionManager.getSessionId()) { await close(); drafts.clear(); }
    context = ctx; exiting = false; inputCount = 0;
    if (child) {
      if (environment.some(value => !value)) throw new Error("Incomplete AC_TEAMS membership environment; refusing independent-root fallback");
      connection = new Connection(environment[0]!, environment[1]!, environment[2]!);
      connection.on("notice", (through, messages) => notify(through, messages));
      connection.on("disconnect", () => { warn("Team coordinator disconnected; this member is shutting down"); ctx.abort(); ctx.shutdown(); });
      connection.on("command", (command: { id: string; command: string; args: Record<string, unknown> }) => {
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
          try { await connection?.request("control_result", { id: command.id, data, error }); }
          catch { return; }
          if (command.command === "shutdown" && !error) ctx.shutdown();
        })();
      });
      await connection.open();
      await connection.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted() });
    }
    if (ctx.mode === "tui") {
      try { Object.assign(display, readDisplaySettings()); }
      catch (error) { Object.assign(display, defaultDisplaySettings); warn(String(error)); }
      disposeUI?.(); disposeUI = installTeamFooter(pi, ctx, host(ctx), display);
    }
    startTelemetry(ctx);
    if (!warned) {
      warned = true;
      const competitors = pi.getAllTools().filter(tool => ["Agent", "SubagentWorkflow", "subagent"].includes(tool.name));
      if (competitors.length) warn(`Other delegation tools are active (${competitors.map(tool => tool.name).join(", ")}). ac-teams limits do not cover them; disable competing launchers for a single team authority.`);
    }
  });
  pi.on("session_shutdown", close);
  const switchGuard = () => {
    if (child || coordinator?.live().length) {
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
    description: "Team panel; /teams teammate <name-or-id>, config, back, stop, or status",
    async getArgumentCompletions(prefix) {
      if (!prefix.includes(" ")) return teamsCompletions(prefix, []);
      if (!context) return null;
      try {
        const members = child || opening ? (await handle("agent", { action: "list" }, context) as Pick<TeamSnapshot, "members">).members : [{ id: "root", status: "idle" as const }];
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
      if (args.trim() === "stop") {
        if (child) throw new Error("A member can only stop its descendants using team_agent");
        const team = await root(ctx);
        for (const member of [...team.live()].sort((a, b) => b.depth - a.depth)) await team.stopTree(member.id);
      }
      if (ctx.mode === "tui" && args.trim() !== "stop" && args.trim() !== "status") {
        if (!child) await root(ctx);
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
        else ctx.ui.notify("Usage: /teams [panel|teammate <name-or-id>|config|back|stop|status]", "info");
      } else {
        const status = await handle("agent", { action: "list" }, ctx);
        ctx.ui.notify(JSON.stringify(status, null, 2), "info");
      }
    },
  });
}
