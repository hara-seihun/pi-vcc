// Thinking anchor: keep the model's most recent reasoning out of the summary.
//
// Extended-thinking models do most of their real work inside thinking blocks.
// When a turn hits the output-token limit mid-thought, the transcript holds a
// huge thinking block and nothing else: no text, no tool call, nothing written
// to disk. If compaction then cuts at the following user message (the harness's
// "your turn was cut off" prompt), the entire block is summarised away, and the
// brief drops thinking, so the work is gone from context.
//
// Two rules fix this:
//   1. Never compact while the newest assistant output is still incomplete
//      (thinking with no completed non-thinking block after it, or a text
//      response truncated by the output limit). Wait for the model to finish.
//   2. When compacting, the kept tail starts no later than the last thinking
//      block. A thinking block that was cut off and then completed by the next
//      assistant message (across the harness prompt) belongs to the same unit,
//      so the anchor is the start of that unit.

export interface AnchorMessage {
  role: string;
  content: unknown;
  stopReason?: string;
}

export type AssistantState = "completed" | "incomplete" | "empty";

const hasThinkingBlock = (content: unknown): boolean =>
  Array.isArray(content) && content.some((b: any) => b?.type === "thinking");

const hasCompletedBlock = (content: unknown): boolean =>
  Array.isArray(content) && content.some((b: any) =>
    b?.type === "toolCall" || (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0),
  );

/**
 * Classify an assistant message.
 * - completed: has a non-thinking block (text or tool call) that finished.
 * - incomplete: has content but no completed non-thinking block. Thinking-only
 *   messages and text responses truncated by the output-token limit land here.
 * - empty: no content (e.g. the aborted placeholder pi writes when compaction
 *   interrupts a turn). Ignored for anchoring.
 */
export const classifyAssistant = (message: AnchorMessage): AssistantState => {
  if (!Array.isArray(message.content) || message.content.length === 0) return "empty";
  if (!hasCompletedBlock(message.content)) return "incomplete";
  // A text-only response cut by the output limit is still being written.
  const hasToolCall = message.content.some((b: any) => b?.type === "toolCall");
  if (!hasToolCall && message.stopReason === "length") return "incomplete";
  return "completed";
};

export interface ThinkingAnchorResult {
  /** True when the newest assistant output is incomplete: do not compact yet. */
  defer: boolean;
  /** Index in the live window that the kept tail must start at or before; null when no thinking is present. */
  anchor: number | null;
}

/**
 * Resolve the thinking anchor over the live (post-compaction) message window.
 *
 * The unit is: the last completed assistant message plus every incomplete
 * assistant message directly preceding it (with any user prompts or tool
 * results in between). If incomplete messages trail the last completed one,
 * the model is mid-thought and compaction must wait; the anchor then points
 * at the start of that trailing run so an unavoidable (overflow) compaction
 * still keeps it.
 */
export const resolveThinkingAnchor = (live: Array<{ message: AnchorMessage }>): ThinkingAnchorResult => {
  const states = live.map((e) => (e.message.role === "assistant" ? classifyAssistant(e.message) : null));

  let lastCompleted = -1;
  for (let i = states.length - 1; i >= 0; i--) {
    if (states[i] === "completed") { lastCompleted = i; break; }
  }

  // Trailing incomplete run after the last completed message → defer.
  let trailingStart: number | null = null;
  for (let i = lastCompleted + 1; i < states.length; i++) {
    if (states[i] === "incomplete") { trailingStart = i; break; }
  }
  if (trailingStart !== null) return { defer: true, anchor: trailingStart };

  if (lastCompleted < 0) return { defer: false, anchor: null };

  // Extend the unit backwards over incomplete messages that this one completed.
  let anchor = lastCompleted;
  for (let i = lastCompleted - 1; i >= 0; i--) {
    const s = states[i];
    if (s === "completed") break;
    if (s === "incomplete") anchor = i;
  }

  const unitHasThinking = live.slice(anchor, lastCompleted + 1)
    .some((e) => e.message.role === "assistant" && hasThinkingBlock(e.message.content));
  if (unitHasThinking) return { defer: false, anchor };

  // The unit has no thinking; fall back to the most recent thinking block anywhere.
  for (let i = anchor - 1; i >= 0; i--) {
    if (live[i].message.role === "assistant" && hasThinkingBlock(live[i].message.content)) {
      return { defer: false, anchor: i };
    }
  }
  return { defer: false, anchor: null };
};
