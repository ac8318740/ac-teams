import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "../settings/config.ts";
import { validExtensionSelection } from "../settings/extension-selection.ts";
import { validatePolicy } from "../sandbox/egress.ts";
import { stripVTControlCharacters } from "node:util";
import { memberName, memberNamePattern, memberNameMaxLength, taskLabelMaxLength, taskLabelPattern } from "../types.ts";
import type { TeamState, Worktree } from "../types.ts";

// UI envelopes add task context after the public 16,000-character input limit.
export const maxMessageText = 17000;
export function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
export function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function text(value: unknown, max = 16000): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function id(value: unknown): asserts value is string { requireValue(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), "Invalid state team ID"); }

function validateWorktree(value: unknown): value is Worktree {
  return object(value) && [value.repo, value.path, value.branch, value.base].every(v => text(v)) && (value.target === undefined || text(value.target));
}
export function taskLabel(title: string): string {
  return stripVTControlCharacters(title).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ").slice(0, taskLabelMaxLength).trim();
}

export function migrate(state: unknown): boolean {
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

export function validate(state: unknown): asserts state is TeamState {
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
    requireValue(member.watches === undefined || (Array.isArray(member.watches) && member.watches.length <= 100 && member.watches.every(watch => object(watch) && typeof watch.task === "string" && Object.hasOwn(state.tasks as object, watch.task) && ["message", "completed"].includes(String(watch.event)) && (watch.seq === undefined || integer(watch.seq, 1)))), "Invalid task watches");
    requireValue(member.analysis === undefined || member.analysis === "auto" || member.analysis === "separate", "Invalid member analysis preference");
    requireValue(member.extensions === undefined || validExtensionSelection(member.extensions), "Invalid member extension selection");
    requireValue(member.terminal === undefined || typeof member.terminal === "boolean", "Invalid member terminal flag");
    requireValue(member.needsInput === undefined || typeof member.needsInput === "boolean", "Invalid member input flag");
    requireValue(member.attention === undefined || member.attention === "waiting" || member.attention === "handoff", "Invalid member attention");
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

// Check every component rather than following a symlink into another home.
export function ensureHome(path: string): void {
  const parent = dirname(path);
  if (parent !== path) ensureHome(parent);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
  requireValue(lstatSync(path).isDirectory(), `Unsafe home directory: ${path}`);
}
export function privateFile(path: string, flags: number): number {
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

export function flush(dir: string, state: TeamState): void {
  const temp = join(dir, `.state-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = privateFile(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
    const snapshot = join(dir, "state.json");
    try { const existing = privateFile(snapshot, constants.O_RDONLY); closeSync(existing); }
    catch (error) { if (code(error) !== "ENOENT") throw error; }
    renameSync(temp, snapshot);
    const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
}
