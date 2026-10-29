# Daily-driver qualification

> **Unwired machinery.** No CI lane, hook or release gate runs these commands.
> They are kept for the open epic
> [#419](https://github.com/kontourai/station/issues/419) (one durable
> conversation across turns, models, Agents and engines). Its acceptance asks
> for automated qualification that fails when a build accepts turn 1 and then
> refuses turn 2. A deterministic report from these commands never claims
> promotion: see [What it proves](#what-it-proves).

The daily-driver qualification asks whether one person could use Station all
day with each supported engine profile. It answers as a matrix of
profile × scenario × surface rows. Each row is `PASS`, `FAIL`, `NOT_VERIFIED`
with a reason code, or `unavailable`.

## What it measures

- **Profiles** (`scripts/daily-driver-profiles.mjs`): `codex-default` and
  `claude-default`, each with the engine's connection-default model. Scenario
  code reads these declarations and never branches on a profile id or engine
  name.
- **Scenarios**: exact confirmation, bounded self-change, liveness and
  settlement, transcript stability, conversation agreement, Agent/engine
  handoff, project isolation, image attachment, and performance under stress.
- **Surfaces**: the deterministic harness, the browser UI, the CLI, and the
  phone. The CLI and phone rows are always `NOT_VERIFIED`; nothing produces
  them yet.

Timing budgets are versioned as `daily-driver-v1`
(`DAILY_DRIVER_TIMING_BUDGETS` in `scripts/lib/daily-driver-qualification.mjs`):

| Measure | Scenario | Budget |
| --- | --- | --- |
| Transcript restore | `transcript-stability` | 750 ms per sample |
| Delta to paint while streaming | `performance-stress` | 100 ms per sample |
| Mounted transcript rows after a 10k-turn restore | `transcript-stability` | at most 200 (`MOUNTED_ROW_CAP` in the scenario spec) |

The report carries the sampled aggregates, never a figure for a measure it
did not sample.

## How to run it

Each browser command needs a clean checkout. It builds and launches that
checkout in isolation, binds every observation to `git rev-parse HEAD`, and
refuses a dirty tree or a revision that changes during the run.

```bash
# Deterministic harness only: no engine, browser, CLI or phone. Prints a
# summary; --json prints the schema-validated report.
npm run dogfood:daily-driver:deterministic -- --json

# Exact confirmation through the real browser path, produced by
# tests/cross-runtime-chat-switching.spec.ts (bounded at 3 minutes).
npm run dogfood:daily-driver:ui

# Liveness, conversation agreement, transcript stability and performance,
# plus the Continue-with handoff, produced by tests/daily-driver-scenarios.spec.ts
# and tests/daily-driver-switching.spec.ts (bounded at 15 minutes).
npm run dogfood:daily-driver:scenarios
```

The browser producers run in the product E2E suite. They attach their
observations to the Playwright result as well. The wrappers above are what
fold those observations into a report. Reports validate against
`schemas/daily-driver-qualification.schema.json`, and observations validate
against the two `schemas/daily-driver-*-observation.schema.json` files.

## What it proves

- The deterministic harness proves the exact-confirmation classifier: trimmed
  output is accepted, while malformed, empty, Markdown-wrapped, prefixed,
  suffixed and timed-out replies are rejected. On a deterministic run, every
  other row is `NOT_VERIFIED` with `SCENARIO_NOT_IMPLEMENTED_IN_HARNESS` or
  `PRODUCT_SURFACE_NOT_EXERCISED`.
- The browser rows prove the UI path (composer, orchestration dispatch, event
  stream, transcript) against a deterministic, engine-shaped backend. That
  backend follows the **two-layer rule**: its reply derives only from the
  per-conversation history it saw through the dispatch seam, so context
  carry-over passes only when the product really threads one conversation
  across turns.
- **Not proven:** no live engine, model, account or network is exercised, so
  `promotion.status` is always `NOT_VERIFIED` with
  `REQUIRED_LIVE_ROWS_NOT_VERIFIED`. A green harness is qualification
  machinery, not evidence that the live daily-driver outcome works.
