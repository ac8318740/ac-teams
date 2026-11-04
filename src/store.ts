import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "./config.ts";
import { validatePolicy } from "./egress.ts";
import { stripVTControlCharacters } from "node:util";
import { isDescendant, isMain, memberName, memberNamePattern, memberNameMaxLength, taskLabelMaxLength, taskLabelPattern } from "./types.ts";
import type { TeamState, TaskArgs, MessageArgs, Task, TaskView, Message, Worktree } from "./types.ts";

// UI envelopes add task context after the public 16,000-character input limit.
const maxMessageText = 17000;
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function text(value: unknown, max = 16000): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function id(value: unknown): asserts value is string { requireValue(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), "Invalid state team ID"); }

export function processIdentity(pid: number): string | undefined {
  requireValue(integer(pid, 1), "Invalid PID");
  requireValue(process.platform === "linux", "Process identity is only supported on Linux");
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ESRCH") {
      try { process.kill(pid, 0); }
      catch (probe) { if (code(probe) === "ESRCH") return undefined; throw probe; }
      throw new Error("Cannot determine identity of a live process");
    }
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return undefined;
  const start = fields[19];
  requireValue(start && /^\d+$/.test(start), "Cannot determine process identity");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  requireValue(boot, "Cannot determine boot identity");
  return `${boot}:${start}`;
}

export function processAlive(pid: number, identity?: string): boolean {
  requireValue(integer(pid, 1), "Invalid PID");
  try { process.kill(pid, 0); }
  catch (error) { if (code(error) === "ESRCH") return false; throw error; }
  const actual = processIdentity(pid);
  return actual !== undefined && (identity === undefined || actual === identity);
}

function validateWorktree(value: unknown): value is Worktree {
  return object(value) && [value.repo, value.path, value.branch, value.base].every(v => text(v)) && (value.target === undefined || text(value.target));
}
function taskView(state: TeamState, task: Task): TaskView {
  return structuredClone({ ...task, blockedBy: task.dependencies.filter(id => state.tasks[id]?.status !== "done") });
}

function taskLabel(title: string): string {
  return stripVTControlCharacters(title).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ").slice(0, taskLabelMaxLength).trim();
}

function migrate(state: unknown): boolean {
  if (!object(state) || ![1, 2, 3, 4].includes(state.version as number)) return false;
  if (state.version !== 4) migrateRoles(state);
  // Schema 5: a post's former text becomes its summary, unchanged.
  requireValue(Array.isArray(state.messages), "Invalid legacy messages");
  for (const message of state.messages) if (object(message) && Object.hasOwn(message, "text")) { message.summary = message.text; delete message.text; }
  state.version = 5;
  return true;
}
function migrateRoles(state: Record<string, unknown>): void {
  if (state.version !== 3) migrateTasks(state);
  // Schema 4: roles replace the special root ID; the creator's record becomes a main session.
  const root = state.root ?? "root";
  requireValue(object(state.members) && typeof root === "string" && Object.hasOwn(state.members, root), "Invalid legacy root member");
  for (const [key, member] of Object.entries(state.members)) if (object(member)) member.role = key === root ? "main" : "member";
  delete state.root;
  state.key = randomUUID();
  state.version = 4;
}
function migrateTasks(state: Record<string, unknown>): void {
  requireValue(object(state.tasks), "Invalid legacy state tasks");
  let number = 0;
  for (const task of Object.values(state.tasks)) {
    requireValue(object(task) && text(task.title, 500), "Invalid legacy task");
    if (state.version === 1) {
      requireValue(typeof task.status === "string" && ["pending", "claimed", "completed"].includes(task.status), "Invalid legacy task status");
      requireValue(task.status === "pending" ? task.owner === undefined : typeof task.owner === "string", "Invalid legacy task owner");
      if (task.status === "pending") task.status = "todo";
      else if (task.status === "claimed") task.status = "in_progress";
      else task.status = "done";
    }
    task.number = ++number;
    task.label = taskLabel(task.title) || "Task";
  }
}

function validate(state: unknown): asserts state is TeamState {
  requireValue(object(state), "Invalid state snapshot");
  id(state.id);
  requireValue(state.version === 5 && text(state.key) && integer(state.limit, 1) && integer(state.depth) && object(state.members) && object(state.tasks) && Array.isArray(state.messages), "Invalid state snapshot schema");
  const members = state.members;
  const names = new Set<string>(["main", "root", ...Object.keys(members)]);
  for (const [key, member] of Object.entries(members)) {
    requireValue(object(member) && member.id === key && text(key) && integer(member.depth) && text(member.token) && text(member.cwd) && ["starting", "busy", "idle", "stopping", "stopped", "interrupted"].includes(String(member.status)) && integer(member.notified), "Invalid state member");
    if (member.name !== undefined) {
      requireValue(text(member.name, memberNameMaxLength) && memberNamePattern.test(member.name) && !names.has(member.name), "Invalid or duplicate teammate name");
      names.add(member.name);
    }
    requireValue(member.parent === undefined || (text(member.parent) && Object.hasOwn(members, member.parent)), "Invalid member parent");
    for (const field of ["identity", "sessionId", "sessionFile", "error", "model", "modelName", "thinking", "activity", "summary", "provider"]) requireValue(member[field] === undefined || typeof member[field] === "string", "Invalid member field");
    if (member.contextUsage !== undefined) {
      const usage = member.contextUsage;
      requireValue(object(usage) && integer(usage.contextWindow, 1) && (usage.tokens === null || integer(usage.tokens)) && (usage.percent === null || typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent >= 0), "Invalid member context usage");
    }
    requireValue(member.role === undefined || member.role === "main" || member.role === "member", "Invalid member role");
    requireValue(member.role !== "main" || member.parent === undefined, "A main session has no parent");
    requireValue(member.handover === undefined || ["busy", "idle", "input"].includes(String(member.handover)), "Invalid member handover state");
    requireValue(member.promotion === undefined || (object(member.promotion) && ["stopped", "moved", "role", "entry"].includes(String(member.promotion.step)) && text(member.promotion.sessionFile)), "Invalid member promotion");
    requireValue(member.waiting === undefined || (object(member.waiting) && Array.isArray(member.waiting.tasks) && member.waiting.tasks.every(task => typeof task === "string" && Object.hasOwn(state.tasks as object, task))), "Invalid member wait");
    requireValue(member.analysis === undefined || member.analysis === "auto" || member.analysis === "separate", "Invalid member analysis preference");
    requireValue(member.terminal === undefined || typeof member.terminal === "boolean", "Invalid member terminal flag");
    requireValue(member.needsInput === undefined || typeof member.needsInput === "boolean", "Invalid member input flag");
    requireValue(member.pid === undefined || integer(member.pid, 1), "Invalid member PID");
    requireValue(member.worktree === undefined || validateWorktree(member.worktree), "Invalid member worktree");
    const paths = (value: unknown) => Array.isArray(value) && value.every(path => typeof path === "string" && path.startsWith("/"));
    const network = (value: unknown) => { try { return object(value) && (value.allow === undefined || (Array.isArray(value.allow) && value.allow.every(entry => typeof entry === "string"))) && (validatePolicy(value), true); } catch { return false; } };
    requireValue(member.access === undefined || (object(member.access) && paths(member.access.read) && paths(member.access.write) && network(member.access.network)), "Invalid member access");
    const seen = new Set<string>([key]);
    for (let parent: unknown = member.parent; parent !== undefined;) {
      requireValue(typeof parent === "string" && !seen.has(parent), "Cyclic member ancestry");
      seen.add(parent);
      parent = (members[parent] as Record<string, unknown>).parent;
    }
  }
  const tasks = state.tasks;
  const edges: Record<string, string[]> = {};
  const taskNumbers = new Set<number>();
  for (const [key, task] of Object.entries(tasks)) {
    requireValue(object(task) && task.id === key && text(key) && integer(task.revision, 1) && text(task.title, 500) && text(task.description) && typeof task.status === "string" && ["todo", "in_progress", "done"].includes(task.status) && Array.isArray(task.dependencies), "Invalid state task");
    requireValue(integer(task.number, 1) && !taskNumbers.has(task.number) && text(task.label, taskLabelMaxLength) && taskLabelPattern.test(task.label), "Invalid task number or label");
    taskNumbers.add(task.number);
    requireValue(task.completedAt === undefined || integer(task.completedAt), "Invalid task completion time");
    requireValue(task.dependencies.every(dep => typeof dep === "string" && dep !== key && Object.hasOwn(tasks, dep)) && new Set(task.dependencies).size === task.dependencies.length, "Invalid task dependencies");
    requireValue(task.owner === undefined || (typeof task.owner === "string" && Object.hasOwn(members, task.owner)), "Invalid task owner");
    requireValue([task.creator, task.delegator].every(member => member === undefined || (typeof member === "string" && Object.hasOwn(members, member))), "Invalid task creator or delegator");
    requireValue(task.outcome === undefined || (task.status === "done" && state.messages.some(message => object(message) && message.id === task.outcome && message.task === key)), "Invalid task outcome");
    requireValue(task.status !== "in_progress" || task.owner !== undefined, "In-progress task requires an owner");
    requireValue(task.status === "todo" || task.dependencies.every(dep => (tasks[dep] as Record<string, unknown>).status === "done"), "Active or done task has unfinished dependencies");
    edges[key] = task.dependencies;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    requireValue(!visiting.has(key), "Cyclic task dependencies");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of edges[key]) visit(dependency);
    visiting.delete(key); visited.add(key);
  }
  for (const key of Object.keys(tasks)) visit(key);
  let last = 0;
  const messageIds = new Set<string>();
  for (const message of state.messages) {
    requireValue(object(message) && integer(message.seq, last + 1) && text(message.id) && !messageIds.has(message.id) && typeof message.from === "string" && Object.hasOwn(members, message.from) && Array.isArray(message.recipients) && message.recipients.every(recipient => typeof recipient === "string" && Object.hasOwn(members, recipient)) && new Set(message.recipients).size === message.recipients.length && text(message.summary, maxMessageText) && typeof message.time === "string" && Number.isFinite(Date.parse(message.time)), "Invalid state message");
    requireValue((message.detail === undefined || text(message.detail)) && (message.task === undefined || (typeof message.task === "string" && Object.hasOwn(tasks, message.task))) && (message.replyTo === undefined || (typeof message.replyTo === "string" && messageIds.has(message.replyTo))) && (message.kind === undefined || (message.kind === "outcome" && message.task !== undefined)), "Invalid message detail or link");
    last = message.seq; messageIds.add(message.id);
  }
}

/**
 * Appends a post. Attention goes to explicit recipients, the linked task's owner and delegator (else creator),
 * and the replied-to post's author; never the sender, and never an implicit broadcast.
 */
function post(state: TeamState, actor: string, args: Pick<MessageArgs, "recipients" | "summary" | "detail" | "task" | "replyTo">, user = false): Message {
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
  const waiters = taskId === undefined ? [] : Object.values(state.members).filter(member => member.waiting?.tasks.includes(taskId)).map(member => member.id);
  const routed = [...explicit, task?.owner, task?.delegator ?? task?.creator, original?.from, ...waiters];
  const recipients = [...new Set(routed.filter((id): id is string => !!id && (id !== actor || (user && explicit.includes(id)))))];
  const message: Message = { seq: (state.messages.at(-1)?.seq ?? 0) + 1, id: randomUUID(), from: actor, recipients, summary: args.summary, time: new Date().toISOString() };
  if (args.detail !== undefined) message.detail = args.detail;
  if (taskId !== undefined) message.task = taskId;
  if (original) message.replyTo = original.id;
  state.messages.push(message);
  return message;
}

// Check every component rather than following a symlink into another home.
function ensureHome(path: string): void {
  const parent = dirname(path);
  if (parent !== path) ensureHome(parent);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
  requireValue(lstatSync(path).isDirectory(), `Unsafe home directory: ${path}`);
}
function privateFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.(), `Unsafe state file: ${path}`);
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export const teamsHome = () => join(stateRoot(), "teams");
/** Reads a team snapshot without taking ownership, for sessions that connect to its coordinator as clients. */
export function readState(dir: string): TeamState {
  const fd = privateFile(join(dir, "state.json"), constants.O_RDONLY);
  try {
    const stored: unknown = JSON.parse(readFileSync(fd, "utf8"));
    migrate(stored); validate(stored);
    return stored;
  } finally { closeSync(fd); }
}

/** Display names for members and tasks; their IDs are distinct UUIDs, so one map names both. */
export function stateLabels(state: TeamState): Record<string, string> {
  return Object.fromEntries([...Object.values(state.members).map(member => [member.id, memberName(member)]), ...Object.values(state.tasks).map(task => [task.id, `#${task.number} ${task.title}`])]);
}

/** Cache only display names, not histories; atomic snapshot replacements invalidate the cache. */
export function createMemberLabels(): (dir: string) => Record<string, string> {
  let key: string | undefined, labels: Record<string, string>;
  return dir => {
    const file = join(dir, "state.json"), stat = lstatSync(file, { bigint: true });
    const next = `${file}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}:${stat.mode}:${stat.uid}:${stat.nlink}`;
    if (next !== key) {
      labels = stateLabels(readState(dir));
      key = next;
    }
    return labels;
  };
}

export class Store {
  readonly dir: string;
  state: TeamState;
  private lock?: number;
  private closed = false;

  constructor(initial: TeamState, home = teamsHome()) {
    validate(initial);
    this.dir = join(resolve(home), initial.id);
    this.state = structuredClone(initial);
    ensureHome(resolve(home));
    try { mkdirSync(this.dir, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
    const dirFd = openSync(this.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireValue(fstatSync(dirFd).uid === process.getuid?.(), "Team directory belongs to another user");
      fchmodSync(dirFd, 0o700);
    } finally { closeSync(dirFd); }
    try {
      this.acquire();
      const path = join(this.dir, "state.json");
      let present = true;
      try { lstatSync(path); } catch (error) { if (code(error) !== "ENOENT") throw error; present = false; }
      if (present) {
        const fd = privateFile(path, constants.O_RDONLY);
        try {
          const stored: unknown = JSON.parse(readFileSync(fd, "utf8"));
          const migrated = migrate(stored);
          validate(stored);
          requireValue(stored.id === initial.id, "Snapshot team ID mismatch");
          if (migrated) this.flush(stored);
          this.state = stored;
        } finally { closeSync(fd); }
      } else this.flush(this.state);
    } catch (error) { this.close(); throw error; }
  }

  private acquire(): void {
    const path = join(this.dir, "owner.lock");
    try { this.lock = privateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      // Serialize stale-lock reapers; an interrupted recovery fails closed.
      const recoveryPath = join(this.dir, "owner.recovery");
      const recovery = privateFile(recoveryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        const fd = privateFile(path, constants.O_RDONLY);
        try {
          const owner: unknown = JSON.parse(readFileSync(fd, "utf8"));
          requireValue(object(owner) && integer(owner.pid, 1) && text(owner.identity), "Uncertain owner lock; refusing recovery");
          requireValue(!processAlive(owner.pid, owner.identity), "Team already has a live owner lock");
          const before = fstatSync(fd), current = lstatSync(path);
          requireValue(before.ino === current.ino && before.dev === current.dev, "Owner lock changed during recovery");
          unlinkSync(path);
        } finally { closeSync(fd); }
        this.lock = privateFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      } finally { closeSync(recovery); unlinkSync(recoveryPath); }
    }
    const identity = processIdentity(process.pid);
    requireValue(identity, "Cannot identify owner process");
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, identity }));
    fsyncSync(this.lock);
  }

  private flush(state: TeamState): void {
    const temp = join(this.dir, `.state-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = privateFile(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
      const snapshot = join(this.dir, "state.json");
      try { const existing = privateFile(snapshot, constants.O_RDONLY); closeSync(existing); }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      renameSync(temp, snapshot);
      const directory = openSync(this.dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if (code(error) !== "ENOENT") throw error; }
    }
  }

  update<T>(fn: (state: TeamState) => T): T {
    requireValue(!this.closed, "Store is closed");
    const draft = structuredClone(this.state);
    const result = fn(draft);
    validate(draft);
    requireValue(draft.id === this.state.id, "Cannot change team ID");
    this.flush(draft);
    this.state = draft;
    return result;
  }

  task(actor: string, args: TaskArgs): TaskView | { tasks: TaskView[]; total: number } {
    requireValue(!this.closed && Object.hasOwn(this.state.members, actor), "Unknown actor or closed store");
    requireValue(args.tasks === undefined || args.action === "create", "tasks is only valid for create");
    if (args.action === "list") {
      const tasks = Object.values(this.state.tasks);
      const offset = args.offset ?? 0, limit = args.limit ?? 100;
      requireValue(integer(offset) && integer(limit, 1) && limit <= 100, "Invalid task offset or limit (1-100)");
      return { tasks: tasks.slice(offset, offset + limit).map(task => taskView(this.state, task)), total: tasks.length };
    }
    if (args.action === "read") {
      requireValue(args.id && Object.hasOwn(this.state.tasks, args.id), "Unknown task");
      return taskView(this.state, this.state.tasks[args.id]);
    }
    return this.update(state => {
      if (args.action === "create") {
        requireValue(args.tasks === undefined || (Array.isArray(args.tasks) && args.tasks.length > 0 && args.tasks.length <= 100), "Batch create requires 1-100 tasks");
        requireValue(args.tasks === undefined || [args.title, args.label, args.description, args.dependencies].every(value => value === undefined), "Use tasks or top-level task fields, not both");
        const inputs = args.tasks ?? [args];
        let number = Object.values(state.tasks).reduce((max, task) => Math.max(max, task.number), 0);
        const existing = new Set(Object.keys(state.tasks));
        const created = inputs.map(input => {
          requireValue(object(input) && text(input.title, 500), "Task requires a title (max 500)");
          const description = input.description === undefined ? input.title : input.description;
          requireValue(text(description), "Task requires a description (max 16000)");
          const label = input.label === undefined ? taskLabel(input.title) : input.label;
          requireValue(text(label, taskLabelMaxLength) && taskLabelPattern.test(label), "Task requires a 1–3-word label (max 60 characters)");
          const dependencies = input.dependencies === undefined ? [] : structuredClone(input.dependencies);
          requireValue(Array.isArray(dependencies) && dependencies.length <= 100 && dependencies.every(dep => existing.has(dep)), "Dependencies must refer to existing tasks");
          const task: Task = { id: randomUUID(), number: ++number, label, revision: 1, creator: actor, title: input.title, description, dependencies, status: "todo" };
          state.tasks[task.id] = task;
          return taskView(state, task);
        });
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
        if (args.dependencies !== undefined) task.dependencies = structuredClone(args.dependencies);
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
        requireValue(args.acceptance === true, "Completion requires acceptance=true after checking acceptance criteria");
        requireValue(text(args.summary), "Completion requires an outcome summary: what was done, how it was checked, and any caveats");
        const outcome = post(state, actor, { summary: args.summary, detail: args.detail, task: task.id });
        outcome.kind = "outcome";
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
        const dependents = Object.values(state.tasks).filter(other => other.dependencies.includes(task.id) && other.status !== "todo");
        requireValue(dependents.length === 0, `Cannot reopen task with active or done dependents: ${dependents.map(t => t.id).join(", ")}`);
        task.status = "todo";
        delete task.completedAt; delete task.outcome;
      } else throw new Error("Unknown task action");
      task.revision++;
      return taskView(state, task);
    });
  }

  message(actor: string, args: MessageArgs, enveloped = false): Message | Message[] {
    requireValue(!this.closed && Object.hasOwn(this.state.members, actor), "Unknown actor or closed store");
    if (args.action === "send") return this.update(state => structuredClone(post(state, actor, args, enveloped)));
    if (args.action === "wait") return this.update(state => {
      const tasks = args.tasks ?? [];
      requireValue(Array.isArray(tasks) && tasks.length <= 100 && tasks.every(task => Object.hasOwn(state.tasks, task)), "Wait tasks must be existing task IDs");
      // Register and recheck in one mutation, so a post committed after the caller last looked still wakes it.
      const after = args.after ?? state.members[actor].notified;
      const ready = state.messages.filter(message => message.seq > after && (message.recipients.includes(actor) || (message.task !== undefined && tasks.includes(message.task))));
      if (ready.length) delete state.members[actor].waiting;
      else state.members[actor].waiting = { tasks: [...new Set(tasks)] };
      return structuredClone(ready);
    });
    requireValue(args.action === "history" || args.action === "search", "Unknown message action");
    const after = args.after ?? 0, limit = args.limit ?? 20;
    requireValue(integer(after) && integer(limit, 1) && limit <= 100, "Invalid cursor or limit (1-100)");
    if (args.action === "search") requireValue(text(args.query, 500), "Search requires a nonempty query (max 500)");
    const results = [];
    for (const message of this.state.messages) {
      if (message.seq > after && (args.action !== "search" || (message.summary.includes(args.query!) || !!message.detail?.includes(args.query!)))) results.push(message);
      if (results.length === limit) break;
    }
    return structuredClone(results);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock === undefined) return;
    const fd = this.lock; this.lock = undefined;
    try {
      const path = join(this.dir, "owner.lock");
      const mine = fstatSync(fd);
      try {
        const current = lstatSync(path);
        if (current.ino === mine.ino && current.dev === mine.dev) unlinkSync(path);
      } catch (error) { if (code(error) !== "ENOENT") throw error; }
    } finally { closeSync(fd); }
  }
}
