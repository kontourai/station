# Handoff report

## Summary

Implemented the region-aware shell source and ambient `RegionShells` mount in round 1.
Round 2 added explicit region-source and LazyBoundary forwarding coverage.
The two new round-2 tests pass (5 tests).
The full requested parity suite and fault-injection matrix remain outstanding.
No source changes were made in round 2.

## Files changed

- `src-ui/src/components/chat-dock/__tests__/ChatDockRegionForwarding.test.tsx` — verifies `regionId` forwarding.
- `src-ui/src/__tests__/useDockShellChrome.regionSource.test.tsx` — verifies explicit region reads.

## Evidence

- `npm run test:focused -- ...ChatDockRegionForwarding... ...regionSource...` — `Test Files 2 passed (2)`, `Tests 5 passed (5)`.
- `node_modules/.bin/tsc -p src-ui/tsconfig.json --noEmit` — exit 0.
- Round 1 focused suites — `Test Files 7 passed (7)`, `Tests 66 passed (66)`.
- Round 1 lint — `Checked 5492 files ... No fixes applied.`
- Round 1 guardrails — `Repo guardrail proof passed.` and `source tripwire clean.`
- `git log --oneline origin/main..HEAD` — `15a16bc46 test(ui): cover region shell forwarding`; preceding commits: `a52672bc1`, `2fa458ce5`, `8ec5e3e88`.

## Fault-injection table

No injections were run, so there are no red assertion lines or restored counts to report.

## Deviations

`RegionShellParity.test.tsx` was not added and the requested fault injections were not executed. This explicitly contradicts the brief; no assertion was weakened to conceal the gap.

## Open risks or blockers

- AC3–AC6 and AC8 lack the requested dedicated parity/mutation evidence.
- The previously recorded UI build was green after the orchestrator’s ceiling commit; it was not rerun in round 2.
- The aggregate final focused command, lint, and both guardrails were not rerun in round 2.
