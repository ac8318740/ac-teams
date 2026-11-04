import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { bindNoticeGroups } from "../src/group.ts";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { CustomMessageComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js";
import { teamMessageRenderer } from "../src/render.ts";
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

test("team notices follow transcript padding in collapsed and expanded views", () => {
  const message = { role: "custom" as const, customType: "ac-teams", content: "Notice", display: true, timestamp: 0,
    details: { through: 1, messages: [{ from: "root", recipients: ["worker"], summary: "Working\nMore detail" }] } };
  const component = new CustomMessageComponent(message, teamMessageRenderer());
  for (const expanded of [false, true]) {
    component.setExpanded(expanded);
    for (const padding of [0, 1, 3]) {
      component.setOutputPad(padding);
      const rendered = component.render(100).map(stripVTControlCharacters);
      const header = rendered.find(line => line.includes("ac-teams"))!;
      assert.equal(header.indexOf("ac-teams"), padding, `padding ${padding}, expanded ${expanded}`);
      assert.ok(rendered.every(line => !line.trim() || line.startsWith(" ".repeat(padding))));
      for (const width of [12, 40, 80]) {
        assert.ok(component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
      }
      if (expanded) assert.match(rendered.join("\n"), /More detail/);
    }
  }
});

test("folded chat blocks align with native rows when later text follows them", () => {
  const chat = new Container();
  const launch = row("team_agent", { action: "launch", name: "worker" });
  finish(launch, { name: "worker", status: "busy" });
  const notice = new CustomMessageComponent({ role: "custom", customType: "ac-teams", content: "Ready", display: true, timestamp: 0,
    details: { messages: [{ from: "worker", recipients: ["root"], summary: "Ready" }] } }, teamMessageRenderer());
  chat.addChild(launch);
  chat.addChild(notice);
  let toolsExpanded = false;
  // SAFETY: the grouping hook only needs the chat layout, global expansion, and active theme.
  bindNoticeGroups({ mode: "tui", ui: { theme, getToolsExpanded: () => toolsExpanded, setWidget(_key, factory) {
    assert.equal(typeof factory, "function");
    if (typeof factory === "function") factory({ children: [{ children: [chat] }] } as unknown as TUI, theme);
  } } } as ExtensionContext, () => ({ root: "Main" }), () => "Main", () => false);
  const nativeChildren = chat.children;
  for (const padding of [0, 1, 3]) {
    launch.setOutputPad(padding);
    notice.setOutputPad(padding);
    chat.addChild(new Text("Later assistant response", padding, 0));
    const rendered = chat.render(100).map(stripVTControlCharacters);
    assert.equal(rendered.find(line => line.includes("ac-teams"))!.indexOf("ac-teams"), padding);
    assert.equal(rendered.find(line => line.includes("Later assistant"))!.indexOf("Later assistant"), padding);
    assert.ok(rendered.every(line => visibleWidth(line) <= 100));
    assert.equal(chat.children, nativeChildren, "folding restores native children after rendering");
    toolsExpanded = true;
    launch.setExpanded(true);
    assert.deepEqual(chat.render(100), nativeChildren.flatMap(child => child.render(100)), "expanded blocks stay native");
    toolsExpanded = false;
    launch.setExpanded(false);
    chat.children.pop();
  }
});

test("folded groups toggle independently through native mouse dispatch and retain Ctrl+O", () => {
  const chat = new Container();
  const create = row("team_task", { action: "create", title: "First task" });
  const start = row("team_task", { action: "start", id: "task-1" });
  const later = row("team_task", { action: "list" });
  const read = row("team_task", { action: "read", id: "task-1" });
  for (const component of [create, start, later, read]) finish(component, { title: "First task", status: "todo" });
  for (const component of [create, start, new Text("Between groups", 0, 0), later, read]) chat.addChild(component);
  let renders = 0;
  let toolsExpanded = false;
  bindNoticeGroups({ mode: "tui", ui: { theme, getToolsExpanded: () => toolsExpanded, setWidget(_key, factory) {
    if (typeof factory === "function") factory({ children: [{ children: [chat] }], requestRender() { renders++; } } as unknown as TUI, theme);
  } } } as ExtensionContext, () => ({}), () => "Main", () => false);
  const draw = () => chat.render(120).map(stripVTControlCharacters);
  const click = (type: "click" | "wheel" = "click", button: "left" | "right" = "left") => chat.handleMouse({
    type, button, x: 2, y: 1, width: 120, height: draw().length, screenX: 2, screenY: 1, shift: false, alt: false, ctrl: false,
  });
  const collapsed = draw();
  assert.equal(click("wheel"), undefined);
  assert.equal(click("click", "right"), undefined);
  assert.deepEqual(draw(), collapsed);
  assert.equal(click()?.handled, true, "the folded header receives clicks through Pi's cached mouse layout");
  assert.doesNotMatch(collapsed.join("\n"), /Ctrl\+O|click/i, "no interaction hint is added");
  const opened = draw();
  assert.ok(opened.some(line => line.includes("team_task") && line.includes("create")));
  assert.equal(opened.filter(line => line.includes("ac-teams")).length, 2, "the other group stays folded");
  assert.ok(!opened.some(line => line.includes("team_task") && line.includes("read")));
  assert.deepEqual(draw(), opened, "local expansion survives rebuilding groups on rerender");
  const clickChild = () => {
    const rendered = draw();
    const y = rendered.findIndex(line => line.includes("team_task") && line.includes("create"));
    const x = rendered[y]!.indexOf("team_task");
    return chat.handleMouse({ type: "click", button: "left", x, y, width: 120, height: rendered.length, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
  };
  assert.equal(clickChild()?.handled, true);
  assert.ok(draw().some(line => line.includes('"title": "First task"')), "child click opens detail");
  assert.equal(draw().filter(line => line.includes("ac-teams")).length, 2, "child expansion keeps the group header");
  assert.equal(clickChild()?.handled, true);
  assert.deepEqual(draw(), opened, "collapsing the child returns to the open group");
  create.setExpanded(true);
  start.setExpanded(true);
  assert.equal(draw().filter(line => line.includes("ac-teams")).length, 2, "even all children expanded is not global expansion");
  create.setExpanded(false);
  start.setExpanded(false);
  const complete = row("team_task", { action: "complete", id: "task-1" });
  finish(complete, { title: "First task", status: "done" });
  chat.children.splice(2, 0, complete);
  assert.ok(draw().some(line => line.includes("team_task") && line.includes("complete")), "new rows join the open group");
  assert.equal(click()?.handled, true);
  assert.ok(!draw().some(line => line.includes("team_task")), "clicking the header again folds it");
  assert.equal(renders, 2);
  click();
  toolsExpanded = true;
  for (const component of [create, start, complete, later, read]) component.setExpanded(true);
  assert.ok(draw().some(line => line.includes('"title": "First task"')), "Ctrl+O still opens native detail");
  toolsExpanded = false;
  for (const component of [create, start, complete, later, read]) component.setExpanded(false);
  assert.ok(!draw().some(line => line.includes("team_task")), "Ctrl+O collapse resets local expansion too");
});

test("each team tool uses one row with a dot, action, arguments, and result", () => {
  for (const [name, args, result, expected] of [
    ["team_agent", { action: "launch", brief: "Review tests" }, { id: "member-1", status: "busy" }, /busy/],
    ["team_task", { action: "create", title: "Fix spacing" }, { id: "task-1", title: "Fix spacing", status: "todo" }, /todo/],
    ["team_message", { action: "send", recipients: ["member-1"], summary: "Please review" }, { seq: 7 }, /seq.*7/],
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
  assert.ok(expanded.includes(JSON.stringify(result, null, 2)));
  assert.ok(!expanded.includes('"brief"'), "Pi already shows the call; the row never repeats it");
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
  assert.ok(lines(component).join("\n").includes('"total": 1'));
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
  const detailLines = JSON.stringify({ tasks, total: 2 }, null, 2).split("\n").length;
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
