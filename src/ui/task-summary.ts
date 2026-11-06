import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { cleanText } from "../text.ts";
import { taskName, type TaskView } from "../types.ts";

export function summaryTasks(tasks: TaskView[]): TaskView[] {
  const dependents = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "done") for (const id of task.completionBlockedBy) dependents.set(id, (dependents.get(id) ?? 0) + 1);
  }
  const rank = (task: TaskView) => task.status === "in_progress" ? 0
    : task.status === "done" ? 4 : task.blockedBy.length ? 3 : dependents.has(task.id) ? 1 : 2;
  return [...tasks].sort((a, b) => rank(a) - rank(b)
    || (a.status === "done" && b.status === "done" ? (b.completedAt ?? -1) - (a.completedAt ?? -1) || b.number - a.number
      : (dependents.get(b.id) ?? 0) - (dependents.get(a.id) ?? 0) || a.number - b.number)).slice(0, 5);
}

export function renderTaskSummary(tasks: TaskView[], theme: Theme, width: number): string[] {
  if (!tasks.length) return [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visible = summaryTasks(tasks);
  const rows = visible.map((task, index) => {
    const status = task.status === "done" ? "done" : task.status === "in_progress" ? "working" : task.blockedBy.length ? "blocked" : "ready";
    const color = status === "done" ? "success" : status === "working" ? "accent" : status === "blocked" ? "error" : "muted";
    const marker = status === "done" ? "✓" : status === "working" ? "●" : status === "blocked" ? "⊘" : "○";
    const blockers = task.blockedBy.length ? ` by ${task.blockedBy.map(id => `#${byId.get(id)?.number ?? "?"}`).join(", ")}` : "";
    const finish = task.completionBlockedBy.filter(id => !task.blockedBy.includes(id));
    const completion = finish.length ? `; finish needs ${finish.map(id => `#${byId.get(id)?.number ?? "?"}`).join(", ")}` : "";
    const name = cleanText(taskName(task)).replaceAll("\n", " ");
    return theme.fg("dim", index === visible.length - 1 ? "└─ " : "├─ ")
      + theme.fg(color, marker) + " " + theme.fg(status === "done" ? "dim" : "text", name)
      + theme.fg(color, ` · ${status}${blockers}${completion}`);
  });
  return [theme.fg("muted", `Tasks ${tasks.filter(task => task.status === "done").length}/${tasks.length} done`), ...rows]
    .map(row => truncateToWidth(row, width));
}
