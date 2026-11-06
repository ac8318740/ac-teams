import { render, type MermaidArt } from "grok-mermaid";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import type { TaskView } from "../types.ts";
import { cleanText } from "../text.ts";

export function taskStatus(task: TaskView): "Done" | "Blocked" | "Working" | "Ready" {
  return task.status === "done" ? "Done" : task.blockedBy.length ? "Blocked" : task.status === "in_progress" ? "Working" : "Ready";
}
export type Bounds = { left: number; right: number; top: number; bottom: number };
export type Direction = "up" | "down" | "left" | "right";
export type TaskGraph = { art: MermaidArt; bounds: Map<string, Bounds>; jumps?: number | null };

const label = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Shorten a title to at most `budget` columns, preferring a word boundary, with an ellipsis when cut. */
export function shortenTitle(title: string, budget: number): string {
  if (visibleWidth(title) <= budget) return title;
  if (budget < 2) return "";
  const cut = sliceByColumn(title, 0, budget - 1), space = cut.lastIndexOf(" ");
  return (space >= cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

const prerequisites = (task: TaskView) => [...task.dependencies, ...task.completionDependencies];

function validGraphTasks(tasks: TaskView[]): boolean {
  const ids = new Set(tasks.map(task => task.id));
  return tasks.length > 0 && tasks.length <= 100 && tasks.reduce((size, task) => size + prerequisites(task).length, 0) <= 300
    && ids.size === tasks.length && new Set(tasks.map(task => task.number)).size === tasks.length
    && !tasks.some(task => task.id.length > 128 || !Number.isSafeInteger(task.number) || task.number < 1 || prerequisites(task).some(id => !ids.has(id)));
}

/** Anchor one task; bound each neighbor group separately without clipping boxes or inventing edges. */
export function buildTaskFocus(tasks: TaskView[], id: string, width: number, height: number): TaskGraph | null {
  if (!validGraphTasks(tasks) || !Number.isSafeInteger(width) || width < 16 || width > 2000
    || !Number.isSafeInteger(height) || height < 14 || height > 2000) return null;
  const numbers = new Map(tasks.map(task => [task.id, task.number]));
  const selected = tasks.find(task => task.id === id);
  if (!selected || prerequisites(selected).includes(id)) return null;
  const parents = tasks.filter(task => prerequisites(selected).includes(task.id));
  const children = tasks.filter(task => prerequisites(task).includes(id));
  if (children.some(task => task.id === id || parents.includes(task))) return null;
  const boxWidth = width - 4, interior = boxWidth - 2, anchor = Math.floor(height / 2);
  const entry = (task: TaskView, role: "parent" | "selected" | "child") => {
    const extra = task.dependencies.filter(parent => role === "parent" || role === "child" && parent !== id);
    const finish = task.completionDependencies.filter(parent => role !== "child" || parent !== id);
    const edgeKind = role === "parent" ? selected.completionDependencies.includes(task.id) ? " · For finish" : "" : role === "child" ? task.completionDependencies.includes(id) ? " · Gates finish" : "" : "";
    const references = (extra.length ? ` · ${role === "child" ? "Also needs" : "Needs"} ${extra.map(parent => `#${numbers.get(parent)}`).join(", ")}` : "")
      + (finish.length ? ` · Finish needs ${finish.map(parent => `#${numbers.get(parent)}`).join(", ")}` : "") + edgeKind;
    const lines = wrapTextWithAnsi(`○ #${task.number} ${cleanText(task.title).replace(/\s+/g, " ")}${references}${task.completionBlockedBy.length && !task.blockedBy.length ? " · Finish blocked" : ""} · ${taskStatus(task)}`, interior - 2);
    return { task, lines, height: lines.length + 2 };
  };
  type Entry = ReturnType<typeof entry>;
  const focus = entry(selected, "selected"), dependentHeader = anchor + focus.height + 2;
  if (dependentHeader + 1 >= height) return null;
  const fit = (entries: Entry[], capacity: number, reverse = false) => {
    const overflow = entries.reduce((sum, item) => sum + item.height, Math.max(0, entries.length - 1)) > capacity;
    const shown: Entry[] = [];
    let used = Number(overflow);
    for (const item of reverse ? [...entries].reverse() : entries) {
      const size = item.height + Number(shown.length > 0);
      if (used + size > capacity) break;
      shown.push(item); used += size;
    }
    if (reverse) shown.reverse();
    return { shown, hidden: entries.length - shown.length, height: used };
  };
  const above = fit(parents.map(task => entry(task, "parent")), anchor - 2, true);
  const below = fit(children.map(task => entry(task, "child")), height - dependentHeader - 1);
  const bounds = new Map<string, Bounds>();
  const art: MermaidArt = { plain: Array(height).fill(""), styled: Array.from({ length: height }, () => []), width, warnings: [] };
  const put = (y: number, spans: MermaidArt["styled"][number]) => {
    art.plain[y] = spans.map(span => span.text).join("").trimEnd(); art.styled[y] = spans;
  };
  const edge = (y: number, text: string) => put(y, [{ text, cls: "edge" }]);
  const heading = (y: number, title: string, prefix = "    ") => {
    const caption = shortenTitle(title, boxWidth), remaining = boxWidth - visibleWidth(caption);
    put(y, [{ text: prefix, cls: "edge" }, { text: caption + (remaining ? " " + "─".repeat(remaining - 1) : ""), cls: "edgeLabel" }]);
  };
  const box = ({ task, lines, height: boxHeight }: Entry, top: number, role: "parent" | "selected" | "child", index = 0, last = false) => {
    bounds.set(task.id, { left: 4, right: width - 1, top, bottom: top + boxHeight - 1 });
    for (let row = 0; row < boxHeight; row++) {
      let prefix = "    ";
      if (role === "parent") {
        if (row === 1) prefix = index ? "├───" : "┌───";
        else if (index || row) prefix = "│   ";
      } else if (role === "selected" && parents.length && row <= 1) prefix = row ? "└──▶" : "│   ";
      else if (role === "child") {
        if (row === 1) prefix = last ? "└──▶" : "├──▶";
        else if (!last || row < 1) prefix = "│   ";
      }
      const spans: MermaidArt["styled"][number] = [{ text: prefix, cls: "edge" }];
      if (!row || row === boxHeight - 1) {
        const center = Math.floor(boxWidth / 2);
        const bar = row && role === "selected" && children.length ? "─".repeat(center - 1) + "┬" + "─".repeat(interior - center) : "─".repeat(interior);
        spans.push({ text: `${row ? "└" : "┌"}${bar}${row ? "┘" : "┐"}`, cls: "border" });
      } else {
        const content = lines[row - 1];
        spans.push({ text: "│", cls: "border" }, { text: " " + content + " ".repeat(Math.max(0, interior - visibleWidth(content) - 1)), cls: "text" }, { text: "│", cls: "border" });
      }
      put(top + row, spans);
    }
  };
  heading(0, `Prerequisites (${parents.length})`);
  let y = anchor - 1 - above.height;
  if (above.hidden) edge(y++, `│   ${shortenTitle(`↑ ${above.hidden} more prerequisites`, boxWidth)}`);
  if (!parents.length) edge(1, "    " + shortenTitle("No prerequisites", boxWidth));
  above.shown.forEach((item, index) => { if (index) edge(y++, "│"); box(item, y, "parent", above.hidden + index); y += item.height; });
  heading(anchor - 1, "Focused task", parents.length ? "│   " : "    ");
  box(focus, anchor, "selected");
  if (children.length) {
    const center = 4 + Math.floor(boxWidth / 2);
    edge(dependentHeader - 2, `${" ".repeat(center)}│`);
    edge(dependentHeader - 1, `┌${"─".repeat(center - 1)}┘`);
  }
  heading(dependentHeader, `Dependents (${children.length})`, children.length ? "│   " : "    ");
  y = dependentHeader + 1;
  if (!children.length) edge(y, "    " + shortenTitle("No dependents", boxWidth));
  below.shown.forEach((item, index) => { if (index) edge(y++, "│"); box(item, y, "child", index, !below.hidden && index === below.shown.length - 1); y += item.height; });
  if (below.hidden) edge(y, `↓   ${shortenTitle(`${below.hidden} more dependents`, boxWidth)}`);
  return { art, bounds };
}

/** Each box shows `#n title · status`; zooming out gives the title fewer columns. Number and status always stay. */
export function buildTaskGraph(tasks: TaskView[], titleBudget = Infinity): TaskGraph | null {
  if (!validGraphTasks(tasks)) return null;
  const source = ["flowchart TD", ...tasks.map((task, index) => `n${index}["○ ${label(`#${task.number} ${shortenTitle(cleanText(task.title), titleBudget)}`.trimEnd())}${task.completionBlockedBy.length && !task.blockedBy.length ? " · Finish blocked" : ""} · ${taskStatus(task)}"]`),
    ...tasks.flatMap((task, index) => [
      ...task.dependencies.map(id => `n${tasks.findIndex(parent => parent.id === id)} --> n${index}`),
      ...task.completionDependencies.map(id => `n${tasks.findIndex(parent => parent.id === id)} -.->|finish| n${index}`),
    ]),
  ].join("\n");
  let art: MermaidArt | null;
  try { art = render(source); } catch { return null; }
  if (!art || art.warnings.length || art.width > 2000 || art.plain.length > 2000) return null;
  const bounds = new Map<string, Bounds>();
  // shortcut: grok-mermaid exposes spans, not node bounds; map rectangular node
  // headers and validate every box. Fall back to the list if its output changes.
  const rendered = art;
  const rowOffsets = new Map<number, Int32Array>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  // Index each plain row once; repeated column slices otherwise rescan it for every box.
  const slice = (y: number, start: number, length: number) => {
    const row = rendered.plain[y] ?? "";
    let offsets = rowOffsets.get(y);
    if (!offsets) {
      offsets = new Int32Array(rendered.width + 1).fill(-1);
      let column = 0;
      for (const { segment, index } of segmenter.segment(row)) {
        offsets[column] = index;
        column += visibleWidth(segment);
      }
      offsets[column] = row.length;
      rowOffsets.set(y, offsets);
    }
    const from = offsets[start], to = offsets[start + length];
    return from >= 0 && to >= 0 ? row.slice(from, to) : sliceByColumn(row, start, length);
  };
  const cell = (y: number, x: number) => slice(y, x, 1);
  rendered.styled.forEach((spans, y) => {
    const borders: number[] = [];
    let column = 0;
    for (const span of spans) {
      if (span.cls === "border") for (const char of span.text) {
        if (char === "│") borders.push(column);
        column += visibleWidth(char);
      } else column += visibleWidth(span.text);
    }
    for (let i = 0; i + 1 < borders.length; i += 2) {
      const left = borders[i], right = borders[i + 1];
      if (cell(y - 1, left) !== "┌" || cell(y - 1, right) !== "┐") continue;
      const header = slice(y, left + 1, right - left - 1).trimStart();
      const task = tasks.find(task => header.startsWith(`○ #${task.number} `) || header === `○ #${task.number}`);
      if (!task || bounds.has(task.id)) continue;
      for (let bottom = y + 1; bottom < rendered.plain.length; bottom++) {
        if (cell(bottom, left) === "└" && cell(bottom, right) === "┘") {
          if (!slice(bottom - 1, left + 1, right - left - 1).trimEnd().endsWith(taskStatus(task))) break;
          bounds.set(task.id, { left, right, top: y - 1, bottom });
          break;
        }
        if (cell(bottom, left) !== "│" || cell(bottom, right) !== "│") break;
      }
    }
  });
  return bounds.size === tasks.length ? { art, bounds } : null;
}

export function moveTaskSelection(bounds: Map<string, Bounds>, id: string, direction: Direction): string {
  const origin = bounds.get(id);
  if (!origin) return id;
  const horizontal = direction === "left" || direction === "right";
  const centerX = (box: Bounds) => (box.left + box.right) / 2;
  const centerY = (box: Bounds) => (box.top + box.bottom) / 2;
  const candidates = [...bounds].filter(([otherId, box]) => {
    if (otherId === id) return false;
    if (horizontal) {
      if (box.top >= origin.bottom || box.bottom <= origin.top) return false;
      return direction === "left" ? box.right < origin.left : box.left > origin.right;
    }
    return direction === "up" ? box.bottom < origin.top : box.top > origin.bottom;
  });
  const distance = (box: Bounds) => horizontal ? Math.abs(centerX(box) - centerX(origin)) : Math.abs(centerY(box) - centerY(origin));
  const offset = (box: Bounds) => horizontal ? Math.abs(centerY(box) - centerY(origin)) : Math.abs(centerX(box) - centerX(origin));
  candidates.sort(([, a], [, b]) => distance(a) - distance(b) || offset(a) - offset(b));
  return candidates[0]?.[0] ?? id;
}
