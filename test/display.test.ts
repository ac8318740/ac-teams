import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CustomEditor, initTheme, type Theme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type EditorComponent } from "@earendil-works/pi-tui";
import { renderTaskSummary, summaryTasks } from "../src/task-summary.ts";
import { installTeamFooter, showDisplayConfig } from "../src/terminal-ui.ts";
import { cleanText } from "../src/render.ts";
import { readDisplaySettings } from "../src/config.ts";
import type { TaskView } from "../src/types.ts";
import type { PanelHost } from "../src/ui-types.ts";

const task = (number: number, extra: Partial<TaskView> = {}): TaskView => ({ id: `T${number}`, number, label: `Task ${number}`, title: `Full task ${number}`, description: "Acceptance criteria", revision: 1, status: "todo", dependencies: [], blockedBy: [], ...extra });
// SAFETY: these bounded Pi test doubles supply exactly the UI methods used below.
const theme = { fg: (color: string, text: string) => color === "error" ? `\x1b[31m${text}\x1b[39m` : text, bold: (text: string) => text } as unknown as Theme;
const tick = () => new Promise<void>(done => setImmediate(done));

test("summary prioritizes working, ready blockers, blocked, then recent completions with stable ties", () => {
  const tasks = [task(20, { status: "done", completedAt: 200 }), task(2), task(1, { status: "in_progress" }), task(9),
    task(4, { dependencies: ["T2"], blockedBy: ["T2"] }), task(5, { dependencies: ["T2"], blockedBy: ["T2"] }),
    task(7), task(6, { dependencies: ["T7"], blockedBy: ["T7"] }), task(21, { status: "done", completedAt: 100 })];
  assert.deepEqual(summaryTasks(tasks).map(task => task.number), [1, 2, 7, 4, 5]);
  assert.deepEqual(summaryTasks([...tasks].reverse()).map(task => task.number), [1, 2, 7, 4, 5]);
  assert.ok(!summaryTasks(tasks).some(task => task.number === 9), "ordinary ready work stays in /teams");
  const completed = [task(99, { status: "done" }), task(10, { status: "done", completedAt: 200 }), task(11, { status: "done", completedAt: 100 })];
  assert.deepEqual(summaryTasks(completed).map(task => task.number), [10, 11, 99], "use actual completion time rather than creation order");
  assert.deepEqual(summaryTasks([task(1, { status: "in_progress" }), ...completed]).map(task => task.number), [1, 10, 11, 99]);
  assert.deepEqual(summaryTasks([task(1, { status: "done" }), task(2, { status: "done" })]).map(task => task.number), [2, 1], "older tasks have deterministic fallback order");
});

test("summary displays all-task counts, numbered labels, blocker references, and bounded terminal rows", () => {
  const tasks = [task(1, { status: "in_progress", label: "Parser tests" }), task(2, { blockedBy: ["T1"], dependencies: ["T1"] }),
    ...Array.from({ length: 8 }, (_, i) => task(i + 3, { status: "done", completedAt: i }))];
  const rows = renderTaskSummary(tasks, theme, 100).map(cleanText);
  assert.equal(rows.length, 6);
  assert.equal(rows[0], "Tasks 8/10 done");
  assert.match(rows[1], /● #1 Parser tests · working/);
  assert.match(rows[2], /⊘ #2 Task 2 · blocked by #1/);
  assert.match(rows[3], /✓ #10 Task 10 · done/);
  for (const width of [1, 15, 30]) assert.ok(renderTaskSummary(tasks, theme, width).every(row => visibleWidth(row) <= width));
  assert.deepEqual(renderTaskSummary([], theme, 60), []);
});

test("team widgets and status preserve other footers and statuses through toggles and cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const widgets = new Map<string, { component: Component; placement?: string }>();
  const statuses = new Map<string, string>([["another-extension", "keep this status"]]);
  let refreshes = 0, needsInput = true;
  const settings = { tasks: true, agents: true };
  const host: PanelHost = { self: "root", drafts: new Map(), snapshot: async () => {
    refreshes++;
    return { members: [{ id: "worker", name: "reviewer", cwd: "/trial", depth: 1, status: "busy", notified: 0, needsInput }], tasks: [task(1, { status: "in_progress" })], messages: [], limit: 10, depth: 2 };
  }, visit: async () => {}, resume: async () => {}, requestTask: async () => "", feedback: async () => "" };
  const ctx = { cwd: "/trial", model: { id: "fixture" }, getContextUsage: () => ({ tokens: 20000, contextWindow: 100000, percent: 20 }), ui: {
    setWidget(key: string, factory: Function | undefined, options?: { placement: string }) {
      if (factory) widgets.set(key, { component: factory({ requestRender() {} }, theme), placement: options?.placement });
      else widgets.delete(key);
    },
    setStatus(key: string, text: string | undefined) {
      if (text === undefined) statuses.delete(key); else statuses.set(key, text);
    },
    setFooter() { assert.fail("never replace or clear another extension's footer"); },
    getEditorComponent() { return undefined; }, setEditorComponent() {},
  } } as unknown as ExtensionContext;
  const dispose = installTeamFooter({ getThinkingLevel: () => "low" } as ExtensionAPI, ctx, host, settings);
  t.after(dispose);
  await tick();
  const rows = (key: string, width = 100) => widgets.get(key)!.component.render(width).map(cleanText);
  const refresh = async () => { t.mock.timers.tick(1000); await tick(); };
  const text = () => rows("ac-teams-agents").join("\n");
  assert.equal(widgets.get("ac-teams-tasks")!.placement, "aboveEditor");
  assert.equal(widgets.get("ac-teams-agents")!.placement, "belowEditor");
  assert.match(rows("ac-teams-tasks").join("\n"), /Tasks 0\/1 done/);
  assert.match(text(), /● main/);
  assert.ok(!text().includes("20.0% context"), "do not duplicate the existing footer");
  assert.equal(statuses.get("ac-teams"), "Teams 2 agents · 1 working · 0/1 tasks done");
  for (const width of [1, 15, 30]) assert.ok(rows("ac-teams-agents", width).every(row => visibleWidth(row) <= width));
  assert.match(text(), /reviewer · Needs input/);
  assert.ok(!text().includes("Ctrl+Shift+Left"), "Main does not need a return shortcut");
  host.self = "worker";
  assert.match(text(), /Ctrl\+Shift\+Left: Main \(keeps questions open\)/);
  host.self = "root";
  assert.ok(widgets.get("ac-teams-agents")!.component.render(100).join("\n").includes("\x1b[31m · Needs input"), "attention stays red beside the agent name");
  needsInput = false;
  await refresh();
  assert.ok(!text().includes("Needs input"), "answer/cancel clears the label on the next snapshot");
  settings.tasks = false;
  await refresh();
  assert.deepEqual(rows("ac-teams-tasks"), []); assert.match(rows("ac-teams-agents").join("\n"), /● main/);
  assert.equal(statuses.get("ac-teams"), "Teams 2 agents · 1 working");
  settings.tasks = true; settings.agents = false;
  await refresh();
  assert.match(rows("ac-teams-tasks").join("\n"), /Tasks/); assert.deepEqual(rows("ac-teams-agents"), []);
  assert.equal(statuses.get("ac-teams"), "Teams 0/1 tasks done");
  settings.tasks = false;
  await refresh();
  assert.deepEqual(rows("ac-teams-tasks"), []); assert.deepEqual(rows("ac-teams-agents"), []);
  assert.ok(!statuses.has("ac-teams"));
  host.self = "worker";
  assert.match(text(), /Ctrl\+Shift\+Left: Main/, "return hint remains when the agent list is hidden");
  host.self = "root";
  settings.agents = true;
  await refresh();
  assert.ok(statuses.has("ac-teams"));
  dispose();
  assert.equal(widgets.size, 0);
  assert.deepEqual([...statuses], [["another-extension", "keep this status"]]);
  const stoppedAt = refreshes;
  await refresh();
  assert.equal(refreshes, stoppedAt, "cleanup stops polling");
});

test("agent navigation composes with the active editor and cleanup respects later replacements", async t => {
  type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  const inputs: string[] = [], visits: string[] = [];
  let text = "", autocomplete = false;
  const customEditor = {
    focused: true,
    getText: () => text,
    setText(value: string) { text = value; },
    getExpandedText: () => `expanded:${text}`,
    isShowingAutocomplete: () => autocomplete,
    handleInput(input: string) { inputs.push(input); },
    render: (_width: number) => ["custom editor"],
    invalidate() {},
  };
  const previous: Factory = () => customEditor;
  let active: Factory | undefined = previous;
  const host: PanelHost = { self: "root", drafts: new Map(), snapshot: async () => ({
    members: [{ id: "peer", parent: "root", name: "peer", cwd: "/trial", depth: 1, status: "idle", createdAt: 0, notified: 0 }], tasks: [], messages: [], limit: 10, depth: 2,
  }), visit: async id => { visits.push(id); }, resume: async () => {}, requestTask: async () => "", feedback: async () => "" };
  const ctx = { cwd: "/trial", ui: {
    getEditorComponent: () => active,
    setEditorComponent(factory: Factory | undefined) { active = factory; },
    setWidget() {}, setStatus() {}, setFooter() { assert.fail("leave footer ownership alone"); }, notify() {},
  } } as unknown as ExtensionContext;
  const settings = { tasks: true, agents: true };
  const install = () => installTeamFooter({} as ExtensionAPI, ctx, host, settings);
  const dispose = install();
  t.after(dispose);
  await tick();
  assert.notEqual(active, previous);
  // SAFETY: construction only reads borderColor; the custom factory ignores these host objects.
  const args = [{ requestRender() {} }, { borderColor: (text: string) => text }, {}] as unknown as Parameters<Factory>;
  const editor: EditorComponent = active!(...args);
  assert.equal(editor, customEditor, "retain the editor instance and its extension-specific methods");
  assert.equal(editor.getExpandedText!(), "expanded:");
  assert.deepEqual(editor.render(80), ["custom editor"]);
  editor.handleInput("/");
  assert.deepEqual(inputs, ["/"]);
  editor.setText("inline /skill");
  editor.handleInput("\x1b[B");
  editor.setText(""); autocomplete = true;
  editor.handleInput("\x1b[B");
  assert.equal(inputs.length, 3, "text and autocomplete keep ownership of arrow keys");
  autocomplete = false;
  editor.handleInput("\x1b[B");
  assert.equal(customEditor.focused, false);
  editor.handleInput("\x1b[B"); editor.handleInput("\r");
  assert.deepEqual(visits, ["peer"]);
  assert.equal(customEditor.focused, true);
  editor.handleInput("\x1b[B"); editor.handleInput("x");
  assert.equal(inputs.at(-1), "x", "typing exits selector and reaches the custom editor");
  settings.agents = false;
  editor.handleInput("\x1b[B");
  assert.equal(inputs.at(-1), "\x1b[B");
  dispose();
  assert.equal(active, previous, "restore the original factory rather than the default editor");

  const disposeAgain = install();
  const later: Factory = () => customEditor;
  active = later;
  disposeAgain();
  assert.equal(active, later, "do not remove another extension's later editor");
  editor.handleInput("\x1b[B");
  assert.equal(inputs.at(-1), "\x1b[B", "a retained editor no longer intercepts keys after disposal");

  active = undefined;
  const disposeDefault = install();
  assert.ok(active!(...args) instanceof CustomEditor, "retain the default editor fallback");
  disposeDefault();
  assert.equal(active, undefined);
});

test("native settings screen toggles independently and preserves values on failed save", async () => {
  const home = mkdtempSync(join(tmpdir(), "at-settings-ui-")), oldHome = process.env.HOME;
  process.env.HOME = home;
  initTheme("dark");
  let component: Component & { handleInput(data: string): void };
  const errors: string[] = [], settings = { tasks: true, agents: true };
  const ctx = { ui: { notify(message: string) { errors.push(message); }, custom(factory: Function) {
    return new Promise<void>(done => { component = factory({ requestRender() {} }, theme, {}, done); });
  } } } as unknown as ExtensionContext;
  try {
    const pending = showDisplayConfig(ctx, settings);
    assert.match(component!.render(80).map(cleanText).join("\n"), /Teams display · global/);
    for (const width of [1, 30, 64]) assert.ok(component!.render(width).every(row => visibleWidth(row) <= width));
    component!.handleInput(" ");
    assert.deepEqual(settings, { tasks: false, agents: true });
    component!.handleInput("\x1b[B"); component!.handleInput("\r");
    assert.deepEqual(settings, { tasks: false, agents: false });
    assert.deepEqual(readDisplaySettings(), settings);
    const path = join(home, ".acstack", "ac-teams", "display.json");
    writeFileSync(path, "{");
    component!.handleInput(" ");
    assert.deepEqual(settings, { tasks: false, agents: false });
    assert.match(errors[0], /display settings/);
    assert.equal(readFileSync(path, "utf8"), "{");
    component!.handleInput("\x1b"); await pending;
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
