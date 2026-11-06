import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, indexedColor, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { contextSummary } from "./telemetry.ts";
import { buildTaskFocus, buildTaskGraph, moveTaskSelection, taskStatus, type TaskGraph } from "./graph.ts";
import { addGraphJumps } from "./graph-jumps.ts";
import { cleanText as clean } from "./render.ts";
import type { PanelHost } from "./ui-types.ts";
import { taskName, type Message, type TaskView } from "./types.ts";

export async function showTeamsPanel(ctx: ExtensionContext, host: PanelHost, view = { graph: false }): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Teams panel requires interactive terminal mode");
  let snapshot = await host.snapshot();
  let tasks = snapshot.tasks;
  let events = snapshot.messages.slice().reverse();
  // Zoom is the title width each box gets, from the longest title (100%) down to none (number and status only).
  const longest = () => Math.max(1, ...tasks.map(task => visibleWidth(clean(task.title))));
  const graphs = new Map<number, TaskGraph | null>();
  const jumpedGraphs = new WeakMap<TaskGraph, TaskGraph>();
  const graphAt = (budget: number) => { if (!graphs.has(budget)) graphs.set(budget, buildTaskGraph(tasks, budget)); return graphs.get(budget)!; };
  let zoom: number | "fit" = "fit", shownZoom = longest();
  let taskGraph: TaskGraph | null = null;
  const drafts = host.drafts;
  const name = (id: string | undefined) => id === "root" ? "Main" : clean(snapshot.members.find(member => member.id === id)?.name ?? id ?? "Unassigned");
  const creator = (task: TaskView) => (task as TaskView & { creator?: string }).creator ?? "root";
  const destination = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let tab = 0, taskIndex = 0, memberIndex = 0, eventIndex = 0;
    let graph = view.graph, detail = false, scroll = 0, detailScroll = 0, columnScroll = 0;
    let graphScope: "auto" | "all" | "focus" = "auto", focusGraph = false;
    let neighborhood: { id: string; width: number; height: number; graph: TaskGraph | null } | undefined;
    let renderedGraph: { graph: TaskGraph; selection: string; width: number; scroll: number; rows: Map<number, string> } | undefined;
    let height = 30, bodyHeight = 21, receipt = "";
    let compose: "new" | "feedback" | undefined;
    let sending = false, opening = false, disposed = false;
    let composeTask: TaskView | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focused = true;
    let memberQuery = "", searching = false, hideStopped = false;
    let jump: { number: string; error: string } | undefined;
    const tabs = ["Tasks", "Teammates", "Board"];
    const selectedTask = () => tasks[taskIndex];
    const memberIds = () => ["root", ...snapshot.members.filter(member => member.id !== "root").map(member => member.id)]
      .filter(id => name(id).toLowerCase().includes(memberQuery.toLowerCase())
        && (!hideStopped || snapshot.members.find(member => member.id === id)?.status !== "stopped"));
    const taskProgress = (id: string) => {
      const assigned = tasks.filter(task => task.owner === id);
      return `${assigned.filter(task => task.status === "done").length}/${assigned.length}`;
    };
    const refresh = () => { if (!disposed) tui.requestRender(); };
    async function poll() {
      try {
        const next = await host.snapshot();
        if (disposed) return;
        const taskId = selectedTask()?.id, memberId = memberIds()[memberIndex], eventId = events[eventIndex]?.id;
        const changed = JSON.stringify(next.tasks) !== JSON.stringify(tasks);
        snapshot = next; tasks = next.tasks; events = next.messages.slice().reverse();
        taskIndex = Math.max(0, tasks.findIndex(task => task.id === taskId));
        memberIndex = Math.max(0, memberIds().indexOf(memberId));
        eventIndex = Math.max(0, events.findIndex(event => event.id === eventId));
        if (changed) { graphs.clear(); taskGraph = null; neighborhood = undefined; }
      } catch (error) { if (!disposed) receipt = `Refresh failed: ${clean(String(error))}`; }
      finally { if (!disposed) { refresh(); timer = setTimeout(() => void poll(), 2000); } }
    }
    timer = setTimeout(() => void poll(), 2000);
    const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);
    const statusText = (task: TaskView, text: string) => taskStatus(task) === "Ready" ? fg("muted", text)
      : theme.style(text, { fg: indexedColor(({ Done: 2, Blocked: 1, Working: 6, Ready: 7 })[taskStatus(task)]) });
    const stateLabel = (task: TaskView) => statusText(task, taskStatus(task));
    const pad = (text: string, width: number) => {
      const clipped = truncateToWidth(text, width);
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    };
    const heading = (text: string) => theme.bold(fg("text", text));
    const tableHeader = (text: string) => theme.bold(theme.underline(fg("accent", text)));
    const label = (key: string, value: string) => fg("muted", key.padEnd(9) + " ") + value;
    const wrap = (lines: string[], width: number) => lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
    const editor = new Editor(tui, {
      borderColor: text => fg("accent", text),
      selectList: {
        selectedPrefix: text => fg("accent", text), selectedText: text => fg("accent", text),
        description: text => fg("muted", text), scrollInfo: text => fg("dim", text), noMatch: text => fg("warning", text),
      },
    });
    const draftKey = () => compose === "new" ? "new" : `feedback:${clean(composeTask!.id)}`;
    const begin = (kind: "new" | "feedback") => {
      if (kind === "feedback" && !selectedTask()) return;
      composeTask = kind === "feedback" ? selectedTask() : undefined;
      compose = kind;
      editor.setText(drafts.get(draftKey()) ?? "");
      editor.focused = focused;
      refresh();
    };
    editor.onSubmit = text => {
      if (sending) return;
      // Pi clears the editor before onSubmit; restore it until delivery succeeds.
      editor.setText(text);
      const message = clean(text).trim();
      if (!message) { receipt = "Write a request or feedback before sending."; refresh(); return; }
      const key = draftKey(), kind = compose, task = composeTask;
      drafts.set(key, editor.getExpandedText());
      sending = true; receipt = "Sending..."; refresh();
      void (async () => {
        try {
          const result = kind === "new" ? await host.requestTask(message) : await host.feedback(task!, message);
          drafts.delete(key);
          compose = undefined; editor.focused = false;
          receipt = clean(result);
        } catch (error) { receipt = `Delivery failed: ${clean(String(error))}. Draft kept; retry or Esc.`; }
        finally { sending = false; refresh(); }
      })();
    };

    async function openSession(id: string) {
      if (opening || sending) return;
      opening = true; receipt = `Opening ${name(id)}...`; refresh();
      try {
        const member = snapshot.members.find(member => member.id === id);
        if (member && ["stopped", "interrupted"].includes(member.status)) await host.resume(id);
        // Main sessions run in their own terminals; resuming one opens it there.
        if (member?.role === "main" && id !== host.self) receipt = `${name(id)} runs in its own terminal`;
        else done(id);
      } catch (error) { receipt = `Could not open ${name(id)}: ${clean(String(error))}`; }
      finally { opening = false; refresh(); }
    }

    function taskDetails(width: number) {
      const task = selectedTask();
      if (!task) return wrap([heading("No tasks yet"), "Request a task with N. Main creates and organizes it."], width);
      const unlocked = tasks.filter(other => other.dependencies.includes(task.id) || other.completionDependencies.includes(task.id));
      const outcome = task.outcome ? snapshot.messages.find(message => message.id === task.outcome) : undefined;
      const [first = "", ...rest] = outcome ? clean(outcome.summary).split("\n") : [];
      const prerequisites = (ids: string[]) => ids.map(id => {
        const parent = tasks.find(item => item.id === id);
        return parent ? `${taskTitle(parent.id)} · ${stateLabel(parent)}` : `${clean(id)} · Unavailable`;
      });
      return wrap([
        heading(taskTitle(task.id)) + fg("muted", " · ") + stateLabel(task), "",
        label("Owner", name(task.owner)), ...(task.delegator ? [label("Delegator", name(task.delegator))] : []),
        label("Creator", name(creator(task))), "",
        ...(outcome ? [section(`Outcome from ${name(outcome.from)}`, width), theme.bold(first), ...rest, ...(outcome.detail ? ["", fg("muted", clean(outcome.detail))] : []), ""] : []),
        section("Description", width), clean(task.description), "",
        section("Dependencies", width),
        label("Start needs", task.dependencies.length ? prerequisites(task.dependencies).join(", ") : fg("muted", "Nothing; can start now")),
        label("Finish also needs", task.completionDependencies.length ? prerequisites(task.completionDependencies).join(", ") : fg("muted", "No additional prerequisites")),
        label("Finish blocked by", task.completionBlockedBy.length ? task.completionBlockedBy.map(taskTitle).join(", ") : fg("muted", "Nothing")),
        label("Unlocks", unlocked.length ? unlocked.map(item => `${taskTitle(item.id)} (${item.dependencies.includes(task.id) ? "start" : "finish"})`).join(", ") : fg("muted", "No other tasks")), "",
        section("Actions", width), fg("accent", "C") + "  Give feedback to creator", fg("accent", "O") + "  Open owner's session", "",
        fg("dim", `ID ${task.id}`),
      ], width);
    }

    function graphLines(width: number) {
      const fits = (g: TaskGraph | null) => !!g && g.art.width <= width && g.art.plain.length <= bodyHeight - 2;
      const minimumTitle = Math.min(12, longest());
      focusGraph = graphScope === "focus" || graphScope === "auto" && !fits(graphAt(minimumTitle));
      if (!focusGraph) {
        if (zoom === "fit") {
          // Never remove titles to claim a fit. Explicit zoom can still show number/status only.
          let low = minimumTitle, high = longest();
          if (fits(graphAt(high))) low = high;
          else if (fits(graphAt(low))) while (low < high - 1) { const mid = (low + high) >> 1; if (fits(graphAt(mid))) low = mid; else high = mid; }
          shownZoom = low;
        } else shownZoom = zoom;
        const raw = graphAt(shownZoom);
        if (raw && !jumpedGraphs.has(raw)) jumpedGraphs.set(raw, addGraphJumps(tasks, raw));
        taskGraph = raw ? jumpedGraphs.get(raw) ?? null : null;
        if (graphScope === "auto" && !fits(taskGraph)) focusGraph = true;
      }
      if (focusGraph) {
        const id = selectedTask()?.id ?? "";
        const height = bodyHeight - 1;
        if (neighborhood?.id !== id || neighborhood.width !== width || neighborhood.height !== height) {
          neighborhood = { id, width, height, graph: buildTaskFocus(tasks, id, width, height) };
        }
        taskGraph = neighborhood.graph;
      }
      if (!taskGraph || bodyHeight < 3) return undefined;
      const { art, bounds } = taskGraph;
      const selection = selectedTask()?.id ?? "";
      const selected = bounds.get(selection);
      if (!selected) return undefined;
      if (selected.left < columnScroll) columnScroll = selected.left;
      if (selected.right - selected.left + 1 >= width) columnScroll = selected.left;
      else if (selected.right >= columnScroll + width) columnScroll = selected.right - width + 1;
      columnScroll = Math.max(0, Math.min(columnScroll, Math.max(0, art.width - width)));
      if (renderedGraph?.graph !== taskGraph || renderedGraph.selection !== selection || renderedGraph.width !== width || renderedGraph.scroll !== columnScroll) {
        renderedGraph = { graph: taskGraph, selection, width, scroll: columnScroll, rows: new Map() };
      }
      const cachedRows = renderedGraph.rows;
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
          const active = task.id === selectedTask()?.id;
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
        const line = indent + sliceByColumn(parts.join(""), columnScroll, width);
        cachedRows.set(y, line);
        return line;
      });
      return { rows, height: art.plain.length, selectedRow: selected.top, selectedHeight: selected.bottom - selected.top + 1, width: art.width, fits: fits(taskGraph), focus: focusGraph, count: bounds.size };
    }

    function body(width: number): string[] {
      if (compose) {
        const target = compose === "new" ? "Main" : name(creator(composeTask!));
        const title = compose === "new" ? "Request a new task" : `Give feedback · ${clean(taskName(composeTask!))}`;
        const description = compose === "new" ? "Describe the outcome you want. Main will review existing work and explain whether to reuse, extend, or create a task."
          : "Your comment goes to the task creator with task context.";
        const intro = wrap([heading(title), label("To", target), "", description, ""], width);
        const input = editor.render(width);
        return [...intro, ...input].slice(0, bodyHeight);
      }
      if (detail) {
        const lines = tab === 0 ? taskDetails(width) : tab === 1 ? memberDetails(width) : eventDetails(width);
        detailScroll = Math.min(detailScroll, Math.max(0, lines.length - bodyHeight));
        return lines.slice(detailScroll, detailScroll + bodyHeight);
      }
      const split = width >= 83;
      const leftWidth = split ? Math.floor((width - 3) * 0.6) : width;
      const rightWidth = width - leftWidth - 3;
      let left: string[], right: string[], selectedRow: number;
      let selectedHeight = 1, graphWidth = 0;
      const graphData = tab === 0 && graph ? graphLines(leftWidth) : undefined;
      if (tab === 0) {
        const titleWidth = Math.max(1, leftWidth - 12);
        left = graphData ? [] : tasks.length ? [tableHeader(`  ${pad("Task", titleWidth)}   State`), "",
          ...tasks.map((task, index) => {
            const selected = index === taskIndex;
            const body = fg(taskStatus(task) === "Done" ? "dim" : "text", pad(taskTitle(task.id), titleWidth));
            return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `)
              + (selected ? theme.bold(body) : body) + "   " + stateLabel(task);
          })] : [heading("No tasks yet"), "N  Request a task from Main"];
        selectedRow = graphData ? graphData.selectedRow : taskIndex + 2;
        selectedHeight = graphData?.selectedHeight ?? 1;
        graphWidth = graphData?.width ?? 0;
        right = split ? taskDetails(rightWidth) : [];
        if (graph && !graphData && tasks.length) left[0] = fg("muted", "Graph unavailable or too large; showing list.");
      } else if (tab === 1) {
        const ids = memberIds();
        const sessionWidth = Math.min(17, Math.max(1, Math.floor(leftWidth / 2)));
        const preferredNameWidth = Math.min(24, Math.max(18, ...ids.map(id => visibleWidth(name(id)))));
        const tasksWidth = Math.max(5, ...ids.map(id => taskProgress(id).length));
        const showTasks = leftWidth >= 2 + preferredNameWidth + 4 + sessionWidth + 4 + tasksWidth;
        const directory = (id: string) => clean(basename(snapshot.members.find(member => member.id === id)?.cwd ?? (id === host.self ? ctx.cwd : ""))) || "—";
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
          const member = snapshot.members.find(member => member.id === id);
          const selected = index === memberIndex;
          const stopped = member && ["stopped", "interrupted"].includes(member.status);
          const description = member?.needsInput ? "Needs input" : id === "root" ? "Main conversation"
            : clean(member?.status ?? "Unavailable").replace(/^./, char => char.toUpperCase());
          const color = member?.needsInput || member?.status === "interrupted" ? "error"
            : member?.status === "busy" ? "accent" : "muted";
          const memberName = fg(selected ? "accent" : stopped ? "dim" : "text", pad(name(id), nameWidth));
          return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `)
            + (selected ? theme.bold(memberName) : memberName) + gap + fg(color, pad(description, sessionWidth))
            + (showTasks ? fg("muted", `${gap}${pad(taskProgress(id), tasksWidth)}`) : "")
            + (showDirectory ? fg("muted", `${gap}${pad(directory(id), directoryWidth)}`) : "");
        })];
        if (!ids.length) left.push(fg("muted", "No matching teammates."));
        selectedRow = memberIndex + 1;
        right = split ? memberDetails(rightWidth) : [];
      } else {
        // One row per post: who, what kind, its summary headline, then task and time as quieter context.
        const fromWidth = Math.min(16, Math.max(4, ...events.map(event => visibleWidth(name(event.from)))));
        const taskWidth = Math.min(5, Math.max(4, ...events.map(event => event.task ? visibleWidth(taskRef(event.task)) : 0)));
        const summaryWidth = Math.max(1, leftWidth - (2 + fromWidth + 2 + 7 + 2 + 2 + taskWidth + 2 + 5));
        left = events.length ? [tableHeader(`  ${pad("From", fromWidth)}  ${pad("Kind", 7)}  ${pad("Summary", summaryWidth)}  ${pad("Task", taskWidth)}  Time`),
          ...events.map((event, index) => {
            const selected = index === eventIndex;
            const from = pad(name(event.from), fromWidth), summary = pad(headline(event), summaryWidth);
            return fg(selected ? "accent" : "dim", `${selected ? "●" : " "} `) + (selected ? theme.bold(fg("accent", from)) : from) + "  "
              + kindLabel(event) + "  " + (selected ? theme.bold(summary) : summary) + "  "
              + fg("muted", pad(event.task ? taskRef(event.task) : "", taskWidth)) + "  " + fg("dim", clock(event.time).slice(0, 5));
          })] : [heading("No posts yet"), fg("muted", "Updates, questions, replies, and outcomes appear here.")];
        selectedRow = eventIndex + 1;
        right = split ? eventDetails(rightWidth) : [];
      }

      const viewHeight = Math.max(1, bodyHeight - (graphWidth ? graphData?.focus ? 1 : 2 : 0));
      if (graphData?.focus) scroll = 0;
      if (selectedRow < scroll) scroll = selectedRow;
      if (selectedRow + selectedHeight > scroll + viewHeight) scroll = selectedRow + selectedHeight - viewHeight;
      const rowCount = graphData?.height ?? left.length;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, rowCount - viewHeight)));
      const viewport = graphData ? graphData.rows(scroll, scroll + viewHeight) : left.slice(scroll, scroll + viewHeight);
      if (graphWidth) {
        if (!graphData?.focus) viewport.unshift(fg("dim", taskGraph?.jumps === null
          ? "Line jumps unavailable; original wires retained"
          : `Rounded bridges (${taskGraph?.jumps ?? 0}); other overlaps unchanged`));
        const hidden = scroll || rowCount > scroll + viewHeight || graphWidth > leftWidth;
        viewport.unshift(fg("muted", (graphData?.focus ? `Focus: ${graphData.count} of ${tasks.length} tasks · A Full map` : `Full map: ${tasks.length} tasks · Zoom ${Math.round(100 * shownZoom / longest())}%${zoom === "fit" ? graphData?.fits ? " (fit)" : " (pan to explore)" : ""}`)
          + (hidden ? ` · ↑ ${scroll} rows · ↓ ${Math.max(0, rowCount - scroll - viewHeight)} rows` : "")
          + (graphWidth > leftWidth ? ` · ← ${columnScroll} cols · ${Math.max(0, graphWidth - columnScroll - leftWidth)} cols →` : "")));
      }
      return Array.from({ length: bodyHeight }, (_, index) => {
        let row = viewport[index] ?? "";
        if (!graphWidth && index === 0 && scroll > 0 && selectedRow !== scroll) row = fg("muted", `↑ ${scroll} rows above`);
        if (!graphWidth && index === bodyHeight - 1 && scroll + bodyHeight < left.length && selectedRow !== scroll + index) row = fg("muted", `↓ ${left.length - scroll - bodyHeight} rows below`);
        return split ? pad(row, leftWidth) + fg("dim", " │ ") + truncateToWidth(right[index] ?? "", rightWidth) : row;
      });
    }

    /** Task number and full title; labels are too short to say what a post is about. */
    function taskTitle(id: string) {
      const task = tasks.find(item => item.id === id);
      return task ? clean(`#${task.number} ${task.title}`) : clean(id);
    }

    const headline = (event: Message) => clean(event.summary).split("\n")[0];
    const taskRef = (id: string) => { const task = tasks.find(item => item.id === id); return task ? `#${task.number}` : "#?"; };
    const kindLabel = (event: Message) => event.kind === "outcome" ? fg("success", pad("Outcome", 7))
      : event.replyTo ? fg("accent", pad("Reply", 7)) : fg("muted", pad("Post", 7));
    // A labelled rule separates tiers more clearly than bold text alone.
    const section = (title: string, width: number) => theme.bold(fg("accent", title)) + " " + fg("dim", "─".repeat(Math.max(0, width - visibleWidth(title) - 1)));
    const post = (id: string | undefined) => snapshot.messages.find(message => message.id === id);
    const clock = (time: string) => { const date = new Date(time); return isNaN(+date) ? clean(time) : date.toTimeString().slice(0, 8); };

    // Tiers: headline (first summary line), the rest of the summary, then optional detail and the thread around it.
    function eventDetails(width: number) {
      const event = events[eventIndex];
      if (!event) return wrap([heading("No posts yet"), "Updates, questions, replies, and outcomes appear here."], width);
      const [first = "", ...rest] = clean(event.summary).split("\n");
      const parent = post(event.replyTo), task = event.task ? tasks.find(item => item.id === event.task) : undefined;
      const replies = snapshot.messages.filter(message => message.replyTo === event.id);
      const date = new Date(event.time);
      return wrap([
        kindLabel(event).trimEnd() + fg("muted", ` from ${name(event.from)}`),
        label("To", event.recipients.map(name).join(", ") || "Team"),
        ...(event.task ? [label("Task", `${taskTitle(event.task)}${task ? ` · ${stateLabel(task)}` : ""}`)] : []),
        ...(parent ? [label("Reply to", `${name(parent.from)}: ${headline(parent)}`)] : []),
        label("Time", isNaN(+date) ? clean(event.time) : date.toLocaleString()), "",
        section("Summary", width), theme.bold(first), ...rest,
        ...(event.detail ? ["", section("Detail", width), clean(event.detail)] : []),
        ...(replies.length ? ["", section(`Replies (${replies.length})`, width), ...replies.map(reply => `${name(reply.from)}: ${headline(reply)}`)] : []),
      ], width);
    }

    function memberDetails(width: number) {
      if (tab === 2) return eventDetails(width);
      const id = memberIds()[memberIndex];
      if (!id) return wrap([heading("No matching teammates"), "Change the name filter or show stopped members."], width);
      const member = snapshot.members.find(member => member.id === id);
      const assigned = tasks.filter(task => task.owner === id);
      const stopped = member && ["stopped", "interrupted"].includes(member.status);
      return wrap([
        heading(name(id)) + fg("muted", " · ") + (member?.needsInput ? fg("error", "Needs input") : clean(member?.status ?? (id === "root" ? "Main conversation" : "Unavailable")).replace(/^./, char => char.toUpperCase())), "",
        label("Model", clean(member?.modelName || member?.model?.slice(member.model.indexOf("/") + 1) || "Unknown")),
        label("Context", clean(contextSummary(member?.contextUsage).replace(/^context unknown/, "Unknown"))),
        label("Directory", clean(member?.cwd ?? (id === host.self ? ctx.cwd : "Unavailable"))),
        ...(member?.error ? [label("Error", fg("error", clean(member.error)))] : []), "",
        section(`Tasks (${assigned.filter(task => task.status === "done").length} of ${assigned.length} done)`, width),
        ...(assigned.length ? assigned.map(task => `${taskTitle(task.id)} · ${stateLabel(task)}`) : [fg("muted", "No assigned tasks.")]), "",
        section("Actions", width), fg("accent", "Enter") + (stopped ? "  Resume and open session" : "  Open session"),
        ...(!host.child && member?.role === "member" ? [fg("accent", "P") + "  Promote to main session " + fg("muted", "(stops the member, reopens its transcript as a main session)")] : []), "",
        section("Session", width),
        fg("muted", label("ID", id)),
        fg("muted", label("File", clean(member?.sessionFile ?? member?.sessionId ?? "Unavailable"))),
        fg("muted", label("Worktree", member?.worktree ? clean(`${member.worktree.path} (${member.worktree.branch})`) : "None")),
      ], width);
    }

    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; editor.focused = value && !!compose; },
      render(width: number) {
        height = Math.max(1, tui.terminal.rows);
        const inner = Math.max(1, width - 4);
        const border = (left: string, right: string) => fg("dim", left + "─".repeat(Math.max(0, width - 2)) + right);
        const row = (text: string) => fg("dim", "│ ") + pad(text, inner) + fg("dim", " │");
        const title = heading("Teams") + fg("muted", ` · ${name(host.self)} · ${snapshot.members.filter(member => member.id !== "root" && ["starting", "busy", "idle", "stopping"].includes(member.status)).length}/${snapshot.limit} live · depth ${snapshot.depth}`);
        const tabLine = tabs.map((text, index) => index === tab ? theme.bold(fg("accent", `[${text}]`)) : fg("muted", ` ${text} `)).join("  ") + (tab === 0 && inner >= 78 ? fg("muted", `    ${graph ? "Graph · prerequisites above · G List" : "List · G Graph"}`) : "");
        const filters = `${searching || memberQuery ? `/ Filter: ${memberQuery}${searching ? "▏" : ""}` : "/ Filter"} · H ${hideStopped ? "Stopped: hidden" : "Hide stopped"}`;
        const help = jump ? `Go to task: ${jump.number}▏ · Enter Go · Esc Cancel${jump.error ? ` · ${jump.error}` : ""}`
          : searching ? `${filters} · Enter Apply · Esc Clear`
          : compose ? "Enter Send · Shift+Enter Newline · Esc Keep draft"
          : detail ? tab === 0 ? "↑↓ Scroll · C Feedback · O Open owner · Esc Back"
            : tab === 1 ? "↑↓ Scroll · Enter Open session · Esc Back" : "↑↓ Scroll · O Open related session · Esc Back"
          : tab === 0 ? `${graph ? "↑↓←→" : "↑↓"} Select · Enter Details · Shift+J Jump · G ${graph ? "List" : "Graph"}${graph ? " · A All/Focus · +/- Zoom · F Fit" : ""} · C Feedback · N New · Tab Next · Esc Close`
          : tab === 1 ? `${filters} · ↑↓ Select · → Details · Enter Open session · N New task · Tab Next · Esc Close`
          : "↑↓ Select · Enter Details · O Open related session · Tab Next · Esc Close";
        const teammates = snapshot.members.filter(member => member.id !== "root");
        const memberStates = teammates.map(member => member.needsInput || member.status === "interrupted" ? "needs input"
          : ["starting", "busy", "stopping"].includes(member.status) ? "working"
          : member.status === "stopped" ? "stopped" : "idle");
        const summaryText = tab === 0
          ? `${tasks.length} tasks · ${["Working", "Ready", "Blocked", "Done"].map(state => `${tasks.filter(task => taskStatus(task) === state).length} ${state.toLowerCase()}`).join(" · ")}`
          : tab === 1 ? `${teammates.length} teammate${teammates.length === 1 ? "" : "s"} · ${["working", "idle", "stopped", "needs input"].map(state => `${memberStates.filter(value => value === state).length} ${state}`).join(" · ")}`
          : `${events.length} post${events.length === 1 ? "" : "s"} · ${events.filter(event => event.kind === "outcome").length} outcomes · ${events.filter(event => event.replyTo).length} replies`;
        const summary = wrapTextWithAnsi(fg("muted", summaryText), inner);
        const receipts = receipt ? wrapTextWithAnsi(fg("muted", receipt), inner) : [];
        const hints = wrapTextWithAnsi(fg("dim", help), inner);
        bodyHeight = Math.max(1, height - 6 - summary.length - receipts.length - hints.length);
        const content = body(inner);
        return [border("╭", "╮"), row(title), ...summary.map(row), row(tabLine), border("├", "┤"),
          ...Array.from({ length: bodyHeight }, (_, index) => row(content[index] ?? "")), border("├", "┤"), ...receipts.map(row), ...hints.map(row), border("╰", "╯")].slice(0, height).map(line => truncateToWidth(line, width));
      },
      invalidate() { editor.invalidate(); renderedGraph = undefined; },
      dispose() {
        disposed = true; clearTimeout(timer);
        if (compose) drafts.set(draftKey(), editor.getExpandedText());
      },
      handleInput(data: string) {
        if (compose) {
          if (sending) return;
          if (matchesKey(data, "escape")) {
            drafts.set(draftKey(), editor.getExpandedText());
            compose = undefined; editor.focused = false; receipt = "Draft kept locally; nothing sent.";
          } else editor.handleInput(data);
          refresh(); return;
        }
        if (opening) return;
        if (jump) {
          if (matchesKey(data, "escape")) jump = undefined;
          else if (matchesKey(data, "enter")) {
            const number = Number(jump.number.trim());
            const index = tasks.findIndex(task => task.number === number);
            if (!/^\d+$/.test(jump.number.trim()) || !Number.isSafeInteger(number) || number < 1) jump.error = "Enter a positive task number";
            else if (index < 0) jump.error = `Task #${number} does not exist`;
            else { taskIndex = index; scroll = 0; columnScroll = 0; jump = undefined; }
          } else if (matchesKey(data, "backspace")) { jump.number = Array.from(jump.number).slice(0, -1).join(""); jump.error = ""; }
          else {
            const text = data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
            if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) { jump.number += clean(text); jump.error = ""; }
          }
          refresh(); return;
        }
        if (searching) {
          if (matchesKey(data, "escape")) { memberQuery = ""; searching = false; }
          else if (matchesKey(data, "enter")) searching = false;
          else if (matchesKey(data, "backspace")) memberQuery = Array.from(memberQuery).slice(0, -1).join("");
          else {
            const text = data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
            if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) memberQuery += clean(text);
          }
          memberIndex = 0; scroll = 0; refresh(); return;
        }
        if (tab === 1 && !detail && (data === "/" || data === "H")) {
          if (data === "/") searching = true;
          else hideStopped = !hideStopped;
          memberIndex = 0; scroll = 0; refresh(); return;
        }
        const direction = (["up", "down", "left", "right"] as const).find(key =>
          matchesKey(data, key) || data === ({ up: "k", down: "j", left: "h", right: "l" } as const)[key]);
        const page = matchesKey(data, "pageDown") ? 1 : matchesKey(data, "pageUp") ? -1 : 0;
        if (matchesKey(data, "escape") || detail && direction === "left") { if (detail) { detail = false; detailScroll = 0; } else done(undefined); }
        else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { tab = (tab + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3; detail = false; scroll = 0; detailScroll = 0; }
        else if (tab === 0 && graph && !detail && taskGraph && selectedTask() && direction) {
          const id = moveTaskSelection(taskGraph.bounds, selectedTask()!.id, direction);
          taskIndex = focusGraph && (direction === "left" || direction === "right")
            ? Math.max(0, Math.min(tasks.length - 1, taskIndex + (direction === "right" ? 1 : -1)))
            : tasks.findIndex(task => task.id === id);
        } else if (!detail && direction === "right") { detail = true; detailScroll = 0; }
        else if (page || direction === "down" || direction === "up") {
          const delta = page ? page * Math.max(1, bodyHeight - (detail ? 0 : tab === 0 ? 2 : 1)) : direction === "down" ? 1 : -1;
          if (detail) detailScroll = Math.max(0, detailScroll + delta);
          else if (tab === 0) taskIndex = Math.max(0, Math.min(tasks.length - 1, taskIndex + delta));
          else if (tab === 1) memberIndex = Math.max(0, Math.min(memberIds().length - 1, memberIndex + delta));
          else eventIndex = Math.max(0, Math.min(events.length - 1, eventIndex + delta));
        } else if (data === "J" && tab === 0 && !detail) { jump = { number: "", error: "" }; }
        else if (data.toLowerCase() === "g" && tab === 0 && !detail) { graph = view.graph = !graph; scroll = 0; }
        else if (data.toLowerCase() === "a" && graph && tab === 0 && !detail) { graphScope = focusGraph ? "all" : "focus"; scroll = 0; columnScroll = 0; taskGraph = null; }
        else if (tab === 0 && graph && !detail && ["+", "=", "-"].includes(data)) {
          // Steps of 1.25x title width, like a smooth zoom; always at least one column so each press shows a change.
          graphScope = "all";
          const at = zoom === "fit" ? shownZoom : zoom;
          zoom = data === "-" ? Math.max(0, Math.min(at - 1, Math.floor(at / 1.25)))
            : Math.min(longest(), Math.max(at + 1, Math.ceil(at * 1.25)));
          scroll = 0; columnScroll = 0;
        } else if (tab === 0 && graph && !detail && data.toLowerCase() === "f") { graphScope = "auto"; zoom = "fit"; scroll = 0; columnScroll = 0; }
        else if (data.toLowerCase() === "n") begin("new");
        else if (data.toLowerCase() === "c" && tab === 0) begin("feedback");
        else if (data.toLowerCase() === "p" && tab === 1 && !host.child) {
          const id = memberIds()[memberIndex];
          if (snapshot.members.find(member => member.id === id)?.role !== "member") receipt = "Only a member can be promoted.";
          else { done(undefined); void host.promote(id).catch(error => ctx.ui.notify(`Promotion failed: ${clean(String(error))}`, "error")); return; }
        }
        else if (matchesKey(data, "enter") || data.toLowerCase() === "o") {
          if (tab === 1 || data.toLowerCase() === "o") {
            const id = tab === 1 ? memberIds()[memberIndex] : tab === 0 ? selectedTask()?.owner : events[eventIndex]?.from;
            if (!id) { receipt = "No related session available."; refresh(); return; }
            void openSession(id);
          } else { detail = true; detailScroll = 0; }
        }
        refresh();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } });
  if (destination) {
    try { await host.visit(destination); } catch (error) { ctx.ui.notify(`Could not open session: ${clean(String(error))}`, "error"); }
  }
}
