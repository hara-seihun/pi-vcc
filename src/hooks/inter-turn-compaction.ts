import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_INTER_TURN_COMPACTION_TOKENS,
  loadSettings,
  type PiVccSettings,
} from "../core/settings";
import { resolveThinkingAnchor } from "../core/thinking-anchor";
import { collectLiveMessages, triggerCompactionContinuation } from "./before-compact";

export { DEFAULT_INTER_TURN_COMPACTION_TOKENS } from "../core/settings";

export function interTurnCompactionThreshold(settings: PiVccSettings): number | null {
  const value = settings.interTurnCompactionTokens;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/**
 * True when the newest assistant output is still incomplete (thinking with no
 * completed text or tool call after it, or a length-truncated text). Compacting
 * now would abort the turn and summarise the reasoning away; wait instead.
 * Unreadable session state counts as "not deferred" so a missing session manager
 * in tests or unusual hosts cannot silently disable inter-turn compaction.
 */
export function shouldDeferForIncompleteOutput(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): boolean {
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return false;
  return resolveThinkingAnchor(collectLiveMessages(branch)).defer;
}

export function registerInterTurnCompaction(pi: ExtensionAPI): void {
  let compacting = false;

  pi.on("before_provider_request", (_event, ctx) => {
    const settings = loadSettings();
    if (!settings.overrideDefaultCompaction) return;

    const threshold = interTurnCompactionThreshold(settings);
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || threshold === null || tokens === null || tokens === undefined || tokens < threshold) return;
    if (shouldDeferForIncompleteOutput(ctx as any)) return;

    compacting = true;
    ctx.compact({
      onComplete: () => {
        compacting = false;
        if (loadSettings().continueAfterThresholdCompact) triggerCompactionContinuation(pi);
      },
      onError: () => {
        compacting = false;
      },
    });
  });
}
