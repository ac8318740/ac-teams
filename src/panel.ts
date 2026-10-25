import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, indexedColor, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { modelContext } from "./telemetry.ts";
import { buildTaskGraph, moveTaskSelection, taskStatus } from "./graph.ts";
import { cleanText as clean } from "./render.ts";
import type { PanelHost } from "./ui-types.ts";
import { taskName, type TaskView } from "./types.ts";

export async function showTeamsPanel(ctx: ExtensionContext, host: PanelHost): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Teams panel requires interactive terminal mode");
  let snapshot = await host.snapshot();
  let tasks = snapshot.tasks;
  let events = snapshot.messages.slice().reverse();
  let taskGraph = buildTaskGraph(tasks);
  const drafts = host.drafts;
  const name = (id: string | undefined) => id === "root" ? "Main" : clean(snapshot.members.find(member => member.id === id)?.name ?? id ?? "Unassigned");
  const creator = (task: TaskView) => (task as TaskView & { creator?: string }).creator ?? "root";
  const destination = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let tab = 0, taskIndex = 0, memberIndex = 0, eventIndex = 0;
    let graph = true, detail = false, scroll = 0, detailScroll = 0, columnScroll = 0;
    let height = 30, bodyHeight = 21, receipt = "Select a task or teammate. N requests a task from Main.";
    let compose: "new" | "feedback" | undefined;
    let sending = false, opening = false, disposed = false;
    let composeTask: TaskView | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focused = true;
    const tabs = ["Tasks", "Teammates", "Activity"];
    const selectedTask = () => tasks[taskIndex];
    const memberIds = () => ["root", ...snapshot.members.filter(member => member.id !== "root").map(member => member.id)];
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
        if (changed) taskGraph = buildTaskGraph(tasks);
      } catch (error) { if (!disposed) receipt = `Refresh failed: ${clean(String(error))}`; }
      finally { if (!disposed) { refresh(); timer = setTimeout(() => void poll(), 2000); } }
    }
    timer = setTimeout(() => void poll(), 2000);
    const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);
    const statusText = (task: TaskView, text: string) => taskStatus(task) === "Ready" ? fg("muted", text)
      : theme.style(text, { fg: indexedColor(({ Done: 2, Blocked: 1, Working: 6, Ready: 7 })[taskStatus(task)]) });
    const stateLabel = (task: TaskView) => statusText(task, taskStatus(task));
    const pad = (text: string, width: number) => truncateToWidth(text, width) + " ".repeat(Math.max(0, width - visibleWidth(text)));
    const heading = (text: string) => theme.bold(fg("text", text));
    const label = (key: string, value: string) => fg("muted", key.padEnd(10)) + value;
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
        done(id);
      } catch (error) { receipt = `Could not open ${name(id)}: ${clean(String(error))}`; }
      finally { opening = false; refresh(); }
    }

    function taskDetails(width: number) {
      const task = selectedTask();
      if (!task) return wrap([heading("No tasks yet"), "Request a task with N. Main creates and organizes it."], width);
      const unlocked = tasks.filter(other => other.dependencies.includes(task.id));
      return wrap([
        heading(clean(taskName(task))), label("Title", clean(task.title)), label("ID", task.id), "",
        label("State", stateLabel(task)), label("Owner", name(task.owner)), label("Creator", name(creator(task))), "",
        heading("Description"), clean(task.description), "",
        heading("Prerequisites"),
        ...(task.dependencies.length ? task.dependencies.map(id => {
          const parent = tasks.find(item => item.id === id);
          return parent ? `${clean(taskName(parent))} · ${taskStatus(parent)}` : `${clean(id)} · Unavailable`;
        }) : [fg("muted", "None; this task can start independently.")]), "",
        heading("Unlocks"), ...(unlocked.length ? unlocked.map(item => clean(taskName(item))) : [fg("muted", "No dependent tasks.")]),
        "",
        fg("accent", "C  Give feedback to creator"), fg("accent", "O  Open owner's full session"),
        ...(!detail ? [fg("muted", "Enter  Full details")] : []),
      ], width);
    }

    function graphLines(width: number) {
      if (!taskGraph) return undefined;
      const { art, bounds } = taskGraph;
      const selected = bounds.get(selectedTask()?.id ?? "");
      if (!selected) return undefined;
      if (selected.left < columnScroll) columnScroll = selected.left;
      if (selected.right - selected.left + 1 >= width) columnScroll = selected.left;
      else if (selected.right >= columnScroll + width) columnScroll = selected.right - width + 1;
      columnScroll = Math.max(0, Math.min(columnScroll, Math.max(0, art.width - width)));
      const rows = art.styled.map((spans, y) => {
        let row = spans.map(span => fg(span.cls === "border" || span.cls === "edge" ? "dim" : "text", span.text)).join("");
        for (const task of tasks) {
          const box = bounds.get(task.id);
          if (!box || y < box.top || y > box.bottom) continue;
          const active = task.id === selectedTask()?.id;
          let text = sliceByColumn(art.plain[y], box.left, box.right - box.left + 1);
          if (active && y === box.top + 1) text = text.replace("○ ", "● ");
          const border = y === box.top || y === box.bottom;
          const content = sliceByColumn(text, 1, box.right - box.left - 1), status = taskStatus(task);
          const color = status === "Done" ? "dim" : "text";
          const index = y === box.bottom - 1 && content.trimEnd().endsWith(status) ? content.lastIndexOf(status) : -1;
          const interior = index < 0 ? fg(color, content) : fg(color, content.slice(0, index)) + stateLabel(task) + fg(color, content.slice(index + status.length));
          const styled = border ? statusText(task, text) : statusText(task, "│") + (active ? theme.bold(interior) : interior) + statusText(task, "│");
          row = sliceByColumn(row, 0, box.left) + styled + sliceByColumn(row, box.right + 1, art.width);
        }
        const indent = " ".repeat(Math.max(0, Math.floor((width - art.width) / 2)));
        return indent + sliceByColumn(row, columnScroll, width);
      });
      return { rows, selectedRow: selected.top, selectedHeight: selected.bottom - selected.top + 1, width: art.width };
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
        const lines = tab === 0 ? taskDetails(width) : memberDetails(width);
        detailScroll = Math.min(detailScroll, Math.max(0, lines.length - bodyHeight));
        return lines.slice(detailScroll, detailScroll + bodyHeight);
      }
      const split = width >= 83;
      const leftWidth = split ? Math.floor((width - 3) * 0.6) : width;
      const rightWidth = width - leftWidth - 3;
      let left: string[], right: string[], selectedRow: number;
      let selectedHeight = 1, graphWidth = 0;
      if (tab === 0) {
        const graphData = graph ? graphLines(leftWidth) : undefined;
        left = graphData ? graphData.rows : tasks.length ? [fg("muted", "  Task / State"), "",
          ...tasks.map((task, index) => {
            const text = `${index === taskIndex ? "●" : " "} ${clean(taskName(task))}`;
            const body = fg(taskStatus(task) === "Done" ? "dim" : "text", truncateToWidth(text, Math.max(1, leftWidth - 10)));
            return (index === taskIndex ? theme.bold(body) : body) + " · " + stateLabel(task);
          })] : [heading("No tasks yet"), "N  Request a task from Main"];
        selectedRow = graphData ? graphData.selectedRow : taskIndex + 2;
        selectedHeight = graphData?.selectedHeight ?? 1;
        graphWidth = graphData?.width ?? 0;
        right = split ? taskDetails(rightWidth) : [];
        if (graph && !graphData && tasks.length) left[0] = fg("muted", "Graph unavailable or too large; showing list.");
      } else if (tab === 1) {
        left = [fg("muted", "  Member       Session"), "", ...memberIds().map((id, index) => {
          const description = id === "root" ? "Main conversation" : snapshot.members.find(member => member.id === id)?.status ?? "Unavailable";
          return fg(index === memberIndex ? "accent" : "text", `${index === memberIndex ? "●" : " "} ${name(id).padEnd(12)} ${clean(description)}`);
        })];
        selectedRow = memberIndex + 2;
        right = split ? memberDetails(rightWidth) : [];
      } else {
        left = events.length ? [fg("muted", "  Recent messages · newest first"), "", ...events.flatMap((event, index) => [
          `${index === eventIndex ? "●" : " "} ${name(event.from)} → ${event.recipients.map(name).join(", ") || "Team"}`,
          fg("muted", `  ${clean(event.time)} · ${clean(event.text).split("\n")[0]}`), "",
        ])] : [heading("No activity yet"), fg("muted", "Recent persistent team messages appear here.")];
        selectedRow = eventIndex * 3 + 2;
        right = split ? eventDetails(rightWidth) : [];
      }

      const viewHeight = Math.max(1, bodyHeight - (graphWidth ? 1 : 0));
      if (selectedRow < scroll) scroll = selectedRow;
      if (selectedRow + selectedHeight > scroll + viewHeight) scroll = selectedRow + selectedHeight - viewHeight;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, left.length - viewHeight)));
      const viewport = left.slice(scroll, scroll + viewHeight);
      if (graphWidth) viewport.unshift(fg("muted", `↑ ${scroll} rows above · ↓ ${Math.max(0, left.length - scroll - viewHeight)} below`
        + (graphWidth > leftWidth ? ` · ← ${columnScroll} cols · ${Math.max(0, graphWidth - columnScroll - leftWidth)} →` : "")));
      return Array.from({ length: bodyHeight }, (_, index) => {
        let row = viewport[index] ?? "";
        if (!graphWidth && index === 0 && scroll > 0) row = fg("muted", `↑ ${scroll} rows above`);
        if (!graphWidth && index === bodyHeight - 1 && scroll + bodyHeight < left.length) row = fg("muted", `↓ ${left.length - scroll - bodyHeight} rows below`);
        return split ? pad(row, leftWidth) + fg("dim", " │ ") + truncateToWidth(right[index] ?? "", rightWidth) : row;
      });
    }

    function eventDetails(width: number) {
      const event = events[eventIndex];
      if (!event) return wrap([heading("No activity yet"), "Recent persistent team messages appear here."], width);
      return wrap([heading("Team message"), "", label("From", name(event.from)), label("To", event.recipients.map(name).join(", ") || "Team"), label("Time", clean(event.time)), "", clean(event.text)], width);
    }

    function memberDetails(width: number) {
      if (tab === 2) return eventDetails(width);
      const id = memberIds()[memberIndex];
      const member = snapshot.members.find(member => member.id === id);
      const assigned = tasks.filter(task => task.owner === id);
      return wrap([heading(name(id)), "", label("State", clean(member?.status ?? (id === "root" ? "Main conversation" : "Unavailable"))),
        label("ID", id), label("Model / context", clean(modelContext(member ?? {}))),
        label("Cwd", clean(member?.cwd ?? (id === host.self ? ctx.cwd : "Unavailable"))),
        label("Session", clean(member?.sessionFile ?? member?.sessionId ?? "Unavailable")),
        label("Worktree", member?.worktree ? clean(`${member.worktree.path} (${member.worktree.branch})`) : "None"),
        ...(member?.error ? [label("Error", clean(member.error))] : []), "", heading("Assigned tasks"),
        ...assigned.map(task => `${clean(taskName(task))} · ${taskStatus(task)}`),
        ...(assigned.length ? [] : [fg("muted", "No assigned tasks.")]), "",
        heading("Message with full context"), "Open the native Pi session to read its conversation and type your message there.", "",
        fg("accent", member && ["stopped", "interrupted"].includes(member.status) ? "Enter  Resume and open" : "Enter  Open full session"),
        fg("muted", "No separate message composer."),
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
        const help = compose ? "Enter Send · Shift+Enter Newline · Esc Keep draft"
          : detail ? tab === 0 ? "↑↓ Scroll · C Feedback · O Open owner · Esc Back" : "↑↓ Scroll · O Open related session · Esc Back"
          : tab === 0 ? `${graph ? "↑↓←→" : "↑↓"} Select · Enter Details · G Graph/List · C Feedback · N New task · Tab Next · Esc Close`
          : tab === 1 ? "↑↓ Select · → Details · Enter Open session · N New task · Tab Next · Esc Close"
          : "↑↓ Select · Enter Details · O Open related session · Tab Next · Esc Close";
        const summary = wrapTextWithAnsi(fg("muted", `${tasks.length} tasks · ${["Working", "Ready", "Blocked", "Done"].map(state => `${tasks.filter(task => taskStatus(task) === state).length} ${state.toLowerCase()}`).join(" · ")}`), inner);
        const receipts = wrapTextWithAnsi(fg("muted", receipt), inner);
        const hints = wrapTextWithAnsi(fg("dim", help), inner);
        bodyHeight = Math.max(1, height - 6 - summary.length - receipts.length - hints.length);
        const content = body(inner);
        return [border("╭", "╮"), row(title), ...summary.map(row), row(tabLine), border("├", "┤"),
          ...Array.from({ length: bodyHeight }, (_, index) => row(content[index] ?? "")), border("├", "┤"), ...receipts.map(row), ...hints.map(row), border("╰", "╯")].slice(0, height).map(line => truncateToWidth(line, width));
      },
      invalidate() { editor.invalidate(); },
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
        const direction = (["up", "down", "left", "right"] as const).find(key => matchesKey(data, key));
        if (matchesKey(data, "escape")) { if (detail) { detail = false; detailScroll = 0; } else done(undefined); }
        else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) { tab = (tab + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3; detail = false; scroll = 0; detailScroll = 0; }
        else if (tab === 0 && graph && !detail && taskGraph && selectedTask() && direction) {
          const id = moveTaskSelection(taskGraph.bounds, selectedTask()!.id, direction);
          taskIndex = tasks.findIndex(task => task.id === id);
        } else if (tab === 1 && matchesKey(data, "right")) { detail = true; detailScroll = 0; }
        else if (matchesKey(data, "down") || matchesKey(data, "up")) {
          const delta = matchesKey(data, "down") ? 1 : -1;
          if (detail) detailScroll = Math.max(0, detailScroll + delta);
          else if (tab === 0) taskIndex = Math.max(0, Math.min(tasks.length - 1, taskIndex + delta));
          else if (tab === 1) memberIndex = Math.max(0, Math.min(memberIds().length - 1, memberIndex + delta));
          else eventIndex = Math.max(0, Math.min(events.length - 1, eventIndex + delta));
        } else if (data.toLowerCase() === "g" && tab === 0 && !detail) { graph = !graph; scroll = 0; }
        else if (data.toLowerCase() === "n") begin("new");
        else if (data.toLowerCase() === "c" && tab === 0) begin("feedback");
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
