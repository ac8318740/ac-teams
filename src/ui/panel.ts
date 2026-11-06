import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { moveTaskSelection, taskStatus } from "./graph.ts";
import { GraphViewport } from "./graph-viewport.ts";
import { panelFormat } from "./panel-format.ts";
import { panelLists } from "./panel-lists.ts";
import { cleanText as clean } from "../text.ts";
import type { PanelHost } from "./types.ts";
import { taskName, type TaskView } from "../types.ts";

export async function showTeamsPanel(ctx: ExtensionContext, host: PanelHost, view = { graph: false }): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Teams panel requires interactive terminal mode");
  let snapshot = await host.snapshot();
  let tasks = snapshot.tasks;
  let events = snapshot.messages.slice().reverse();
  const viewport = new GraphViewport();
  const drafts = host.drafts;
  const name = (id: string | undefined) => id === "root" ? "Main" : clean(snapshot.members.find(member => member.id === id)?.name ?? id ?? "Unassigned");
  const creator = (task: TaskView) => task.creator ?? "root";
  const destination = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let tab = 0, taskIndex = 0, memberIndex = 0, eventIndex = 0;
    let graph = view.graph, detail = false, scroll = 0, detailScroll = 0;
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
        if (changed) viewport.update();
      } catch (error) { if (!disposed) receipt = `Refresh failed: ${clean(String(error))}`; }
      finally { if (!disposed) { refresh(); timer = setTimeout(() => void poll(), 2000); } }
    }
    timer = setTimeout(() => void poll(), 2000);
    const fg = (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text);
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

    function body(width: number): string[] {
      const style = panelFormat(theme, tasks, snapshot.members);
      if (compose) {
        const target = compose === "new" ? "Main" : name(creator(composeTask!));
        const title = compose === "new" ? "Request a new task" : `Give feedback · ${clean(taskName(composeTask!))}`;
        const description = compose === "new" ? "Describe the outcome you want. Main will review existing work and explain whether to reuse, extend, or create a task."
          : "Your comment goes to the task creator with task context.";
        return [...style.wrap([style.heading(title), style.label("To", target), "", description, ""], width), ...editor.render(width)].slice(0, bodyHeight);
      }
      const leftWidth = width >= 83 ? Math.floor((width - 3) * 0.6) : width;
      const result = panelLists({ tasks, members: snapshot.members, messages: snapshot.messages, events, ids: memberIds(),
        taskIndex, memberIndex, eventIndex, tab, detail, graph, scroll, detailScroll, width, bodyHeight,
        graphData: tab === 0 && graph && !detail ? viewport.render(tasks, selectedTask()?.id ?? "", leftWidth, bodyHeight, theme) : undefined,
        session: { self: host.self, child: host.child, cwd: ctx.cwd } }, style);
      scroll = result.scroll; detailScroll = result.detailScroll;
      return result.lines;
    }

    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; editor.focused = value && !!compose; },
      render(width: number) {
        height = Math.max(1, tui.terminal.rows);
        const { pad, heading } = panelFormat(theme, tasks, snapshot.members);
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
      invalidate() { editor.invalidate(); viewport.invalidate(); },
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
            else { taskIndex = index; scroll = 0; viewport.resetPan(); jump = undefined; }
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
        else if (tab === 0 && graph && !detail && viewport.taskGraph && selectedTask() && direction) {
          const id = moveTaskSelection(viewport.taskGraph.bounds, selectedTask()!.id, direction);
          taskIndex = viewport.focusGraph && (direction === "left" || direction === "right")
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
        else if (data.toLowerCase() === "a" && graph && tab === 0 && !detail) { viewport.toggleScope(); scroll = 0; }
        else if (tab === 0 && graph && !detail && ["+", "=", "-"].includes(data)) {
          viewport.zoomBy(data === "-", tasks); scroll = 0;
        } else if (tab === 0 && graph && !detail && data.toLowerCase() === "f") { viewport.fit(); scroll = 0; }
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
