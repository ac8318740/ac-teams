import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { taskStatus } from "./graph.ts";
import { cleanText as clean } from "../text.ts";
import type { Message, TaskView } from "../types.ts";
import type { TeamSnapshot } from "./types.ts";
import type { PanelFormat } from "./panel-format.ts";
import type { GraphFrame } from "./graph-viewport.ts";
import { taskDetails, memberDetails, eventDetails } from "./panel-details.ts";

type ListView = {
  tasks: TaskView[]; members: TeamSnapshot["members"]; messages: Message[]; events: Message[]; ids: string[];
  taskIndex: number; memberIndex: number; eventIndex: number; tab: number; detail: boolean; graph: boolean;
  scroll: number; detailScroll: number; width: number; bodyHeight: number; graphData?: GraphFrame;
  session: { self: string; child: boolean; cwd: string };
};

export function panelLists(data: ListView, style: PanelFormat) {
  const { tasks, members, messages, events, ids, taskIndex, memberIndex, eventIndex, tab, detail, graph, width, bodyHeight, graphData, session } = data;
  let { scroll, detailScroll } = data;
  const { fg, stateLabel, pad, heading, tableHeader, taskTitle, headline, taskRef, kindLabel, clock, name } = style;
  const taskProgress = (id: string) => { const assigned = tasks.filter(task => task.owner === id); return `${assigned.filter(task => task.status === "done").length}/${assigned.length}`; };
  if (detail) {
    const lines = tab === 0 ? taskDetails(tasks[taskIndex], tasks, messages, style, width) : tab === 1 ? memberDetails(ids[memberIndex], members, tasks, session, style, width) : eventDetails(events[eventIndex], tasks, messages, style, width);
    detailScroll = Math.min(detailScroll, Math.max(0, lines.length - bodyHeight));
    return { lines: lines.slice(detailScroll, detailScroll + bodyHeight), scroll, detailScroll };
  }
  const split = width >= 83;
  const leftWidth = split ? Math.floor((width - 3) * 0.6) : width;
  const rightWidth = width - leftWidth - 3;
  let left: string[], right: string[], selectedRow: number;
  let selectedHeight = 1, graphWidth = 0;
  if (tab === 0) {
    const titleWidth = Math.max(1, leftWidth - 12);
    left = graphData ? [] : tasks.length ? [tableHeader(`  ${pad("Task", titleWidth)}   State`), "",
      ...tasks.map((task, index) => {
        const selected = index === taskIndex;
        const body = fg(taskStatus(task) === "Done" ? "dim" : "text", pad(taskTitle(task.id), titleWidth));
        return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `)
          + (selected ? style.bold(body) : body) + "   " + stateLabel(task);
      })] : [heading("No tasks yet"), "N  Request a task from Main"];
    selectedRow = graphData ? graphData.selectedRow : taskIndex + 2;
    selectedHeight = graphData?.selectedHeight ?? 1;
    graphWidth = graphData?.width ?? 0;
    right = split ? taskDetails(tasks[taskIndex], tasks, messages, style, rightWidth) : [];
    if (graph && !graphData && tasks.length) left[0] = fg("muted", "Graph unavailable or too large; showing list.");
  } else if (tab === 1) {
    const sessionWidth = Math.min(17, Math.max(1, Math.floor(leftWidth / 2)));
    const preferredNameWidth = Math.min(24, Math.max(18, ...ids.map(id => visibleWidth(name(id)))));
    const tasksWidth = Math.max(5, ...ids.map(id => taskProgress(id).length));
    const showTasks = leftWidth >= 2 + preferredNameWidth + 4 + sessionWidth + 4 + tasksWidth;
    const directory = (id: string) => clean(basename(members.find(member => member.id === id)?.cwd ?? (id === session.self ? session.cwd : ""))) || "—";
    const directorySpace = showTasks ? leftWidth - (2 + preferredNameWidth + 4 + sessionWidth + 4 + tasksWidth + 4) : 0;
    const showDirectory = directorySpace >= 10;
    const directoryWidth = showDirectory ? Math.min(directorySpace, Math.max(10, ...ids.map(id => visibleWidth(directory(id))))) : 0;
    let nameWidth = Math.max(1, Math.min(preferredNameWidth, leftWidth - sessionWidth - 6));
    const gaps = 1 + Number(showTasks) + Number(showDirectory);
    const spare = Math.max(0, leftWidth - (2 + nameWidth + sessionWidth + (showTasks ? tasksWidth : 0) + directoryWidth + 4 * gaps));
    const nameExtra = Math.min(spare, Math.max(0, ...ids.map(id => visibleWidth(name(id)) - nameWidth)));
    const gap = " ".repeat(4 + Math.floor((spare - nameExtra) / gaps));
    nameWidth += nameExtra + (spare - nameExtra) % gaps;
    left = [tableHeader(`  ${pad("Member", nameWidth)}${gap}${pad("State", sessionWidth)}`
      + (showTasks ? `${gap}${pad("Done", tasksWidth)}` : "") + (showDirectory ? `${gap}Directory` : "")), ...ids.map((id, index) => {
      const member = members.find(member => member.id === id);
      const selected = index === memberIndex;
      const stopped = member && ["stopped", "interrupted"].includes(member.status);
      const description = member?.needsInput ? "Needs input" : id === "root" ? "Main conversation"
        : clean(member?.status ?? "Unavailable").replace(/^./, char => char.toUpperCase());
      const color = member?.needsInput || member?.status === "interrupted" ? "error"
        : member?.status === "busy" ? "accent" : "muted";
      const memberName = fg(selected ? "accent" : stopped ? "dim" : "text", pad(name(id), nameWidth));
      return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `)
        + (selected ? style.bold(memberName) : memberName) + gap + fg(color, pad(description, sessionWidth))
        + (showTasks ? fg("muted", `${gap}${pad(taskProgress(id), tasksWidth)}`) : "")
        + (showDirectory ? fg("muted", `${gap}${pad(directory(id), directoryWidth)}`) : "");
    })];
    if (!ids.length) left.push(fg("muted", "No matching teammates."));
    selectedRow = memberIndex + 1;
    right = split ? memberDetails(ids[memberIndex], members, tasks, session, style, rightWidth) : [];
  } else {
    // One row per post: who, what kind, its summary headline, then task and time as quieter context.
    const fromWidth = Math.min(16, Math.max(4, ...events.map(event => visibleWidth(name(event.from)))));
    const taskWidth = Math.min(5, Math.max(4, ...events.map(event => event.task ? visibleWidth(taskRef(event.task)) : 0)));
    const summaryWidth = Math.max(1, leftWidth - (2 + fromWidth + 2 + 7 + 2 + 2 + taskWidth + 2 + 5));
    left = events.length ? [tableHeader(`  ${pad("From", fromWidth)}  ${pad("Kind", 7)}  ${pad("Summary", summaryWidth)}  ${pad("Task", taskWidth)}  Time`),
      ...events.map((event, index) => {
        const selected = index === eventIndex;
        const from = pad(name(event.from), fromWidth), summary = pad(headline(event), summaryWidth);
        return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `) + (selected ? style.bold(fg("accent", from)) : from) + "  "
          + kindLabel(event) + "  " + (selected ? style.bold(summary) : summary) + "  "
          + fg("muted", pad(event.task ? taskRef(event.task) : "", taskWidth)) + "  " + fg("dim", clock(event.time).slice(0, 5));
      })] : [heading("No posts yet"), fg("muted", "Updates, questions, replies, and outcomes appear here.")];
    selectedRow = eventIndex + 1;
    right = split ? eventDetails(events[eventIndex], tasks, messages, style, rightWidth) : [];
  }

  const viewHeight = Math.max(1, bodyHeight - (graphWidth ? graphData?.focus ? 1 : 2 : 0));
  if (graphData?.focus) scroll = 0;
  if (selectedRow < scroll) scroll = selectedRow;
  if (selectedRow + selectedHeight > scroll + viewHeight) scroll = selectedRow + selectedHeight - viewHeight;
  const rowCount = graphData?.height ?? left.length;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rowCount - viewHeight)));
  const viewport = graphData ? graphData.rows(scroll, scroll + viewHeight) : left.slice(scroll, scroll + viewHeight);
  if (graphWidth) {
    if (!graphData?.focus) viewport.unshift(fg("dim", graphData?.jumps === null
      ? "Line jumps unavailable; original wires retained"
      : `Rounded bridges (${graphData?.jumps ?? 0}); other overlaps unchanged`));
    const hidden = scroll || rowCount > scroll + viewHeight || graphWidth > leftWidth;
    viewport.unshift(fg("muted", (graphData?.focus ? `Focus: ${graphData.count} of ${tasks.length} tasks · A Full map` : `Full map: ${tasks.length} tasks · Zoom ${Math.round(100 * graphData!.shownZoom / graphData!.longest)}%${graphData?.zoom === "fit" ? graphData?.fits ? " (fit)" : " (pan to explore)" : ""}`)
      + (hidden ? ` · ↑ ${scroll} rows · ↓ ${Math.max(0, rowCount - scroll - viewHeight)} rows` : "")
      + (graphWidth > leftWidth ? ` · ← ${graphData!.columnScroll} cols · ${Math.max(0, graphWidth - graphData!.columnScroll - leftWidth)} cols →` : "")));
  }
  const lines = Array.from({ length: bodyHeight }, (_, index) => {
    let row = viewport[index] ?? "";
    if (!graphWidth && index === 0 && scroll > 0 && selectedRow !== scroll) row = fg("muted", `↑ ${scroll} rows above`);
    if (!graphWidth && index === bodyHeight - 1 && scroll + bodyHeight < left.length && selectedRow !== scroll + index) row = fg("muted", `↓ ${left.length - scroll - bodyHeight} rows below`);
    return split ? pad(row, leftWidth) + fg("dim", " │ ") + truncateToWidth(right[index] ?? "", rightWidth) : row;
  });
  return { lines, scroll, detailScroll };
}
