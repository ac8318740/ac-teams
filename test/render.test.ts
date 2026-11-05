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
teams({ events: { on() {} }, registerMessageRenderer() {}, registerFlag() {}, registerShortcut() {}, registerCommand() {}, on() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);

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
      const header = rendered.find(line => line.includes("Message sent"))!;
      assert.equal(header.indexOf("Message sent"), padding, `padding ${padding}, expanded ${expanded}`);
      assert.ok(rendered.every(line => !line.trim() || line.startsWith(" ".repeat(padding))));
      for (const width of [12, 40, 80]) {
        assert.ok(component.render(width).every(line => visibleWidth(line) <= width), `fits width ${width}`);
      }
      if (expanded) assert.match(rendered.join("\n"), /More detail/);
    }
  }
});

test("expanded records distinguish field labels and section headers in native and grouped rendering", () => {
  const posts = [{ from: "reviewer", recipients: ["root"], summary: "A colon: stays ordinary\x1b[2J", time: "2026-11-04T21:47:26Z" }];
  const history = row("team_message", { action: "history" });
  finish(history, posts);
  history.setExpanded(true);
  const notice = new CustomMessageComponent({ role: "custom", customType: "ac-teams", content: "", display: true, timestamp: 0, details: { messages: posts } }, teamMessageRenderer());
  notice.setExpanded(true);
  notice.setOutputPad(0);
  const chat = new Container();
  chat.addChild(history);
  bindNoticeGroups({ mode: "tui", ui: { theme, getToolsExpanded: () => true, setWidget(_key, factory) {
    if (typeof factory === "function") factory({ children: [{ children: [chat] }], requestRender() {} } as unknown as TUI, theme);
  } } } as ExtensionContext, () => ({ root: "Main" }), () => "root", () => false);
  for (const component of [history, notice, chat]) {
    const raw = component.render(160).join("\n");
    assert.ok(raw.includes(theme.fg("accent", theme.bold("From:"))), "field prefixes use the host accent and bold");
    assert.ok(raw.includes(theme.fg("accent", theme.bold("Summary:"))));
    const heading = component === notice ? "Message received · reviewer → Main agent (this session)" : "Message 1 · Received";
    assert.ok(raw.includes(theme.fg("accent", theme.underline(theme.bold(heading)))), "message headings use the host underline style");
    assert.ok(raw.includes(theme.fg("dim", " 2026-11-04T21:47:26Z")), "timestamp values are secondary");
    assert.ok(!raw.includes(theme.fg("accent", theme.bold("A colon:"))), "message prose is not mistaken for a field prefix");
    assert.ok(!raw.includes("\x1b[2J"), "source control sequences are never restored by styling");
    const text = stripVTControlCharacters(raw);
    assert.match(text, /Summary: A colon: stays ordinary/);
    assert.match(text, /From: reviewer/);
    if (component !== notice) {
      const lines = text.split("\n"), first = lines.findIndex(line => line.includes("Message 1 · Received"));
      assert.equal(lines[first - 1]!.replace(/[│]/g, "").trim(), "", "native and grouped history leave a blank line before the first message");
    }
    for (const width of [1, 12, 40, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width), `${component.constructor.name} styled rows fit width ${width}`);
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
    assert.equal(rendered.find(line => line.includes("ac-teams activity"))!.indexOf("●"), padding);
    assert.equal(rendered.find(line => line.includes("Later assistant"))!.indexOf("Later assistant"), padding);
    assert.ok(rendered.every(line => visibleWidth(line) <= 100));
    assert.equal(chat.children, nativeChildren, "folding restores native children after rendering");
    const narrow = chat.render(40).map(stripVTControlCharacters).join(" ").replace(/\s+/g, " ");
    assert.match(narrow, /ac-teams activity · Teammate started; received 1 message/, "narrow headers retain every action type");
    toolsExpanded = true;
    launch.setExpanded(true);
    const expanded = chat.render(100).map(stripVTControlCharacters).join("\n");
    assert.match(expanded, /ac-teams activity · Teammate started; received 1 message/);
    assert.match(expanded, /Status: Working/);
    assert.equal((expanded.match(/Message received/g) ?? []).length, 1, "expanded group does not repeat its previews");
    toolsExpanded = false;
    launch.setExpanded(false);
    chat.children.pop();
  }
});

test("notice grouping releases its old context and rebinds after reload", () => {
  const chat = new Container();
  const create = row("team_task", { action: "create", title: "Reload task" });
  finish(create, { title: "Reload task", status: "todo" });
  chat.addChild(create);
  const nativeRender = chat.render;
  let stale = false, toolsExpanded = false;
  const ui = { theme, getToolsExpanded: () => toolsExpanded, setWidget(_key: string, factory: unknown) {
    if (typeof factory === "function") factory({ children: [{ children: [chat] }], requestRender() {} }, theme);
  } };
  // SAFETY: this host double rejects the same expired context access as Pi 1.5.
  const ctx = { mode: "tui", get ui() {
    if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
    return ui;
  } } as ExtensionContext;
  const dispose = bindNoticeGroups(ctx, () => ({}), () => "root", () => false);
  assert.match(chat.render(120).map(stripVTControlCharacters).join("\n"), /ac-teams activity/);
  dispose?.();
  stale = true;
  assert.doesNotThrow(() => chat.render(120), "shutdown must remove the wrapper before Pi expires its context");
  assert.equal(chat.render, nativeRender);
  const unbind = bindNoticeGroups({ mode: "tui", ui } as ExtensionContext, () => ({}), () => "root", () => false);
  dispose?.();
  assert.notEqual(chat.render, nativeRender, "repeated old cleanup must not remove the new wrapper");
  toolsExpanded = true;
  const rendered = chat.render(120).map(stripVTControlCharacters).join("\n");
  assert.equal((rendered.match(/ac-teams activity/g) ?? []).length, 1, "reload installs exactly one fresh wrapper");
  assert.match(rendered, /Title: Reload task/, "the fresh wrapper reads the current expansion state");
  unbind?.();
  assert.equal(chat.render, nativeRender);
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
  assert.ok(opened.some(line => line.includes("Tasks created")));
  assert.equal(opened.filter(line => line.includes("ac-teams activity")).length, 2, "the other group stays folded");
  assert.ok(!opened.some(line => line.includes("Task details")));
  assert.deepEqual(draw(), opened, "local expansion survives rebuilding groups on rerender");
  const clickChild = () => {
    const rendered = draw();
    const y = rendered.findIndex(line => /[├└]─ ● Tasks created/.test(line));
    const x = rendered[y]!.indexOf("Tasks created");
    return chat.handleMouse({ type: "click", button: "left", x, y, width: 120, height: rendered.length, screenX: x, screenY: y, shift: false, alt: false, ctrl: false });
  };
  assert.equal(clickChild()?.handled, true);
  assert.ok(draw().some(line => line.includes("Title: First task")), "child click opens detail");
  assert.equal(draw().filter(line => line.includes("ac-teams activity")).length, 2, "child expansion keeps the group header");
  assert.equal(clickChild()?.handled, true);
  assert.deepEqual(draw(), opened, "collapsing the child returns to the open group");
  create.setExpanded(true);
  start.setExpanded(true);
  assert.equal(draw().filter(line => line.includes("ac-teams activity")).length, 2, "even all children expanded is not global expansion");
  create.setExpanded(false);
  start.setExpanded(false);
  const complete = row("team_task", { action: "complete", id: "task-1" });
  finish(complete, { title: "First task", status: "done" });
  chat.children.splice(2, 0, complete);
  assert.ok(draw().some(line => line.includes("Task completed")), "new rows join the open group");
  assert.equal(click()?.handled, true);
  assert.ok(!draw().some(line => /[├└]─ ● Tasks created/.test(line)), "clicking the header again folds it");
  assert.equal(renders, 4, "both group and child toggles request a render");
  click();
  toolsExpanded = true;
  for (const component of [create, start, complete, later, read]) component.setExpanded(true);
  assert.ok(draw().some(line => line.includes("Title: First task")), "Ctrl+O still opens readable detail");
  toolsExpanded = false;
  for (const component of [create, start, complete, later, read]) component.setExpanded(false);
  assert.ok(!draw().some(line => /[├└]─ ● Tasks created/.test(line)), "Ctrl+O collapse resets local expansion too");
});

test("mixed message blocks retain direction when the group and message details expand", () => {
  const chat = new Container();
  const send = row("team_message", { action: "send", recipients: ["worker"], summary: "Review the parser", detail: "Check cancellation handling" });
  finish(send, { seq: 7, recipients: ["worker"] });
  const incoming = new CustomMessageComponent({ role: "custom", customType: "ac-teams", content: "Ready", display: true, timestamp: 0,
    details: { messages: [{ from: "worker", recipients: ["root"], summary: "Ready to review" }] } }, teamMessageRenderer());
  chat.addChild(incoming);
  chat.addChild(send);
  let toolsExpanded = false;
  bindNoticeGroups({ mode: "tui", ui: { theme, getToolsExpanded: () => toolsExpanded, setWidget(_key, factory) {
    if (typeof factory === "function") factory({ children: [{ children: [chat] }], requestRender() {} } as unknown as TUI, theme);
  } } } as ExtensionContext, () => ({ root: "Main" }), () => "Main", () => false);
  const draw = (width = 180) => chat.render(width).map(stripVTControlCharacters).join("\n");
  const folded = draw();
  assert.match(folded, /● ac-teams activity · Received 1 message; sent 1 message/);
  assert.doesNotMatch(folded, /Message received|Message sent/);
  chat.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 180, height: chat.render(180).length, screenX: 2, screenY: 1, shift: false, alt: false, ctrl: false });
  assert.match(draw(), /Message sent · Main agent \(this session\) → worker/);
  assert.match(draw(), /Message received · worker → Main agent \(this session\)/);
  assert.equal((draw().match(/Ready to review/g) ?? []).length, 1, "opening a group does not repeat its preview");
  assert.ok(draw().indexOf("Message received") < draw().indexOf("Message sent"));
  const rendered = chat.render(180).map(stripVTControlCharacters);
  const y = rendered.findIndex(line => line.includes("Message sent"));
  assert.equal(chat.handleMouse({ type: "click", button: "left", x: 2, y, width: 180, height: rendered.length, screenX: 2, screenY: y, shift: false, alt: false, ctrl: false })?.handled, true);
  assert.match(draw(), /Check cancellation handling/);
  assert.match(draw(), /To: worker/);
  assert.doesNotMatch(draw(), /Technical details|"recipients"/);
  for (const width of [12, 40, 80]) assert.ok(chat.render(width).every(line => visibleWidth(line) <= width));
  toolsExpanded = true;
  assert.match(draw(), /Message sent · Main agent \(this session\) → worker/);
  assert.match(draw(), /Message received · worker → Main agent \(this session\)/);
  toolsExpanded = false;
  send.setExpanded(false);
  incoming.setExpanded(false);
  assert.equal(draw(), folded);
});

test("team tools show human actions and results rather than tool names or JSON counts", () => {
  for (const [name, args, result, pendingTitle, completeTitle, body] of [
    ["team_agent", { action: "launch", name: "Reviewer", brief: "Review tests" }, { id: "member-1", name: "Reviewer", status: "busy" }, /Starting teammate · Reviewer/, /Teammate started · Reviewer/, undefined],
    ["team_task", { action: "create", title: "Fix spacing" }, { id: "task-1", title: "Fix spacing", status: "todo" }, /Creating tasks/, /Tasks created/, /Fix spacing · Not started/],
    ["team_message", { action: "send", recipients: ["member-1"], summary: "Please review" }, { seq: 7, recipients: ["member-1"] }, /Sending message/, /Message sent/, /Please review/],
  ] as const) {
    const component = row(name, args);
    const pending = lines(component);
    assert.equal(pending.length, 2, "Pi's separator and a human action heading");
    assert.equal(pending[0], "");
    assert.match(pending[1], pendingTitle);
    assert.doesNotMatch(pending[1], /team_agent|team_task|team_message|[{}]/);
    finish(component, result);
    const complete = lines(component);
    assert.match(complete[1], completeTitle);
    if (body) assert.match(complete.join("\n"), body);
    assert.match(complete[1], /ctrl\+o for details/);
    assert.doesNotMatch(complete.join("\n"), /team_agent|team_task|team_message|seq:|\+\d+ lines|[{}▸▾]/);
  }
});

test("long and multiline arguments stay one line at narrow widths without losing expanded results", () => {
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
  assert.match(expanded, /Id: member-1/);
  assert.match(expanded, /Status: Working/);
  assert.match(expanded, /Nested:\n\s+Full: response/);
  assert.match(expanded, /Brief:\n\s+Review 界 tests/, "requested instructions survive in the expanded record");
  assert.doesNotMatch(expanded, /[{}]|Action:/, "call and result are one readable record, not duplicate JSON");
  component.setExpanded(false);
  assert.equal(lines(component).length, 2);
});

test("clicking a completed row expands and collapses through Pi's native mouse region", () => {
  const component = row("team_task", { action: "list" });
  finish(component, { tasks: [{ id: "task-1" }], total: 1 });
  const collapsed = lines(component)[1];
  const x = collapsed.indexOf("details");
  assert.ok(x > 0, "expansion hint is present and clickable");
  const click = { type: "click", button: "left", x, y: 1, width: 120, height: 2, screenX: x, screenY: 1, shift: false, alt: false, ctrl: false } as const;
  assert.equal(component.handleMouse(click)?.handled, true);
  assert.ok(lines(component).join("\n").includes("Total: 1"));
  component.handleMouse(click);
  assert.equal(lines(component).length, 3);
});

test("collapsed task lists preview titles and statuses, never empty request JSON", () => {
  const component = row("team_task", { action: "list" });
  const tasks = [
    { id: "task-1", title: "Fix spacing", status: "todo" },
    { id: "task-2", title: "Check clicks", status: "done" },
  ];
  finish(component, { tasks, total: 2 });
  const collapsed = lines(component, 180).join("\n");
  assert.match(collapsed, /2 of 2 tasks/);
  assert.match(collapsed, /Fix spacing · Not started/);
  assert.match(collapsed, /Check clicks · Completed/);
  assert.doesNotMatch(collapsed, /[{}▸▾]|\+\d+ lines/);
});

test("statuses remain distinct and understandable without color", () => {
  for (const [status, expected] of [
    ["todo", "Not started"], ["in_progress", "In progress"], ["done", "Completed"],
    ["busy", "Working"], ["interrupted", "Stopped unexpectedly"], ["idle", "Ready"],
  ] as const) {
    const component = row("team_task", { action: "read", id: "task-1" });
    finish(component, { title: "Fix spacing", status });
    assert.ok(lines(component, 180).join("\n").includes(`Fix spacing · ${expected}`));
  }
});

test("long previews leave room for the expansion hint and preserve full JSON", () => {
  const component = row("team_task", { action: "create", title: "界 Very long task ".repeat(50) });
  const result = { title: "界 Very long task ".repeat(50), status: "todo" };
  finish(component, result);
  const collapsed = lines(component, 100)[1];
  assert.ok(visibleWidth(collapsed) <= 100);
  assert.match(collapsed, /ctrl\+o for details/);
  assert.doesNotMatch(collapsed, /[{}]/);
  assert.match(lines(component, 100).join("\n"), /Not started/);
  component.setExpanded(true);
  assert.match(lines(component, 100)[1], /ctrl\+o to collapse/);
});

test("lists show counts, and errors remain visible with full text on expansion", () => {
  for (const [name, data, expected] of [
    ["team_agent", { members: [{ id: "root" }, { id: "member-1" }], limit: 10 }, /2 agents/],
    ["team_task", { tasks: [], total: 5 }, /0 of 5 tasks/],
    ["team_message", [{ text: "hello" }], /1 message/],
  ] as const) {
    const component = row(name, { action: name === "team_message" ? "history" : "list" });
    finish(component, data);
    assert.match(lines(component)[1], expected);
  }
  const component = row("team_agent", { action: "launch", brief: "Review" });
  const error = "Team coordinator is not connected\nTry again";
  component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true });
  assert.match(lines(component)[1], /Agent launch failed/);
  assert.match(lines(component).join("\n"), /Team coordinator is not connected/);
  component.setExpanded(true);
  assert.ok(lines(component).map(line => line.trim()).join("\n").includes(error));
});
