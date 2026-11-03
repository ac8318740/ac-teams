import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionContext, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, indexedColor, setKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { buildTaskGraph, moveTaskSelection, taskStatus } from "../src/graph.ts";
import { cleanText, renderTeamMessage, teamMessageRenderer, teamToolRenderers } from "../src/render.ts";
import { showTeamsPanel } from "../src/panel.ts";
import type { PanelHost, TeamSnapshot } from "../src/ui-types.ts";
import type { TaskView } from "../src/types.ts";

const task = (id: string, overrides: Partial<TaskView> = {}): TaskView => ({
  id, number: Number(id.replace(/^T/, "")) || 1, label: `Task ${id}`, revision: 1, title: `Task ${id}`, description: "Real task description", dependencies: [], status: "todo", blockedBy: [], ...overrides,
});
const tasks = [task("T03", { status: "done" }), task("T12", { status: "in_progress", dependencies: ["T03"] }),
  task("T21", { dependencies: ["T03"] }), task("T18", { dependencies: ["T12", "T21"], blockedBy: ["T12", "T21"] })];
// SAFETY: these bounded Pi doubles implement only the documented methods the UI uses.
const theme = {
  fg(color: string, text: string) { return `\x1b[${color === "dim" ? 90 : 37}m${text}\x1b[39m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
  style(text: string, options: { fg: Parameters<typeof foregroundAnsi>[0] }) { return foregroundAnsi(options.fg, "256color") + text + "\x1b[39m"; },
} as unknown as Theme;
const renderContext = (expanded = false) => ({ expanded, isError: false, isPartial: false, args: { action: "send" }, outputPad: 0 }) as Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const plain = (component: Component, width = 60) => component.render(width).map(line => cleanText(line).trimEnd()).join("\n");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("status priority and graph map match real domain values", () => {
  assert.deepEqual(tasks.map(taskStatus), ["Done", "Working", "Ready", "Blocked"]);
  assert.equal(taskStatus(task("x", { status: "done", blockedBy: ["y"] })), "Done");
  assert.equal(taskStatus(task("x", { status: "in_progress", blockedBy: ["y"] })), "Blocked");
  const graph = buildTaskGraph(tasks);
  assert.ok(graph);
  assert.equal(graph.bounds.size, 4);
  for (const [id, box] of graph.bounds) {
    assert.ok(box.right > box.left && box.bottom > box.top, id);
    assert.ok(graph.art.plain[box.top].includes("┌"));
  }
  for (const [id, direction, expected] of [
    ["T12", "right", "T21"], ["T21", "left", "T12"], ["T12", "up", "T03"], ["T21", "up", "T03"],
    ["T12", "down", "T18"], ["T21", "down", "T18"], ["T03", "up", "T03"], ["T18", "down", "T18"],
    ["T12", "left", "T12"], ["T21", "right", "T21"],
  ] as const) assert.equal(moveTaskSelection(graph.bounds, id, direction), expected);
});

test("graph handles real UUID task IDs without wrapping away selectable headers", () => {
  const first = "938d26e0-5440-4894-ae3a-6e0f37e1aeaa", second = "02d2f8b6-3cdb-4a82-bf28-358e471c70fb";
  const graph = buildTaskGraph([task(first, { number: 1, label: "Core", title: "Completed foundation", status: "done" }), task(second, { number: 2, label: "Parser tests", dependencies: [first] })]);
  assert.ok(graph);
  assert.equal(graph.bounds.size, 2);
  assert.equal(moveTaskSelection(graph.bounds, first, "down"), second);
  assert.match(graph.art.plain.join("\n"), /#1 Core/);
  assert.match(graph.art.plain.join("\n"), /#2 Parser tests/);
  assert.ok(!graph.art.plain.join("\n").includes("938d26e0"));
  assert.ok(buildTaskGraph([task(first, { number: 1, label: "First" }), task(first.replace("5440", "1111"), { number: 2, label: "Second" })]), "UUID prefix collisions no longer affect selection");
  assert.equal(buildTaskGraph([task(first), task(second)]), null, "duplicate numbers must not select the wrong task");
});

test("graph sanitizes labels, handles wide text, and safely falls back", () => {
  const graph = buildTaskGraph(tasks.map(item => ({ ...item, label: '解析器 👩‍💻 "]\nINJECT --> OTHER\x1b[31m' })));
  assert.ok(graph);
  assert.equal(graph.bounds.size, tasks.length);
  assert.ok(!graph.art.plain.join("\n").includes("\x1b"));
  assert.equal(moveTaskSelection(graph.bounds, "T12", "right"), "T21");
  assert.equal(buildTaskGraph([]), null);
  assert.equal(buildTaskGraph([tasks[0], tasks[0]]), null);
  assert.equal(buildTaskGraph([task("x", { dependencies: ["missing"] })]), null);
  assert.equal(buildTaskGraph([task("T".repeat(500))]), null);
  assert.equal(buildTaskGraph(Array.from({ length: 101 }, (_, i) => task(String(i)))), null);
  const single = buildTaskGraph([tasks[0]])!;
  for (const direction of ["up", "down", "left", "right"] as const) assert.equal(moveTaskSelection(single.bounds, "T03", direction), "T03");
});

test("tool renderers expand full JSON without mutating payloads or exposing terminal controls", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const renderers = teamToolRenderers("team_message");
  const data = { id: "M1", text: "First line\nA long second line that must wrap instead of becoming a JSON dump.\x1b[2J", recipients: ["root"] };
  const result = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
  const before = JSON.stringify(result);
  const compact = plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext()));
  assert.ok(!compact.includes("Recipients:"));
  const expanded = renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, renderContext(true));
  const lines = expanded.render(32);
  assert.ok(lines.every(line => visibleWidth(line) <= 32));
  const text = plain(expanded, 2000);
  assert.ok(text.includes(JSON.stringify(data, null, 2)));
  assert.match(text, /Request/);
  assert.match(text, /Response/);
  assert.ok(!text.includes("\x1b[2J"));
  assert.equal(JSON.stringify(result), before);
  const fallback = renderers.renderResult!({ content: result.content, details: undefined }, { expanded: true, isPartial: false }, theme, renderContext(true));
  assert.ok(plain(fallback, 2000).includes(JSON.stringify(data)));
  assert.equal(plain(renderers.renderCall!({ action: "send", text: data.text }, theme, renderContext(true))), "");
  const agentData = { id: "member-uuid", name: "parser-review", status: "idle" };
  const agentResult = { content: [{ type: "text" as const, text: JSON.stringify(agentData) }], details: agentData };
  assert.match(plain(renderers.renderResult!(agentResult, { expanded: false, isPartial: false }, theme, renderContext())), /\[idle\] parser-review/);
  assert.ok(!plain(renderers.renderResult!(agentResult, { expanded: false, isPartial: false }, theme, renderContext())).includes("member-uuid"));
  assert.match(plain(renderers.renderResult!(agentResult, { expanded: true, isPartial: false }, theme, renderContext(true))), /"id": "member-uuid"/);
  const message = renderTeamMessage({ role: "custom", customType: "team", content: "hello\x1b]0;bad\x07", display: true, timestamp: 0 }, { expanded: true, outputPad: 0 }, theme)!;
  assert.match(plain(message), /Content: hello/);
  assert.equal(cleanText("x\x1b]0;title\x07\x1b[31my\x00\r\nz"), "xy\nz");
});

test("compact tool rows prefer aliases while expanded JSON retains IDs", () => {
  initTheme("dark", false);
  setKeybindings(new KeybindingsManager());
  const labels = () => ({ root: "Main", "member-uuid": "oom-review" });
  for (const [tool, args, data, expected] of [
    ["team_message", { action: "send", recipients: ["member-uuid"], text: "Review" }, { id: "message-uuid", seq: 7, recipients: ["member-uuid"] }, /to oom-review.*seq: 7/],
    ["team_agent", { action: "status", id: "member-uuid" }, { id: "member-uuid", name: "oom-review", status: "idle" }, /\[idle\] oom-review/],
    ["team_message", { action: "history" }, [{ id: "message-uuid", from: "member-uuid", recipients: ["root"], text: "Done" }], /oom-review → Main/],
  ] as const) {
    const renderers = teamToolRenderers(tool, labels);
    const context = { ...renderContext(), args };
    const result = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
    const compact = plain(renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, context), 1000);
    assert.match(compact, expected);
    assert.doesNotMatch(compact, /member-uuid|message-uuid/);
    const expanded = plain(renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context), 2000);
    assert.ok(expanded.includes(JSON.stringify(data, null, 2)));
    const pending = plain(renderers.renderCall!(args, theme, { ...context, isPartial: true }), 1000);
    assert.doesNotMatch(pending, /member-uuid/);
  }
});

test("notification previews use aliases and fall back to unknown IDs", () => {
  const render = teamMessageRenderer(() => ({ root: "Main", "member-uuid": "oom-review\x1b[2J" }));
  const message = { role: "custom" as const, customType: "ac-teams", content: "Notice", display: true, timestamp: 0,
    details: { through: 3, messages: [{ from: "member-uuid", recipients: ["root", "legacy-id"], text: "Done\nDetails" }] } };
  const compact = plain(render(message, { expanded: false, outputPad: 0 }, theme)!, 1000);
  assert.match(compact, /oom-review → Main, legacy-id · Done/);
  assert.doesNotMatch(compact, /member-uuid|Details/);
  assert.ok(!compact.includes("\x1b"));
  assert.match(plain(render(message, { expanded: true, outputPad: 0 }, theme)!, 1000), /member-uuid/);
});

async function panelFixture(snapshot: TeamSnapshot) {
  let component: Component & { dispose?(): void; handleInput(data: string): void };
  let close: (id?: string) => void = () => {};
  const visits: string[] = [], resumes: string[] = [], sent: string[] = [];
  const host: PanelHost = { self: "root", child: false, promote: async () => {}, drafts: new Map(), snapshot: async () => snapshot,
    visit: async id => { visits.push(id); }, resume: async id => { resumes.push(id); },
    requestTask: async text => { sent.push(text); return "Delivered to Main"; },
    feedback: async (_task, text) => { sent.push(text); return "Delivered feedback"; } };
  const tui = { terminal: { rows: 32, columns: 100 }, requestRender() {} };
  const ctx = { mode: "tui", cwd: "/project", ui: { notify() {},
    custom: (factory: (...args: unknown[]) => typeof component) => new Promise<string | undefined>(resolve => {
      close = id => { component.dispose?.(); resolve(id); };
      component = factory(tui, theme, {}, close);
    }),
  } } as unknown as ExtensionContext;
  const running = showTeamsPanel(ctx, host);
  await tick();
  return { host, tui, component: component!, visits, resumes, sent, running, close: () => close(),
    text: (width = 100) => plain(component!, width) };
}
const snapshot = (): TeamSnapshot => ({ members: [], tasks: tasks.map(item => ({ ...item })), messages: [], limit: 4, depth: 2 });

test("panel keeps selected status color, dims done text, fits narrow terminals, and has empty states", async () => {
  const f = await panelFixture(snapshot());
  try {
    const lines = f.component.render(150);
    assert.match(lines.join("\n"), new RegExp(foregroundAnsi(indexedColor(2), "256color").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(lines.some(line => line.includes("\x1b[90m") && line.includes("● #3 Task T03")));
    assert.match(f.text(150), /● #3 Task T03 · Done/);
    assert.match(f.text(150), /Working/);
    assert.ok(lines.join("\n").includes(foregroundAnsi(indexedColor(6), "256color")));
    assert.ok(lines.join("\n").includes(foregroundAnsi(indexedColor(1), "256color")));
    f.component.handleInput("g");
    assert.match(f.text(), /● #3 Task T03/);
    assert.ok(!f.text().includes("> #"));
    assert.match(f.text(), /Done/);
    f.tui.terminal.rows = 10;
    assert.ok(f.component.render(12).every(line => visibleWidth(line) <= 12));
    assert.ok(f.component.render(12).length <= 10);
  } finally { f.close(); await f.running; }
  const empty = await panelFixture({ ...snapshot(), tasks: [], members: [{ id: "root", cwd: "/project", depth: 0, status: "idle", notified: 0 }] });
  try {
    assert.match(empty.text(), /No tasks yet/);
    assert.match(empty.text(), /0\/4 live/, "Main must not consume a member slot");
    empty.component.handleInput("\t");
    assert.match(empty.text(), /● Main/);
    assert.match(empty.text(150), /Model +Unknown/);
    assert.match(empty.text(150), /Context +Unknown/);
    assert.match(empty.text(150), /Directory +\/project/);
    empty.component.handleInput("\t");
    assert.match(empty.text(), /No activity yet/);
  } finally { empty.close(); await empty.running; }
});

test("teammate columns stay aligned and preserve status at narrow and split widths", async () => {
  const data = snapshot();
  data.members = [
    { id: "scout", name: "marketplace-scout", status: "stopped", depth: 1, cwd: "/project", notified: 0 },
    { id: "fix", name: "setup-fix", status: "busy", depth: 1, cwd: "/project", notified: 0 },
    { id: "wide", name: "解析器👩‍💻".repeat(12), status: "idle", needsInput: true, depth: 1, cwd: "/project", notified: 0 },
  ];
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    for (const width of [40, 80, 100, 150]) {
      const lines = f.component.render(width).map(cleanText);
      const header = lines.find(line => /Member +Session/.test(line))!;
      assert.ok(header, `column headings at width ${width}`);
      const column = visibleWidth(header.slice(0, header.indexOf("Session")));
      for (const status of ["Main conversation", "Stopped", "Busy", "Needs input"]) {
        const line = lines.find(line => line.includes(status))!;
        assert.ok(line, `${status} visible at width ${width}`);
        assert.equal(visibleWidth(line.slice(0, line.indexOf(status))), column, `${status} aligned at width ${width}`);
      }
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
    for (const width of [12, 24, 39, 82, 83]) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
    }
    f.component.handleInput("\x1b[B");
    assert.match(f.text(80), /● marketplace-scout/);
    f.component.handleInput("\x1b[C");
    assert.match(f.text(80), /State +Stopped/);
  } finally { f.close(); await f.running; }
});

test("teammate table adds task progress and directory only when they fit", async () => {
  const data = snapshot();
  data.members = [
    { id: "worker", name: "marketplace-fix", status: "busy", depth: 1, cwd: "/work/marketplace/", notified: 0 },
    { id: "other", name: "other", status: "idle", depth: 1, cwd: "/work/解析器", notified: 0 },
  ];
  data.tasks = data.tasks.map((task, i) => ({ ...task, owner: i < 3 ? "worker" : "other", status: i === 0 ? "done" : "todo" }));
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    const wide = f.component.render(150).map(cleanText);
    const header = wide.find(line => /Member +Session +Tasks +Directory/.test(line))!;
    assert.ok(header);
    const worker = wide.find(line => /marketplace-fix +Busy/.test(line))!;
    assert.match(worker, /marketplace-fix {4,}Busy {4,}1\/3 {4,}marketplace/);
    for (const [title, value] of [["Session", "Busy"], ["Tasks", "1/3"], ["Directory", "marketplace"]]) {
      assert.equal(visibleWidth(header.slice(0, header.indexOf(title))), visibleWidth(worker.slice(0, worker.lastIndexOf(value))));
    }
    assert.ok(!worker.includes("/work/"));
    assert.match(wide.find(line => /other +Idle/.test(line))!, /0\/1 +解析器/);
    const columnAt = (width: number, title: string) => {
      const heading = f.component.render(width).map(cleanText).find(line => /Member +Session/.test(line))!;
      return visibleWidth(heading.slice(0, heading.indexOf(title)));
    };
    assert.ok(columnAt(180, "Session") > columnAt(150, "Session"), "Session moves with available width");
    assert.ok(columnAt(180, "Tasks") > columnAt(150, "Tasks"), "Tasks moves with available width");
    assert.ok(columnAt(180, "Directory") > columnAt(150, "Directory"), "Directory uses the right-hand space");
    const medium = f.text(100).split("\n").find(line => /Member +Session/.test(line))!;
    assert.match(medium, /Tasks/);
    assert.ok(!medium.includes("Directory"));
    const narrow = f.text(40).split("\n").find(line => /Member +Session/.test(line))!;
    assert.ok(!narrow.includes("Tasks"));
    assert.ok(!narrow.includes("Directory"));
    for (let width = 12; width <= 180; width++) {
      assert.ok(f.component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
    }
    f.component.handleInput("\x1b[B"); f.component.handleInput("\x1b[C");
    assert.match(f.text(100), /Tasks +1\/3/);
    assert.match(f.text(100), /Completed \/ currently assigned/);
    assert.match(f.text(100), /Directory +\/work\/marketplace\//);
    data.tasks[1].owner = "other";
    assert.match(f.text(100), /Tasks +1\/2/, "reassignment leaves the denominator");
  } finally { f.close(); await f.running; }
});

test("teammate search and stopped filter affect only the visible roster and selected session", async () => {
  const data = snapshot();
  data.members = [
    { id: "scout-id", name: "marketplace-scout", role: "member", status: "stopped", depth: 1, cwd: "/project", notified: 0 },
    { id: "fix-id", name: "marketplace-fix", role: "member", status: "busy", depth: 1, cwd: "/project", notified: 0 },
    { id: "test-id", name: "setup-tests", role: "member", status: "idle", needsInput: true, depth: 1, cwd: "/project", notified: 0 },
    { id: "interrupted-id", name: "interrupted-review", role: "member", status: "interrupted", depth: 1, cwd: "/project", notified: 0 },
  ];
  const before = JSON.stringify(data);
  const f = await panelFixture(data);
  try {
    f.component.handleInput("\t");
    assert.match(f.text(150), /1 working · 0 idle · 1 stopped · 2 needs input/);
    assert.match(f.text(150), /→ Details/);
    const footer = () => { const text = f.text(150); return text.slice(text.lastIndexOf("├")); };
    assert.match(footer(), /\/ Filter · H Hide stopped/);
    const rows = f.component.render(150).map(cleanText);
    const headingRow = rows.findIndex(line => /Member +Session/.test(line));
    assert.match(rows[headingRow + 1], /● Main/, "headings sit directly above roster rows");
    assert.ok(!rows.slice(0, rows.findLastIndex(line => line.includes("├"))).some(line => /Filter names|H Hide stopped/.test(line)));
    f.component.handleInput("h");
    assert.ok(!f.text(150).includes("marketplace-scout"));
    assert.match(footer(), /Stopped: hidden/);
    assert.match(f.text(150), /interrupted-review/, "interrupted sessions remain visible for recovery");
    f.component.handleInput("/");
    f.component.handleInput("MARKETPLACE");
    assert.match(footer(), /Filter: MARKETPLACE▏/);
    assert.match(footer(), /Stopped: hidden/);
    assert.match(f.text(150), /● marketplace-fix/);
    assert.ok(!f.text(150).includes("setup-tests"));
    assert.deepEqual(f.sent, [], "search input must not trigger task or promotion shortcuts");
    f.component.handleInput("\r");
    assert.match(footer(), /Filter: MARKETPLACE/);
    f.component.handleInput("\x1b[C");
    assert.match(f.text(150), /Esc Back/);
    assert.ok(!f.text(150).includes("No separate message composer"));
    f.component.handleInput("\x1b");
    f.component.handleInput("/");
    f.component.handleInput("does-not-exist");
    assert.match(f.text(150), /No matching teammates/);
    f.component.handleInput("\r");
    f.component.handleInput("\r");
    await tick();
    assert.deepEqual(f.visits, [], "empty search cannot open an unrelated member");
    f.component.handleInput("/");
    f.component.handleInput("\x1b");
    assert.match(f.text(150), /setup-tests/);
    f.component.handleInput("h");
    assert.match(f.text(150), /marketplace-scout/);
    assert.equal(JSON.stringify(data), before);
    f.component.handleInput("/");
    f.component.handleInput("\x1b[200~marketplace-fix😀\x1b[201~");
    f.component.handleInput("\x7f");
    assert.match(f.text(150), /● marketplace-fix/);
    f.component.handleInput("\r");
    f.component.handleInput("\r");
    await tick(); await f.running;
    assert.deepEqual(f.visits, ["fix-id"]);
  } finally { f.close(); await f.running; }
});

test("panel summaries follow the active tab and details separate model from context", async () => {
  const data = snapshot();
  data.members = [{ id: "worker", name: "worker", status: "idle", depth: 1, cwd: "/project", notified: 0,
    modelName: "Test model", contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } }];
  data.messages = [{ seq: 1, id: "M1", from: "root", recipients: ["worker"], text: "Hello", time: "2026-01-01T12:00:00Z" }];
  const f = await panelFixture(data);
  try {
    assert.match(f.text(150), /4 tasks/);
    f.component.handleInput("\t"); f.component.handleInput("\x1b[B");
    assert.match(f.text(150), /1 teammate/);
    assert.ok(!f.text(150).includes("4 tasks"));
    assert.match(f.text(150), /Model +Test model/);
    assert.match(f.text(150), /Context +12k \/ 100k \(12%\)/);
    f.component.handleInput("\t");
    assert.match(f.text(150), /1 message · newest first/);
    assert.ok(!f.text(150).includes("4 tasks"));
  } finally { f.close(); await f.running; }
});

test("composer retains failed/cancelled drafts, uses real receipts, and resumes before visiting", async () => {
  const data = snapshot();
  data.members.push({ id: "worker", depth: 1, cwd: "/project", status: "stopped", notified: 0 });
  const f = await panelFixture(data);
  try {
    f.host.requestTask = async () => { throw new Error("offline\x1b[2J"); };
    f.component.handleInput("n"); f.component.handleInput("Build parser"); f.component.handleInput("\r");
    await tick();
    assert.match(f.text(), /Delivery failed: Error: offline/);
    assert.equal(f.host.drafts.get("new"), "Build parser");
    f.component.handleInput("\x1b");
    assert.equal(f.host.drafts.get("new"), "Build parser");
    f.component.handleInput("n");
    assert.match(f.text(), /Main will review existing work/);
    f.host.requestTask = async text => { f.sent.push(text); return "Receipt M42: delivered to Main"; };
    f.component.handleInput("\r"); await tick();
    assert.deepEqual(f.sent, ["Build parser"]);
    assert.equal(f.host.drafts.has("new"), false);
    assert.match(f.text(), /Receipt M42: delivered to Main/);
    f.component.handleInput("\t"); f.component.handleInput("\x1b[B");
    f.component.handleInput("\r"); await tick(); await f.running;
    assert.deepEqual(f.resumes, ["worker"]);
    assert.deepEqual(f.visits, ["worker"]);
  } finally { f.close(); await f.running; }
});

test("polling preserves task identity, never overlaps, and stops after disposal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const data = snapshot();
  const f = await panelFixture(data);
  let calls = 0;
  let resolve: (value: TeamSnapshot) => void = () => {};
  try {
    f.component.handleInput("g");
    f.component.handleInput("\x1b[B"); f.component.handleInput("\x1b[B");
    assert.match(f.text(), /● #21 Task T21/);
    f.host.snapshot = () => { calls++; return new Promise(done => { resolve = done; }); };
    t.mock.timers.tick(2000); await tick();
    assert.equal(calls, 1);
    t.mock.timers.tick(10000); await tick();
    assert.equal(calls, 1);
    resolve({ ...data, tasks: [data.tasks[2], data.tasks[0], data.tasks[1], data.tasks[3]] });
    await tick();
    assert.match(f.text(), /● #21 Task T21/);
    t.mock.timers.tick(2000); await tick();
    assert.equal(calls, 2);
    f.close(); await f.running;
    resolve(data); await tick();
    t.mock.timers.tick(10000); await tick();
    assert.equal(calls, 2);
  } finally { f.close(); await f.running; }
});

test("fallback does not overwrite delivery receipts and Activity uses persistent messages", async () => {
  const data = snapshot();
  data.tasks = [task("T1", { dependencies: ["missing"] })];
  data.messages = [{ seq: 1, id: "M1", from: "root", recipients: ["worker"], text: "Real persistent message", time: "2026-01-01T12:00:00Z" }];
  const f = await panelFixture(data);
  try {
    assert.match(f.text(), /Graph unavailable or too large/);
    f.component.handleInput("n"); f.component.handleInput("Describe outcome"); f.component.handleInput("\r");
    await tick();
    assert.match(f.text(), /Delivered to Main/);
    assert.match(f.text(), /Delivered to Main/);
    f.component.handleInput("\t"); f.component.handleInput("\t");
    assert.match(f.text(), /Real persistent message/);
    assert.match(f.text(), /Recent messages · newest first/);
    assert.match(f.text(), /● Main → worker/);
  } finally { f.close(); await f.running; }
});

test("feedback sends prose and task context without mutating task state", async () => {
  const data = snapshot();
  const before = JSON.stringify(data);
  const f = await panelFixture(data);
  const deliveries: { id: string; text: string }[] = [];
  try {
    f.host.feedback = async (selected, text) => { deliveries.push({ id: selected.id, text }); return "Receipt F1: feedback delivered"; };
    f.component.handleInput("c"); f.component.handleInput("Please clarify acceptance");
    f.component.handleInput("\x1b");
    assert.equal(f.host.drafts.get("feedback:T03"), "Please clarify acceptance");
    f.component.handleInput("c"); f.component.handleInput("\r"); await tick();
    assert.deepEqual(deliveries, [{ id: "T03", text: "Please clarify acceptance" }]);
    assert.match(f.text(), /Receipt F1: feedback delivered/);
    assert.equal(f.host.drafts.has("feedback:T03"), false);
    assert.equal(JSON.stringify(data), before);
  } finally { f.close(); await f.running; }
});
