import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { buildTaskFocus, buildTaskGraph, moveTaskSelection, shortenTitle, taskStatus } from "../src/ui/graph.ts";
import { GraphViewport } from "../src/ui/graph-viewport.ts";
import { cleanText } from "../src/ui/render.ts";
import type { TaskView } from "../src/types.ts";

const task = (id: string, overrides: Partial<TaskView> = {}): TaskView => ({
  id, number: Number(id.replace(/^T/, "")) || 1, label: `Task ${id}`, revision: 1, title: `Task ${id}`, description: "Real task description", dependencies: [], status: "todo", blockedBy: [], ...overrides,
});
const tasks = [task("T03", { status: "done" }), task("T12", { status: "in_progress", dependencies: ["T03"] }),
  task("T21", { dependencies: ["T03"] }), task("T18", { dependencies: ["T12", "T21"], blockedBy: ["T12", "T21"] })];
// SAFETY: these bounded Pi doubles implement only the documented methods the UI uses.
const theme = {
  fg(color: string, text: string) { return `\x1b[${color === "dim" ? 90 : color === "accent" ? 95 : 37}m${text}\x1b[39m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
  underline(text: string) { return `\x1b[4m${text}\x1b[24m`; },
  style(text: string, options: { fg: Parameters<typeof foregroundAnsi>[0] }) { return foregroundAnsi(options.fg, "256color") + text + "\x1b[39m"; },
} as unknown as Theme;

test("graph viewport reuses rows, invalidates styles, and replaces task snapshots", () => {
  const viewport = new GraphViewport();
  let styled = 0;
  const countingTheme = { ...theme, fg: (color: Parameters<Theme["fg"]>[0], text: string) => {
    styled++; return theme.fg(color, text);
  } } as Theme;
  const first = viewport.render(tasks, "T12", 180, 100, countingTheme)!;
  assert.ok(first);
  const rows = first.rows(0, first.height);
  const calls = styled;
  assert.deepEqual(first.rows(0, first.height), rows);
  assert.equal(styled, calls, "cached visible rows do not restyle");
  viewport.invalidate();
  const restyled = viewport.render(tasks, "T12", 180, 100, countingTheme)!;
  assert.deepEqual(restyled.rows(0, restyled.height), rows);
  assert.ok(styled > calls, "theme invalidation redraws cached rows");
  const changed = tasks.map(item => ({ ...item, title: `Updated ${item.id}` }));
  viewport.update();
  const next = viewport.render(changed, "T12", 180, 100, theme)!;
  assert.match(cleanText(next.rows(0, next.height).join("\n")), /Updated T12/);
  viewport.zoomBy(true, changed);
  assert.equal(viewport.render(changed, "T12", 180, 100, theme)!.zoom === "fit", false);
  viewport.fit();
  assert.equal(viewport.render(changed, "T12", 180, 100, theme)!.zoom, "fit");
});

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
  const graph = buildTaskGraph([task(first, { number: 1, label: "Core", title: "Core", status: "done" }), task(second, { number: 2, label: "Parser tests", title: "Parser tests", dependencies: [first] })]);
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

test("graph bounds scan each Unicode row once instead of rescanning it per box", t => {
  let segmented = 0;
  const segment = Intl.Segmenter.prototype.segment;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string) {
    segmented += input.length;
    return segment.call(this, input);
  });
  const graph = buildTaskGraph(Array.from({ length: 40 }, (_, i) => task(`T${i + 1}`, {
    title: `Review 解析器 👩‍💻 e\u0301 ${i + 1}`,
  })));
  assert.ok(graph);
  assert.equal(graph.bounds.size, 40);
  const area = graph.art.plain.reduce((size, row) => size + row.length, 0);
  assert.ok(segmented < area * 20, `${segmented} characters segmented for ${area} characters of graph`);
  for (const [id, box] of graph.bounds) {
    for (const [y, x, corner] of [[box.top, box.left, "┌"], [box.top, box.right, "┐"], [box.bottom, box.left, "└"], [box.bottom, box.right, "┘"]] as const) {
      assert.equal(sliceByColumn(graph.art.plain[y], x, 1), corner, id);
    }
    assert.match(sliceByColumn(graph.art.plain[box.top + 1], box.left + 1, box.right - box.left - 1), /Review 解析器 👩‍💻 e\u0301/);
  }
});

test("focus stacks multiple parents and shared dependents without hiding original blockers", () => {
  const data = [task("T1", { title: "解析器 👩‍💻 e\u0301 contracts", status: "done" }), task("T2", { dependencies: ["T1"] }),
    task("T3", { dependencies: ["T1", "T2"], blockedBy: ["T2"] }),
    task("T4", { dependencies: ["T3", "T2", "T5"], blockedBy: ["T3", "T2", "T5"] }), task("T5")];
  const before = JSON.stringify(data);
  for (const width of [26, 40, 75]) {
    const graph = buildTaskFocus(data, "T3", width, 80);
    assert.ok(graph);
    assert.deepEqual([...graph.bounds.keys()], ["T1", "T2", "T3", "T4"]);
    assert.ok(graph.art.plain.every(row => visibleWidth(row) <= width));
    assert.equal(graph.art.width, width);
    const content = (id: string) => {
      const box = graph.bounds.get(id)!;
      return graph.art.plain.slice(box.top + 1, box.bottom).map(row => sliceByColumn(row, box.left + 1, box.right - box.left - 1).trim()).join(" ");
    };
    assert.match(content("T1"), /解析器 👩‍💻 e\u0301 contracts · Done/);
    assert.match(content("T2"), /Needs #1/);
    assert.match(content("T3"), /Blocked$/);
    assert.match(content("T4"), /Also needs #2, #5 · Blocked/);
    assert.ok(graph.bounds.get("T2")!.bottom < graph.bounds.get("T3")!.top);
    assert.ok(graph.bounds.get("T3")!.bottom < graph.bounds.get("T4")!.top);
    for (const box of graph.bounds.values()) {
      assert.equal(sliceByColumn(graph.art.plain[box.top], box.left, 1), "┌");
      assert.equal(sliceByColumn(graph.art.plain[box.bottom], box.right, 1), "┘");
    }
  }
  assert.equal(JSON.stringify(data), before);
  assert.equal(buildTaskFocus(data, "missing", 40, 80), null);
  assert.equal(buildTaskFocus(data, "T3", 15, 80), null);
  assert.equal(buildTaskFocus([task("T1", { dependencies: ["missing"] })], "T1", 40, 80), null);
  assert.equal(buildTaskFocus([task("T1", { dependencies: ["T1"] })], "T1", 40, 80), null);
  assert.equal(buildTaskFocus([task("T1"), task("T1")], "T1", 40, 80), null);
});

test("focus keeps every high-fanout neighbor selectable at bounded width", () => {
  const data = Array.from({ length: 80 }, (_, i) => task(`T${i + 1}`, { dependencies: i ? ["T1"] : [] }));
  const graph = buildTaskFocus(data, "T1", 40, 1000);
  assert.ok(graph);
  assert.equal(graph.bounds.size, 80);
  assert.ok(graph.art.plain.every(row => visibleWidth(row) <= 40));
  assert.equal(moveTaskSelection(graph.bounds, "T1", "down"), "T2");
  assert.equal(moveTaskSelection(graph.bounds, "T79", "down"), "T80");
  assert.equal(moveTaskSelection(graph.bounds, "T80", "up"), "T79");
});

test("focus anchors the selected box and bounds neighbor overflow independently", () => {
  const data = [task("T1"), task("T2", { title: "A long prerequisite title that wraps across several lines", dependencies: ["T1"] }),
    task("T3", { dependencies: ["T1", "T2"], blockedBy: ["T2"] }), task("T4", { dependencies: ["T3"] })];
  for (const id of ["T1", "T2", "T3", "T4"]) {
    const graph = buildTaskFocus(data, id, 40, 36);
    assert.ok(graph);
    assert.equal(graph.bounds.get(id)?.top, 18, "selection must not move when neighbor heights/counts change");
    assert.equal(graph.bounds.get(id)?.left, 4);
    assert.equal(graph.art.plain.length, 36);
    assert.match(graph.art.plain[0], /Prerequisites/);
    assert.match(graph.art.plain[17], /Focused task/);
    assert.match(graph.art.plain.join("\n"), /Dependents/);
    assert.ok(graph.art.plain.every(line => visibleWidth(line) <= 40));
    if (id === "T1") assert.match(graph.art.plain[1], /No prerequisites/, "empty state belongs directly below its section header");
    if (id === "T4") assert.match(graph.art.plain.join("\n"), /No dependents/);
  }
  const many = Array.from({ length: 80 }, (_, i) => task(`T${i + 1}`, { dependencies: i ? ["T1"] : [] }));
  const graph = buildTaskFocus(many, "T1", 40, 30)!;
  assert.equal(graph.bounds.get("T1")?.top, 15);
  const hidden = graph.art.plain.join("\n").match(/(\d+) more dependents/);
  assert.ok(hidden);
  assert.equal(Number(hidden[1]) + graph.bounds.size, 80);
  for (const box of graph.bounds.values()) {
    assert.ok(box.top >= 0 && box.bottom < 30);
    assert.equal(sliceByColumn(graph.art.plain[box.top], box.left, 1), "┌");
    assert.equal(sliceByColumn(graph.art.plain[box.bottom], box.right, 1), "┘");
  }
  const prerequisites = many.map((item, i) => ({ ...item, dependencies: i === 79 ? many.slice(0, 79).map(parent => parent.id) : [], blockedBy: i === 79 ? ["T1"] : [] }));
  const parentGraph = buildTaskFocus(prerequisites, "T80", 40, 30)!;
  const hiddenParents = parentGraph.art.plain.join("\n").match(/(\d+) more prerequisites/);
  assert.ok(hiddenParents);
  assert.equal(Number(hiddenParents[1]) + parentGraph.bounds.size, 80);
  assert.equal(parentGraph.bounds.get("T80")?.top, 15);
  assert.match(parentGraph.art.plain.join("\n"), /Blocked/);
  for (const width of [16, 18, 26]) {
    const narrow = buildTaskFocus([task("T1")], "T1", width, 40)!;
    assert.ok(narrow.art.plain.every(line => visibleWidth(line) <= width));
    assert.match(narrow.art.plain.join("\n"), /Ready/);
  }
  for (const height of [8, 0, 2001, NaN, 30.5]) {
    assert.equal(buildTaskFocus(data, "T2", 40, height), null, "invalid/short viewports must not hide selected status");
  }
});

test("shortenTitle prefers word boundaries and keeps short titles whole", () => {
  assert.equal(shortenTitle("Count lines in a.txt", 40), "Count lines in a.txt");
  assert.equal(shortenTitle("Count lines in a.txt", 12), "Count lines…");
  assert.equal(shortenTitle("Supercalifragilistic", 8), "Superca…");
  assert.equal(shortenTitle("Anything", 1), "");
});
