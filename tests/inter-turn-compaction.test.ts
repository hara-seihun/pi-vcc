import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INTER_TURN_COMPACTION_TOKENS,
  interTurnCompactionThreshold,
  registerInterTurnCompaction,
} from "../src/hooks/inter-turn-compaction";
import { DEFAULT_SETTINGS } from "../src/core/settings";

let tmpDir: string;
let configPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-inter-turn-test-"));
  configPath = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterEach(() => {
  try { unlinkSync(configPath); } catch {}
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function setConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config));
}

function harness(initialTokens: number | null = DEFAULT_INTER_TURN_COMPACTION_TOKENS) {
  let handler: ((event: unknown, ctx: any) => void) | undefined;
  let tokens = initialTokens;
  const compactions: any[] = [];
  const messages: any[] = [];
  const pi = {
    on(event: string, candidate: (event: unknown, ctx: any) => void) {
      expect(event).toBe("before_provider_request");
      handler = candidate;
    },
    sendUserMessage(content: unknown, options: unknown) {
      messages.push({ content, options });
    },
  } as any;
  registerInterTurnCompaction(pi);
  let branch: unknown[] | undefined;
  const ctx = {
    getContextUsage: () => ({ tokens }),
    compact: (options: unknown) => compactions.push(options),
    sessionManager: { getBranch: () => branch },
  };
  return {
    fire: () => handler!({}, ctx),
    setTokens: (value: number | null) => { tokens = value; },
    setBranch: (value: unknown[] | undefined) => { branch = value; },
    compactions,
    messages,
  };
}

describe("inter-turn compaction", () => {
  test("starts at 250,000 active-context tokens", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness(DEFAULT_INTER_TURN_COMPACTION_TOKENS - 1);
    run.fire();
    expect(run.compactions).toHaveLength(0);
    run.setTokens(DEFAULT_INTER_TURN_COMPACTION_TOKENS);
    run.fire();
    expect(run.compactions).toHaveLength(1);
  });

  test("keeps one compaction in flight and resumes the interrupted tool loop", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness();
    run.fire();
    run.fire();
    expect(run.compactions).toHaveLength(1);

    run.compactions[0].onComplete();
    expect(run.messages).toEqual([{
      content: "your context was compacted, you now have tons of space to keep working as long as you like",
      options: { deliverAs: "followUp" },
    }]);
  });

  test("a failed compaction may retry", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness();
    run.fire();
    run.compactions[0].onError(new Error("failed"));
    run.fire();
    expect(run.compactions).toHaveLength(2);
  });

  test("does not abort a turn whose newest output is still thinking only", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness();
    const think = (id: string, extra: unknown[] = [], stopReason = "length") => ({
      id, type: "message",
      message: { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "t".repeat(1000) }, ...extra] },
    });
    run.setBranch([
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      think("a1"),
      { id: "u2", type: "message", message: { role: "user", content: "Your last turn was cut off" } },
    ]);
    run.fire();
    expect(run.compactions).toHaveLength(0);

    run.setBranch([
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      think("a1"),
      { id: "u2", type: "message", message: { role: "user", content: "Your last turn was cut off" } },
      think("a2", [{ type: "toolCall", id: "tc", name: "bash", arguments: {} }], "toolUse"),
      { id: "t2", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
    ]);
    run.fire();
    expect(run.compactions).toHaveLength(1);
  });

  test("null disables inter-turn compaction", () => {
    setConfig({ ...DEFAULT_SETTINGS, interTurnCompactionTokens: null });
    const run = harness(900_000);
    run.fire();
    expect(run.compactions).toHaveLength(0);
  });

  test("leaves automatic compaction to Pi when default override is disabled", () => {
    setConfig({ ...DEFAULT_SETTINGS, overrideDefaultCompaction: false });
    const run = harness();
    run.fire();
    expect(run.compactions).toHaveLength(0);
  });

  test("does not resume when automatic continuation is disabled", () => {
    setConfig({ ...DEFAULT_SETTINGS, continueAfterThresholdCompact: false });
    const run = harness();
    run.fire();
    run.compactions[0].onComplete();
    expect(run.messages).toEqual([]);
  });

  test("invalid threshold values fail closed", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "250000"] as unknown[]) {
      expect(interTurnCompactionThreshold({
        ...DEFAULT_SETTINGS,
        interTurnCompactionTokens: value as number,
      })).toBeNull();
    }
  });
});
