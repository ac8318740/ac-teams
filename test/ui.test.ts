import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionContext, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, indexedColor, setKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { buildTaskGraph, moveTaskSelection, taskStatus } from "../src/graph.ts";
import { cleanText, renderTeamMessage, teamToolRenderers } from "../src/render.ts";
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

async function panelFixture(snapshot: TeamSnapshot) {
  let component: Component & { dispose?(): void; handleInput(data: string): void };
  let close: (id?: string) => void = () => {};
  const visits: string[] = [], resumes: string[] = [], sent: string[] = [];
  const host: PanelHost = { self: "root", drafts: new Map(), snapshot: async () => snapshot,
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
    empty.component.handleInput("\t");
    assert.match(empty.text(), /No activity yet/);
  } finally { empty.close(); await empty.running; }
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
