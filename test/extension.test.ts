import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { initTheme, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { cleanText } from "../src/render.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import teams from "../src/index.ts";
import { taskRequestGuidance } from "../src/coordinator.ts";
import { Store, teamsHome } from "../src/store.ts";
import { teamEntryType } from "../src/mains.ts";

// SAFETY: this bounded test double implements only the Pi host calls used by the extension.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "at-ext-"));
  const oldHome = process.env.HOME, oldPi = process.env.AC_TEAMS_PI;
  process.env.HOME = home;
  process.env.AC_TEAMS_PI = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionToolContext): Promise<void> }>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const flags = new Map<string, unknown>();
  const warnings: string[] = [], messages: unknown[] = [];
  let approval = false, confirmations = 0;
  const events = new EventEmitter();
  const entries: { type: string; id: string; customType: string; data: unknown }[] = [];
  let active = ["team_agent", "team_task", "team_message"];
  const api = {
    events,
    registerFlag() {}, registerCommand(name: string, command: { handler(args: string, ctx: ExtensionToolContext): Promise<void> }) { commands.set(name, command); }, registerMessageRenderer() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
    getFlag(name: string) { return flags.get(name); },
    getThinkingLevel() { return "low"; },
    getAllTools() { return [...tools.values(), { name: "Agent" }]; },
    sendMessage(message: unknown) { messages.push(message); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: randomUUID(), customType, data }); },
    getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
  };
  // SAFETY: lifecycle and tool callbacks here only access the mocked context fields below.
  const ctx = { cwd: home, mode: "rpc", hasUI: true, model: { provider: "test", id: "model" }, tools: [], executeTool() { throw new Error("Unexpected nested tool"); },
    getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => id, getSessionFile: () => join(home, "root.jsonl"), getSessionDir: () => home, getEntries: () => entries },
    ui: { notify(message: string) { warnings.push(message); }, async confirm() { confirmations++; return approval; }, async select(_title: string, options: string[]) { return options[0]; } },
  } as unknown as ExtensionToolContext;
  const id = randomUUID();
  // SAFETY: all called host methods are provided above; registration captures the real callbacks.
  teams(api as unknown as ExtensionAPI);
  async function execute(name: string, args: unknown) {
    return (await tools.get(name)!.execute(randomUUID(), args, new AbortController().signal, undefined, ctx)).details;
  }
  return { ctx, id, home, entries, get active() { return active; }, flags, warnings, messages, tools, commands, execute, events, approve(value: boolean) { approval = value; }, get confirmations() { return confirmations; },
    async event(name: string) { return handlers.get(name)?.({ type: name }, ctx); },
    async close() {
      try { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); }
      finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldPi === undefined) delete process.env.AC_TEAMS_PI; else process.env.AC_TEAMS_PI = oldPi; rmSync(home, { recursive: true, force: true }); }
    },
  };
}

test("team navigation wraps editors installed by later session_start handlers", async () => {
  const f = fixture();
  type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  const inputs: string[] = [];
  const editor = {
    focused: true, getText: () => "", setText() {},
    handleInput(input: string) { inputs.push(input); },
    render: () => ["inline slash editor"], invalidate() {},
  };
  const previous: Factory = () => editor;
  let active: Factory | undefined;
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    getEditorComponent: () => active,
    setEditorComponent(factory: Factory | undefined) { active = factory; },
    setWidget() {}, setStatus() {},
  });
  try {
    await f.event("session_start");
    // CLI-loaded ac-teams runs before the installed inline slash editor in teammates.
    active = previous;
    await f.event("resources_discover");
    assert.notEqual(active, previous, "install navigation after all startup editors");
    // SAFETY: the predecessor factory ignores the TUI, theme, and keybindings arguments.
    const args = [{ requestRender() {} }, {}, {}] as unknown as Parameters<Factory>;
    const current = active!(...args);
    assert.equal(current, editor, "preserve the later editor and its input handling");
    current.handleInput("/");
    assert.deepEqual(inputs, ["/"]);
    current.handleInput("\x1b[B");
    assert.equal(editor.focused, false, "Down enters the agent selector");
    current.handleInput("\x1b[A");
    assert.equal(editor.focused, true, "Up returns to the prompt");
    await f.event("session_shutdown");
    assert.equal(active, previous, "shutdown restores the other extension's editor");
  } finally { await f.close(); }
});

test("footer snapshots omit history while the panel still loads messages and complete tasks", async t => {
  const f = fixture();
  const message = t.mock.method(Store.prototype, "message");
  const statuses: string[] = [];
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    setWidget() {}, setStatus(_key: string, value: string) { statuses.push(value); },
    getEditorComponent() { return undefined; }, setEditorComponent() {},
    async custom() {},
  });
  try {
    await f.event("session_start");
    await f.execute("team_task", { action: "create", title: "Keep full tasks", description: "Acceptance criteria" });
    await f.execute("team_message", { action: "send", recipients: ["root"], summary: "Keep this message" });
    const before = message.mock.calls.length;
    await f.event("resources_discover");
    const end = Date.now() + 2000;
    while (!statuses.length) { assert.ok(Date.now() < end); await delay(5); }
    assert.match(statuses.at(-1)!, /0\/1 tasks done/);
    assert.equal(message.mock.calls.length, before, "footer snapshot must not read history");
    await f.commands.get("teams")!.handler("panel", f.ctx);
    assert.equal(message.mock.calls.length, before + 1);
    assert.equal(message.mock.calls.at(-1)!.arguments[1].action, "history");
    assert.equal((message.mock.calls.at(-1)!.result as { summary: string }[])[0].summary, "Keep this message");
  } finally { await f.close(); }
});

test("Main's question marker follows balanced attention signals without counting teammate relays twice", async () => {
  const f = fixture();
  const root = async () => (await f.execute("team_agent", { action: "list" }) as { members: { id: string; needsInput?: boolean }[] }).members.find(member => member.id === "root")!;
  try {
    await f.event("session_start");
    f.events.emit("herdr:blocked", { active: true });
    assert.equal((await root()).needsInput, true, "question opened before the team coordinator");
    f.events.emit("herdr:blocked", { active: true });
    f.events.emit("herdr:blocked", { active: false });
    assert.equal((await root()).needsInput, true);
    f.events.emit("herdr:blocked", { active: true, source: "ac-teams" });
    f.events.emit("herdr:blocked", { active: false });
    assert.equal((await root()).needsInput, undefined, "answer/cancel clears Main's marker despite a teammate relay");
    f.events.emit("herdr:blocked", { active: true });
    await f.event("agent_settled");
    assert.equal((await root()).needsInput, undefined);
  } finally { await f.close(); }
});

test("extension coexistence warns, tools inherit model, and native pre-exit cancellation preserves live members", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    assert.match(f.warnings[0], /do not cover/);
    assert.equal(await f.event("session_before_exit"), undefined);
    assert.equal(f.confirmations, 0);
    const member = await f.execute("team_agent", { action: "launch", name: "parser", brief: "WAIT" }) as { id: string };
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

test("display configuration rejects headless use without opening a team", async () => {
  const f = fixture();
  try {
    await f.commands.get("teams")!.handler("config", f.ctx);
    assert.match(f.warnings[0], /requires an interactive terminal/);
    assert.equal(existsSync(join(f.ctx.cwd, ".pi", "ac-teams", "teams")), false);
  } finally { await f.close(); }
});

test("context telemetry refreshes, skips unchanged writes, and stops on shutdown", async () => {
  const f = fixture();
  let reads = 0, tokens = 100;
  f.ctx.getContextUsage = () => { reads++; return { tokens, contextWindow: 200000, percent: tokens / 2000 }; };
  const rootMember = async () => (await f.execute("team_agent", { action: "list" }) as { members: { id: string; contextUsage?: { tokens: number | null } }[] }).members.find(member => member.id === "root")!;
  const waitTokens = async (expected: number) => {
    for (let i = 0; i < 35; i++) { if ((await rootMember()).contextUsage?.tokens === expected) return; await delay(100); }
    assert.fail(`Telemetry did not publish ${expected} tokens`);
  };
  try {
    await f.event("session_start");
    await rootMember();
    await waitTokens(100);
    const path = join(f.ctx.cwd, ".pi", "ac-teams", "teams", f.ctx.sessionManager.getSessionId(), "state.json");
    const modified = statSync(path).mtimeMs;
    await delay(1200);
    assert.equal(statSync(path).mtimeMs, modified, "unchanged metrics must not rewrite state");
    tokens = 48000;
    await waitTokens(tokens);
    await f.event("session_shutdown");
    const stoppedReads = reads;
    await delay(1200);
    assert.equal(reads, stoppedReads, "shutdown must clear the reporting timer");
  } finally { await f.close(); }
});

test("raising the root ceiling requires explicit host confirmation", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    await assert.rejects(f.execute("team_agent", { action: "limits", limit: 11 }), /not explicitly approved/);
    f.approve(true);
    const { sandbox, resources, ...limits } = await f.execute("team_agent", { action: "limits", limit: 11 }) as { sandbox: { backend: string }; resources: { scope: string } };
    assert.deepEqual(limits, { limit: 11, depth: 2 });
    assert.equal(resources.scope, "host");
    assert.equal(sandbox.backend, "docker");
    assert.equal(f.confirmations, 2);
  } finally { await f.close(); }
});

test("team tools guide solo planning and task-backed delegation without tracking every action", async () => {
  const f = fixture();
  try {
    for (const name of ["team_agent", "team_task"]) {
      const tool = f.tools.get(name)!;
      const guidelines = tool.promptGuidelines!.join(" ");
      assert.match(guidelines, /Before delegating a deliverable through team_agent, create or reuse a team_task/);
      assert.match(guidelines, /pass it as the launch task/);
      assert.match(guidelines, /not create one task per teammate/);
    }
    const agentGuidance = f.tools.get("team_agent")!.promptGuidelines!.join(" ");
    assert.match(agentGuidance, /Check team_agent list resources before adding concurrency/);
    assert.match(agentGuidance, /advisory, not a memory reservation or capacity guarantee/);
    assert.match(agentGuidance, /If contention slows progress, stop unneeded idle members and resume their saved sessions/);
    assert.doesNotMatch(agentGuidance, /Sequence launches/);
    assert.match(agentGuidance, /Analysis defaults to auto/);
    assert.match(agentGuidance, /Choose analysis: separate.*uncertain compatibility/);
    assert.match(agentGuidance, /possibly from sessions outside this team/);
    assert.match(agentGuidance, /not proof of attachment or compatibility/);
    const task = f.tools.get("team_task")!;
    assert.match(task.promptSnippet!, /multi-step/);
    assert.match(task.description, /solo and team/);
    assert.match(task.promptGuidelines!.join(" "), /3\+ steps/);
    assert.match(task.promptGuidelines!.join(" "), /trivial/);
    assert.ok(task.promptGuidelines!.includes(taskRequestGuidance));
  } finally { await f.close(); }
});

test("task batches and lists keep model output compact while read and details retain full records", async () => {
  const f = fixture();
  const call = (args: unknown) => f.tools.get("team_task")!.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
  try {
    const result = await call({ action: "create", tasks: [{ title: "Inspect existing implementation", description: "Acceptance: " + "evidence ".repeat(1000) }, { title: "Run checks" }] });
    const batch = result.details as { tasks: { id: string; description: string }[] };
    const text = (value: typeof result) => value.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.equal(batch.tasks.length, 2);
    assert.ok(text(result).length < 1500);
    assert.ok(!text(result).includes("evidence"));
    const list = await call({ action: "list" });
    assert.ok(text(list).includes(batch.tasks[0].id));
    assert.ok(!text(list).includes("evidence"));
    const read = await call({ action: "read", id: batch.tasks[0].id });
    assert.ok(text(read).includes(batch.tasks[0].description));
    await call({ action: "start", id: batch.tasks[0].id });
    await assert.rejects(call({ action: "complete", id: batch.tasks[0].id }), /acceptance/);
    await call({ action: "complete", id: batch.tasks[0].id, acceptance: true, summary: "Inspected" });
    await assert.rejects(call({ action: "list", tasks: [{ title: "Wrong action" }] }), /create/);
  } finally { await f.close(); }
});

test("message sends return receipts while history and search preserve the full message", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    const tool = f.tools.get("team_message")!;
    const sent = await tool.execute(randomUUID(), { action: "send", recipients: ["root"], summary: "unique message body", detail: "supporting detail" }, new AbortController().signal, undefined, f.ctx);
    const receipt = sent.details as { seq: number; id: string; recipients: string[] };
    assert.deepEqual(Object.keys(receipt).sort(), ["id", "recipients", "seq"]);
    assert.equal(receipt.seq, 1);
    assert.equal(typeof receipt.id, "string");
    assert.deepEqual(receipt.recipients, []);
    assert.deepEqual(sent.content, [{ type: "text", text: JSON.stringify(receipt) }]);
    assert.match(tool.promptGuidelines!.join(" "), /never poll history/);
    const history = await f.execute("team_message", { action: "history" }) as { seq: number; id: string; summary: string; detail: string; from: string; time: string }[];
    assert.equal(history[0].id, receipt.id);
    assert.equal(history[0].seq, receipt.seq);
    assert.equal(history[0].summary, "unique message body");
    assert.equal(history[0].detail, "supporting detail");
    assert.equal(typeof history[0].from, "string");
    assert.equal(typeof history[0].time, "string");
    assert.deepEqual(await f.execute("team_message", { action: "search", query: "unique message" }), history);
    assert.deepEqual(await f.execute("team_message", { action: "search", query: "supporting" }), history, "search covers detail");
    await assert.rejects(f.execute("team_message", { action: "send", summary: "to nobody" }), /never broadcast/);
    assert.deepEqual(await f.execute("team_message", { action: "history", after: receipt.seq, limit: 10 }), []);
  } finally { await f.close(); }
});

test("message tool accepts aliases and renders resolved recipients by name", async () => {
  const f = fixture();
  try {
    initTheme("dark", false);
    await f.event("session_start");
    const member = await f.execute("team_agent", { action: "launch", name: "oom-review", brief: "WAIT" }) as { id: string };
    const tool = f.tools.get("team_message")!;
    const args = { action: "send", recipients: ["oom-review"], summary: "Please review" };
    const sent = await tool.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
    assert.deepEqual((sent.details as { recipients: string[] }).recipients, [member.id]);
    const context = { args, outputPad: 0, isError: false } as Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
    const compact = tool.renderResult!(sent, { expanded: false, isPartial: false }, theme, context).render(1000).map(cleanText).join("\n");
    assert.match(compact, /to oom-review/);
    assert.ok(!compact.includes(member.id));
    assert.ok(!compact.includes((sent.details as { id: string }).id));
    await assert.rejects(f.execute("team_message", { ...args, recipients: ["oom-review", member.id] }), /Recipients/);
  } finally { await f.close(); }
});

test("tool wiring refuses malformed requests and preserves task acceptance checks", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    await assert.rejects(f.execute("team_agent", { action: "list", surprise: true }), /Invalid/);
    for (const label of ["", "one two three four", "bad\nlabel", "x".repeat(61)]) {
      await assert.rejects(f.execute("team_task", { action: "create", title: "One", label, description: "Do it" }), /Invalid/);
    }
    await assert.rejects(f.execute("team_task", { action: "create", number: 42, title: "One", description: "Do it" }), /Invalid/);
    const task = await f.execute("team_task", { action: "create", title: "Verify parser behavior in full", label: "Parser tests", description: "Verify before completing" }) as { id: string; number: number; label: string };
    assert.equal(task.number, 1);
    assert.equal(task.label, "Parser tests");
    const reserved = await f.execute("team_task", { action: "claim", id: task.id }) as { status: string; blockedBy: string[] };
    assert.equal(reserved.status, "todo");
    assert.deepEqual(reserved.blockedBy, []);
    await assert.rejects(f.execute("team_task", { action: "complete", id: task.id, acceptance: true }), /in-progress/);
    await f.execute("team_task", { action: "start", id: task.id });
    await assert.rejects(f.execute("team_task", { action: "complete", id: task.id }), /acceptance/);
    await assert.rejects(f.execute("team_task", { action: "complete", id: task.id, acceptance: true }), /outcome summary/);
    const completed = await f.execute("team_task", { action: "complete", id: task.id, acceptance: true, summary: "Parser verified" }) as { status: string };
    assert.equal(completed.status, "done");
    await f.execute("team_task", { action: "release", id: task.id });
    await assert.rejects(f.execute("team_task", { action: "claim", id: task.id }), /reopen/);
    const reopened = await f.execute("team_task", { action: "reopen", id: task.id }) as { status: string; owner?: string };
    assert.equal(reopened.status, "todo");
    assert.equal(reopened.owner, undefined);
    const history = await f.execute("team_message", { action: "history" }) as { summary: string; task: string }[];
    assert.equal(history[0].summary, "Parser verified");
    assert.equal(history[0].task, task.id);
  } finally { await f.close(); }
});

/** Writes a team where this session is the main session "second", beside the creator and one stopped member. */
function seedTeam(f: ReturnType<typeof fixture>, sessionId = f.id) {
  const team = randomUUID();
  const store = new Store({ version: 5, id: team, key: randomUUID(), limit: 10, depth: 2, tasks: {}, messages: [], members: {
    root: { id: "root", role: "main", depth: 0, token: "a", cwd: f.home, status: "stopped", notified: 0, sessionId: randomUUID() },
    second: { id: "second", name: "main-2", role: "main", depth: 0, token: "b", cwd: f.home, status: "stopped", notified: 0, sessionId },
    w1: { id: "w1", name: "worker", role: "member", parent: "root", depth: 1, token: "c", cwd: f.home, status: "stopped", notified: 0 },
  } }, teamsHome());
  store.close();
  return team;
}

test("a resumed main session with no coordinator offers takeover; declining turns team tools off", async () => {
  const f = fixture();
  try {
    const team = seedTeam(f);
    f.entries.push({ type: "custom", id: "e1", customType: teamEntryType, data: { team, member: "second" } });
    f.approve(false);
    await f.event("session_start");
    assert.equal(f.confirmations, 1);
    assert.deepEqual(f.active, []);
    await assert.rejects(f.execute("team_agent", { action: "list" }), /declined to run the team coordinator/);
  } finally { await f.close(); }
});

test("accepting takeover runs the coordinator as that main session", async () => {
  const f = fixture();
  try {
    const team = seedTeam(f);
    f.entries.push({ type: "custom", id: "e1", customType: teamEntryType, data: { team, member: "second" } });
    f.approve(true);
    await f.event("session_start");
    const status = await f.execute("team_agent", { action: "list" }) as { members: { id: string; status: string }[] };
    assert.equal(status.members.find(member => member.id === "second")?.status, "idle");
    assert.equal(f.entries.length, 1, "the existing team entry is reused");
  } finally { await f.close(); }
});

test("/teams join refuses a session already in that team or leading a team with members", async () => {
  const f = fixture();
  try {
    seedTeam(f);
    await f.event("session_start");
    await f.commands.get("teams")!.handler("join", f.ctx);
    assert.match(f.warnings.at(-1)!, /already in that team/);
    await f.execute("team_agent", { action: "launch", name: "helper", brief: "hello" });
    await f.commands.get("teams")!.handler("join", f.ctx);
    assert.match(f.warnings.at(-1)!, /already in a team with other members/);
  } finally { await f.close(); }
});

test("/teams join adds this session as a main session and writes the team entry", async () => {
  const f = fixture();
  try {
    const team = seedTeam(f, randomUUID());
    await f.event("session_start");
    await f.commands.get("teams")!.handler("join", f.ctx);
    const entry = f.entries.at(-1)!;
    assert.equal(entry.customType, teamEntryType);
    assert.equal((entry.data as { team: string }).team, team);
    const status = await f.execute("team_agent", { action: "list" }) as { members: { id: string; role?: string; sessionId?: string }[] };
    assert.equal(status.members.find(member => member.sessionId === f.id)?.role, "main");
    assert.match(String((f.messages.at(-1) as { content: string }).content), /Joined team/);
  } finally { await f.close(); }
});

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Condition timed out"); await delay(10); }
}

test("notices steer in summaries once, are acknowledged only after persistence, and a wait with nothing new ends the turn", async () => {
  const f = fixture();
  try {
    const task = await f.execute("team_task", { action: "create", title: "Review", description: "Review" }) as { id: string };
    const member = await f.execute("team_agent", { action: "launch", name: "worker", model: "test/model", brief: "REPORT:Found the bug", task: task.id }) as { id: string };
    const notices = () => f.messages.filter(message => (message as { customType?: string }).customType === "ac-teams") as { content: string; details: { through: number } }[];
    await until(() => notices().length === 1);
    assert.match(notices()[0].content, /Found the bug/);
    const wait = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id] }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([wait.details, wait.terminate], [[], true], "a post already shown in a notice does not end the wait again");
    const missed = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id], after: 0 }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([missed.details.length, missed.terminate], [1, false], "a post after the caller's cursor returns at once instead of sleeping");
    f.entries.push({ type: "custom_message", id: randomUUID(), customType: "ac-teams", data: undefined, details: notices()[0].details } as never);
    await f.event("turn_end");
    const idle = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id] }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([idle.details, idle.terminate], [[], true]);
    await f.execute("team_message", { action: "send", recipients: [member.id], summary: "Thanks" });
    assert.equal(notices().length, 1, "the sender's own post does not notify it");
  } finally { await f.close(); }
});
