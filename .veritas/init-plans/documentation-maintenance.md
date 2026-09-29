# Documentation maintenance policy

Status: **owner-approved and applied in this audit branch**, 2026-09-27.
Brian approved activation after reviewing this tested proposal. The approval
reference is `conversation:2026-09-27:station-documentation-maintenance-approved`;
the policy-change attestation binds the resulting protected hashes. Authority
settings and existing checks are preserved. The accompanying
[additions](documentation-maintenance-additions.json) record the applied delta,
not a replacement configuration or an executable migration.

## Active behavior

`documentation-truth`, running the existing `npm run docs:truth:gate`, is in
both default and required evidence IDs. Existing checks and authority remain.
The explanatory `documentation-source-currentness` rule is at
Guide, linking the [audit skill](../../.agents/skills/documentation-audit/SKILL.md)
and [maintenance guide](../../docs/guides/documentation.md).

This makes stale **recorded** documentation dependencies block readiness even
when only source code changes. It also checks navigation, generated content,
examples and publication contracts. A reviewer still needs to judge prose,
diagrams and missing coverage. A passing check cannot detect an unrecorded
dependency or prove a live provider/device outcome.

Do not require a Markdown diff for every change. After reviewing affected
claims, retaining unchanged prose can be correct. Replacing source hashes
without that review is not maintenance.

The pre-edit route now also supplies `docs:impact` guidance from the same
review ledger. Its catch-up mode compares each recorded claim's document/source
bytes, reports the review revision separately from the page's edit commit,
and searches new or unmapped changes from the recorded coverage baseline.
This guidance helps agents find the work; the required truth check detects
stale recorded evidence. Neither one approves a semantic claim or proves that
unmapped code has no documentation impact.

## Why this is needed

Before this activation, the required merge-queue regression reached `docsTruth`
through static verification, while ordinary `ci:fast` did not universally run it. The separate
same-repository PR source-scan job checks freshness, but it is not a required
check and does not run for every fork or merge-group event. This policy brings
that feedback into required local/CI readiness without adding another validator.

Default selection alone is insufficient. The first trial selected and ran the
check, but Veritas treated its failure as an optional diagnostic warning. The
revised proposal adds it to `requiredEvidenceCheckIds`; the actual CLI then
reports an independent required-evidence failure.

The frozen upstream CI graph now splits fast checks into plan, test shards and
statics. The statics job still invokes Veritas readiness; the required
`fast-checks` job aggregates those results. This policy therefore applies
through that existing call, without adding a parallel CI gate.

## Executed controls

The isolated trial used installed Veritas 1.7.4 and Node 24.19.0 at source
revision `86e2799a1a20d16ab5d8fc2d77e3c32065118033`. Each run used real
`readiness --working-tree` with candidate Repo Map/Standards override paths and
the unchanged authority. No evidence was skipped or replaced, and no approval
or attestation was invented.

| Case | Documentation check | Blocking documentation failure | Check / total readiness |
| --- | --- | --- | --- |
| Default-only, clean | Pass | No | 22.871 / 72.819 seconds |
| Default-only, recorded source changed | Fail | No; optional warning | 21.852 / 86.479 seconds |
| Required candidate, recorded source changed | Fail | Yes | 27.691 / 95.913 seconds |
| Required candidate, exact restoration | Pass | No | 23.533 / 85.849 seconds |

The adverse case appended a comment to `packages/contracts/src/live-surface.ts`,
a dependency named by 12 records. The real strict ledger test reported the
stale source: one failure and 148 passing foundation tests. Exact byte
restoration removed that failure. All 13 documentation subchecks passed in the
clean/restored cases.

An initial target, `runtime-path-resolver.ts`, was not recorded in that trial's
ledger. Its passing result is retained as an unrecorded-dependency control and
target-selection error, not a claimed catch. Both files were restored exactly;
the final tree was clean.

A later check executed the installed Veritas selection planner for a server
path that selects `connected-agents`. With the documentation ID only in
defaults, that route omitted it. With the ID required, the plan included both
checks, plus the existing required evidence. An explicit command selection
also retained required documentation evidence. Readiness consumes this plan;
required checks are unioned with routed, default or explicit selections.
This was a local planner test and source review, not a hosted run or policy
activation.

Every candidate readiness command exited 1 because the override configurations
had unapproved protected hashes. That expected authority refusal is separate
from the documentation result. The required adverse case had both failures;
the restored case retained only the authority refusal. No row is an overall
readiness pass or activated-policy receipt.

The local receipt digest is
`38887d185e19690b19e99d8050c570f033789ec07ae7235d5d928226c48e9990`.
The required adverse/restored Veritas report digests are respectively
`a24604b3c64895990468fe28e23cc804d296a162e030f1cecbd7ba7dac99d6af`
and `c50791438c6f6dc9c1637d347ad55e54731f5ae85908e01a50bb34dd8c31d774`.
Generated evidence remains outside the tracked repository under the existing
[generated-evidence rules](../GOVERNANCE.md).

## Cost and activation

The command graph has no readiness call beneath `docsTruth`; the executed logs
show one invocation, with no recursion. The existing aggregate runs 13 subchecks
at bounded concurrency four. CLI parity overlaps an existing fast check by
about 0.3 seconds in this trial; the other checks cover distinct contracts.

These are local observations under concurrent host load, not a hosted upper
bound. The 15-minute `ci:fast` budget and 220-second static reserve are unchanged.
The pre-activation integrated checks and measured cost are recorded below.
Future changes must preserve CI headroom; do not remove checks or increase
budgets to hide a failure.

Activation changes protected hashes and adds required evidence. Under
[GOVERNANCE.md](../GOVERNANCE.md), it requires genuine owner review and the existing
policy-change attestation process. This activation applied only the reviewed
additive entries, preserved unrelated policy, and retained the real approval reference.
The owner approved that exact activation in the conversation on 2026-09-27.
The preceding trials remain candidate evidence, including their expected
authority refusals; they are not relabeled as active-policy passes.

Before activation, the final candidate at `d2cf36b34` selected and passed the
documentation check in 35.679 seconds; total readiness took 108.81 seconds and
retained only the unapproved-policy refusal and its derived warning. Normal
`ci:fast` passed on macOS, and `verify:static` passed on Linux at that revision.
Those are local revision-bound receipts, not hosted regression or deployment.

Landing review incorporated upstream `2400482c2`, which adds five direct
documentation checks to `ci:fast` and removes documentation-only whole-diff
deferral. Those commands now overlap members of the aggregate. The required
Veritas check still supplies the full aggregate, including recorded review
freshness. The earlier cost figures above describe the earlier command graph;
final landing verification measures the integrated graph without removing checks.

Landing review also exercised automatic release bookkeeping. The named deploy
ledger contract validates current data and exact rendering without refreshing
human review hashes; its generator and validator remain review-bound. Missing
classified changeset notes retain an explicit absent historical state. Other
source/doc drift, corrupt projections and malformed records still fail. The
[maintenance guide](../../docs/guides/documentation.md#generated-release-records-and-removed-notes)
records these lifecycle distinctions and their limits.
