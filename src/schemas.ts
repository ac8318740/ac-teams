import { Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
export const AgentSchema = Type.Object({
  action: Type.Union(["launch", "list", "status", "stop", "resume", "limits", "cleanup"].map(v => Type.Literal(v))),
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
  description: Type.Optional(Type.String({ maxLength: 16000 })),
  dependencies: Type.Optional(Type.Array(id, { maxItems: 100, uniqueItems: true })),
}, { additionalProperties: false });
export const MessageSchema = Type.Object({
  action: Type.Union(["send", "history", "search"].map(v => Type.Literal(v))),
  recipients: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })),
  text: Type.Optional(text), query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export function validate(operation: string, value: unknown): void {
  const schema = operation === "agent" ? AgentSchema : operation === "task" ? TaskSchema : operation === "message" ? MessageSchema : undefined;
  if (!schema || !Value.Check(schema, value)) throw new Error(`Invalid ${operation} request`);
}
