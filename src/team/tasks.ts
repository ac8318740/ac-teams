import { randomUUID } from "node:crypto";
import { isDescendant, isMain, taskLabelMaxLength, taskLabelPattern, batchTaskKeyMaxLength, batchTaskKeyPattern } from "../types.ts";
import type { TeamState, TaskArgs, Task, TaskView } from "../types.ts";
import { integer, object, requireValue, taskLabel, text } from "./snapshot.ts";
import { post } from "./messages.ts";

function taskView(state: TeamState, task: Task): TaskView {
  const completionDependencies = task.completionDependencies ?? [];
  const unfinished = (id: string) => state.tasks[id]?.status !== "done";
  return structuredClone({ ...task, completionDependencies, blockedBy: task.dependencies.filter(unfinished), completionBlockedBy: [...task.dependencies, ...completionDependencies].filter(unfinished) });
}

export function task(state: TeamState, actor: string, args: TaskArgs): TaskView | { tasks: TaskView[]; total: number } {
  requireValue(args.tasks === undefined || args.action === "create", "tasks is only valid for create");
  if (args.action === "list") {
    const tasks = Object.values(state.tasks);
    const offset = args.offset ?? 0, limit = args.limit ?? 100;
    requireValue(integer(offset) && integer(limit, 1) && limit <= 100, "Invalid task offset or limit (1-100)");
    return { tasks: tasks.slice(offset, offset + limit).map(task => taskView(state, task)), total: tasks.length };
  }
  if (args.action === "read") {
    requireValue(args.id && Object.hasOwn(state.tasks, args.id), "Unknown task");
    return taskView(state, state.tasks[args.id]);
  }
  if (args.action === "create") {
    requireValue(args.tasks === undefined || (Array.isArray(args.tasks) && args.tasks.length > 0 && args.tasks.length <= 100), "Batch create requires 1-100 tasks");
    requireValue(args.tasks === undefined || [args.title, args.label, args.description, args.dependencies, args.completionDependencies].every(value => value === undefined), "Use tasks or top-level task fields, not both");
    const inputs = args.tasks ?? [args];
    let number = Object.values(state.tasks).reduce((max, task) => Math.max(max, task.number), 0);
    const ids = inputs.map(() => randomUUID());
    const keys = new Map<string, string>();
    args.tasks?.forEach((input, index) => {
      requireValue(object(input), "Invalid task input");
      if (input.key === undefined) return;
      requireValue(text(input.key, batchTaskKeyMaxLength) && batchTaskKeyPattern.test(input.key), `Invalid batch task key (1-${batchTaskKeyMaxLength} letters, digits, underscores, or hyphens; starts with a letter)`);
      requireValue(!keys.has(input.key), `Duplicate batch task key: ${input.key}`);
      keys.set(input.key, ids[index]);
    });
    const created = inputs.map((input, index) => {
      requireValue(object(input) && text(input.title, 500), "Task requires a title (max 500)");
      const description = input.description === undefined ? input.title : input.description;
      requireValue(text(description), "Task requires a description (max 16000)");
      const label = input.label === undefined ? taskLabel(input.title) : input.label;
      requireValue(text(label, taskLabelMaxLength) && taskLabelPattern.test(label), "Task requires a 1–3-word label (max 60 characters)");
      const resolveDependencies = (refs: string[] = []) => {
        requireValue(Array.isArray(refs) && refs.length <= 100, "Invalid task dependencies (max 100)");
        return refs.map(ref => {
          requireValue(typeof ref === "string", "Invalid task dependency");
          if (args.tasks !== undefined && ref.startsWith("@")) {
            const id = keys.get(ref.slice(1));
            requireValue(id, `Unknown batch task reference: ${ref}`);
            return id;
          }
          requireValue(Object.hasOwn(state.tasks, ref), "Dependencies must refer to existing tasks or @keys in this batch");
          return ref;
        });
      };
      const dependencies = resolveDependencies(input.dependencies);
      const completionDependencies = resolveDependencies(input.completionDependencies);
      const task: Task = { id: ids[index], number: ++number, label, revision: 1, creator: actor, title: input.title, description, dependencies, completionDependencies, status: "todo" };
      state.tasks[task.id] = task;
      return task;
    }).map(task => taskView(state, task));
    return args.tasks === undefined ? created[0] : { tasks: created, total: created.length };
  }
  requireValue(args.id && Object.hasOwn(state.tasks, args.id), "Unknown task");
  const task = state.tasks[args.id];
  if (args.action === "complete" && task.outcome) {
    // A retried completion returns the original; a different outcome is a conflict, not a second post.
    const published = state.messages.find(message => message.id === task.outcome)!;
    requireValue(published.from === actor && published.summary === args.summary && published.detail === args.detail, "Task is already done with a different outcome; reopen it before completing again");
    return taskView(state, task);
  }
  requireValue(args.revision === undefined || (integer(args.revision) && args.revision === task.revision), "Stale or invalid task revision; read the task before retrying");
  if (args.action === "edit") {
    requireValue(task.status === "todo", "Only to-do tasks can be edited");
    requireValue(!task.owner || task.owner === actor, "Only the owner can edit a reserved task");
    if (args.title !== undefined) task.title = args.title;
    if (args.label !== undefined) task.label = args.label;
    if (args.description !== undefined) task.description = args.description;
    for (const field of ["dependencies", "completionDependencies"] as const) {
      if (args[field] === undefined) continue;
      requireValue(Array.isArray(args[field]) && args[field].length <= 100, "Invalid task dependencies (max 100)");
      task[field] = structuredClone(args[field]);
    }
  } else if (args.action === "claim") {
    requireValue(task.status !== "done", "Task is done; explicitly reopen it before claiming");
    requireValue(!task.owner, `Task is already owned by ${task.owner}`);
    task.owner = actor;
  } else if (args.action === "start") {
    requireValue(!task.owner || task.owner === actor, "Only the owner can start this task");
    requireValue(task.status === "todo", "Only to-do tasks can be started");
    const blocked = taskView(state, task).blockedBy;
    requireValue(blocked.length === 0, `Task is blocked by unfinished dependencies: ${blocked.join(", ")}`);
    task.owner = actor;
    task.status = "in_progress";
  } else if (args.action === "complete") {
    requireValue(task.owner === actor, "Only the owner can complete this task");
    requireValue(task.status === "in_progress", "Only in-progress tasks can be completed; start it first");
    const blocked = taskView(state, task).completionBlockedBy;
    requireValue(blocked.length === 0, `Task completion is blocked by unfinished dependencies: ${blocked.join(", ")}`);
    requireValue(args.acceptance === true, "Completion requires acceptance=true after checking acceptance criteria");
    requireValue(text(args.summary), "Completion requires an outcome summary: what was done, how it was checked, and any caveats");
    const outcome = post(state, actor, { summary: args.summary, detail: args.detail, task: task.id, kind: "outcome" });
    task.outcome = outcome.id;
    task.status = "done";
    task.completedAt = Date.now();
  } else if (args.action === "release") {
    requireValue(task.owner, "Task has no owner to release");
    const interrupted = ["interrupted", "stopped"].includes(state.members[task.owner].status);
    requireValue(task.owner === actor || (interrupted && (isMain(state.members[actor]) || isDescendant(state, task.owner, actor))), "Only the owner can release this task; ancestors may release interrupted descendants");
    if (task.status === "in_progress") task.status = "todo";
    delete task.owner;
  } else if (args.action === "reopen") {
    requireValue(task.status === "done", "Only done tasks can be reopened");
    requireValue(!task.owner || task.owner === actor || isMain(state.members[actor]), "Only the owner or a main session can reopen an owned task");
    const dependents = Object.values(state.tasks).filter(other => (other.dependencies.includes(task.id) && other.status !== "todo") || ((other.completionDependencies ?? []).includes(task.id) && other.status === "done"));
    requireValue(dependents.length === 0, `Cannot reopen task with active or done dependents: ${dependents.map(t => t.id).join(", ")}`);
    task.status = "todo";
    delete task.completedAt; delete task.outcome;
  } else throw new Error("Unknown task action");
  task.revision++;
  return taskView(state, task);
}
