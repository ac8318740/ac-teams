import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { isDescendant, isLive, memberNamePattern, memberNameMaxLength, taskLabelMaxLength, taskLabelPattern } from "./types.ts";
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

function migrate(state: unknown): boolean {
  if (!object(state) || (state.version !== 1 && state.version !== 2)) return false;
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
    task.label = stripVTControlCharacters(task.title).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ").slice(0, taskLabelMaxLength).trim() || "Task";
  }
  state.version = 3;
  return true;
}

function validate(state: unknown): asserts state is TeamState {
  requireValue(object(state), "Invalid state snapshot");
  id(state.id);
  requireValue(state.version === 3 && text(state.root) && integer(state.limit, 1) && integer(state.depth) && object(state.members) && object(state.tasks) && Array.isArray(state.messages), "Invalid state snapshot schema");
  const members = state.members;
  const names = new Set<string>(["main", "root", ...Object.keys(members)]);
  for (const [key, member] of Object.entries(members)) {
    requireValue(object(member) && member.id === key && text(key) && integer(member.depth) && text(member.token) && text(member.cwd) && ["starting", "busy", "idle", "stopping", "stopped", "interrupted"].includes(String(member.status)) && integer(member.notified), "Invalid state member");
    if (member.name !== undefined) {
      requireValue(text(member.name, memberNameMaxLength) && memberNamePattern.test(member.name) && !names.has(member.name), "Invalid or duplicate teammate name");
      names.add(member.name);
    }
    requireValue(member.parent === undefined || (text(member.parent) && Object.hasOwn(members, member.parent)), "Invalid member parent");
    for (const field of ["identity", "sessionId", "sessionFile", "error", "model", "modelName", "thinking", "activity", "summary"]) requireValue(member[field] === undefined || typeof member[field] === "string", "Invalid member field");
    if (member.contextUsage !== undefined) {
      const usage = member.contextUsage;
      requireValue(object(usage) && integer(usage.contextWindow, 1) && (usage.tokens === null || integer(usage.tokens)) && (usage.percent === null || typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent >= 0), "Invalid member context usage");
    }
    requireValue(member.terminal === undefined || typeof member.terminal === "boolean", "Invalid member terminal flag");
    requireValue(member.needsInput === undefined || typeof member.needsInput === "boolean", "Invalid member input flag");
    requireValue(member.pid === undefined || integer(member.pid, 1), "Invalid member PID");
    requireValue(member.worktree === undefined || validateWorktree(member.worktree), "Invalid member worktree");
    const seen = new Set<string>([key]);
    for (let parent: unknown = member.parent; parent !== undefined;) {
      requireValue(typeof parent === "string" && !seen.has(parent), "Cyclic member ancestry");
      seen.add(parent);
      parent = (members[parent] as Record<string, unknown>).parent;
    }
  }
  requireValue(Object.hasOwn(members, state.root), "Invalid root member");
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
    requireValue(task.creator === undefined || (typeof task.creator === "string" && Object.hasOwn(members, task.creator)), "Invalid task creator");
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
    requireValue(object(message) && integer(message.seq, last + 1) && text(message.id) && !messageIds.has(message.id) && typeof message.from === "string" && Object.hasOwn(members, message.from) && Array.isArray(message.recipients) && message.recipients.every(recipient => typeof recipient === "string" && Object.hasOwn(members, recipient)) && new Set(message.recipients).size === message.recipients.length && text(message.text, maxMessageText) && typeof message.time === "string" && Number.isFinite(Date.parse(message.time)), "Invalid state message");
    last = message.seq; messageIds.add(message.id);
  }
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

export class Store {
  readonly dir: string;
  state: TeamState;
  private lock?: number;
  private closed = false;

  constructor(initial: TeamState, home = join(homedir(), ".acstack", "ac-teams", "teams")) {
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
        requireValue(text(args.title, 500) && text(args.description), "Task requires a title (max 500) and description (max 16000)");
        const label = args.label ?? args.title;
        requireValue(text(label, taskLabelMaxLength) && taskLabelPattern.test(label), "Task requires a 1–3-word label (max 60 characters); a concise title can serve as the label");
        const number = Object.values(state.tasks).reduce((max, task) => Math.max(max, task.number), 0) + 1;
        const task: Task = { id: randomUUID(), number, label, revision: 1, creator: actor, title: args.title, description: args.description, dependencies: args.dependencies === undefined ? [] : structuredClone(args.dependencies), status: "todo" };
        state.tasks[task.id] = task;
        return taskView(state, task);
      }
      requireValue(args.id && Object.hasOwn(state.tasks, args.id), "Unknown task");
      const task = state.tasks[args.id];
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
        requireValue(task.owner === actor, "Only the owner can start this task; claim it first");
        requireValue(task.status === "todo", "Only to-do tasks can be started");
        const blocked = taskView(state, task).blockedBy;
        requireValue(blocked.length === 0, `Task is blocked by unfinished dependencies: ${blocked.join(", ")}`);
        task.status = "in_progress";
      } else if (args.action === "complete") {
        requireValue(task.owner === actor, "Only the owner can complete this task");
        requireValue(task.status === "in_progress", "Only in-progress tasks can be completed; start it first");
        requireValue(args.acceptance === true, "Completion requires acceptance=true after checking acceptance criteria");
        task.status = "done";
        task.completedAt = Date.now();
      } else if (args.action === "release") {
        requireValue(task.owner, "Task has no owner to release");
        const interrupted = ["interrupted", "stopped"].includes(state.members[task.owner].status);
        requireValue(task.owner === actor || (interrupted && (actor === state.root || isDescendant(state, task.owner, actor))), "Only the owner can release this task; ancestors may release interrupted descendants");
        if (task.status === "in_progress") task.status = "todo";
        delete task.owner;
      } else if (args.action === "reopen") {
        requireValue(task.status === "done", "Only done tasks can be reopened");
        requireValue(!task.owner || task.owner === actor || actor === state.root, "Only the owner or root can reopen an owned task");
        const dependents = Object.values(state.tasks).filter(other => other.dependencies.includes(task.id) && other.status !== "todo");
        requireValue(dependents.length === 0, `Cannot reopen task with active or done dependents: ${dependents.map(t => t.id).join(", ")}`);
        task.status = "todo";
        delete task.completedAt;
      } else throw new Error("Unknown task action");
      task.revision++;
      return taskView(state, task);
    });
  }

  message(actor: string, args: MessageArgs, enveloped = false): Message | Message[] {
    requireValue(!this.closed && Object.hasOwn(this.state.members, actor), "Unknown actor or closed store");
    if (args.action === "send") return this.update(state => {
      const limit = enveloped ? maxMessageText : 16000;
      requireValue(text(args.text, limit), `Message text must be nonempty and at most ${limit} characters`);
      const recipients = args.recipients === undefined ? Object.values(state.members).filter(member => member.id !== actor && isLive(member)).map(member => member.id) : args.recipients;
      requireValue(Array.isArray(recipients) && (args.recipients === undefined || recipients.length > 0) && new Set(recipients).size === recipients.length && recipients.every(recipient => typeof recipient === "string" && Object.hasOwn(state.members, recipient) && isLive(state.members[recipient])), "Recipients must be unique live member IDs");
      const message = { seq: (state.messages.at(-1)?.seq ?? 0) + 1, id: randomUUID(), from: actor, recipients: [...recipients], text: args.text, time: new Date().toISOString() };
      state.messages.push(message);
      return structuredClone(message);
    });
    requireValue(args.action === "history" || args.action === "search", "Unknown message action");
    const after = args.after ?? 0, limit = args.limit ?? 20;
    requireValue(integer(after) && integer(limit, 1) && limit <= 100, "Invalid cursor or limit (1-100)");
    if (args.action === "search") requireValue(text(args.query, 500), "Search requires a nonempty query (max 500)");
    const results = [];
    for (const message of this.state.messages) {
      if (message.seq > after && (args.action !== "search" || message.text.includes(args.query!))) results.push(message);
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
