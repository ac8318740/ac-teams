import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { AgentSchema, TaskSchema, MessageSchema, validate } from "./schemas.ts";
import type { AgentArgs, Operation } from "./types.ts";
import { Coordinator } from "./coordinator.ts";
import { Connection } from "./connection.ts";
import { policy } from "./config.ts";

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
  const warn = (message: string) => context?.ui.notify(message, "warning");
  const notify = (through: number) => {
    pi.sendMessage({ customType: "ac-teams", content: `New team messages through sequence ${through}. Read team_message history after your last cursor. Reply only with useful updates, not acknowledgements.`, display: true, details: { through } }, { deliverAs: "followUp", triggerTurn: true });
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
    }).then(value => { coordinator = value; return value; }, error => { opening = undefined; throw error; });
    return opening;
  }
  async function handle(operation: Exclude<Operation, "join" | "ack">, value: unknown, ctx: ExtensionContext): Promise<unknown> {
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
  function output(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data }; }
  const guidance = "Team launches use real long-lived Pi sessions. Idle members count against the shared ceiling. Use stable member/task IDs; query status and history instead of acknowledging notifications. Limits cover only ac-teams, not other launchers or shell commands.";
  pi.registerTool({
    name: "team_agent", label: "Team agent", description: "Launch/resume Pi members, list/status, stop owned subtrees, change root limits, and explicitly clean stopped worktrees.",
    promptGuidelines: [guidance, "Delegation needs the user's authorization. Give each member a bounded brief, and avoid concurrent writers in the same cwd. Worktrees are opt-in."],
    parameters: AgentSchema,
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("agent", args, ctx)); },
  });
  pi.registerTool({
    name: "team_task", label: "Team task", description: "Manage shared tasks: create/list/read/edit, claim a reservation, start work, complete, release ownership, or explicitly reopen. Progress is todo/in_progress/done; blockedBy is derived from unfinished dependencies. Mutations support revision checks.",
    promptGuidelines: ["Claim reserves a to-do task even if blocked; start requires ownership and all dependencies done. Complete requires in-progress work and acceptance=true after checking the criteria. Release clears ownership, returns in-progress work to todo, and leaves done work done. Reopen is explicit and cannot invalidate active or done dependents."],
    parameters: TaskSchema,
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("task", args, ctx)); },
  });
  pi.registerTool({
    name: "team_message", label: "Team message", description: "Send a persistent direct/team message or read cursor-paged history. New messages queue a compact follow-up notification for each recipient.",
    parameters: MessageSchema,
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("message", args, ctx)); },
  });
  async function close() {
    exiting = true;
    connection?.close(); connection = undefined;
    if (opening) await (await opening).close();
    coordinator = undefined; opening = undefined;
  }
  pi.on("session_start", async (_event, ctx) => {
    context = ctx; exiting = false;
    if (child) {
      if (environment.some(value => !value)) throw new Error("Incomplete AC_TEAMS membership environment; refusing independent-root fallback");
      connection = new Connection(environment[0]!, environment[1]!, environment[2]!);
      connection.on("notice", through => notify(through));
      connection.on("disconnect", () => { warn("Team coordinator disconnected; this member is shutting down"); ctx.shutdown(); });
      await connection.open();
      await connection.request("join", { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(tool => tool.name), trusted: ctx.isProjectTrusted() });
    }
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
  pi.registerCommand("teams", {
    description: "Team status, stop all members, or show native session/worktree locations",
    async handler(args, ctx) {
      context = ctx;
      if (args.trim() === "stop") {
        if (child) throw new Error("A member can only stop its descendants using team_agent");
        const team = await root(ctx);
        for (const member of [...team.live()].sort((a, b) => b.depth - a.depth)) await team.stopTree(member.id);
      }
      const status = await handle("agent", { action: "list" }, ctx);
      ctx.ui.notify(JSON.stringify(status, null, 2), "info");
    },
  });
}
