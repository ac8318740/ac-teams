import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Member, Telemetry } from "./types.ts";

export function readTelemetry(ctx: ExtensionContext): Telemetry {
  const usage = ctx.getContextUsage();
  return { type: "telemetry", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    modelName: ctx.model?.name ?? ctx.model?.id,
    contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null };
}

export function modelContext(member: Pick<Member, "model" | "modelName" | "contextUsage">): string {
  const model = member.modelName || member.model?.slice(member.model.indexOf("/") + 1) || "Model unknown";
  const usage = member.contextUsage;
  const count = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(value);
  const context = !usage ? "context unknown" : usage.tokens === null || usage.percent === null
    ? `context unknown / ${count(usage.contextWindow)}`
    : `${count(usage.tokens)} / ${count(usage.contextWindow)} (${usage.percent.toFixed(1).replace(/\.0$/, "")}%)`;
  return `${model} · ${context}`;
}
