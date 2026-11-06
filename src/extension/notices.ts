import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "../types.ts";

interface ReceiptTransport {
  remote: boolean;
  ack(through: number): void | Promise<void>;
}

export function createNotices(pi: ExtensionAPI, receiptIdentity: () => { team: string; member: string },
  memberLabels: () => Record<string, string>, warn: (message: string) => void,
  transport: () => ReceiptTransport | undefined) {
  /** Highest notice handed to Pi, and highest found persisted in this session and acknowledged. */
  let sent = 0, acked = 0;
  let ackPending: object | undefined;
  const attention = { busy: false, blocked: false };
  const setAttention = (kind: "busy" | "blocked", active: boolean) => {
    if (attention[kind] === active) return;
    attention[kind] = active;
    pi.events.emit(`herdr:${kind}`, { active, source: "ac-teams" });
  };
  const receiveAttention = (value: typeof attention) => {
    setAttention("busy", value.busy);
    setAttention("blocked", value.blocked);
  };
  const resetReceipts = () => {
    sent = acked = 0;
    ackPending = undefined;
  };
  const notify = (through: number, messages: Message[] = []) => {
    if (through <= sent) return;
    // Unacknowledged posts are offered again; show each one once.
    messages = messages.filter(message => message.seq > sent);
    const labels = memberLabels(), name = (id: string) => labels[id] ?? id;
    const lines = messages.map(message => `[${message.seq}] ${name(message.from)}${message.kind === "outcome" ? " completed" : ""}${message.task ? ` ${name(message.task)} [${message.task}]` : ""}: ${message.summary}${message.detail ? ` (detail: team_message history seq=${message.seq} includeDetail=true)` : ""}`);
    pi.sendMessage({ customType: "ac-teams", content: `Team posts:\n${lines.join("\n")}\nAct only if one needs you. Fetch detail only to settle a question about your own work.`, display: true, details: { ...receiptIdentity(), through, messages } }, { deliverAs: "steer", triggerTurn: true });
    sent = through;
  };
  /** Acknowledges notices only once they are durable session entries, so a crash before persistence redelivers them. */
  const reconcile = (ctx: ExtensionContext) => {
    const identity = receiptIdentity();
    const through = ctx.sessionManager.getEntries().reduce((max, entry) => {
      if (entry.type !== "custom_message" || entry.customType !== "ac-teams") return max;
      const receipt = entry.details as { team?: string; member?: string; through?: number } | undefined;
      return receipt?.team === identity.team && receipt.member === identity.member && Number.isSafeInteger(receipt.through) ? Math.max(max, receipt.through!) : max;
    }, 0);
    sent = Math.max(sent, through);
    const target = transport();
    if (through <= acked || ackPending || !target) return;
    if (target.remote) {
      const pending = ackPending = {};
      void Promise.resolve(target.ack(through)).then(() => {
        if (ackPending !== pending) return;
        acked = through;
        ackPending = undefined;
        reconcile(ctx);
      }).catch(error => {
        if (ackPending !== pending) return;
        ackPending = undefined;
        warn(String(error));
      });
    } else {
      try { target.ack(through); acked = through; }
      catch (error) { warn(String(error)); }
    }
  };
  return { notify, reconcile, reset: resetReceipts, receiveAttention, setAttention, get sent() { return sent; } };
}
