import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTheme, type Theme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
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

test("task widget is above the editor, selector stays in footer, and toggles and cleanup are independent", async t => {
  let footer: Component | undefined, widget: Component | undefined, refreshes = 0;
  let placement: string | undefined;
  let needsInput = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settings = { tasks: true, agents: true };
  const host: PanelHost = { self: "root", drafts: new Map(), snapshot: async () => {
    refreshes++;
    return { members: [{ id: "worker", name: "reviewer", cwd: "/trial", depth: 1, status: "busy", notified: 0, needsInput }], tasks: [task(1, { status: "in_progress" })], messages: [], limit: 10, depth: 2 };
  }, visit: async () => {}, resume: async () => {}, requestTask: async () => "", feedback: async () => "" };
  const ctx = { cwd: "/trial", model: { id: "fixture" }, getContextUsage: () => ({ tokens: 20000, contextWindow: 100000, percent: 20 }), ui: {
    setWidget(_key: string, factory: Function | undefined, options?: { placement: string }) {
      placement = options?.placement;
      widget = factory?.({}, theme);
    },
    setFooter(factory: Function | undefined) {
      if (factory) footer = factory({ requestRender() {} }, theme, { onBranchChange: () => () => {}, getGitBranch: () => "trial", getExtensionStatuses: () => new Map() });
    }, setEditorComponent() {},
  } } as unknown as ExtensionContext;
  const dispose = installTeamFooter({ getThinkingLevel: () => "low" } as ExtensionAPI, ctx, host, settings);
  t.after(dispose);
  await tick();
  const text = () => footer!.render(100).map(cleanText).join("\n");
  let output = text();
  assert.equal(placement, "aboveEditor");
  assert.match(widget!.render(100).map(cleanText).join("\n"), /Tasks 0\/1 done/);
  assert.ok(!output.includes("Tasks"));
  assert.ok(output.indexOf("● main") > output.indexOf("20.0% context"));
  assert.match(output, /reviewer · Needs input/);
  assert.ok(!output.includes("Ctrl+Shift+Left"), "Main does not need a return shortcut");
  host.self = "worker";
  assert.match(text(), /Ctrl\+Shift\+Left: Main \(keeps questions open\)/);
  host.self = "root";
  assert.ok(footer!.render(100).join("\n").includes("\x1b[31m · Needs input"), "attention stays red beside the agent name");
  needsInput = false;
  t.mock.timers.tick(1000); await tick();
  assert.ok(!text().includes("Needs input"), "answer/cancel clears the label on the next snapshot");
  settings.tasks = false;
  output = text(); assert.deepEqual(widget!.render(100), []); assert.ok(output.includes("● main"));
  settings.tasks = true; settings.agents = false;
  output = text(); assert.match(widget!.render(100).map(cleanText).join("\n"), /Tasks/); assert.ok(!output.includes("● main"));
  settings.tasks = false;
  host.self = "worker";
  output = text(); assert.ok(output.includes("20.0% context")); assert.ok(!output.includes("Tasks")); assert.ok(!output.includes("● main"));
  assert.match(output, /Ctrl\+Shift\+Left: Main/, "return hint remains when the agent list is hidden");
  assert.equal(refreshes, 2);
  dispose(); assert.equal(widget, undefined);
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
