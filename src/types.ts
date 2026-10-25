export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
  target?: string;
}
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
export interface Telemetry {
  type: "telemetry";
  model?: string;
  modelName?: string;
  contextUsage: ContextUsage | null;
}
export interface Member {
  id: string;
  name?: string;
  parent?: string;
  depth: number;
  token: string;
  cwd: string;
  status: "starting" | "busy" | "idle" | "stopping" | "stopped" | "interrupted";
  pid?: number;
  identity?: string;
  sessionId?: string;
  sessionFile?: string;
  notified: number;
  worktree?: Worktree;
  error?: string;
  model?: string;
  modelName?: string;
  contextUsage?: ContextUsage;
  thinking?: string;
  activity?: string;
  summary?: string;
  terminal?: boolean;
}
export const memberNameMaxLength = 40;
export const memberNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)?(?![\s\S])/;
export function memberName(member: Pick<Member, "id" | "name">): string { return member.id === "root" ? "Main" : member.name ?? member.id; }
export const taskLabelMaxLength = 60;
export const taskLabelPattern = /^[^\s\x00-\x1f\x7f-\x9f]+(?: [^\s\x00-\x1f\x7f-\x9f]+){0,2}(?![\s\S])/;
export function taskName(task: Pick<Task, "number" | "label">): string { return `#${task.number} ${task.label}`; }
export interface Task {
  id: string;
  number: number;
  label: string;
  revision: number;
  title: string;
  description: string;
  dependencies: string[];
  status: "todo" | "in_progress" | "done";
  completedAt?: number;
  owner?: string;
  creator?: string;
}
export interface TaskView extends Task {
  blockedBy: string[];
}
export interface Message {
  seq: number;
  id: string;
  from: string;
  recipients: string[];
  text: string;
  time: string;
}
export interface TeamState {
  version: 3;
  id: string;
  root: string;
  limit: number;
  depth: number;
  members: Record<string, Member>;
  tasks: Record<string, Task>;
  messages: Message[];
}
export interface TaskArgs {
  action: "create" | "list" | "read" | "edit" | "claim" | "start" | "release" | "complete" | "reopen";
  revision?: number;
  acceptance?: boolean;
  offset?: number;
  limit?: number;
  id?: string;
  title?: string;
  label?: string;
  description?: string;
  dependencies?: string[];
}
export interface MessageArgs {
  action: "send" | "history" | "search";
  recipients?: string[];
  text?: string;
  query?: string;
  after?: number;
  limit?: number;
}
export interface AgentArgs {
  action: "launch" | "list" | "status" | "stop" | "resume" | "limits" | "cleanup";
  id?: string;
  name?: string;
  brief?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  worktree?: boolean;
  base?: string;
  target?: string;
  limit?: number;
  depth?: number;
}
export interface UserAction {
  action: "task_request" | "feedback" | "resume";
  id?: string;
  text?: string;
  model?: string;
  thinking?: string;
}
export type Operation = "agent" | "task" | "message" | "join" | "ack" | "event" | "control_result" | "ui";
export function isLive(member: Pick<Member, "status">): boolean {
  return ["starting", "busy", "idle", "stopping"].includes(member.status);
}
export function isDescendant(state: TeamState, id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let member = state.members[id]; member?.parent; member = state.members[member.parent]) {
    if (seen.has(member.id)) return false;
    seen.add(member.id);
    if (member.parent === ancestor) return true;
  }
  return false;
}
