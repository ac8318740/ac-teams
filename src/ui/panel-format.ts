import type { Theme } from "@earendil-works/pi-coding-agent";
import { indexedColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { taskStatus } from "./graph.ts";
import { cleanText as clean } from "../text.ts";
import type { Message, TaskView } from "../types.ts";
import type { TeamSnapshot } from "./types.ts";

export function panelFormat(theme: Theme, tasks: TaskView[], members: TeamSnapshot["members"]) {
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
  const clock = (time: string) => { const date = new Date(time); return isNaN(+date) ? clean(time) : date.toTimeString().slice(0, 8); };

  const name = (id: string | undefined) => id === "root" ? "Main" : clean(members.find(member => member.id === id)?.name ?? id ?? "Unassigned");
  const creator = (task: TaskView) => task.creator ?? "root";
  return { bold: (text: string) => theme.bold(text), fg, statusText, stateLabel, pad, heading, tableHeader, label, wrap, taskTitle, headline, taskRef, kindLabel, section, clock, name, creator };
}
export type PanelFormat = ReturnType<typeof panelFormat>;
