export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
  target?: string;
}
export interface Member {
  id: string;
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
}
export interface Task {
  id: string;
  revision: number;
  title: string;
  description: string;
  dependencies: string[];
  status: "todo" | "in_progress" | "done";
  owner?: string;
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
  version: 2;
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
export type Operation = "agent" | "task" | "message" | "join" | "ack";
export function isLive(member: Member): boolean {
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
