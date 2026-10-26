import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import teams from "../src/index.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark", false);
setKeybindings(new KeybindingsManager());
const tools = new Map<string, ToolDefinition>();
// SAFETY: registration only uses these host methods; no lifecycle callbacks run here.
teams({ events: { on() {} }, registerMessageRenderer() {}, registerFlag() {}, registerCommand() {}, on() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);

function row(name: string, args: Record<string, unknown>) {
  // SAFETY: tool rows only use requestRender; no terminal is started in these tests.
  const ui = { requestRender() {} } as unknown as TUI;
  return new ToolExecutionComponent(name, "render-test", args, {}, tools.get(name), ui, process.cwd());
}
function lines(component: ToolExecutionComponent, width = 120) {
  return component.render(width).map(stripVTControlCharacters);
}
function finish(component: ToolExecutionComponent, data: unknown, isError = false) {
  component.updateResult({ content: [{ type: "text", text: JSON.stringify(data) }], details: data, isError });
}

test("each team tool uses one row with a dot, action, arguments, and result", () => {
  for (const [name, args, result, expected] of [
    ["team_agent", { action: "launch", brief: "Review tests" }, { id: "member-1", status: "busy" }, /busy/],
    ["team_task", { action: "create", title: "Fix spacing" }, { id: "task-1", title: "Fix spacing", status: "todo" }, /todo/],
    ["team_message", { action: "send", recipients: ["member-1"], text: "Please review" }, { seq: 7 }, /seq.*7/],
  ] as const) {
    const component = row(name, args);
    const pending = lines(component);
    assert.equal(pending.length, 2, "only Pi's single separator and one content row");
    assert.equal(pending[0], "");
    assert.match(pending[1], /●/);
    assert.ok(pending[1].includes(name));
    assert.ok(pending[1].includes(args.action));
    assert.match(pending[1], /running/);
    assert.doesNotMatch(pending[1], /[{}]/);
    finish(component, result);
    const complete = lines(component);
    assert.equal(complete.length, 2);
    assert.match(complete[1], expected);
    assert.match(complete[1], /\+\d+ lines \(ctrl\+o to expand\)/);
    assert.doesNotMatch(complete[1], /[{}▸▾]/);
  }
});

test("long and multiline arguments stay one line at narrow widths without losing expanded JSON", () => {
  const args = { action: "launch", brief: "Review 界 tests\n".repeat(30), cwd: "/tmp/example" };
  const result = { id: "member-1", status: "busy", nested: { full: "response" } };
  const component = row("team_agent", args);
  finish(component, result);
  for (const width of [12, 40, 80]) {
    const compact = lines(component, width);
    assert.equal(compact.length, 2);
    assert.ok(compact.every(line => visibleWidth(line) <= width));
    assert.ok(!compact[1].includes("\n"));
  }
  component.setExpanded(true);
  const expanded = lines(component, 2000).map(line => line.slice(1).trimEnd()).join("\n");
  assert.ok(expanded.includes(JSON.stringify(args, null, 2)));
  assert.ok(expanded.includes(JSON.stringify(result, null, 2)));
  assert.match(expanded, /Request/);
  assert.match(expanded, /Response/);
  component.setExpanded(false);
  assert.equal(lines(component).length, 2);
});

test("clicking a completed row expands and collapses through Pi's native mouse region", () => {
  const component = row("team_task", { action: "list" });
  finish(component, { tasks: [{ id: "task-1" }], total: 1 });
  const collapsed = lines(component)[1];
  const x = collapsed.indexOf("lines");
  assert.ok(x > 0, "expansion hint is present and clickable");
  const click = { type: "click", button: "left", x, y: 1, width: 120, height: 2, screenX: x, screenY: 1, shift: false, alt: false, ctrl: false } as const;
  assert.equal(component.handleMouse(click)?.handled, true);
  assert.match(lines(component).join("\n"), /Response/);
  component.handleMouse(click);
  assert.equal(lines(component).length, 2);
});

test("collapsed task lists preview titles and statuses, never empty request JSON", () => {
  const component = row("team_task", { action: "list" });
  const tasks = [
    { id: "task-1", title: "Fix spacing", status: "todo" },
    { id: "task-2", title: "Check clicks", status: "done" },
  ];
  finish(component, { tasks, total: 2 });
  const collapsed = lines(component, 180)[1];
  assert.match(collapsed, /2 of 2 tasks/);
  assert.match(collapsed, /\[todo\] Fix spacing/);
  assert.match(collapsed, /\[done\] Check clicks/);
  assert.doesNotMatch(collapsed, /[{}▸▾]/);
  const detailLines = JSON.stringify({ action: "list" }, null, 2).split("\n").length
    + JSON.stringify({ tasks, total: 2 }, null, 2).split("\n").length + 2;
  assert.ok(collapsed.includes(`+${detailLines} lines`));
});

test("status badges use bold semantic colors while remaining distinct without color", () => {
  for (const [status, color] of [
    ["todo", "warning"], ["in_progress", "accent"], ["done", "success"],
    ["busy", "accent"], ["interrupted", "error"], ["idle", "muted"],
  ] as const) {
    const component = row("team_task", { action: "read", id: "task-1" });
    finish(component, { title: "Fix spacing", status });
    const rendered = component.render(180)[1];
    assert.ok(rendered.includes(theme.fg(color, theme.bold(`[${status}]`))));
    assert.ok(stripVTControlCharacters(rendered).includes(`[${status}] Fix spacing`));
  }
});

test("long previews leave room for the expansion hint and preserve full JSON", () => {
  const component = row("team_task", { action: "create", title: "界 Very long task ".repeat(50) });
  const result = { title: "界 Very long task ".repeat(50), status: "todo" };
  finish(component, result);
  const collapsed = lines(component, 100)[1];
  assert.ok(visibleWidth(collapsed) <= 100);
  assert.match(collapsed, /\+\d+ lines \(ctrl\+o to expand\)/);
  assert.doesNotMatch(collapsed, /[{}]/);
  assert.match(collapsed, /\[todo\]/);
  component.setExpanded(true);
  assert.match(lines(component, 100)[1], /ctrl\+o to collapse/);
});

test("lists show counts, and errors remain visible with full text on expansion", () => {
  for (const [name, data, expected] of [
    ["team_agent", { members: [{ id: "root" }, { id: "member-1" }], limit: 10 }, /2 members/],
    ["team_task", { tasks: [], total: 5 }, /0 of 5 tasks/],
    ["team_message", [{ text: "hello" }], /1 messages/],
  ] as const) {
    const component = row(name, { action: "list" });
    finish(component, data);
    assert.match(lines(component)[1], expected);
  }
  const component = row("team_agent", { action: "launch", brief: "Review" });
  const error = "Team coordinator is not connected\nTry again";
  component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true });
  assert.equal(lines(component).length, 2);
  assert.match(lines(component)[1], /error.*Team coordinator is not connected/);
  component.setExpanded(true);
  assert.ok(lines(component).map(line => line.trim()).join("\n").includes(error));
});
