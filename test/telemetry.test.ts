import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTelemetry, modelContext } from "../src/telemetry.ts";
import { validate } from "../src/schemas.ts";

test("model and context labels use Pi's reported estimates and distinguish unknown from zero", () => {
  const ctx = { model: { provider: "anthropic", id: "claude-fixture", name: "Claude Opus 4.6" }, getContextUsage: () => ({ tokens: 48000, contextWindow: 200000, percent: 24 }) } as unknown as ExtensionContext;
  const event = readTelemetry(ctx);
  validate("event", event);
  assert.equal(event.model, "anthropic/claude-fixture");
  assert.equal(modelContext({ ...event, contextUsage: event.contextUsage! }), "Claude Opus 4.6 · 48k / 200k (24%)");
  assert.equal(modelContext({ model: "test/model" }), "model · context unknown");
  assert.equal(modelContext({}), "Model unknown · context unknown");
  assert.equal(modelContext({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } }), "Model unknown · context unknown / 200k");
  assert.equal(modelContext({ contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 } }), "Model unknown · 0 / 200k (0%)");
  for (const contextUsage of [{ tokens: -1, contextWindow: 200000, percent: 0 }, { tokens: 0, contextWindow: 0, percent: 0 }, { tokens: 0, contextWindow: 200000, percent: Infinity }]) assert.throws(() => validate("event", { ...event, contextUsage }), /Invalid/);
});
