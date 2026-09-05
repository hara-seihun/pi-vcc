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
    model: undefined as { provider: string; id: string } | undefined,
    getContextUsage: () => ({ tokens }),
    compact: (options: unknown) => compactions.push(options),
    sessionManager: { getBranch: () => branch },
  };
  return {
    fire: () => handler!({}, ctx),
    setTokens: (value: number | null) => { tokens = value; },
    setModel: (provider: string, id: string) => { ctx.model = { provider, id }; },
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

  test("uses Astra's threshold for OpenAI and numbered account aliases", () => {
    setConfig({
      ...DEFAULT_SETTINGS,
      interTurnCompactionTokensByModel: {
        "openai/gpt-6-astra": 500_000,
        "openai-codex/gpt-6-astra": 500_000,
      },
    });
    for (const provider of ["openai", "openai-codex", "openai-codex-3"]) {
      const run = harness(499_999);
      run.setModel(provider, "gpt-6-astra");
      run.fire();
      expect(run.compactions).toHaveLength(0);
      run.setTokens(500_000);
      run.fire();
      expect(run.compactions).toHaveLength(1);
    }
  });

  test("re-evaluates the threshold on model switches and configuration changes", () => {
    const config = {
      ...DEFAULT_SETTINGS,
      interTurnCompactionTokensByModel: { "openai-codex/gpt-6-astra": 500_000 },
    };
    setConfig(config);
    const run = harness(300_000);
    run.setModel("openai-codex-7", "gpt-6-astra");
    run.fire();
    expect(run.compactions).toHaveLength(0);
    run.setModel("openai-codex-7", "gpt-5.6-luna");
    run.fire();
    expect(run.compactions).toHaveLength(1);
    run.compactions[0].onComplete();
    run.setModel("openai-codex-7", "gpt-6-astra");
    run.fire();
    expect(run.compactions).toHaveLength(1);
    setConfig({ ...config, interTurnCompactionTokensByModel: {} });
    run.fire();
    expect(run.compactions).toHaveLength(2);
  });

  test("keeps overrides provider-specific and lets exact account overrides disable compaction", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      interTurnCompactionTokensByModel: {
        "openai-codex/gpt-6-astra": 500_000,
        "openai-codex-2/gpt-6-astra": null,
      },
    };
    expect(interTurnCompactionThreshold(settings, { provider: "anthropic", id: "gpt-6-astra" })).toBe(250_000);
    expect(interTurnCompactionThreshold(settings, { provider: "openai-codex-2", id: "gpt-6-astra" })).toBeNull();
    expect(interTurnCompactionThreshold(settings, { provider: "anthropic", id: "claude-opus-5" })).toBe(250_000);
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
