import { render, type MermaidArt } from "grok-mermaid";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import { taskName, type TaskView } from "./types.ts";
import { cleanText } from "./render.ts";

export function taskStatus(task: TaskView): "Done" | "Blocked" | "Working" | "Ready" {
  return task.status === "done" ? "Done" : task.blockedBy.length ? "Blocked" : task.status === "in_progress" ? "Working" : "Ready";
}
export type Bounds = { left: number; right: number; top: number; bottom: number };
export type Direction = "up" | "down" | "left" | "right";
export type TaskGraph = { art: MermaidArt; bounds: Map<string, Bounds> };

const label = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cell = (art: MermaidArt, y: number, x: number) => sliceByColumn(art.plain[y] ?? "", x, 1);

export function buildTaskGraph(tasks: TaskView[]): TaskGraph | null {
  if (!tasks.length || tasks.length > 100 || tasks.reduce((size, task) => size + task.dependencies.length, 0) > 300) return null;
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length || new Set(tasks.map(task => task.number)).size !== tasks.length || tasks.some(task => task.id.length > 128 || !Number.isSafeInteger(task.number) || task.number < 1 || task.dependencies.some(id => !ids.has(id)))) return null;
  const source = ["flowchart TD", ...tasks.map((task, index) => `n${index}["○ ${label(cleanText(taskName(task)))} · ${taskStatus(task)}"]`),
    ...tasks.flatMap((task, index) => task.dependencies.map(id => `n${tasks.findIndex(parent => parent.id === id)} --> n${index}`)),
  ].join("\n");
  let art: MermaidArt | null;
  try { art = render(source); } catch { return null; }
  if (!art || art.warnings.length || art.width > 2000 || art.plain.length > 2000) return null;
  const bounds = new Map<string, Bounds>();
  // shortcut: grok-mermaid exposes spans, not node bounds; map rectangular node
  // headers and validate every box. Fall back to the list if its output changes.
  const rendered = art;
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
      if (cell(rendered, y - 1, left) !== "┌" || cell(rendered, y - 1, right) !== "┐") continue;
      const header = sliceByColumn(rendered.plain[y], left + 1, right - left - 1).trimStart();
      const task = tasks.find(task => header.startsWith(`○ #${task.number} `));
      if (!task || bounds.has(task.id)) continue;
      for (let bottom = y + 1; bottom < rendered.plain.length; bottom++) {
        if (cell(rendered, bottom, left) === "└" && cell(rendered, bottom, right) === "┘") {
          if (!sliceByColumn(rendered.plain[bottom - 1], left + 1, right - left - 1).trimEnd().endsWith(taskStatus(task))) break;
          bounds.set(task.id, { left, right, top: y - 1, bottom });
          break;
        }
        if (cell(rendered, bottom, left) !== "│" || cell(rendered, bottom, right) !== "│") break;
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
