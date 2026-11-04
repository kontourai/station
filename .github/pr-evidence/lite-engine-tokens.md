# Daily engine token throughput: initial local evidence

**Historical initial implementation evidence.** The corrected scope, cache
semantics and omission behavior are recorded in [the review fix evidence](lite-engine-tokens-fix.md).

This is local source/component evidence. It does not qualify live providers,
installed shells, production receivers, endpoint enablement, billing completeness,
or a release.

## Contract and accounting

`station_daily.engine_tokens_today` is an optional receiver field and an always
present new-sender array of at most eight unique `{engine, bucket}` entries.
Only positive retained input-plus-output usage appears. The buckets are:

| Bucket | Tokens |
| --- | --- |
| `1-10k` | 1–10,000 |
| `10k-100k` | 10,001–100,000 |
| `100k-1M` | 100,001–1,000,000 |
| `1M-10M` | 1,000,001–10,000,000 |
| `10M+` | Above 10,000,000 |

The canonical allocation fold uses Station observation UTC time through the
completed day's cutoff. Cache and reasoning breakdowns are not added separately;
input/output retain their provider-reported inclusivity. Cumulative restatements,
rejected duplicate event IDs and child summaries do not add another counter.
Unallocatable corrections, undated reports, undeclared usage scopes and hosted
home-wide usage are omitted. The token domain participates in the Lite notice
revision. Exact operator marginals count the buckets; public releases exclude them.

## Executed checks

- `npm run dependencies:ci` and pre-edit `npm run gate:for -- <changed paths>`.
- Focused parser, publisher, accounting and Node HTTP/PGlite weekly broker:
  121 passed, with one initial fixture failure from attempting to insert a
  duplicate canonical event ID. Corrected the fixture to assert that rejection.
- Focused parser, publisher, orchestration accounting and UI consent routes:
  147/147 passed, 56.87 seconds combined.
- Privacy renderer plus accounting: 58/58 passed, 5.91 seconds combined.
- Final adapter/accounting plus parser baseline at
  `943e5535ede3df08f35144ea5b3d4246fde911bf`: 54/54 passed, 17.46 seconds combined.
  The seam invokes the real Ollama adapter `sendTurn` with a deterministic
  provider finish chunk and reads the persisted events through the real
  orchestration service into the next day's ping. No live model call.
- `npm run lint:check`: passed; inherited warnings and information remain.
- `node scripts/code-health-gate.mjs --base=origin/main`: passed, zero new
  dead-code or duplication findings. The new atomic publisher projection and
  additional parser domain branch have advisory complexity findings. Their
  bounded integration behavior is covered by the seam and parser checks.
- `npm run test:changed -- --base=origin/main --explain`: exit 3, 36 targets
  selected, none executed, broad lane deferred. This is provisional selection,
  not a completed broad test run.
- `npm run docs:review:record -- --batch <review notes>` recorded delta reviews
  without advancing the coverage baseline. `npm run docs:learn:build` rebuilt
  the atlas; `npm run docs:mcp:generate` regenerated 132 topics with no content diff.
- The rendered Lite inventory equals the reference's generated catalog.

## Wiring fault injection

Baseline commit: `943e5535ede3df08f35144ea5b3d4246fde911bf`, clean tree.
Changed only the publisher's accounting callback from `options.dailyUsage` to
`undefined`, then ran:

```sh
npm run test:focused -- src-server/analytics/__tests__/usage-observation-projection.test.ts
```

The named next-day engine-usage test failed at the expected bucket assertion:
expected `codex:1M-10M`, received `engine_tokens_today: []`. Result: 1 failed,
27 passed, 13.00 seconds. The original bytes were restored and checked against
the committed source before the restoration run. Restoration: 28/28 passed,
18.39 seconds. The mutation was never committed.

## Notice render inspection

[Before](lite-engine-tokens-before.png) and [after](lite-engine-tokens-after.png)
show actual component markup/styles with the published design tokens, at 390
pixels on the left and 1440 pixels on the right; light above, dark below.
All four combinations were opened and inspected. This is component copy/wrapping
coverage, not a full installed-app journey.
