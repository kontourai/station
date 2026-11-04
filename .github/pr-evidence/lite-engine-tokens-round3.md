# Daily throughput: third review fix evidence

This supersedes the adoption behavior and fresh-restart wording in
[round 2](lite-engine-tokens-round2.md). It is local source and fixture evidence,
not live-provider, installed-shell, deployment, billing or release qualification.

## Inherited-counter boundary

The daily projection now recognizes `usageAvailability: 'unavailable'` or
`continuation: 'native-fork'` on either `session.started` or
`session.configured` for cumulative providers. Each first-reported component
establishes an undated baseline; only later increases count. Default lifetime
accounting and per-turn providers are unchanged.

Source audit found exactly two unavailable-usage emission sites in the Codex
adapter: start and configuration, both conditioned on source affinity. That
affinity comes from either native adoption or the resume cursor. The tests cover
the paired adoption event shape, each availability marker independently, and a
native-fork marker without availability metadata. The adapter currently suppresses
usage notifications for source-affinity continuations; these retained-event tests
qualify the fold's metadata handling, not live provider reporting completeness.

Every repeated cumulative-engine session start withholds a new baseline,
including a fresh start after a lost native session. This rule is unchanged and
can undercount, never leak inherited usage. The whole first reported figure of
each token component is withheld: the whole first turn when usage is reported
once per turn, or part of it when updates arrive more often. Sparse components
establish baselines independently. The reset/correction undercount is unchanged.

## Red before repair

Tests were committed first in `4f2a61159d88`. On the previous production head,
the accounting and privacy suites produced **6 intended failures / 64 passes**:

- All four inherited-counter cases attributed **42,050,000** input tokens where
  the first figure must contribute **zero**. A later 42,100,000 figure must
  contribute only **50,000**; lifetime input remains 42,100,000.
- Both generated disclosure renderers lacked the repeated-start and whole-figure
  undercount wording. The corrected inventory drives both policy and Play output.
- The Codex resume fixture now uses the actual matched-identity configuration,
  replacing the Claude-only `nativeSessionResumed` start marker. This fixture
  correction passes the unchanged production behavior; it is not a new product
  defect.

## Limits

NOT_VERIFIED: real outside-CLI/native adoption or resume handoffs, live-provider
completeness, Codex cache inclusivity, installed/native behavior, Worker execution,
production rollout, endpoint enablement, billing equivalence and release
qualification. No live model call or endpoint enablement is part of this round.
