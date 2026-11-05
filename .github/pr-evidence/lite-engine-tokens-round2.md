# Daily throughput: second review fix evidence

Historical round-2 evidence; adoption handling is superseded by
[round 3](lite-engine-tokens-round3.md).

This supersedes the first review's resume behavior and tokens-only Lite option
copy. It is local source/component evidence, not live-provider, installed-shell,
receiver-deployment, billing or release qualification.

## Resumed cumulative counters

The Lite daily projection opts into conservative resume baselines in the existing
canonical observation fold. Every repeated cumulative-engine session start
(resume/reattach), explicit recorded resume, or initially matched native resume
withholds the first reported value of each token component from dated usage.
Later component increases count normally. Every repeated session start withholds
a baseline, including a fresh start after a lost native session. Only an initial
fresh start and per-turn engines keep their first figure. Default lifetime
accounting is unchanged. This clarification corrects the original round-2
claim that all fresh starts retained their first turn; the code is unchanged.

The first resumed report can include work done in an outside terminal. The whole
first reported figure of each token component is withheld: the whole first turn
when the engine reports once per turn, or part of it when it reports more often.
A repeated fresh start therefore undercounts, never leaks outside usage. Sparse
components establish their baseline when first reported. The earlier reset/correction undercount is unchanged.

## Red before repair

The behavior tests were added on the previous production head and committed in
`c4458e978e2f5cb8f02a14264c1ac4d793eba9db` before repairs or mutation controls.

- Two resumed intervals reported 9,120,000 day-two input tokens instead of
  70,000. The corrected projection keeps the legitimate 50k and 20k increases,
  retains day one's 100k, and leaves lifetime input at 9,220,000.
- An initially matched native resume reported 42,050,000 instead of 50,000.
  The repaired test also checks cache-component baselines and a Claude first-turn
  positive control.
- The mounted Lite choice lacked "Daily counts" in its accessible description.

The two-file red run had five failed assertions and 77 passes. No live model call
was made.

## Coverage controls

Items 3–5 were gaps in tests for working production behavior. After committing
the strengthened tests and confirming a clean tree, injected all three specific
regressions, then ran the publisher and runtime composition suites:

| Item | Injected defect | Observed red assertion |
| --- | --- | --- |
| 3: cache boundary | Add Codex cached input to its reported input again | Correct 60,300 tokens are `10k-100k`; the double-counted 120,300 becomes `100k-1M`. |
| 4: all reads | Add an accounting read under the daily lock, retaining the later outside read | Recorded `[true, false]` fails the no-held-lock assertion; inspecting only the last read would miss it. |
| 5: runtime scope | Pass undefined instead of `INTERNAL_SESSION_READ_SCOPE` | The external call assertion rejects the wrong scope even though the source fixture returns usage. |

The control run produced exactly three intended failures and 62 passes in
74.94 seconds. The original publisher and runtime source bytes were restored;
no mutation was committed.

## Green after repair/restoration

```sh
npm run test:focused -- src-server/analytics/__tests__/usage-observation-projection.test.ts src-server/services/__tests__/telemetry-publishers.test.ts src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts src-ui/src/components/__tests__/TelemetryConsent.routes.test.tsx packages/shared/src/__tests__/usage-fold.test.ts src-server/services/__tests__/privacy-inventory.test.ts
```

Six suites passed **217/217** in **77.88 seconds**, including restored coverage
controls. The accessible description again says daily counts plus coarse tokens
per engine from conversations run in Station. UI copy ratchet: zero new findings.

[Updated notice](lite-engine-tokens-round2.png) shows actual component markup and
styles at 390 pixels (left) and 1440 pixels (right), light above and dark below;
all four combinations were inspected. Compare the
[previous notice](lite-engine-tokens-fix-after.png). This is component evidence,
not an installed-app journey.

The decision, reference, privacy inventory and generated disclosures state the
resume undercount. The catalog meaning changes its notice revision. Receiver-first
rollout, empty-field omission and Codex's unverified cache-inclusivity declaration
remain unchanged.
