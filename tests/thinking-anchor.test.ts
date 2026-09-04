import { describe, expect, test } from "bun:test";
import { classifyAssistant, resolveThinkingAnchor } from "../src/core/thinking-anchor";

const think = (chars: number, extra: any[] = [], stopReason = "stop") => ({
  message: {
    role: "assistant",
    stopReason,
    content: [{ type: "thinking", thinking: "t".repeat(chars) }, ...extra],
  },
});
const text = (s = "answer") => ({ type: "text", text: s });
const call = () => ({ type: "toolCall", id: "tc", name: "bash", arguments: {} });
const user = (s = "hi") => ({ message: { role: "user", content: s } });
const result = () => ({ message: { role: "toolResult", content: [text("ok")] } });
const aborted = () => ({ message: { role: "assistant", stopReason: "aborted", content: [] } });
const plain = (s = "answer") => ({ message: { role: "assistant", stopReason: "stop", content: [text(s)] } });

describe("classifyAssistant", () => {
  test("thinking only is incomplete", () => {
    expect(classifyAssistant(think(10).message)).toBe("incomplete");
  });
  test("thinking + tool call is completed", () => {
    expect(classifyAssistant(think(10, [call()], "toolUse").message)).toBe("completed");
  });
  test("thinking + text is completed", () => {
    expect(classifyAssistant(think(10, [text()]).message)).toBe("completed");
  });
  test("length-truncated text without tool call is incomplete", () => {
    expect(classifyAssistant(think(10, [text("partial")], "length").message)).toBe("incomplete");
  });
  test("empty text does not complete", () => {
    expect(classifyAssistant(think(10, [text("   ")]).message)).toBe("incomplete");
  });
  test("aborted placeholder with no content is empty", () => {
    expect(classifyAssistant(aborted().message)).toBe("empty");
  });
});

describe("resolveThinkingAnchor", () => {
  test("no thinking anywhere → no anchor, no defer", () => {
    const live = [user(), plain(), user(), plain()];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: false, anchor: null });
  });

  test("turn cut off mid-thought → defer, anchor at the thinking message", () => {
    // Session shape: user, think147k (length), harness "cut off" user, aborted.
    const live = [user(), think(147_000, [], "length"), user("cut off"), aborted()];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: true, anchor: 1 });
  });

  test("cut-off thinking completed by the next message → anchor at the cut-off message", () => {
    // think150k (length), harness user, think58k+text+call, toolResult, aborted.
    const live = [
      user(), plain(), result(),
      think(150_000, [], "length"),
      user("cut off"),
      think(58_000, [text(), call()], "toolUse"),
      result(),
      aborted(),
    ];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: false, anchor: 3 });
  });

  test("tool loop: anchor is the last completed assistant message", () => {
    const live = [user(), think(500, [call()], "toolUse"), result(), think(700, [call()], "toolUse"), result()];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: false, anchor: 3 });
  });

  test("last completed message without thinking falls back to the most recent thinking block", () => {
    const live = [user(), think(500, [text()]), user(), plain(), user(), plain()];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: false, anchor: 1 });
  });

  test("two consecutive incomplete messages before completion → anchor at the first", () => {
    const live = [user(), think(10, [call()], "toolUse"), result(), think(100, [], "length"), user(), think(100, [], "length"), user(), think(5, [text()])];
    expect(resolveThinkingAnchor(live)).toEqual({ defer: false, anchor: 3 });
  });
});
