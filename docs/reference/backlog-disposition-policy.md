# Backlog disposition policy

Every open GitHub issue is classified at all times. The executable policy is
`scripts/backlog-priority-policy.mjs`; this document describes its stable
contract rather than duplicating its constants.

An issue is classified when it carries a priority (`P1`, `P2`, or `P3`) or one
of the explicit non-actionable dispositions: `blocked`, `epic`,
`decision-needed`, or `acceptance-needed`. Other labels do not classify an
issue. This makes an omitted disposition fail immediately, including on a
newly opened issue; there is no grandfathered backlog ceiling or grace period.

`P1` is the actionable queue. Nothing derives it: a `bug` label no longer
implies `P1`, and no label implies any priority. Priority is a triage judgement
recorded by whoever triages, and the gate below is what requires one to arrive.

The queue is uncapped. `maxActionableP1` is `null`; the ceiling check is
retained and still enforces any policy that sets one, so re-capping is a
one-constant change. The cap of five was dropped in 2026-08 because "every bug
is `P1`" made a finite ceiling incoherent. That rule is gone (owner decision,
2026-09-09) and the queue was deliberately left uncapped rather than
re-capped, since restoring a ceiling would fail the gate against a backlog
nobody has re-triaged. Whether to cap it again is open.

A `P1` issue still cannot also carry an explicit non-actionable disposition.
That is now the load-bearing rule: work that is genuinely not actionable must
say so through `blocked`, `epic`, `decision-needed`, or `acceptance-needed`
rather than through a lower priority. Non-actionable dispositions still count as
classified, so a blocked or decision-needed issue does not need a priority
simply to satisfy the policy.

The GitHub workflow runs on issue lifecycle and label changes, daily for drift,
and manually through `workflow_dispatch`. Its tests derive fixtures from the
same exported policy constants to make changes to classifications or the P1
limit deliberate.
