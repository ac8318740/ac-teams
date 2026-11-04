import { Type } from "typebox";
import { Value } from "typebox/value";
import { taskLabelMaxLength, taskLabelPattern, memberNameMaxLength, memberNamePattern } from "./types.ts";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
export const AgentSchema = Type.Object({
  action: Type.Union(["launch", "list", "status", "stop", "resume", "limits", "cleanup"].map(v => Type.Literal(v))),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: memberNameMaxLength, pattern: memberNamePattern.source, description: "Required on launch: a unique descriptive one- or two-word lowercase name, e.g. parser or code-review. Retained on resume." })),
  id: Type.Optional(id), brief: Type.Optional(text), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh"].map(v => Type.Literal(v)))),
  analysis: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("separate")], { description: "Launch/resume only: auto (default) requests existing pi-lens same-workspace reuse, possibly outside this team; explicit environment opt-outs win. Choose separate for different environments or rules, uncertain compatibility, or independent analyzer state. Does not disable checks or guarantee attachment. Resume keeps the saved preference unless overridden; restricted members always use separate analysis." })),
  worktree: Type.Optional(Type.Boolean()), base: Type.Optional(id), target: Type.Optional(id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Launch only: an existing to-do task the new member owns, with you as its delegator. Its activity reaches you; include its goal in the brief." })),
  access: Type.Optional(Type.Object({
    read: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
    write: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
    network: Type.Optional(Type.Object({
      allow: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 260 }), { maxItems: 64, description: "Hosts the member may reach through its proxy: host or *.host (subdomains), optionally :port; without a port, 80 and 443. [] allows only the model provider. Omit allow for any public destination." })),
    }, { additionalProperties: false, description: "Omit to keep the requester's network access. Children can only narrow it. The model provider stays reachable." })),
  }, { additionalProperties: false, description: "Launch only: OS-enforced directory access (Docker container). Paths are absolute or cwd-relative directories; write implies read and permits changing those live files; everything else on the host is hidden, and outbound access goes through a proxy that reaches only public addresses. Omit to inherit the requesting member's access; an unsandboxed requester then launches an unsandboxed member. Children can only narrow access. Launch fails if enforcement is unavailable; check team_agent list/limits sandbox first." })),
}, { additionalProperties: false });
const taskFields = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: taskLabelMaxLength, pattern: taskLabelPattern.source, description: "Optional 1–3-word label. Derived from title when omitted." })),
  description: Type.Optional(Type.String({ maxLength: 16000, description: "Details and acceptance criteria. Defaults to title; include explicit criteria for substantial or delegated work." })),
  dependencies: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true, description: "Existing prerequisite task UUIDs whose verified outputs this task needs before it can start; all must be done. Include multiple prerequisites when needed; leave empty for independent work. blockedBy is derived automatically." })),
};
export const TaskSchema = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1 })), acceptance: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  action: Type.Union(["create", "list", "read", "edit", "claim", "start", "release", "complete", "reopen"].map(v => Type.Literal(v))),
  id: Type.Optional(id), ...taskFields,
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 16000, description: "Complete: brief outcome, required action, and critical caveats, published atomically with done and delivered in notices. Put supporting evidence, file references, and check-by-check results in detail." })),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 16000, description: "Complete: optional supporting evidence, checks run, file references, and fuller limitations, read on demand." })),
  tasks: Type.Optional(Type.Array(Type.Object({ ...taskFields, title: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 100, description: "Create several tasks atomically. Use instead of top-level task fields. Dependencies must refer to existing task IDs, not items in this batch." })),
}, { additionalProperties: false });
export const MessageSchema = Type.Object({
  action: Type.Union(["send", "history", "search", "wait"].map(v => Type.Literal(v))),
  tasks: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true, description: "Wait: also wake on posts linked to these tasks, e.g. ones you delegated." })),
  recipients: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true, description: "Exact teammate names or member IDs." })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 16000, description: "Send: brief outcome, question, or update, with any required action and critical caveats, delivered directly to recipients. Put supporting evidence, file references, and check-by-check results in detail." })),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 16000, description: "Send: optional supporting evidence, checks run, file references, and fuller limitations, read only when needed." })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Send: link an existing task; its owner and delegator receive the post." })),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Send: the post ID this answers; its author receives the reply and it stays on that post's task." })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
const UserActionSchema = Type.Object({
  action: Type.Union([Type.Literal("task_request"), Type.Literal("feedback"), Type.Literal("resume"), Type.Literal("promote"), Type.Literal("leave")]),
  id: Type.Optional(id), text: Type.Optional(text), confirmed: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  thinking: AgentSchema.properties.thinking,
}, { additionalProperties: false });
const ContextUsageSchema = Type.Object({
  tokens: Type.Union([Type.Null(), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })]),
  contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  percent: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
}, { additionalProperties: false });
const EventSchema = Type.Union([Type.Object({
  type: Type.Literal("blocked"), active: Type.Boolean(),
}, { additionalProperties: false }), Type.Object({
  type: Type.Union(["agent_start", "agent_settled", "activity", "summary", "model_error", "telemetry"].map(v => Type.Literal(v))),
  text: Type.Optional(Type.String({ maxLength: 2000 })),
  model: Type.Optional(Type.String({ maxLength: 256 })),
  modelName: Type.Optional(Type.String({ maxLength: 256 })),
  contextUsage: Type.Optional(Type.Union([Type.Null(), ContextUsageSchema])),
}, { additionalProperties: false })]);
export function validate(operation: string, value: unknown): void {
  const schema = operation === "agent" ? AgentSchema : operation === "task" ? TaskSchema : operation === "message" ? MessageSchema : operation === "ui" ? UserActionSchema : operation === "event" ? EventSchema : undefined;
  if (!schema || !Value.Check(schema, value)) throw new Error(`Invalid ${operation} request`);
  if (operation === "agent") {
    const args = value as { action: string; name?: string };
    if (args.action === "launch" && !args.name) throw new Error("A descriptive teammate name is required on launch");
    if (args.action !== "launch" && args.name !== undefined) throw new Error("A teammate name can only be set on launch");
    if (args.action !== "launch" && args.action !== "resume" && (value as { analysis?: unknown }).analysis !== undefined) throw new Error("Analysis can only be set on launch or resume");
    if (args.action !== "launch" && (value as { task?: unknown }).task !== undefined) throw new Error("A task can only be assigned on launch");
    if (args.action !== "launch" && (value as { access?: unknown }).access !== undefined) throw new Error("Access can only be set on launch; resume keeps the member's access");
  }
}
