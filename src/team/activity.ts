import { isDeepStrictEqual } from "node:util";
import { isRecord, send } from "./connection.ts";
import { validate } from "./requests.ts";
import { Store } from "./store.ts";
import type { TeamProtocol } from "./protocol.ts";
import type { CoordinatorOptions } from "./options.ts";
import { liveMembers } from "./launch.ts";
import { isDescendant, isLive, isMain, type ContextUsage } from "../types.ts";

export function assistantEvent(message: unknown): { type: string; text: string } | undefined {
  if (!isRecord(message) || message.role !== "assistant") return;
  // Pi can report its AbortError as an error after a completed tool batch.
  if (message.stopReason === "aborted" || (message.stopReason === "error" && message.errorMessage === "This operation was aborted")) return { type: "cancelled", text: "" };
  if (message.stopReason === "error") return { type: "model_error", text: String(message.errorMessage || "Model request failed").slice(0, 2000) };
  if (message.stopReason !== "stop" || !Array.isArray(message.content)) return;
  const text = message.content.filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string").map(part => part.text).join(" ").trim().split("\n")[0].slice(0, 500);
  return text ? { type: "summary", text } : undefined;
}

/** Converts member events into visible state and ancestor attention. */
export class TeamActivity {
  readonly statuses = new Map<string, { busy: boolean; blocked: boolean }>();
  private store: Store;
  private self: string;
  private options: CoordinatorOptions;
  private protocol: TeamProtocol;
  private stopping: () => boolean;
  private settled: (id: string) => void;

  constructor(store: Store, self: string, options: CoordinatorOptions, protocol: TeamProtocol, stopping: () => boolean, settled: (id: string) => void) {
    this.settled = settled;
    this.store = store;
    this.self = self;
    this.options = options;
    this.protocol = protocol;
    this.stopping = stopping;
  }
  publish(force?: string): void {
    const state = this.store.state;
    for (const id of new Set([this.self, ...this.protocol.sockets.keys()])) {
      const owner = state.members[id];
      const members = liveMembers(this.store).filter(member => member.status !== "stopping" && isDescendant(state, member.id, id));
      const next = {
        busy: !!owner && isLive(owner) && owner.status !== "stopping" && owner.attention !== "handoff" && members.some(member => member.status === "starting" || member.status === "busy"),
        blocked: members.some(member => member.needsInput),
      };
      const previous = this.statuses.get(id);
      if (id === this.self) {
        for (const kind of ["busy", "blocked"] as const) if (next[kind] !== (previous?.[kind] ?? false)) this.options.status?.(kind, next[kind]);
      } else if (id === force || !isDeepStrictEqual(previous, next)) {
        send(this.protocol.sockets.get(id)!, { type: "attention", ...next });
      }
      this.statuses.set(id, next);
    }
  }
  record(actor: string, value: unknown): void {
    validate("event", value);
    if (this.stopping()) return;
    const event = value as { type: string; active?: boolean; text?: string; model?: string; modelName?: string; contextUsage?: ContextUsage | null };
    const member = this.store.state.members[actor];
    if (!member || !isLive(member) || (member.status === "stopping" && event.type !== "model_error")) return;
    const current = { ...member };
    if (event.type === "blocked") { if (event.active) current.needsInput = true; else delete current.needsInput; }
    else if (event.type === "telemetry") {
      current.model = event.model ?? current.model;
      current.modelName = event.modelName;
      current.contextUsage = event.contextUsage ?? undefined;
    }
    else if (event.type === "agent_start") { current.status = "busy"; current.activity = "Working"; delete current.error; delete current.summary; if (current.attention === "handoff") delete current.attention; }
    else if (event.type === "agent_settled") { delete current.needsInput; current.status = "idle"; current.activity = current.error ? "Model request failed" : current.summary || "Available for follow-up"; }
    else if (event.type === "activity") current.activity = event.text;
    else if (event.type === "summary") current.summary = event.text?.slice(0, 500);
    else if (event.type === "model_error") current.error = event.text || "Model request failed";
    if (["summary", "model_error", "cancelled"].includes(event.type)) current.attention = "handoff";
    if (!isDeepStrictEqual(member, current)) {
      this.store.update(next => { next.members[actor] = structuredClone(current); });
      this.publish();
      if (!isMain(member) && member.status === "busy" && current.status === "idle") this.settled(actor);
    }
    if (event.type === "model_error" && !isMain(member) && member.status !== "stopping") {
      const recipient = member.parent && isLive(this.store.state.members[member.parent]) ? member.parent : this.self;
      this.store.message(actor, { action: "send", recipients: [recipient], summary: `Member ${actor} model error: ${event.text || "Model request failed"}` });
      this.protocol.notify(recipient);
    }
  }
}
