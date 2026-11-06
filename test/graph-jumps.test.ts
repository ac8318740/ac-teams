import test from "node:test";
import assert from "node:assert/strict";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";
import { buildTaskGraph, type TaskGraph } from "../src/ui/graph.ts";
import { addGraphJumps } from "../src/ui/graph-jumps.ts";
import type { TaskView } from "../src/types.ts";

const sample = (dependencies: number[][], title = "Task"): TaskView[] => dependencies.map((parents, i) => ({
  id: `t${i}`, number: i + 1, label: title, title: `${title} ${i + 1}`, description: "", revision: 1,
  status: "todo", dependencies: parents.map(n => `t${n}`), completionDependencies: [], blockedBy: parents.map(n => `t${n}`), completionBlockedBy: parents.map(n => `t${n}`),
}));
const crossing = () => sample([[], [], [], [0, 1, 2], [0, 1, 2], [0, 1, 2]]);
function graphFor(tasks: TaskView[], budget = Infinity): TaskGraph {
  const graph = buildTaskGraph(tasks, budget);
  assert.ok(graph, "fixture must pass the base renderer's bounds validation");
  return graph;
}
function changeCell(graph: TaskGraph, x: number, y: number, glyph: string): TaskGraph {
  let column = 0;
  const styled = graph.art.styled.map((row, index) => index !== y ? row : row.map(span => {
    const start = column;
    column += visibleWidth(span.text);
    return x < start || x >= column ? span : { ...span, text: sliceByColumn(span.text, 0, x - start) + glyph + sliceByColumn(span.text, x - start + 1, column - x - 1) };
  }));
  return { ...graph, art: { ...graph.art, styled, plain: styled.map(row => row.map(span => span.text).join("").replace(/ +$/, "")) } };
}
function unchanged(tasks: TaskView[], graph: TaskGraph) {
  const result = addGraphJumps(tasks, graph);
  assert.equal(result.jumps, null);
  assert.equal(result.art, graph.art);
  assert.equal(result.bounds, graph.bounds);
}

test("independent crossings get continuous rounded bridges without changing boxes or joins", () => {
  const tasks = crossing(), graph = graphFor(tasks), before = structuredClone(graph);
  const result = addGraphJumps(tasks, graph);
  assert.equal(visibleWidth("╭─╮"), 3);
  assert.equal(result.jumps, 1);
  // The bridge joins the horizontal stroke at both ends; the vertical wire passes underneath.
  assert.equal(sliceByColumn(graph.art.plain[4], 67, 1), "┼");
  assert.equal(sliceByColumn(result.art.plain[4], 66, 3), "╭─╮");
  assert.equal(sliceByColumn(result.art.plain[5], 65, 4), "─╯│╰");
  assert.equal(sliceByColumn(result.art.plain[5], 69, 1), "┤", "the neighboring junction remains intact");
  assert.doesNotMatch(result.art.plain.join(""), /∩/);
  assert.equal(result.art.plain.length, graph.art.plain.length + 1);
  for (const x of [13, 41, 69]) assert.equal(sliceByColumn(result.art.plain[4], x, 1), "│", "spacer rows continue every other vertical wire");
  assert.equal(result.art.plain.join("").split("┼").length - 1, 4, "corners and mixed/shared overlaps remain");
  assert.equal(result.art.width, graph.art.width);
  assert.equal(result.art.warnings, graph.art.warnings);
  assert.deepEqual(graph, before, "source graph is immutable");
  for (const [id, box] of graph.bounds) {
    const shifted = result.bounds.get(id)!;
    const delta = box.top >= 4 ? 1 : 0;
    assert.deepEqual(shifted, { ...box, top: box.top + delta, bottom: box.bottom + delta });
    for (let y = box.top; y <= box.bottom; y++) assert.equal(result.art.plain[y + delta], graph.art.plain[y]);
  }
  for (let y = 0; y < result.art.plain.length; y++) {
    assert.ok(visibleWidth(result.art.plain[y]) <= result.art.width);
    assert.equal(result.art.styled[y].map(span => span.text).join("").trimEnd(), result.art.plain[y]);
  }
  const limited = { ...graph, art: { ...graph.art, plain: [...graph.art.plain, ...Array(2000 - graph.art.plain.length).fill("")],
    styled: [...graph.art.styled, ...Array.from({ length: 2000 - graph.art.styled.length }, () => [])] } };
  const retained = addGraphJumps(tasks, limited);
  assert.equal(retained.jumps, 0, "bridges must respect the existing canvas height limit");
  assert.equal(retained.art, limited.art);
});

test("real shared-source and shared-destination joins, corners, and mixed overlaps stay unchanged", () => {
  for (const dependencies of [[[], [0], [0], [0]], [[], [], [], [0, 1, 2]]]) {
    const tasks = sample(dependencies), graph = graphFor(tasks);
    assert.ok(graph.art.plain.join("").includes("┼"), "exercise a real join");
    const result = addGraphJumps(tasks, graph);
    assert.equal(result.jumps, 0);
    assert.equal(result.art, graph.art);
  }
  const tasks = crossing().map(task => ({ ...task, blockedBy: [] })), graph = graphFor(tasks);
  assert.equal(addGraphJumps(tasks, graph).jumps, 0, "shared endpoints and turns disqualify every crossing in this layout");
});

test("singletons, chains, and disconnected maps are verified without inventing jumps", () => {
  for (const dependencies of [[[]], [[], [0], [1]], [[], [], []]]) {
    const tasks = sample(dependencies), graph = graphFor(tasks), result = addGraphJumps(tasks, graph);
    assert.equal(result.jumps, 0);
    assert.equal(result.art, graph.art);
  }
});

test("chains of different task counts and title budgets retain all arrows and bounds", () => {
  for (const count of [2, 9, 17, 60, 100]) for (const budget of [0, 12, Infinity]) {
    const tasks = sample(Array.from({ length: count }, (_, i) => i ? [i - 1] : []));
    const graph = graphFor(tasks, budget), result = addGraphJumps(tasks, graph);
    assert.equal(result.jumps, 0);
    assert.equal(result.art, graph.art);
    assert.equal(result.bounds, graph.bounds);
    assert.equal(result.art.plain.join("").split("▼").length - 1, count - 1);
  }
});

test("skip-rank lanes validate their left-pointing arrows and source-side exits", () => {
  const tasks = sample([[], [0], [0, 1], [0, 1, 2]]);
  // Public renderer output, with independent box coordinates, isolates routing
  // from buildTaskGraph's existing rejection of some side-connected box bounds.
  const art = render('flowchart TD\na["A"]\nb["B"]\nc["C"]\nd["D"]\na --> b\na --> c\nb --> c\na --> d\nb --> d\nc --> d');
  assert.ok(art);
  const graph: TaskGraph = { art, bounds: new Map(tasks.map((task, i) => [task.id, { left: 1, right: 5, top: i * 5, bottom: i * 5 + 2 }])) };
  assert.equal(sliceByColumn(art.plain[11], 6, 1), "◄");
  assert.equal(sliceByColumn(art.plain[6], 7, 1), "┼", "chain/skip routes share destinations at this overlap");
  const result = addGraphJumps(tasks, graph);
  assert.equal(result.jumps, 0);
  assert.equal(result.art, graph.art);
  unchanged(tasks, changeCell(graph, 6, 11, "▼"));
  unchanged(tasks, changeCell(graph, 7, 5, "─"));
  unchanged(tasks, changeCell(graph, 5, 1, "│"));
});

test("Unicode spans use terminal columns, not UTF-16 or code-point offsets", () => {
  const tasks = crossing().map(task => ({ ...task, title: `解析 👩🏽‍💻 e\u0301 ${task.number}` }));
  for (const budget of [0, 12, Infinity]) {
    const graph = graphFor(tasks, budget), before = structuredClone(graph), result = addGraphJumps(tasks, graph);
    assert.notEqual(result.jumps, null);
    assert.deepEqual(graph, before);
    assert.equal(result.art.width, graph.art.width);
    for (const [id, box] of graph.bounds) {
      const shifted = result.bounds.get(id)!;
      assert.equal(shifted.bottom - shifted.top, box.bottom - box.top);
      for (let y = box.top; y <= box.bottom; y++) assert.equal(
        sliceByColumn(result.art.plain[shifted.top + y - box.top], shifted.left, shifted.right - shifted.left + 1),
        sliceByColumn(graph.art.plain[y], box.left, box.right - box.left + 1));
    }
    for (let y = 0; y < result.art.plain.length; y++) {
      assert.ok(visibleWidth(result.art.plain[y]) <= graph.art.width);
      assert.equal(result.art.styled[y].map(span => span.text).join("").trimEnd(), result.art.plain[y]);
    }
  }
  const art = render('flowchart TD\na["解析 👩🏽‍💻 é"]\nb["解析 👩🏽‍💻 é"]\nc["解析 👩🏽‍💻 é"]\na --> b\na --> c\nb --> c');
  assert.ok(art);
  const laneTasks = sample([[], [0], [0, 1]]);
  const lane: TaskGraph = { art, bounds: new Map(laneTasks.map((task, i) => [task.id, { left: 1, right: 13, top: i * 5, bottom: i * 5 + 2 }])) };
  assert.equal(sliceByColumn(art.plain[11], 14, 1), "◄", "lane arrow follows Unicode text spans");
  assert.equal(addGraphJumps(laneTasks, lane).jumps, 0);
  unchanged(laneTasks, changeCell(lane, 14, 11, "▼"));
});

test("mask, missing-arrow, extra-arrow, plain/styled, and unexpected-edge mismatches fail closed", () => {
  const tasks = crossing(), graph = graphFor(tasks);
  unchanged(tasks, changeCell(graph, 67, 4, "─"));
  unchanged(tasks, changeCell(graph, 67, 4, "▼"));
  unchanged(tasks, changeCell(graph, 13, 7, "│"));
  unchanged(tasks, changeCell(graph, 13, 7, "◄"));
  unchanged(tasks, changeCell(graph, 67, 4, "x"));
  unchanged(tasks, { ...graph, art: { ...graph.art, plain: graph.art.plain.map((row, y) => y === 4 ? row.replace("┼", "─") : row) } });
  const extra = structuredClone(graph);
  extra.art.styled[0].unshift({ cls: "edge", text: "▼" });
  extra.art.plain[0] = "▼" + extra.art.plain[0];
  extra.art.width++;
  unchanged(tasks, extra);
});

test("invalid topology and bounds return the original rendering, without trusting incoming metadata", () => {
  const tasks = crossing(), graph = graphFor(tasks);
  unchanged([], graph);
  for (const invalid of [null, [null], tasks.map(task => ({ ...task, completionDependencies: null }))]) {
    unchanged(invalid as unknown as TaskView[], graph);
  }
  unchanged([...tasks, tasks[0]], graph);
  unchanged(tasks.map((task, i) => i ? task : { ...task, dependencies: ["missing"] }), graph);
  unchanged(tasks.map((task, i) => i ? task : { ...task, dependencies: ["t3"] }), graph);
  unchanged(tasks.map((task, i) => i === 3 ? { ...task, dependencies: ["t0", "t0"] } : task), graph);
  unchanged(tasks, { ...graph, bounds: new Map() });
  for (const left of [-1, NaN, 0.5, 2001]) {
    const bounds = new Map(graph.bounds);
    bounds.set("t0", { ...bounds.get("t0")!, left });
    unchanged(tasks, { ...graph, bounds });
  }
  const bounds = new Map(graph.bounds);
  bounds.set("t0", { ...bounds.get("t1")! });
  unchanged(tasks, { ...graph, bounds });
  const annotated = Object.assign(graph, { jumps: 999 });
  assert.equal(addGraphJumps(tasks, annotated).jumps, 1);
  assert.equal(annotated.jumps, 999);
  unchanged(tasks, { ...graph, art: { ...graph.art, warnings: ["unsupported input"] } });
});

test("hostile task, canvas, and string sizes stop before reconstruction", () => {
  const tasks = crossing(), graph = graphFor(tasks);
  unchanged(sample(Array.from({ length: 101 }, () => [])), graph);
  unchanged(tasks.map((task, i) => i ? task : { ...task, dependencies: Array(301).fill("t1") }), graph);
  for (const width of [NaN, Infinity, -1, 0, 1.5, 2001]) unchanged(tasks, { ...graph, art: { ...graph.art, width } });
  unchanged(tasks, { ...graph, art: { ...graph.art, width: 2000, plain: Array(2000).fill(""), styled: Array.from({ length: 2000 }, () => []) } });
  unchanged(tasks, { ...graph, art: { ...graph.art, plain: Array(2001).fill(""), styled: Array.from({ length: 2001 }, () => []) } });
  const huge = "x".repeat(4_000_001);
  unchanged(tasks.map((task, i) => i ? task : { ...task, id: huge }), graph);
  unchanged(tasks.map((task, i) => i ? task : { ...task, dependencies: [huge] }), graph);
  unchanged(tasks, { ...graph, art: { ...graph.art, styled: [[{ cls: "text", text: huge }], ...graph.art.styled.slice(1)] } });
  unchanged(tasks, { ...graph, art: { ...graph.art, plain: [huge, ...graph.art.plain.slice(1)] } });
  const styled = graph.art.styled.slice();
  styled[0] = Array.from({ length: graph.art.width + 1 }, () => ({ cls: "none" as const, text: "" }));
  unchanged(tasks, { ...graph, art: { ...graph.art, styled } });
});
