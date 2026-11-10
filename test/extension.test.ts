import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, initTheme, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { cleanText } from "../src/ui/render.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import teams from "../src/index.ts";
import { Coordinator, taskRequestGuidance } from "../src/team/coordinator.ts";
import { Connection } from "../src/team/connection.ts";
import { Store } from "../src/team/store.ts";
import { readState, teamsHome } from "../src/team/snapshot.ts";
import { teamEntryType } from "../src/members/main-terminal.ts";
import { createNotices } from "../src/extension/notices.ts";

// SAFETY: this bounded test double implements only the Pi host calls used by the extension.
function fixture(entries: { type: string; id: string; customType: string; data: unknown }[] = []) {
  const home = mkdtempSync(join(tmpdir(), "at-ext-"));
  const oldHome = process.env.HOME, oldPi = process.env.AC_TEAMS_PI, oldHerdr = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "0";
  process.env.HOME = home;
  process.env.AC_TEAMS_PI = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionToolContext): Promise<void> }>();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const flags = new Map<string, unknown>();
  const warnings: string[] = [], messages: unknown[] = [];
  let approval = false, confirmations = 0;
  const events = new EventEmitter();
  let active = ["team_agent", "team_task", "team_message"];
  const api = {
    events,
    registerShortcut(key: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> }) { shortcuts.set(key, shortcut); }, registerFlag() {}, registerCommand(name: string, command: { handler(args: string, ctx: ExtensionToolContext): Promise<void> }) { commands.set(name, command); }, registerMessageRenderer() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
    getFlag(name: string) { return flags.get(name); },
    getThinkingLevel() { return "low"; },
    getAllTools() { return [...tools.values(), { name: "Agent" }]; },
    sendMessage(message: unknown) { messages.push(message); },
    sendUserMessage(message: unknown) { messages.push(message); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", id: randomUUID(), customType, data }); },
    getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
  };
  // SAFETY: lifecycle and tool callbacks here only access the mocked context fields below.
  const ctx = { cwd: home, mode: "rpc", hasUI: true, model: { provider: "test", id: "model" }, tools: [], executeTool() { throw new Error("Unexpected nested tool"); },
    getContextUsage: () => undefined, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => join(home, "root.jsonl"), getSessionDir: () => home, getEntries: () => entries },
    ui: { notify(message: string) { warnings.push(message); }, async confirm() { confirmations++; return approval; }, async select(_title: string, options: string[]) { return options[0]; } },
  } as unknown as ExtensionToolContext;
  const id = randomUUID();
  // SAFETY: all called host methods are provided above; registration captures the real callbacks.
  teams(api as unknown as ExtensionAPI);
  // Model the host's real loaded-set query, not discovery or tool-name inference.
  const path = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const sourceInfo = { path, source: "local", scope: "user" as const, origin: "top-level" as const };
  const loaded = new DefaultResourceLoader({ cwd: home, agentDir: join(home, ".pi", "agent") }).getExtensions().extensions;
  loaded.push({
    path, resolvedPath: path, sourceInfo,
    tools: new Map([...tools].map(([name, definition]) => [name, { definition, sourceInfo }])),
    handlers: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  });
  async function execute(name: string, args: unknown) {
    return (await tools.get(name)!.execute(randomUUID(), args, new AbortController().signal, undefined, ctx)).details;
  }
  return { ctx, id, home, entries, loaded, get active() { return active; }, flags, warnings, messages, tools, commands, shortcuts, execute, events, approve(value: boolean) { approval = value; }, get confirmations() { return confirmations; },
    async event(name: string, data: Record<string, unknown> = {}) { return handlers.get(name)?.({ type: name, toolResults: [], ...data }, ctx); },
    async close() {
      try { await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx); }
      finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldPi === undefined) delete process.env.AC_TEAMS_PI; else process.env.AC_TEAMS_PI = oldPi; if (oldHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldHerdr; rmSync(home, { recursive: true, force: true }); }
    },
  };
}

test("worker entrypoint and loaded-set exclusion keep the actual Pi entrypoint identity", async t => {
  const f = fixture();
  const open = t.mock.method(Coordinator, "open");
  const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const other = join(f.home, "other.ts");
  writeFileSync(other, "export default function () {}\n");
  const own = f.loaded.at(-1)!;
  // A second loader record without our tool identity still points at our entrypoint.
  for (const path of [entrypoint, other]) f.loaded.push({ ...own, path, resolvedPath: path, tools: new Map() });
  try {
    await f.event("session_start");
    await f.execute("team_agent", { action: "list" });
    assert.equal(open.mock.calls[0].arguments[0].extension, entrypoint);
    const config = await f.execute("team_config", { action: "read" }) as { inventory: { id: string }[] };
    assert.ok(config.inventory.some(entry => entry.id === `explicit:${other}`));
    assert.ok(!config.inventory.some(entry => entry.id === `explicit:${entrypoint}`));
  } finally { await f.close(); }
});

test("/teams reload consumes a one-shot automatic recovery marker; ordinary reload still asks", async t => {
  const f = fixture();
  let reloads = 0;
  Object.assign(f.ctx, { hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    reload: async () => { reloads++; await f.event("session_shutdown"); } });
  const confirmations = t.mock.method(f.ctx.ui, "confirm", async () => { assert.fail("Explicit reload must not ask to rejoin"); });
  try {
    await f.event("session_start");
    const member = await f.execute("team_agent", { action: "launch", name: "peer", brief: "hello" }) as { id: string };
    await f.commands.get("teams")!.handler("reload", f.ctx);
    assert.equal(reloads, 1);
    assert.ok(f.entries.some(entry => entry.customType === "ac-teams-reload" && (entry.data as { rejoin?: boolean }).rejoin));
    // A fresh extension runtime has no coordinator and must consume the persisted intent.
    const restarted = fixture(f.entries);
    try {
      Object.assign(restarted.ctx, { hasUI: false });
      Object.assign(restarted.ctx.sessionManager, { getSessionId: () => f.id });
      // Use the original HOME and state, just as Pi reload does.
      process.env.HOME = f.home;
      await restarted.event("session_start");
      assert.equal(restarted.confirmations, 0);
      assert.ok(restarted.entries.some(entry => entry.customType === "ac-teams-reload" && Object.keys(entry.data as object).length === 0), "recovery intent is consumed before linking");
      const state = readState(join(teamsHome(), f.id))!;
      assert.notEqual(state.members[member.id].status, "stopped");
    } finally { await restarted.close(); process.env.HOME = f.home; }
    confirmations.mock.restore();
    const ordinary = fixture(f.entries);
    try {
      process.env.HOME = f.home;
      Object.assign(ordinary.ctx.sessionManager, { getSessionId: () => f.id });
      await ordinary.event("session_start");
      assert.equal(ordinary.confirmations, 1, "ordinary startup must not reuse explicit reload approval");
    } finally { await ordinary.close(); process.env.HOME = f.home; }
  } finally { confirmations.mock.restore(); await f.close(); }
});

test("/teams reload cancels before interrupting a running tool", async () => {
  const f = fixture();
  let aborted = false, reloaded = false;
  Object.assign(f.ctx, { isIdle: () => false, hasPendingMessages: () => false,
    abort: () => { aborted = true; }, reload: async () => { reloaded = true; } });
  try {
    await f.event("session_start");
    await f.commands.get("teams")!.handler("reload", f.ctx);
    assert.equal(aborted, false);
    assert.equal(reloaded, false);
    assert.ok(f.warnings.some(text => /reload cancelled/.test(text)));
  } finally { await f.close(); }
});

test("/teams config starts a Pi conversation without an editor or menu", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    const ctx = { ...f.ctx, mode: "tui" as const, ui: { ...f.ctx.ui,
      select: async () => { assert.fail("No configuration menu"); },
      editor: async () => { assert.fail("No file editor"); },
    } };
    await f.commands.get("teams")!.handler("config", ctx);
    assert.equal(f.messages.length, 1);
    assert.match(String(f.messages[0]), /through a conversation/);
    assert.match(String(f.messages[0]), /team_config with action read/);
    assert.ok(f.active.includes("team_config"));
    const snapshot = await f.execute("team_config", { action: "read" }) as { projectAllowed: boolean; inventory: unknown[] };
    assert.equal(snapshot.projectAllowed, false);
    assert.ok(Array.isArray(snapshot.inventory));
    assert.equal(existsSync(join(f.home, ".pi", "ac-teams", "config.json")), false);
  } finally { await f.close(); }
});

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

test("teams command starts in list mode and remembers graph/list choice across reopenings", async () => {
  const f = fixture();
  initTheme("dark");
  const graphModes: boolean[] = [];
  Object.assign(f.ctx, { mode: "tui" });
  Object.assign(f.ctx.ui, {
    custom(factory: Function) {
      return new Promise<void>(done => {
        const component = factory({ terminal: { rows: 32, columns: 100 }, requestRender() {} }, theme, {}, done) as Component & { handleInput(data: string): void; dispose(): void };
        graphModes.push(component.render(100).map(cleanText).join("\n").includes("+/- Zoom"));
        if (graphModes.length < 3) component.handleInput("g");
        component.dispose(); done();
      });
    },
  });
  try {
    for (let i = 0; i < 3; i++) await f.commands.get("teams")!.handler("panel", f.ctx);
    assert.deepEqual(graphModes, [false, true, false]);
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
    assert.match(agentGuidance, /Stop each member once it goes idle unless you will send it more work within a couple of minutes/);
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
    const taskGuidance = task.promptGuidelines!.join(" ");
    assert.match(taskGuidance, /outputs each task needs/);
    assert.match(taskGuidance, /verified output/);
    assert.match(taskGuidance, /Keep independent work parallel/);
    assert.match(taskGuidance, /completionDependencies accept existing UUIDs and @key references/);
    assert.match(taskGuidance, /Before starting or delegating, check that the recorded dependencies match/);
    assert.match(taskGuidance, /creating tasks together does not make them independent/);
    assert.doesNotMatch(taskGuidance, /Dependencies cannot refer to siblings/);
    assert.match(taskGuidance, /all dependencies must be done before task start/);
    assert.match(taskGuidance, /Reassess dependencies when scope changes/);
    assert.match(taskGuidance, /usable intermediate output/);
    assert.match(taskGuidance, /both fields must be done before completion/);
    assert.match(agentGuidance, /Coordinate shared-file work/);
    assert.doesNotMatch(agentGuidance, /Avoid concurrent writers/);
    assert.doesNotMatch(taskGuidance, /initial plan in one team_task call/);
    assert.match(JSON.stringify(task.parameters), /Prerequisite task UUIDs/);
    assert.match(JSON.stringify(task.parameters), /Unique batch-only name/);
  } finally { await f.close(); }
});

test("task edit tool exposes owner confirmation, warnings and persistent edit subscriptions", async () => {
  const f = fixture();
  const task = (args: unknown) => f.tools.get("team_task")!.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
  const message = (args: unknown) => f.tools.get("team_message")!.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
  const text = (result: Awaited<ReturnType<typeof task>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  try {
    const upstream = JSON.parse(text(await task({ action: "create", title: "Producer" })));
    const active = JSON.parse(text(await task({ action: "create", title: "Consumer" })));
    await task({ action: "start", id: active.id });
    const edited = JSON.parse(text(await task({ action: "edit", id: active.id, dependencies: [upstream.id] })));
    assert.match(edited.warnings.join(" "), /grounded.*pause.*unsound/);
    assert.deepEqual(edited.completionBlockedBy, [upstream.id]);
    await assert.rejects(task({ action: "edit", id: active.id, dependencies: [] }), /confirmDependencyRemoval/);
    await task({ action: "edit", id: active.id, dependencies: [], revision: edited.revision, confirmDependencyRemoval: true });
    const watched = await message({ action: "watch", tasks: [active.id], event: "edited" });
    assert.match(text(watched), /edited/);
    await assert.rejects(message({ action: "wait", tasks: [active.id], event: "edited" }), /watch/);
    await message({ action: "unwatch", tasks: [active.id], event: "edited" });
    assert.match(JSON.stringify(f.tools.get("team_task")!.parameters), /TASK OWNER.*exact supplied/);
    assert.match(f.tools.get("team_task")!.promptGuidelines!.join(" "), /Done edits remain rejected/);
  } finally { await f.close(); }
});

test("task batches and lists keep model output compact while read and details retain full records", async () => {
  const f = fixture();
  const call = (args: unknown) => f.tools.get("team_task")!.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
  try {
    const result = await call({ action: "create", tasks: [{ key: "inspect", title: "Inspect existing implementation", description: "Acceptance: " + "evidence ".repeat(1000) }, { title: "Run checks", dependencies: ["@inspect"] }] });
    const batch = result.details as { tasks: { id: string; description: string }[] };
    const text = (value: typeof result) => value.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.equal(batch.tasks.length, 2);
    assert.ok(text(result).length < 1500);
    assert.ok(!text(result).includes("evidence"));
    const checks = JSON.parse(text(result)).tasks[1];
    assert.deepEqual(checks.dependencies, [batch.tasks[0].id]);
    assert.deepEqual(checks.blockedBy, [batch.tasks[0].id]);
    await assert.rejects(call({ action: "start", id: batch.tasks[1].id }), /blocked/);
    const consumer = await call({ action: "create", title: "Prepare integration", completionDependencies: [batch.tasks[0].id] });
    const compact = JSON.parse(text(consumer));
    assert.deepEqual(compact.completionDependencies, [batch.tasks[0].id]);
    assert.deepEqual(compact.completionBlockedBy, [batch.tasks[0].id]);
    assert.deepEqual(compact.blockedBy, []);
    await call({ action: "start", id: compact.id });
    await assert.rejects(call({ action: "complete", id: compact.id, acceptance: true, summary: "Too early" }), /completion.*blocked/);
    await assert.rejects(call({ action: "create", title: "Bad", completionDependencies: [batch.tasks[0].id, batch.tasks[0].id] }), /Invalid task request/);
    await assert.rejects(call({ action: "create", tasks: [{ title: "Bad", key: "@invalid" }] }), /Invalid task request/);
    await assert.rejects(call({ action: "create", key: "outside", title: "Bad" }), /Invalid task request/);
    for (const key of ["worker\n", "a".repeat(65)]) {
      await assert.rejects(call({ action: "create", tasks: [{ title: "Bad", key }] }), /Invalid task request/);
    }
    await call({ action: "create", tasks: [
      { key: "a".repeat(64), title: "Maximum key" },
      { title: "Consumer", dependencies: ["@" + "a".repeat(64)] },
    ] });
    const list = await call({ action: "list" });
    assert.ok(text(list).includes(batch.tasks[0].id));
    assert.ok(!text(list).includes("evidence"));
    const read = await call({ action: "read", id: batch.tasks[0].id });
    assert.ok(text(read).includes(batch.tasks[0].description));
    await call({ action: "start", id: batch.tasks[0].id });
    await assert.rejects(call({ action: "complete", id: batch.tasks[0].id }), /acceptance/);
    await call({ action: "complete", id: batch.tasks[0].id, acceptance: true, summary: "Inspected" });
    await call({ action: "start", id: batch.tasks[1].id });
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

test("message reads show summaries by default and fetch selected detail explicitly", async () => {
  const f = fixture();
  const tool = f.tools.get("team_message")!;
  const call = (args: unknown) => tool.execute(randomUUID(), args, new AbortController().signal, undefined, f.ctx);
  const text = (result: Awaited<ReturnType<typeof call>>) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  try {
    const task = await f.execute("team_task", { action: "create", title: "Review" }) as { id: string };
    await call({ action: "send", recipients: ["root"], summary: "Unrelated" });
    const sent = await call({ action: "send", task: task.id, summary: "Review complete", detail: "Evidence ".repeat(1000) });
    const { seq } = sent.details as { seq: number };
    const history = await call({ action: "history", task: task.id });
    const posts = JSON.parse(text(history));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].seq, seq);
    assert.equal(posts[0].hasDetail, true);
    assert.equal(posts[0].detail, undefined);
    assert.ok(text(history).length < 1000);
    assert.ok((history.details as { detail: string }[])[0].detail.includes("Evidence"), "UI and persistence retain full detail");
    const search = await call({ action: "search", task: task.id, query: "Evidence" });
    assert.deepEqual(JSON.parse(text(search)), posts, "search still matches hidden detail");
    const selected = await call({ action: "history", seq, includeDetail: true });
    assert.equal(JSON.parse(text(selected))[0].detail, "Evidence ".repeat(1000));
    const plain = await call({ action: "history", seq: 1 });
    assert.equal(JSON.parse(text(plain))[0].hasDetail, false);
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
    assert.match(compact, /Message sent · Main agent \(this session\) → oom-review/);
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
function seedTeam(f: ReturnType<typeof fixture>, sessionId = f.id, cwd = f.home) {
  const team = randomUUID();
  const store = new Store({ version: 5, id: team, key: randomUUID(), limit: 10, depth: 2, tasks: {}, messages: [], members: {
    root: { id: "root", role: "main", depth: 0, token: "a", cwd, status: "stopped", notified: 0, sessionId: randomUUID() },
    second: { id: "second", name: "main-2", role: "main", depth: 0, token: "b", cwd, status: "stopped", notified: 0, sessionId },
    w1: { id: "w1", name: "worker", role: "member", parent: "root", depth: 1, token: "c", cwd, status: "stopped", notified: 0 },
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
    assert.equal(await f.event("tool_result", { toolName: "read", input: { path: "/skills/handoff/SKILL.md" }, content: [], isError: false }), undefined);
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

test("/teams join <id> chooses the exact team without a picker or UI", async () => {
  const f = fixture();
  try {
    seedTeam(f, randomUUID());
    const team = seedTeam(f, randomUUID());
    Object.assign(f.ctx, { hasUI: false });
    Object.assign(f.ctx.ui, { async select() { assert.fail("explicit join must not open a picker"); } });
    await f.event("session_start");
    await f.commands.get("teams")!.handler(`join ${team}`, f.ctx);
    assert.equal((f.entries.at(-1)?.data as { team: string }).team, team);
    const status = await f.execute("team_agent", { action: "list" }) as { members: { role?: string; sessionId?: string }[] };
    assert.equal(status.members.find(member => member.sessionId === f.id)?.role, "main");
    assert.match((f.messages.at(-1) as { content: string }).content, new RegExp(`Joined team ${team}`));
  } finally { await f.close(); }
});

test("explicit join connects to the live sender before sharing its tasks", async () => {
  const sender = fixture();
  let receiver: ReturnType<typeof fixture> | undefined;
  try {
    const task = await sender.execute("team_task", { action: "create", title: "Continue work" }) as { id: string };
    receiver = fixture();
    process.env.HOME = sender.home;
    Object.assign(receiver.ctx, { cwd: sender.home });
    await receiver.event("session_start");
    await receiver.commands.get("teams")!.handler(`join ${sender.id}`, receiver.ctx);
    const status = await sender.execute("team_agent", { action: "list" }) as { members: { role?: string; sessionId?: string; status: string }[] };
    assert.equal(status.members.find(member => member.sessionId === receiver!.id)?.role, "main");
    assert.equal(status.members.find(member => member.sessionId === receiver!.id)?.status, "idle");
    const tasks = await receiver.execute("team_task", { action: "list" }) as { tasks: { id: string }[] };
    assert.equal(tasks.tasks[0].id, task.id);
    const joined = receiver.messages.at(-1) as { content: string; details: { joined: { team: string; member: string; sessionId: string } } };
    assert.match(joined.content, new RegExp(`Joined team ${sender.id}`));
    assert.equal(joined.details.joined.team, sender.id);
    assert.equal(joined.details.joined.sessionId, receiver.id);
    assert.ok(joined.details.joined.member);
  } finally { await receiver?.close(); await sender.close(); }
});

for (const live of [false, true]) test(`joining a ${live ? "live" : "stopped"} team restores panels and telemetry`, async () => {
  const sender = fixture();
  let receiver: ReturnType<typeof fixture> | undefined;
  type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  const previous: Factory = () => { throw new Error("Editor is not needed for rendering widgets"); };
  let active: Factory | undefined = previous;
  const widgets = new Map<string, Component>();
  initTheme("dark");
  try {
    const team = live ? sender.id : seedTeam(sender, randomUUID());
    if (live) await sender.execute("team_task", { action: "create", title: "Shared work" });
    receiver = fixture();
    process.env.HOME = sender.home;
    Object.assign(receiver.ctx, { cwd: sender.home, mode: "tui" });
    Object.assign(receiver.ctx.ui, {
      getEditorComponent: () => active,
      setEditorComponent(factory: Factory | undefined) { active = factory; },
      setWidget(key: string, factory: ((...args: unknown[]) => Component) | undefined) {
        if (key !== "ac-teams-tasks" && key !== "ac-teams-agents") return;
        if (factory) widgets.set(key, factory({ requestRender() {} }, theme));
        else widgets.delete(key);
      },
      setStatus() {},
    });
    await receiver.event("session_start");
    await receiver.event("resources_discover");
    assert.equal(widgets.size, 2, "startup installs both widgets");
    await receiver.commands.get("teams")!.handler(`join ${team}`, receiver.ctx);
    assert.equal(widgets.size, 2, "join reinstalls both widgets without another resources_discover event");
    assert.notEqual(active, previous, "join reinstalls editor navigation");
    const member = (receiver.entries.at(-1)!.data as { member: string }).member;
    await until(() => readState(join(teamsHome(), team)).members[member]?.model === "test/model");
    await until(() => widgets.get("ac-teams-agents")!.render(200).some(row => row.includes("● main-")));
    if (live) {
      await until(() => widgets.get("ac-teams-tasks")!.render(200).some(row => row.includes("Shared work")));
      await receiver.shortcuts.get("ctrl+shift+left")!.handler(receiver.ctx);
      assert.equal(receiver.warnings.at(-1), "Open this main in its own terminal. Tab switching requires Herdr.", "joined mains register the return shortcut and show a plain error without Herdr");
    }
    await receiver.event("session_shutdown");
    assert.equal(widgets.size, 0, "shutdown removes the replacement widgets");
    assert.equal(active, previous, "shutdown restores the original editor");
  } finally { await receiver?.close(); await sender.close(); }
});

test("explicit join rejects unknown, foreign, and path-like IDs without changing teams", async () => {
  const f = fixture();
  try {
    const foreign = seedTeam(f, randomUUID(), join(f.home, "other-project"));
    await f.event("session_start");
    for (const id of [randomUUID(), foreign, "../escape", `${foreign} extra`]) {
      await f.commands.get("teams")!.handler(`join ${id}`, f.ctx);
      assert.match(f.warnings.at(-1)!, /No team with that ID in this project/);
      assert.equal(f.entries.length, 0);
      assert.equal(f.messages.length, 0);
    }
    const duplicate = seedTeam(f);
    await f.commands.get("teams")!.handler(`join ${duplicate}`, f.ctx);
    assert.match(f.warnings.at(-1)!, /already in that team/);
    await f.execute("team_agent", { action: "launch", name: "helper", brief: "hello" });
    await f.commands.get("teams")!.handler(`join ${foreign}`, f.ctx);
    assert.match(f.warnings.at(-1)!, /already in a team with other members/);
  } finally { await f.close(); }
});

test("reading a handoff skill anywhere appends join-first guidance with the sender's actual team", async () => {
  const f = fixture();
  try {
    const team = seedTeam(f, randomUUID());
    await f.event("session_start");
    await f.commands.get("teams")!.handler(`join ${team}`, f.ctx);
    for (const path of ["/opt/skills/handoff/SKILL.md", "skills/handoff/SKILL.md", "C:\\skills\\handoff\\SKILL.md"]) {
      const content = [{ type: "text", text: "Original skill instructions" }];
      const structuredContent = { original: true };
      const patch = await f.event("tool_result", { toolName: "read", input: { path }, content, structuredContent, isError: false }) as { content: { type: string; text: string }[]; structuredContent: unknown };
      assert.deepEqual(patch.content[0], content[0]);
      assert.deepEqual(patch.structuredContent, structuredContent);
      const text = patch.content.at(-1)!.text;
      assert.ok(text.includes(`/teams join ${team}`));
      assert.match(text, /Pi senders only/);
      assert.match(text, /Decide whether.*same team/);
      assert.match(text, /shared tasks, messages, and team control/);
      assert.match(text, /standalone.*normal launch instructions and agent-kind choice/);
      assert.match(text, /Only if.*same-team handoff.*steps/);
      assert.match(text, /--kind pi/);
      assert.match(text, /without.*handoff prompt/);
      assert.match(text, /main.*sessionId/);
      assert.match(text, /--wait/);
      assert.match(text, /stalled/);
      assert.match(text, /Only after.*confirm/);
      assert.ok(!text.includes("acstack"));
    }
  } finally { await f.close(); }
});

test("the handoff read hook ignores errors, other tools, and other skills", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    const event = { toolName: "read", input: { path: "/skills/handoff/SKILL.md" }, content: [{ type: "text", text: "Skill" }], isError: false };
    for (const change of [{ isError: true }, { toolName: "bash" }, { input: { path: "/skills/implement/SKILL.md" } }, { input: { path: "/skills/handoff/launch-herdr.md" } }]) {
      assert.equal(await f.event("tool_result", { ...event, ...change }), undefined);
    }
    assert.equal(existsSync(join(teamsHome(), f.id)), false, "unrelated reads must not start a team");
    await f.event("tool_result", event);
    assert.ok(existsSync(join(teamsHome(), f.id)), "a fresh sender needs a team the receiver can join");
    assert.match(((await f.event("tool_result", event)) as { content: { text: string }[] }).content.at(-1)!.text, new RegExp(`/teams join ${f.id}`));
  } finally { await f.close(); }
});

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Condition timed out"); await delay(10); }
}

test("team pauses drive balanced Herdr attention across notification turns, final replies, reload and abort", async () => {
  const f = fixture();
  const busy: boolean[] = [];
  f.events.on("herdr:busy", (event: { active: boolean; source: string }) => { if (event.source === "ac-teams") busy.push(event.active); });
  try {
    await f.event("session_start");
    await f.execute("team_message", { action: "wait" });
    await f.event("agent_settled");
    assert.deepEqual(busy, [], "a workerless pause does not report active work");
    const worker = await f.execute("team_agent", { action: "launch", name: "worker", model: "test/model", brief: "WAIT" }) as { id: string };
    await f.execute("team_message", { action: "wait" });
    await f.event("agent_settled");
    await f.event("agent_start");
    await f.event("agent_settled");
    assert.deepEqual(busy, [true], "notification-only turns retain the active worker's busy interval");
    await f.event("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Please approve the next step." }] } });
    assert.deepEqual(busy, [true, false]);
    await f.execute("team_message", { action: "wait" });
    await f.event("session_shutdown");
    assert.deepEqual(busy, [true, false, true, false], "closing balances the interval");
    f.approve(true);
    await f.event("session_start");
    await f.execute("team_agent", { action: "list" });
    await until(() => readState(join(teamsHome(), f.id))?.members[worker.id].status === "idle");
    assert.equal(busy.at(-1), false, "restoring a pause cannot keep settled workers busy");
    await f.execute("team_agent", { action: "launch", name: "other", model: "test/model", brief: "WAIT" });
    assert.equal(busy.at(-1), true);
    await f.event("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
    assert.equal(busy.at(-1), false);
  } finally { await f.close(); }
});

test("watch and unwatch register without pausing; pause leaves watches intact", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    const task = await f.execute("team_task", { action: "create", title: "Observe" }) as { id: string };
    const watched = await f.tools.get("team_message")!.execute(randomUUID(), { action: "watch", tasks: [task.id] }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: { watching: { task: string; event: string }[] } };
    assert.equal(watched.terminate, undefined);
    assert.deepEqual(watched.details.watching, [{ task: task.id, event: "completed" }]);
    const pause = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait" }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean };
    assert.equal(pause.terminate, true);
    await f.event("agent_start");
    const cancelled = await f.execute("team_message", { action: "unwatch", tasks: [task.id] }) as { watching: unknown[] };
    assert.deepEqual(cancelled.watching, []);
  } finally { await f.close(); }
});

for (const rejectOld of [false, true]) test(`late acknowledgement ${rejectOld ? "failure" : "success"} cannot change a replacement team's receipt cursor`, async () => {
  let identity = { team: "old", member: "root" }, through = 100;
  const pending: { through: number; resolve(): void; reject(error: Error): void }[] = [];
  const warnings: string[] = [];
  // SAFETY: notice reconciliation only reads entries; this host has no tool or editor behavior.
  const ctx = { sessionManager: { getEntries: () => [{ type: "custom_message", customType: "ac-teams", details: { ...identity, through } }] } } as unknown as ExtensionContext;
  const api = { events: new EventEmitter(), sendMessage() {} } as unknown as ExtensionAPI;
  const notices = createNotices(api, () => identity, () => ({}), text => warnings.push(text), () => ({
    remote: true,
    ack: through => new Promise<void>((resolve, reject) => pending.push({ through, resolve, reject })),
  }));
  notices.reconcile(ctx);
  notices.reset();
  identity = { team: "new", member: "other" };
  through = 1;
  notices.reconcile(ctx);
  if (rejectOld) pending[0].reject(new Error("Old team disconnected"));
  else pending[0].resolve();
  await delay(0);
  notices.reconcile(ctx);
  assert.deepEqual(pending.map(ack => ack.through), [100, 1], "the current acknowledgement remains in flight");
  assert.deepEqual(warnings, [], "stale failures do not warn in the new team");
  pending[1].resolve();
  await delay(0);
  through = 2;
  notices.reconcile(ctx);
  assert.deepEqual(pending.map(ack => ack.through), [100, 1, 2], "the new team's next durable post is acknowledged");
  pending[2].resolve();
  await delay(0);
});

test("receipt cursors belong to one team/member across joins and session reloads", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    for (let n = 0; n < 100; n++) await f.execute("team_message", { action: "send", recipients: ["root"], summary: `Old post ${n}` });
    f.entries.push({ type: "custom_message", id: "old", customType: "ac-teams", details: { team: f.id, member: "root", through: 100 } } as never);
    await f.event("turn_end");
    const target = seedTeam(f, randomUUID());
    await f.commands.get("teams")!.handler(`join ${target}`, f.ctx);
    const joined = f.messages.at(-1) as { details: { team: string; member: string } };
    assert.equal(joined.details.team, target);
    f.entries.push({ type: "custom_message", id: "foreign-member", customType: "ac-teams", details: { team: target, member: "root", through: 999 } } as never);
    f.entries.push({ type: "custom_message", id: "legacy", customType: "ac-teams", details: { through: 999 } } as never);
    await f.event("session_start");
    await f.execute("team_agent", { action: "launch", name: "new-worker", model: "test/model", brief: "ERROR" });
    await until(() => f.messages.some(message => (message as { content: string }).content.includes("Provider rejected this model")));
    const notice = f.messages.find(message => (message as { content: string }).content.includes("Provider rejected this model")) as { details: { team: string; member: string; through: number } };
    assert.equal(notice.details.team, target);
    assert.equal(notice.details.member, joined.details.member);
    // The idle notice may share the first batch.
    assert.ok(notice.details.through <= 2, "old team's cursor must not suppress this team's first post");
    f.entries.push({ type: "custom_message", id: "new", customType: "ac-teams", details: notice.details } as never);
    await f.event("session_start");
    assert.equal(readState(join(teamsHome(), target)).members[joined.details.member].notified, notice.details.through);
    assert.ok(!f.warnings.some(warning => warning.includes("Invalid notification cursor")));
  } finally { await f.close(); }
});

for (const remote of [false, true]) test(`failed ${remote ? "RPC" : "local"} acknowledgement stays retryable`, async () => {
  const sender = fixture();
  let receiver: ReturnType<typeof fixture> | undefined;
  const originalAck = Coordinator.prototype.ack, originalRequest = Connection.prototype.request;
  let attempts = 0, release: (() => void) | undefined;
  try {
    await sender.event("session_start");
    if (remote) {
      await sender.execute("team_task", { action: "create", title: "Shared team" });
      receiver = fixture();
      process.env.HOME = sender.home;
      Object.assign(receiver.ctx, { cwd: sender.home });
      await receiver.event("session_start");
      await receiver.commands.get("teams")!.handler(`join ${sender.id}`, receiver.ctx);
    }
    const f = receiver ?? sender;
    if (receiver) {
      const joined = receiver.messages.at(-1) as { details: { member: string } };
      await sender.execute("team_message", { action: "send", recipients: [joined.details.member], summary: "Persist this" });
    } else await f.execute("team_agent", { action: "launch", name: "worker", model: "test/model", brief: "REPORT:Persist this" });
    await until(() => f.messages.some(message => (message as { content: string }).content.includes("Persist this")));
    const notice = f.messages.at(-1) as { details: { member: string; through: number } };
    f.entries.push({ type: "custom_message", id: "notice", customType: "ac-teams", details: notice.details } as never);
    if (remote) Connection.prototype.request = function(operation, args) {
      if (operation === "ack" && ++attempts === 1) return new Promise((_resolve, reject) => { release = () => reject(new Error("Temporary ack failure")); });
      return originalRequest.call(this, operation, args);
    };
    else Coordinator.prototype.ack = function(id, through) {
      if (++attempts === 1) throw new Error("Temporary ack failure");
      originalAck.call(this, id, through);
    };
    await f.event("turn_end");
    if (remote) {
      await f.event("agent_settled");
      assert.equal(attempts, 1, "only one ack may be in flight");
      release!();
      await until(() => f.warnings.some(warning => warning.includes("Temporary ack failure")));
    }
    await f.event("turn_end");
    await until(() => readState(join(teamsHome(), sender.id)).members[notice.details.member].notified === notice.details.through);
    assert.equal(attempts, 2);
  } finally {
    Coordinator.prototype.ack = originalAck; Connection.prototype.request = originalRequest;
    await receiver?.close(); await sender.close();
  }
});

test("notices steer in summaries once, are acknowledged only after persistence, and a wait with nothing new ends the turn", async () => {
  const f = fixture();
  try {
    await f.event("session_start");
    const task = await f.execute("team_task", { action: "create", title: "Review", description: "Review" }) as { id: string };
    const member = await f.execute("team_agent", { action: "launch", name: "worker", model: "test/model", brief: "REPORT:Found the bug", task: task.id }) as { id: string };
    const notices = () => f.messages.filter(message => (message as { customType?: string }).customType === "ac-teams") as { content: string; details: { through: number } }[];
    // The completion post and the idle notice may arrive in one batch or two.
    await until(() => notices().some(notice => /Found the bug/.test(notice.content)) && notices().some(notice => /is idle and/.test(notice.content)));
    const shown = notices().length;
    const wait = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id] }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([wait.details, wait.terminate], [[], true], "a post already shown in a notice does not end the wait again");
    const missed = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id], after: 0 }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([missed.details.length, missed.terminate], [2, false], "a post after the caller's cursor returns at once instead of sleeping");
    f.entries.push({ type: "custom_message", id: randomUUID(), customType: "ac-teams", data: undefined, details: notices().at(-1)!.details } as never);
    await f.event("turn_end");
    const idle = await f.tools.get("team_message")!.execute(randomUUID(), { action: "wait", tasks: [task.id] }, new AbortController().signal, undefined, f.ctx) as { terminate?: boolean; details: unknown[] };
    assert.deepEqual([idle.details, idle.terminate], [[], true]);
    await f.execute("team_message", { action: "send", recipients: [member.id], summary: "Thanks" });
    assert.equal(notices().length, shown, "the sender's own post does not notify it");
  } finally { await f.close(); }
});
