import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindNoticeGroups } from "../ui/notice-groups.ts";
import { cleanText } from "../ui/render.ts";
import { isRecord } from "../team/connection.ts";
import { assistantEvent } from "../team/coordinator.ts";
import { readTelemetry } from "../ui/telemetry.ts";
import type { TeamSession } from "./session.ts";
import type { TeamPresentation } from "./presentation.ts";

type EventSession = Pick<TeamSession,
  "child" | "link" | "teamId" | "report" | "warn" | "notices" | "stopping" | "connected" | "publish" |
  "blocked" | "clearBlocked" | "disabled" | "start" | "memberLabels" | "memberId" | "ownWarnings" |
  "close" | "switchBlocked" | "liveCount" | "reloadStarted" | "reloadBoundary" | "reloadSettled">;

export function createEvents(pi: ExtensionAPI, session: EventSession,
  presentation: Pick<TeamPresentation, "installUI">, observe: () => void) {
  const { child, link, teamId, report, warn } = session;
  const { reconcile } = session.notices;
  let telemetryTimer: NodeJS.Timeout | undefined;
  let disposeNoticeGroups: (() => void) | undefined;
  let warned = false;
  function startTelemetry(ctx: ExtensionContext) {
    clearInterval(telemetryTimer);
    let previous = "", pending = false;
    const publish = async () => {
      if (session.stopping || pending || !session.connected) return;
      pending = true;
      try {
        const event = readTelemetry(ctx), encoded = JSON.stringify(event);
        if (encoded === previous) return;
        await session.publish(event);
        previous = encoded;
      } catch (error) { if (!session.stopping) warn(cleanText(String(error))); }
      finally { pending = false; }
    };
    telemetryTimer = setInterval(() => void publish(), 1000);
    telemetryTimer.unref();
    void publish();
  }
  pi.events.on("herdr:blocked", (data: unknown) => {
    // Main already receives this signal locally; relay only across the team socket.
    if (!isRecord(data) || typeof data.active !== "boolean" || data.source === "ac-teams") return;
    session.blocked(data.active);
  });
  pi.on("agent_start", (_event, ctx) => { session.reloadStarted(); report(ctx, { type: "agent_start" }); });
  pi.on("turn_end", (event, ctx) => { reconcile(ctx); session.reloadBoundary(ctx, event.toolResults.length > 0); });
  pi.on("agent_settled", (_event, ctx) => { session.clearBlocked(); reconcile(ctx); report(ctx, { type: "agent_settled" }); session.reloadSettled(ctx); });
  pi.on("tool_execution_start", (event, ctx) => report(ctx, { type: "activity", text: `Running ${event.toolName}`.slice(0, 500) }));
  pi.on("tool_result", async (event, ctx) => {
    if (child || session.disabled || session.stopping || event.toolName !== "read" || event.isError || typeof event.input.path !== "string" || !/(?:^|[\\/\\\\])handoff[\\/\\\\]SKILL\.md$/.test(event.input.path)) return;
    let guidance: string;
    try {
      await link(ctx);
      guidance = [
        "AC Teams handoff (Pi senders only): Decide whether the receiving agent should be in the same team, based on the user's intent and whether shared tasks, messages, and team control are appropriate. Joining is not automatic. If the receiver should be standalone, follow the skill's normal launch instructions and agent-kind choice without using team join. Only if you choose a same-team handoff through Herdr, use the following steps instead of the skill's standalone launch:",
        "1. Record team_agent list before launch. Start a fresh Pi with Herdr (--kind pi), in the same project, without the handoff prompt. Do not launch a different agent kind or inherit member credentials.",
        `2. Once the new Pi is ready, submit /teams join ${teamId(ctx)} in THAT session using herdr agent prompt <receiver> ${JSON.stringify(`/teams join ${teamId(ctx)}`)} (or the equivalent Herdr API). Do not run it in the sender.`,
        "3. Verify the receiver's joined-team details (expand with Ctrl+O if folded) and a new main with its sessionId in the sender's team_agent list. Slash commands may not produce a model turn: do not use prompt --wait as proof of joining. On a stalled response or timeout, inspect receiver output and team membership before retrying. If joining fails or cannot be confirmed, stop and report; do not send the handoff prompt.",
        "4. Only after both checks confirm membership, seed the handoff prompt through Herdr and follow the skill's acknowledgement steps. Task ownership does not transfer automatically.",
      ].join("\n");
    } catch (error) {
      guidance = `AC Teams same-team handoff unavailable: ${cleanText(String(error))}. If the receiver should share this team, stop and report; do not send its handoff prompt until membership can be established. If the receiver should be standalone, follow the skill's normal launch instructions and agent-kind choice without using team join.`;
    }
    return { content: [...event.content, { type: "text", text: guidance }], structuredContent: event.structuredContent };
  });
  pi.on("message_end", (event, ctx) => {
    const change = assistantEvent(event.message);
    if (change) report(ctx, change);
  });
  pi.on("session_start", async (_event, ctx) => {
    observe();
    await session.start(ctx);
    disposeNoticeGroups?.();
    disposeNoticeGroups = bindNoticeGroups(ctx, session.memberLabels, session.memberId, line => session.ownWarnings.has(line));
    startTelemetry(ctx);
    if (!warned) {
      warned = true;
      const competitors = pi.getAllTools().filter(tool => ["Agent", "SubagentWorkflow", "subagent"].includes(tool.name));
      if (competitors.length) warn(`Other delegation tools are active (${competitors.map(tool => tool.name).join(", ")}). ac-teams limits do not cover them; disable competing launchers for a single team authority.`);
    }
  });
  // CLI-loaded teammates run session_start before other extensions install their editors.
  pi.on("resources_discover", (_event, ctx) => presentation.installUI(ctx));
  pi.on("session_shutdown", async () => {
    disposeNoticeGroups?.();
    disposeNoticeGroups = undefined;
    await session.close();
  });
  const switchGuard = () => {
    if (session.switchBlocked) {
      warn("Stop team members before switching/forking/traversing sessions (team_agent stop, or /teams stop)");
      return { cancel: true as const };
    }
  };
  pi.on("session_before_switch", switchGuard);
  pi.on("session_before_fork", switchGuard);
  pi.on("session_before_tree", switchGuard);
  // Pi 1.4.0 has no supported veto hook. Pi builds with the upstream hook use this typed compatibility cast.
  type BeforeExit = (event: { type: "session_before_exit" }, ctx: ExtensionContext) => Promise<{ cancel: true } | undefined>;
  // SAFETY: Pi's runtime stores arbitrary event names; only patched Pi emits this hook with the standard event/context signature.
  (pi.on as unknown as (event: "session_before_exit", handler: BeforeExit) => void)("session_before_exit", async (_event, ctx) => {
    const count = session.liveCount;
    if (!count) return;
    if (!ctx.hasUI || !await ctx.ui.confirm("Stop active team and exit?", `${count} live member(s), including idle members, will be stopped. Worktrees and native sessions are retained.`)) return { cancel: true };
  });
  return {
    startTelemetry,
    stopTelemetry() {
      clearInterval(telemetryTimer);
      telemetryTimer = undefined;
    },
  };
}
