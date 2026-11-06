import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentSchema, TaskSchema, MessageSchema } from "../team/requests.ts";
import type { TaskView, Message } from "../types.ts";
import { taskRequestGuidance } from "../team/coordinator.ts";
import { teamToolRenderers } from "../ui/render.ts";
import { configureWorker, WorkerConfigSchema } from "../ui/worker-config.ts";
import type { extensionInventory } from "../settings/worker-extensions.ts";
import type { TeamSession } from "./session.ts";

export function registerTools(pi: ExtensionAPI,
  session: Pick<TeamSession, "handle" | "memberLabels" | "memberId"> & { notices: Pick<TeamSession["notices"], "sent"> },
  parentInventory: () => ReturnType<typeof extensionInventory>) {
  const { handle, memberLabels, memberId } = session;
  function output(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data }; }
  const guidance = "Team launches use real long-lived Pi sessions. Idle members count against the shared ceiling and retain their processes and extensions. Check team_agent list resources before adding concurrency; teammate launch/resume results include pre-launch host headroom. Resource warnings are advisory, not a memory reservation or capacity guarantee. Choose concurrency using resource readings and observed progress, not low headroom alone. Use configured extension presets for scoped workers, with optional include/exclude IDs; choose broader presets only when the task needs them. Required coordination/safety/auth cannot be excluded. Every worker is limited to the actual parent-loaded set, including full and unconfigured launches. Include can only restore IDs from that parent; nested delegation cannot widen it. Run /teams config to configure lean presets. Missing presets fail rather than silently loading everything; resumes keep saved IDs and report installed-code changes. If contention slows progress, stop unneeded idle members and resume their saved sessions later. Use teammate names for messaging and stable IDs for member control and tasks; never acknowledge notifications. Limits cover only ac-teams, not other launchers or shell commands.";
  const taskTrackingGuidance = "Before delegating a deliverable through team_agent, create or reuse a team_task and pass it as the launch task; its owner's completion outcome reports back to you. Use one shared task list for your own work and delegated work; do not create one task per teammate by default. Quick lookups and brief second opinions need no separate task unless their results need coordination or follow-up.";
  const teamAgentTool = {
    name: "team_agent", label: "Team agent", description: "Launch/resume Pi members, list/status, stop owned subtrees, change root limits, and explicitly clean stopped worktrees. Create or reuse team_task entries for delegated deliverables; quick lookups need no task unless results need coordination or follow-up.",
    promptGuidelines: ["Prefer parallel execution for independent, meaningful work when it is likely to shorten completion time. Batch independent file reads and read-only checks in the same tool turn, including during review; serialize only when a result determines the next call. Establish shared interfaces and launch independent work early rather than implementing it yourself first. The lead may orchestrate, implement, or combine both, whichever gets to a correct, maintainable, verified result fastest. Give each implementer a coherent outcome, including tests. Avoid duplicate work and unnecessary handoffs; do not split planning, implementation, and testing into mandatory separate roles. Keep small or tightly coupled tasks solo. Fresh scrutiny or context isolation can also justify delegation. Preserve project-required checks and independent review.", guidance, taskTrackingGuidance, "Analysis defaults to auto: request existing pi-lens same-workspace reuse, possibly from sessions outside this team. If pi-lens is absent or disabled, launch proceeds without enabling it. Explicit environment opt-outs win; restricted members stay separate. Choose analysis: separate for different environments or rules, uncertain compatibility, suspicious diagnostics, or independent analyzer state. Different assignments alone do not require separation. This is a launch/resume preference, not proof of attachment or compatibility; an existing leader participates only if warm attach was already enabled there.", "You may delegate within the user's approved task unless the user restricts delegation. This does not expand filesystem, network, spending, or publishing permissions. Give each new member a unique descriptive name (one or two lowercase words, hyphenated if two), plus a bounded brief. Names remain stable on resume. Avoid concurrent writers in the same cwd. Worktrees are opt-in."],
    parameters: AgentSchema,
    ...teamToolRenderers("team_agent", memberLabels, memberId),
    async execute(_id, args, _signal, _update, ctx) { return output(await handle("agent", args, ctx)); },
  } satisfies ToolDefinition<typeof AgentSchema>;
  pi.registerTool(teamAgentTool);
  pi.registerTool({
    name: "team_config", label: "Team configuration", description: "Read worker extension inventory and policy, or save a user-approved policy. Ask preferences in conversation first; never ask the user to edit configuration files. Save validates the policy and requests final confirmation without starting a team.",
    parameters: WorkerConfigSchema,
    async execute(_id, args, _signal, _update, ctx) {
      return output(await configureWorker(ctx, pi.getFlag("teams-project-config") === true, parentInventory, args));
    },
  });
  pi.registerTool({
    name: "team_task", label: "Team task", description: "Plan and track multi-step solo and team work in one shared list. Create one task or a batch with tasks:[{title,...}], list compact summaries, read full details, edit, claim a reservation, start, complete, release, or reopen. Start atomically claims unowned ready work. Progress is todo/in_progress/done; blockedBy is derived from unfinished dependencies. Mutations support revision checks.",
    promptSnippet: "Plan and track multi-step work, alone or with teammates",
    promptGuidelines: [
      "Use team_task before substantial work with 3+ steps, when the user gives an explicit task list, or when coordinating deliverables. This includes your own research, design, implementation, and verification; no teammate is required. Skip single trivial tasks, conversation, and tool-by-tool bookkeeping.",
      "Before creating team_task entries, identify the outputs each task needs from other tasks. If it cannot start correctly without another task's verified output, record that prerequisite in dependencies (UUID or @key within a create batch). Consider shared contracts/setup before consumers, implementation before integration verification, and multiple outputs before final assembly. Keep independent work parallel; never add edges just to make a graph. Reassess dependencies when scope changes.",
      "Create connected team_task plans atomically with batch keys: tasks:[{key:'worker',title:'Worker'},{title:'Bridge',dependencies:['@worker']}]. Dependencies accept existing UUIDs and @key references to any entry in this batch, including later entries. Include every required prerequisite; all prerequisites must be done before start. Before starting or delegating, check that the recorded dependencies match the outputs each task needs; creating tasks together does not make them independent. Keys are batch-only; use returned UUIDs in later calls. Titles are required; labels and descriptions default from titles. Include acceptance criteria for substantial or delegated work. Reuse relevant existing tasks rather than duplicating them.",
      "Call team_task start BEFORE beginning a task; it claims unowned ready work atomically. Use claim only to reserve work in advance, including blocked work. Complete each task IMMEDIATELY when its own acceptance checks pass with acceptance=true; separately assigned review gates parent integration, not child completion, unless its acceptance criteria require it. Never complete partial work or work with unresolved failures. Report blockers. Each agent should normally work on one task at a time; teammates can work in parallel.",
      taskTrackingGuidance, taskRequestGuidance,
      "team_task list returns compact summaries; read a task for its full description and acceptance criteria. Use returned UUIDs for API references and stable task numbers/names when reporting to people. Add dependencies only for real prerequisites, never merely to connect the diagram.",
      "team_task start refuses another owner's task or unfinished dependencies. Complete requires ownership, in-progress work, and acceptance=true. Release clears ownership, returns in-progress work to todo, and leaves done work done. Reopen is explicit and cannot invalidate active or done dependents.",
    ],
    parameters: TaskSchema,
    ...teamToolRenderers("team_task", memberLabels, memberId),
    async execute(_id, args, _signal, _update, ctx) {
      const data = await handle("task", args, ctx) as TaskView | { tasks: TaskView[]; total: number };
      const compact = (task: TaskView) => ({ id: task.id, number: task.number, label: task.label, title: task.title, status: task.status, owner: task.owner, revision: task.revision, dependencies: task.dependencies, blockedBy: task.blockedBy });
      const content = args.action === "read" ? data : "tasks" in data ? { tasks: data.tasks.map(compact), total: data.total } : compact(data);
      return { content: [{ type: "text" as const, text: JSON.stringify(content) }], details: data };
    },
  });
  pi.registerTool({
    name: "team_message", label: "Team message", description: "Post to the team board, read history or search, watch tasks, or pause. A post has a required one-line summary that stands alone, optional detail, and links an existing task or replies to a post. It reaches named recipients (teammate names or IDs) plus the linked task's owner and delegator; it is never broadcast. Recipients receive summaries at their next safe point. Watch registers persistent one-shot task notifications without pausing (completion by default); unwatch cancels them. Wait pauses this turn; unrelated messages do not cancel watches.",
    promptGuidelines: ["Post only what changes someone's work: an outcome, a blocker, a question, or new context. Task state already records ownership and start; do not announce them or acknowledge notices. team_task complete publishes the outcome; do not send it again.", "Write readable summaries with normal spacing. Put the decision, required action, and critical caveats in the summary; supporting evidence belongs in detail or a referenced artifact.", "Notices carry summaries. History/search return summaries by default; use seq from a notice with includeDetail=true only for evidence your work needs, or task to narrow a relevant discussion. Do not fetch the whole board to catch up on notices.", "After delegating, do not repeat the delegated work. Do distinct work, or call team_message wait as your last action to pause; never poll history. Completion already notifies the task's delegator. Use watch only for additional task notifications (event completed or message); they survive unrelated turns until triggered and delivered or cancelled with unwatch. Register once, not after each message. Wait optionally registers next-message watches for tasks; omit tasks to pause without changing existing watches."],
    parameters: MessageSchema,
    ...teamToolRenderers("team_message", memberLabels, memberId),
    async execute(_id, args, _signal, _update, ctx) {
      // Posts already shown in a notice are not news to this wait.
      const result = await handle("message", args.action === "wait" && args.after === undefined ? { ...args, after: session.notices.sent } : args, ctx);
      // Nothing ready: end the turn without another model request; the next matching notice starts a new one.
      if (args.action === "wait") return { ...output(result), terminate: (result as Message[]).length === 0 };
      if (args.action === "watch" || args.action === "unwatch") return output(result);
      if (args.action === "send") {
        const { seq, id, recipients } = result as Message;
        return output({ seq, id, recipients });
      }
      const content = args.includeDetail ? result : (result as Message[]).map(({ detail, ...message }) => ({ ...message, hasDetail: !!detail }));
      return { content: [{ type: "text" as const, text: JSON.stringify(content) }], details: result };
    },
  });
  return teamAgentTool;
}
