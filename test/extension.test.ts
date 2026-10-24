import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import teams from "../src/index.ts";

// SAFETY: this bounded test double implements only the Pi host calls used by the extension.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "at-ext-"));
  const oldHome = process.env.HOME, oldPi = process.env.AC_TEAMS_PI;
  process.env.HOME = home;
  process.env.AC_TEAMS_PI = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const flags = new Map<string, unknown>();
  const warnings: string[] = [], messages: unknown[] = [];
  let approval = false, confirmations = 0;
  const api = {
    registerFlag() {}, registerCommand() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
    getFlag(name: string) { return flags.get(name); },
    getThinkingLevel() { return "low"; },
    getAllTools() { return [...tools.values(), { name: "Agent" }]; },
    sendMessage(message: unknown) { messages.push(message); },
  };
  // SAFETY: lifecycle and tool callbacks here only access the mocked context fields below.
  const ctx = { cwd: home, hasUI: true, model: { provider: "test", id: "model" }, tools: [], executeTool() { throw new Error("Unexpected nested tool"); },
    sessionManager: { getSessionId: () => id, getSessionFile: () => join(home, "root.jsonl") },
    ui: { notify(message: string) { warnings.push(message); }, async confirm() { confirmations++; return approval; } },
  } as unknown as ExtensionToolContext;
  const id = randomUUID();
  // SAFETY: all called host methods are provided above; registration captures the real callbacks.
  teams(api as unknown as ExtensionAPI);
  async function execute(name: string, args: unknown) {
    return (await tools.get(name)!.execute(randomUUID(), args, new AbortController().signal, undefined, ctx)).details;
  }
  return { ctx, flags, warnings, messages, execute, approve(value: boolean) { approval = value; }, get confirmations() { return confirmations; },
    async event(name: string) { return handlers.get(name)?.({ type: name }, ctx); },
    async close() {
      try { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); }
      finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldPi === undefined) delete process.env.AC_TEAMS_PI; else process.env.AC_TEAMS_PI = oldPi; rmSync(home, { recursive: true, force: true }); }
    },
  };
}

test("extension coexistence warns, tools inherit model, and native pre-exit cancellation preserves live members", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    assert.match(f.warnings[0], /do not cover/);
    assert.equal(await f.event("session_before_exit"), undefined);
    assert.equal(f.confirmations, 0);
    const member = await f.execute("team_agent", { action: "launch", brief: "WAIT" }) as { id: string };
    assert.equal(typeof member.id, "string");
    assert.deepEqual(await f.event("session_before_switch"), { cancel: true });
    assert.deepEqual(await f.event("session_before_fork"), { cancel: true });
    assert.deepEqual(await f.event("session_before_tree"), { cancel: true });
    assert.deepEqual(await f.event("session_before_exit"), { cancel: true });
    f.approve(true);
    assert.equal(await f.event("session_before_exit"), undefined);
    await f.execute("team_agent", { action: "stop", id: member.id });
    assert.equal(await f.event("session_before_switch"), undefined);
  } finally { await f.close(); }
});

test("raising the root ceiling requires explicit host confirmation", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    await assert.rejects(f.execute("team_agent", { action: "limits", limit: 11 }), /not explicitly approved/);
    f.approve(true);
    assert.deepEqual(await f.execute("team_agent", { action: "limits", limit: 11 }), { limit: 11, depth: 2 });
    assert.equal(f.confirmations, 2);
  } finally { await f.close(); }
});

test("tool wiring refuses malformed requests and preserves task acceptance checks", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    await assert.rejects(f.execute("team_agent", { action: "list", surprise: true }), /Invalid/);
    const task = await f.execute("team_task", { action: "create", title: "One", description: "Verify before completing" }) as { id: string };
    const reserved = await f.execute("team_task", { action: "claim", id: task.id }) as { status: string; blockedBy: string[] };
    assert.equal(reserved.status, "todo");
    assert.deepEqual(reserved.blockedBy, []);
    await assert.rejects(f.execute("team_task", { action: "complete", id: task.id, acceptance: true }), /in-progress/);
    await f.execute("team_task", { action: "start", id: task.id });
    await assert.rejects(f.execute("team_task", { action: "complete", id: task.id }), /acceptance/);
    const completed = await f.execute("team_task", { action: "complete", id: task.id, acceptance: true }) as { status: string };
    assert.equal(completed.status, "done");
    await f.execute("team_task", { action: "release", id: task.id });
    await assert.rejects(f.execute("team_task", { action: "claim", id: task.id }), /reopen/);
    const reopened = await f.execute("team_task", { action: "reopen", id: task.id }) as { status: string; owner?: string };
    assert.equal(reopened.status, "todo");
    assert.equal(reopened.owner, undefined);
    await f.execute("team_message", { action: "send", text: "persisted, with no recipients" });
    const history = await f.execute("team_message", { action: "history" }) as { text: string }[];
    assert.equal(history[0].text, "persisted, with no recipients");
  } finally { await f.close(); }
});
