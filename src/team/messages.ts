import { randomUUID } from "node:crypto";
import type { TeamState, MessageArgs, Message, WatchResult } from "../types.ts";
import { integer, maxMessageText, requireValue, text } from "./snapshot.ts";

/**
 * Appends a post. Attention goes to explicit recipients, the linked task's owner and delegator (else creator),
 * and the replied-to post's author; never the sender, and never an implicit broadcast.
 */
export function post(state: TeamState, actor: string, args: Pick<MessageArgs, "recipients" | "summary" | "detail" | "task" | "replyTo"> & { kind?: "outcome" | "edited" }, user = false): Message {
  // A user's request is authored in a session but addressed to that session's own model.
  const limit = user ? maxMessageText : 16000;
  requireValue(text(args.summary, limit), `A post needs a nonempty summary of at most ${limit} characters`);
  requireValue(args.detail === undefined || text(args.detail), "Detail must be nonempty and at most 16000 characters");
  const original = args.replyTo === undefined ? undefined : state.messages.find(message => message.id === args.replyTo);
  requireValue(args.replyTo === undefined || original, "Unknown post to reply to");
  requireValue(!args.task || !original?.task || args.task === original.task, "A reply stays on the replied-to post's task");
  const taskId = args.task ?? original?.task;
  const task = taskId === undefined ? undefined : state.tasks[taskId];
  requireValue(taskId === undefined || task, "Unknown task");
  requireValue(args.recipients === undefined || Array.isArray(args.recipients), "Recipients must be unique known member names or IDs");
  const members = Object.values(state.members);
  // Names resolve to durable IDs; a stopped member still receives its post on resume.
  const explicit = (args.recipients ?? []).map(recipient => typeof recipient === "string" ? members.find(member => member.id === recipient || member.name === recipient)?.id : undefined);
  requireValue(new Set(explicit).size === explicit.length && explicit.every((recipient): recipient is string => recipient !== undefined), "Recipients must be unique known member names or IDs");
  requireValue(explicit.length > 0 || task || original, "Name recipients, a task, or a post to reply to; posts are never broadcast");
  const seq = (state.messages.at(-1)?.seq ?? 0) + 1;
  const waiters = taskId === undefined ? [] : Object.values(state.members).filter(member => {
    if (member.id === actor) return false;
    const matching = member.watches?.filter(watch => watch.task === taskId && watch.seq === undefined && (watch.event === "message" || (watch.event === "completed" && args.kind === "outcome") || (watch.event === "edited" && args.kind === "edited"))) ?? [];
    for (const watch of matching) if (watch.event !== "edited") watch.seq = seq;
    const legacy = member.waiting?.tasks.includes(taskId);
    if (legacy) member.waiting!.tasks = member.waiting!.tasks.filter(task => task !== taskId);
    return matching.length > 0 || legacy;
  }).map(member => member.id);
  const routed = [...explicit, task?.owner, task?.delegator ?? task?.creator, original?.from, ...waiters];
  const recipients = [...new Set(routed.filter((id): id is string => !!id && (id !== actor || (user && explicit.includes(id)))))];
  const message: Message = { seq, id: randomUUID(), from: actor, recipients, summary: args.summary, time: new Date().toISOString() };
  if (args.kind) message.kind = args.kind;
  if (args.detail !== undefined) message.detail = args.detail;
  if (taskId !== undefined) message.task = taskId;
  if (original) message.replyTo = original.id;
  state.messages.push(message);
  return message;
}

export function message(state: TeamState, actor: string, args: MessageArgs, enveloped = false): Message | Message[] | WatchResult {
  if (args.action === "send") return structuredClone(post(state, actor, args, enveloped));
  if (["watch", "unwatch", "wait"].includes(args.action)) {
    const tasks = args.tasks ?? [];
    requireValue(Array.isArray(tasks) && tasks.length <= 100 && tasks.every(task => typeof task === "string" && Object.hasOwn(state.tasks, task)), "Watch tasks must be existing task IDs");
    requireValue(args.action !== "watch" || tasks.length > 0, "Watch requires 1-100 tasks");
    requireValue(args.event === undefined || args.event === "message" || args.event === "completed" || args.event === "edited", "Invalid watch event");
    requireValue(args.action !== "wait" || args.event !== "edited", "Use watch event=edited for persistent edit subscriptions; wait does not register them");
    const member = state.members[actor];
    const watches = member.watches ??= [];
    if (args.action === "unwatch") {
      member.watches = watches.filter(watch => !((tasks.length === 0 || tasks.includes(watch.task)) && (args.event === undefined || watch.event === args.event)));
      if (args.event === undefined || args.event === "message") {
        if (tasks.length === 0) delete member.waiting;
        else if (member.waiting) member.waiting.tasks = member.waiting.tasks.filter(task => !tasks.includes(task));
      }
      return { watching: structuredClone(member.watches), updates: [] };
    }
    const event = args.event ?? (args.action === "wait" ? "message" : "completed");
    const after = args.after ?? member.notified;
    requireValue(integer(after), "Invalid notification cursor");
    // Check and register atomically; completion watches also catch tasks already done.
    const ready = state.messages.filter(message => (args.action === "wait" && message.seq > after && message.recipients.includes(actor)) || (message.task !== undefined && tasks.includes(message.task) && (event === "completed" ? message.id === state.tasks[message.task].outcome : message.from !== actor && message.seq > after && (event !== "edited" || message.kind === "edited"))));
    for (const task of new Set(tasks)) {
      if ((event === "edited" || !ready.some(message => message.task === task && (event === "message" || message.id === state.tasks[task].outcome))) && !watches.some(watch => watch.task === task && watch.event === event)) watches.push({ task, event });
    }
    requireValue(watches.length <= 100, "At most 100 task watches per member");
    return args.action === "wait" ? structuredClone(ready) : { watching: structuredClone(watches), updates: structuredClone(ready) };
  }
  requireValue(args.action === "history" || args.action === "search", "Unknown message action");
  const after = args.after ?? 0, limit = args.limit ?? 20;
  requireValue(integer(after) && integer(limit, 1) && limit <= 100, "Invalid cursor or limit (1-100)");
  if (args.action === "search") requireValue(text(args.query, 500), "Search requires a nonempty query (max 500)");
  if (args.task !== undefined) requireValue(Object.hasOwn(state.tasks, args.task), "History/search task must be an existing task ID");
  if (args.seq !== undefined) requireValue(integer(args.seq, 1), "Invalid message sequence");
  const results = [];
  for (const message of state.messages) {
    if (message.seq > after && (args.task === undefined || message.task === args.task) && (args.seq === undefined || message.seq === args.seq) && (args.action !== "search" || (message.summary.includes(args.query!) || !!message.detail?.includes(args.query!)))) results.push(message);
    if (results.length === limit) break;
  }
  return structuredClone(results);
}
