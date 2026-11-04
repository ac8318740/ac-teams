import type { Access, AccessRequest } from "./access.ts";
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
  /** Launch-time pi-lens preference; absent older records default to auto. */
  analysis?: "auto" | "separate";
  activity?: string;
  summary?: string;
  terminal?: boolean;
  needsInput?: boolean;
  access?: Access;
  /** Provider fixed at an enforced member's first launch; member telemetry cannot change it. */
  provider?: string;
  /** Authority: a main session or a member. Absent once a main session has left the team. */
  role?: "main" | "member";
  /** State recorded when the coordinator owner stopped this member; the next owner's resume pass consumes it. */
  handover?: "busy" | "idle" | "input";
  /** Registered by a yield: posts on these tasks reach this member and wake it. Cleared when it next works. */
  waiting?: { tasks: string[] };
  /** Promotion in progress: the last completed step and what a rollback restores. */
  promotion?: { step: "stopped" | "moved" | "role" | "entry"; sessionFile: string; parent?: string; access?: Access; provider?: string };
}
export const memberNameMaxLength = 40;
export const memberNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)?(?![\s\S])/;
export function memberName(member: Pick<Member, "id" | "name">): string { return member.id === "root" ? "Main" : member.name ?? member.id; }
export function isMain(member: Pick<Member, "role"> | undefined): boolean { return member?.role === "main"; }
/** Mains control every member and other mains; members control only their descendants, never a main. */
export function canControl(state: TeamState, actor: string, id: string): boolean {
  const target = state.members[id];
  return !!target && id !== actor && (isMain(state.members[actor]) ? target.role !== undefined : !isMain(target) && isDescendant(state, id, actor));
}
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
  /** Who handed this task to its owner; receives its activity. Routing falls back to the creator. */
  delegator?: string;
  /** The post that published this task's completion outcome. */
  outcome?: string;
}
export interface TaskView extends Task {
  blockedBy: string[];
}
export interface Message {
  seq: number;
  id: string;
  from: string;
  recipients: string[];
  /** Delivered directly in notices; complete enough to act on. */
  summary: string;
  /** Read on demand. */
  detail?: string;
  task?: string;
  replyTo?: string;
  /** "outcome": the post that completed its task. */
  kind?: "outcome";
  time: string;
}
export interface TeamState {
  version: 5;
  id: string;
  /** Lets an unsandboxed session of the same user add itself as a main session. */
  key: string;
  limit: number;
  depth: number;
  members: Record<string, Member>;
  tasks: Record<string, Task>;
  messages: Message[];
}
export interface TaskInput {
  title: string;
  label?: string;
  description?: string;
  dependencies?: string[];
}
export interface TaskArgs {
  tasks?: TaskInput[];
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
  /** Complete: the outcome published with the completion. */
  summary?: string;
  detail?: string;
}
export interface MessageArgs {
  action: "send" | "history" | "search" | "wait";
  /** Wait: also wake on posts linked to these tasks. */
  tasks?: string[];
  recipients?: string[];
  summary?: string;
  detail?: string;
  task?: string;
  replyTo?: string;
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
  analysis?: "auto" | "separate";
  worktree?: boolean;
  base?: string;
  target?: string;
  limit?: number;
  depth?: number;
  access?: AccessRequest;
  /** Launch: an existing task the new member owns, with the requester as its delegator. */
  task?: string;
}
export interface UserAction {
  action: "task_request" | "feedback" | "resume" | "promote" | "leave";
  id?: string;
  /** Promote: the user approved running a sandboxed member with full access. */
  confirmed?: boolean;
  text?: string;
  model?: string;
  thinking?: string;
}
export type Operation = "agent" | "task" | "message" | "join" | "ack" | "event" | "control_result" | "ui" | "add_main";
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
