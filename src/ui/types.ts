import type { Member, Message, TaskView } from "../types.ts";

export interface TeamSnapshot {
  members: Omit<Member, "token" | "identity">[];
  tasks: TaskView[];
  messages: Message[];
  limit: number;
  depth: number;
}

export interface PanelHost {
  self: string;
  /** True in a member session; false in a main session. */
  child: boolean;
  snapshot(includeMessages?: boolean): Promise<TeamSnapshot>;
  visit(id: string): Promise<void>;
  requestTask(text: string): Promise<string>;
  feedback(task: TaskView, text: string): Promise<string>;
  resume(memberId: string): Promise<void>;
  /** Stops a member and relaunches it as a main session (user only). */
  promote(memberId: string): Promise<void>;
  drafts: Map<string, string>;
}
