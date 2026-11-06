import { contextSummary } from "./telemetry.ts";
import { cleanText as clean } from "../text.ts";
import type { Message, TaskView } from "../types.ts";
import type { TeamSnapshot } from "./types.ts";
import type { PanelFormat } from "./panel-format.ts";

export function taskDetails(task: TaskView | undefined, tasks: TaskView[], messages: Message[], style: PanelFormat, width: number) {
  const { fg, stateLabel, heading, label, wrap, taskTitle, section, name, creator, bold: styleBold } = style;
  if (!task) return wrap([heading("No tasks yet"), "Request a task with N. Main creates and organizes it."], width);
  const unlocked = tasks.filter(other => other.dependencies.includes(task.id) || other.completionDependencies.includes(task.id));
  const outcome = task.outcome ? messages.find(message => message.id === task.outcome) : undefined;
  const [first = "", ...rest] = outcome ? clean(outcome.summary).split("\n") : [];
  const prerequisites = (ids: string[]) => ids.map(id => {
    const parent = tasks.find(item => item.id === id);
    return parent ? `${taskTitle(parent.id)} · ${stateLabel(parent)}` : `${clean(id)} · Unavailable`;
  });
  return wrap([
    heading(taskTitle(task.id)) + fg("muted", " · ") + stateLabel(task), "",
    label("Owner", name(task.owner)), ...(task.delegator ? [label("Delegator", name(task.delegator))] : []),
    label("Creator", name(creator(task))), "",
    ...(outcome ? [section(`Outcome from ${name(outcome.from)}`, width), styleBold(first), ...rest, ...(outcome.detail ? ["", fg("muted", clean(outcome.detail))] : []), ""] : []),
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

export function eventDetails(event: Message | undefined, tasks: TaskView[], messages: Message[], style: PanelFormat, width: number) {
  const { fg, stateLabel, heading, label, wrap, taskTitle, headline, kindLabel, section, name, bold: styleBold } = style;
  const post = (id: string | undefined) => messages.find(message => message.id === id);
  if (!event) return wrap([heading("No posts yet"), "Updates, questions, replies, and outcomes appear here."], width);
  const [first = "", ...rest] = clean(event.summary).split("\n");
  const parent = post(event.replyTo), task = event.task ? tasks.find(item => item.id === event.task) : undefined;
  const replies = messages.filter(message => message.replyTo === event.id);
  const date = new Date(event.time);
  return wrap([
    kindLabel(event).trimEnd() + fg("muted", ` from ${name(event.from)}`),
    label("To", event.recipients.map(name).join(", ") || "Team"),
    ...(event.task ? [label("Task", `${taskTitle(event.task)}${task ? ` · ${stateLabel(task)}` : ""}`)] : []),
    ...(parent ? [label("Reply to", `${name(parent.from)}: ${headline(parent)}`)] : []),
    label("Time", isNaN(+date) ? clean(event.time) : date.toLocaleString()), "",
    section("Summary", width), styleBold(first), ...rest,
    ...(event.detail ? ["", section("Detail", width), clean(event.detail)] : []),
    ...(replies.length ? ["", section(`Replies (${replies.length})`, width), ...replies.map(reply => `${name(reply.from)}: ${headline(reply)}`)] : []),
  ], width);
}

export function memberDetails(id: string | undefined, members: TeamSnapshot["members"], tasks: TaskView[], session: { self: string; child: boolean; cwd: string }, style: PanelFormat, width: number) {
  const { fg, stateLabel, heading, label, wrap, taskTitle, section, name } = style;
  if (!id) return wrap([heading("No matching teammates"), "Change the name filter or show stopped members."], width);
  const member = members.find(member => member.id === id);
  const assigned = tasks.filter(task => task.owner === id);
  const stopped = member && ["stopped", "interrupted"].includes(member.status);
  return wrap([
    heading(name(id)) + fg("muted", " · ") + (member?.needsInput ? fg("error", "Needs input") : clean(member?.status ?? (id === "root" ? "Main conversation" : "Unavailable")).replace(/^./, char => char.toUpperCase())), "",
    label("Model", clean(member?.modelName || member?.model?.slice(member.model.indexOf("/") + 1) || "Unknown")),
    label("Context", clean(contextSummary(member?.contextUsage).replace(/^context unknown/, "Unknown"))),
    label("Directory", clean(member?.cwd ?? (id === session.self ? session.cwd : "Unavailable"))),
    ...(member?.error ? [label("Error", fg("error", clean(member.error)))] : []), "",
    section(`Tasks (${assigned.filter(task => task.status === "done").length} of ${assigned.length} done)`, width),
    ...(assigned.length ? assigned.map(task => `${taskTitle(task.id)} · ${stateLabel(task)}`) : [fg("muted", "No assigned tasks.")]), "",
    section("Actions", width), fg("accent", "Enter") + (stopped ? "  Resume and open session" : "  Open session"),
    ...(!session.child && member?.role === "member" ? [fg("accent", "P") + "  Promote to main session " + fg("muted", "(stops the member, reopens its transcript as a main session)")] : []), "",
    section("Session", width),
    fg("muted", label("ID", id)),
    fg("muted", label("File", clean(member?.sessionFile ?? member?.sessionId ?? "Unavailable"))),
    fg("muted", label("Worktree", member?.worktree ? clean(`${member.worktree.path} (${member.worktree.branch})`) : "None")),
  ], width);
}
