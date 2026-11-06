import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handoverPrompt } from "../members/main-terminal.ts";

/** Pauses only at a persisted turn boundary, after the entire tool batch finishes. */
export function createReloadPause(pi: Pick<ExtensionAPI, "sendUserMessage">, needsInput: () => boolean) {
  let requested = false, paused = false, resume = false, draftPending = false, continueOnSettle = false;
  function submitDraft(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const text = ctx.ui.getEditorText();
    if (!text.trim()) return;
    pi.sendUserMessage(text, { deliverAs: "followUp" });
    draftPending = true;
    resume = true;
    ctx.ui.setEditorText("");
  }
  function state(ctx: ExtensionContext) {
    if (requested) submitDraft(ctx);
    return { ready: requested && !draftPending && ctx.isIdle() && !ctx.hasPendingMessages() && !needsInput(), resume };
  }
  return {
    prepare(ctx: ExtensionContext) {
      if (!requested) { resume = !ctx.isIdle() || ctx.hasPendingMessages(); requested = true; continueOnSettle = false; }
      return state(ctx);
    },
    state,
    started() { if (requested) { paused = false; resume = true; } },
    boundary(ctx: ExtensionContext, hasTools = true) {
      if (!requested || paused || needsInput()) return;
      draftPending = false;
      submitDraft(ctx);
      if (draftPending || ctx.hasPendingMessages()) return;
      resume = hasTools;
      if (!hasTools) return;
      paused = true;
      ctx.abort();
    },
    settled(ctx: ExtensionContext) {
      if (continueOnSettle || (requested && paused && ctx.hasPendingMessages())) {
        continueOnSettle = false;
        pi.sendUserMessage(handoverPrompt, { deliverAs: "followUp" });
      }
    },
    cancel(ctx: ExtensionContext) {
      const continueWork = requested && paused && resume;
      continueOnSettle = continueWork && !ctx.isIdle();
      requested = false;
      paused = false;
      resume = false;
      draftPending = false;
      if (continueWork && ctx.isIdle()) pi.sendUserMessage(handoverPrompt, { deliverAs: "followUp" });
    },
  };
}
