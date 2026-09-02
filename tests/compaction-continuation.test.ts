import { describe, expect, it } from "bun:test";
import {
  COMPACTION_CONTINUATION_MESSAGE,
  triggerCompactionContinuation,
} from "../src/hooks/before-compact";

describe("compaction continuation", () => {
  it("resumes with a visible user message queued after compaction", () => {
    const calls: Array<{ content: unknown; options: unknown }> = [];
    const pi = {
      sendUserMessage: (content: unknown, options: unknown) => calls.push({ content, options }),
    } as any;

    triggerCompactionContinuation(pi);

    expect(calls).toEqual([{
      content: "your context was compacted, you now have tons of space to keep working as long as you like",
      options: { deliverAs: "followUp" },
    }]);
    expect(calls[0]?.content).toBe(COMPACTION_CONTINUATION_MESSAGE);
  });
});
