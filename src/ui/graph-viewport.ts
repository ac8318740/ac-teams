import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { buildTaskFocus, buildTaskGraph, taskStatus, type TaskGraph } from "./graph.ts";
import { addGraphJumps } from "./graph-jumps.ts";
import { cleanText as clean } from "../text.ts";
import type { TaskView } from "../types.ts";
import { panelFormat } from "./panel-format.ts";

export class GraphViewport {
  private graphs = new Map<number, TaskGraph | null>();
  private jumpedGraphs = new WeakMap<TaskGraph, TaskGraph>();
  private zoom: number | "fit" = "fit";
  private shownZoom = 1;
  taskGraph: TaskGraph | null = null;
  private graphScope: "auto" | "all" | "focus" = "auto";
  focusGraph = false;
  private neighborhood: { id: string; width: number; height: number; graph: TaskGraph | null } | undefined;
  private renderedGraph: { graph: TaskGraph; selection: string; width: number; scroll: number; rows: Map<number, string> } | undefined;
  private columnScroll = 0;

  update() { this.graphs.clear(); this.taskGraph = null; this.neighborhood = undefined; }
  invalidate() { this.renderedGraph = undefined; }
  resetPan() { this.columnScroll = 0; }
  toggleScope() { this.graphScope = this.focusGraph ? "all" : "focus"; this.resetPan(); this.taskGraph = null; }
  fit() { this.graphScope = "auto"; this.zoom = "fit"; this.resetPan(); }
  zoomBy(out: boolean, tasks: TaskView[]) {
    this.graphScope = "all";
    const at = this.zoom === "fit" ? this.shownZoom : this.zoom;
    const longest = Math.max(1, ...tasks.map(task => visibleWidth(clean(task.title))));
    this.zoom = out ? Math.max(0, Math.min(at - 1, Math.floor(at / 1.25)))
      : Math.min(longest, Math.max(at + 1, Math.ceil(at * 1.25)));
    this.resetPan();
  }

  render(tasks: TaskView[], selection: string, width: number, bodyHeight: number, theme: Theme) {
    const { fg, statusText, stateLabel } = panelFormat(theme, tasks, []);
    const longest = () => Math.max(1, ...tasks.map(task => visibleWidth(clean(task.title))));
    const graphAt = (budget: number) => { if (!this.graphs.has(budget)) this.graphs.set(budget, buildTaskGraph(tasks, budget)); return this.graphs.get(budget)!; };
    const fits = (g: TaskGraph | null) => !!g && g.art.width <= width && g.art.plain.length <= bodyHeight - 2;
    const minimumTitle = Math.min(12, longest());
    this.focusGraph = this.graphScope === "focus" || this.graphScope === "auto" && !fits(graphAt(minimumTitle));
    if (!this.focusGraph) {
      if (this.zoom === "fit") {
        // Never remove titles to claim a fit. Explicit zoom can still show number/status only.
        let low = minimumTitle, high = longest();
        if (fits(graphAt(high))) low = high;
        else if (fits(graphAt(low))) while (low < high - 1) { const mid = (low + high) >> 1; if (fits(graphAt(mid))) low = mid; else high = mid; }
        this.shownZoom = low;
      } else this.shownZoom = this.zoom;
      const raw = graphAt(this.shownZoom);
      if (raw && !this.jumpedGraphs.has(raw)) this.jumpedGraphs.set(raw, addGraphJumps(tasks, raw));
      this.taskGraph = raw ? this.jumpedGraphs.get(raw) ?? null : null;
      if (this.graphScope === "auto" && !fits(this.taskGraph)) this.focusGraph = true;
    }
    if (this.focusGraph) {
      const id = selection;
      const height = bodyHeight - 1;
      if (this.neighborhood?.id !== id || this.neighborhood.width !== width || this.neighborhood.height !== height) {
        this.neighborhood = { id, width, height, graph: buildTaskFocus(tasks, id, width, height) };
      }
      this.taskGraph = this.neighborhood.graph;
    }
    if (!this.taskGraph || bodyHeight < 3) return undefined;
    const { art, bounds } = this.taskGraph;
    const selected = bounds.get(selection);
    if (!selected) return undefined;
    if (selected.left < this.columnScroll) this.columnScroll = selected.left;
    if (selected.right - selected.left + 1 >= width) this.columnScroll = selected.left;
    else if (selected.right >= this.columnScroll + width) this.columnScroll = selected.right - width + 1;
    this.columnScroll = Math.max(0, Math.min(this.columnScroll, Math.max(0, art.width - width)));
    if (this.renderedGraph?.graph !== this.taskGraph || this.renderedGraph.selection !== selection || this.renderedGraph.width !== width || this.renderedGraph.scroll !== this.columnScroll) {
      this.renderedGraph = { graph: this.taskGraph, selection, width, scroll: this.columnScroll, rows: new Map() };
    }
    const cachedRows = this.renderedGraph.rows;
    const rows = (start: number, end: number) => art.styled.slice(start, end).map((spans, index) => {
      const y = start + index;
      const cached = cachedRows.get(y);
      if (cached !== undefined) return cached;
      const row = spans.map(span => span.cls === "edgeLabel" ? theme.bold(fg("accent", span.text))
        : fg(span.cls === "border" || span.cls === "edge" ? "dim" : "text", span.text)).join("");
      const replacements: { left: number; right: number; text: string }[] = [];
      for (const task of tasks) {
        const box = bounds.get(task.id);
        if (!box || y < box.top || y > box.bottom) continue;
        const active = task.id === selection;
        let text = sliceByColumn(art.plain[y], box.left, box.right - box.left + 1);
        if (active && y === box.top + 1) text = text.replace("○ ", "● ");
        const border = y === box.top || y === box.bottom;
        const content = sliceByColumn(text, 1, box.right - box.left - 1), status = taskStatus(task);
        const color = active ? "accent" : status === "Done" ? "dim" : "text";
        const index = y === box.bottom - 1 && content.trimEnd().endsWith(status) ? content.lastIndexOf(status) : -1;
        const interior = index < 0 ? fg(color, content) : fg(color, content.slice(0, index)) + stateLabel(task) + fg(color, content.slice(index + status.length));
        // The selected box keeps its status colour but gets a heavy border and bold text, so selection never competes with status.
        const edge = (part: string) => statusText(task, active ? part.replace(/[┌┐└┘─│┬┴]/g, ch => ({ "┌": "┏", "┐": "┓", "└": "┗", "┘": "┛", "─": "━", "│": "┃", "┬": "┯", "┴": "┷" })[ch]!) : part);
        const styled = border ? edge(text) : edge("│") + (active ? theme.bold(interior) : interior) + edge("│");
        replacements.push({ left: box.left, right: box.right, text: styled });
      }
      // Slice the original row once per gap; re-slicing styled replacements multiplies ANSI codes.
      let column = 0;
      const parts = replacements.sort((a, b) => a.left - b.left).flatMap(box => {
        const gap = sliceByColumn(row, column, box.left - column);
        column = box.right + 1;
        return [gap, box.text];
      });
      parts.push(sliceByColumn(row, column, art.width - column));
      const indent = " ".repeat(Math.max(0, Math.floor((width - art.width) / 2)));
      const line = indent + sliceByColumn(parts.join(""), this.columnScroll, width);
      cachedRows.set(y, line);
      return line;
    });
    return { rows, height: art.plain.length, selectedRow: selected.top, selectedHeight: selected.bottom - selected.top + 1, width: art.width, fits: fits(this.taskGraph), focus: this.focusGraph, count: bounds.size, jumps: this.taskGraph.jumps, columnScroll: this.columnScroll, shownZoom: this.shownZoom, zoom: this.zoom, longest: longest() };
  }
}

export type GraphFrame = NonNullable<ReturnType<GraphViewport["render"]>>;
