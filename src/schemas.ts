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
  worktree: Type.Optional(Type.Boolean()), base: Type.Optional(id), target: Type.Optional(id),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
}, { additionalProperties: false });
export const TaskSchema = Type.Object({
  revision: Type.Optional(Type.Integer({ minimum: 1 })), acceptance: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  action: Type.Union(["create", "list", "read", "edit", "claim", "start", "release", "complete", "reopen"].map(v => Type.Literal(v))),
  id: Type.Optional(id), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: taskLabelMaxLength, pattern: taskLabelPattern.source, description: "A concise 1–3-word task label. Defaults to title only when title satisfies this limit." })),
  description: Type.Optional(Type.String({ maxLength: 16000 })),
  dependencies: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true })),
}, { additionalProperties: false });
export const MessageSchema = Type.Object({
  action: Type.Union(["send", "history", "search"].map(v => Type.Literal(v))),
  recipients: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })),
  text: Type.Optional(text), query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
const UserActionSchema = Type.Object({
  action: Type.Union([Type.Literal("task_request"), Type.Literal("feedback"), Type.Literal("resume")]),
  id: Type.Optional(id), text: Type.Optional(text),
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
  }
}
