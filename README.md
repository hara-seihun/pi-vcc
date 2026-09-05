# pi-vcc

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls — produces a brief transcript via extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Demo

![pi-vcc demo](./demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | 35-99% on real sessions (higher on longer sessions) |
| **Compaction latency** | Waits for LLM call | 30-470ms, no API calls |
| **History after compaction** | Gone — agent only sees summary | Active lineage searchable via `vcc_recall` (`scope:"all"` available) |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero — no API calls |
| **Structure** | Free-form prose | Brief transcript + 4 semantic sections |

## Features

- **No LLM** — purely algorithmic, zero extra API cost
- **Brief transcript** — chronological conversation flow, each tool call collapsed to a one-liner with `(#N)` refs, text truncated to keep it compact
- **5 semantic sections** — session goal, files & changes, commits, outstanding context, user preferences
- **Bounded merge** — rolling sections re-capped after merge instead of growing unbounded
- **Lossless recall** — `vcc_recall` reads raw session JSONL, so visible messages, assistant thinking, and active-lineage history stay searchable across compactions
- **Scoped recall** — default search is active lineage; use `scope:"all"` / `scope:all` to intentionally search across all lineages
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by term relevance, rare terms weighted higher than common ones
- **`/pi-vcc-recall`** — slash command to search history directly, results shown as collapsible message and auto-fed to agent as context
- **Fallback cut** — still works when Pi core returns nothing to summarize
- **`/pi-vcc`** — manual compaction on demand

## Install

```bash
pi install npm:@sting8k/pi-vcc
```

Or from GitHub:

```bash
pi install https://github.com/sting8k/pi-vcc
```

Or try without installing:

```bash
pi -e https://github.com/sting8k/pi-vcc
```

Pi 0.85.0's SDK entry point imports `@earendil-works/pi-server` without declaring it. Pi-vcc declares that peer explicitly so a clean install can load `convertToLlm`; it does not rely on a host-specific `node_modules` link.

## Usage

pi-vcc compacts between provider requests at 250,000 active-context tokens by default, before a long tool loop can exhaust its context window. It also handles Pi's end-of-run threshold and overflow compactions, and supports manual commands.

### Compaction

- **`/pi-vcc`** — manual compaction, keeps the last 1 user turn by default.
- **`/pi-vcc keep:N [prompt]`** — keep the last `N` user turns; optional prompt is sent to the agent after compaction.
  - `keep:1` = default, `keep:0` = compact everything, no tail.
- By default pi-vcc also handles `/compact` and automatic threshold compactions. Set `overrideDefaultCompaction: false` to send those paths back to Pi core and disable pi-vcc's inter-turn trigger.
- **Smart keep**: when enabled, pi-vcc auto-boosts `keep:1` to a larger N if the tail is small enough (< 5k tokens, capped at 25k).

### Compacted message structure

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset...
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
* bash "bun test tests/auth.test.ts" (#16)
...(28 earlier lines omitted)
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

**Sections:**

| Section | Description |
|---|---|
| `[Session Goal]` | Initial goal + scope changes (regex-based extraction) |
| `[Files And Changes]` | Modified/created files from tool calls (capped, paths trimmed to common root) |
| `[Commits]` | Git commits made during the session (last 8, hash + first line) |
| `[Outstanding Context]` | Unresolved items — errors, pending questions |
| `[User Preferences]` | Regex-extracted from user messages (`always`, `never`, `prefer`...) |
| Brief transcript | Chronological conversation flow — rolling window of ~120 recent lines, tool calls collapsed to one-liners with `(#N)` refs |

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly, so anything dropped by compaction stays reachable. Search includes plaintext assistant `thinking` blocks, and results label those passages as `[thinking]`. This covers the reasoning text or reasoning summary that the provider persisted; encrypted provider reasoning cannot be searched. By default recall covers the active conversation lineage, regardless of how many compactions have happened. Use `scope:"all"` to also reach messages from other branches, such as turns that were edited or retried. Scope is limited to the current session — earlier sessions are not searchable.

**Plain keywords work best.** Multi-word queries are OR-matched and ranked by relevance; a regex pattern is also accepted, and if it matches nothing the query falls back to keyword search:

```
vcc_recall({ query: "auth token" })                  // active-lineage OR search, ranked
vcc_recall({ query: "auth token", page: 2 })           // paginated (5 results/page)
vcc_recall({ query: "hook|inject" })                  // regex pattern
vcc_recall({ query: "auth token", scope: "all" })    // search all lineages
```

Manual slash command:

```
/pi-vcc-recall auth token scope:all
```

## Pipeline

1. **Guard tool loops** — before each provider request, compact when active context reaches `interTurnCompactionTokens`
2. **Calibrate** — estimate `charsPerToken` from `preparation.tokensBefore` vs actual message chars (falls back to heuristic `4 chars/token`)
3. **Smart keep** — if the `keep:1` tail is small (< 5k tokens), boost keep to the largest N whose tail stays ≤ 25k tokens; explicit `keep:N` is always respected
4. **Build cut** — split at the keep boundary; everything before is summarized, the tail stays intact
4b. **Thinking anchor** — the kept tail always starts at or before the model's last thinking block, whichever cut asked for it (default, smart keep, budget cut, or explicit `keep:N`). A thinking block cut off by the output limit and completed by the next assistant message counts as one unit, so the cut-off reasoning survives too. Compaction waits while the newest assistant output is still thinking-only or a length-truncated text; the inter-turn trigger skips those requests instead of aborting the turn, and `/compact` or a threshold compaction cancels with a notice. Only an overflow compaction (the request cannot be sent) proceeds, and it still keeps the incomplete block.
5. **Normalize** — raw Pi messages → uniform compactable blocks (user, visible assistant text, tool calls, tool results); raw assistant thinking remains available to recall
6. **Filter noise** — strip system messages, empty blocks
7. **Build sections** — extract goal, file paths, commits, outstanding context, preferences
8. **Brief transcript** — chronological conversation flow, tool calls collapsed to one-liners, text truncated
9. **Format** — render into bracketed sections + transcript
10. **Merge** — if previous summary exists: sticky sections dedup, volatile sections replace, transcript rolls

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load with safe defaults):

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "interTurnCompactionTokens": 250000,
  "interTurnCompactionTokensByModel": {
    "openai/gpt-6-astra": 500000,
    "openai-codex/gpt-6-astra": 500000
  },
  "debug": false
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: when `true`, pi-vcc handles all compaction paths — `/pi-vcc`, `/compact`, and auto-threshold/overflow. Set `false` to restrict pi-vcc to `/pi-vcc` and let the rest fall through to pi core. Existing config files keep whatever value they already have.
- **`smartKeepTail`** *(default `true`)*: when `true`, pi-vcc boosts the default `keep:1` to the largest `N` whose tail stays ≤ 25k tokens, but only when the `keep:1` tail is already small (≤ 5k tokens). Explicit `keep:N` from the user is always respected.
- **`continueAfterThresholdCompact`** *(default `true`)*: after a successful automatic compaction, resume with the user message `your context was compacted, you now have tons of space to keep working as long as you like`. Pi queues it before the compaction callback returns, so it becomes the resumed turn rather than a later ghost turn. Set this to `false` to stop after compaction.
- **`interTurnCompactionTokens`** *(default `250000`)*: active-context limit checked before every provider request, including requests inside one long tool loop. Set it to `null` to disable this trigger and rely on Pi's end-of-run context check.
- **`interTurnCompactionTokensByModel`** defaults to an empty object. Keys are `provider/model` and values are token limits or `null`. The example above raises OpenAI Astra to 500,000 while other models keep the 250,000 default. Numbered account aliases such as `openai-codex-3` use the `openai-codex` entry unless an exact account entry exists. Pi-vcc reads the active model and config before every provider request, so switching models changes the threshold immediately.
- **`debug`** *(default `false`)*: when `true`, each compaction writes detailed info to `/tmp/pi-vcc-debug.json` — message counts, cut boundary, summary preview, sections, token estimate calibration.

## Benchmarks

Local benchmarks / research comparing the ranked brief against the shipped pi-vcc 0.3.18 baseline (recall, fact-density, precision, size) live in [`benchmarks/README.md`](./benchmarks/README.md).

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) — the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent this extension is built for

## Acknowledgments

- Recall `mode:"touched"` + `#N:path` drill-down ported from
  [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik),
  who also suggested the feature.

## License

MIT
