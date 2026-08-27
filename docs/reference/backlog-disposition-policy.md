# Backlog disposition policy

Every open GitHub issue is classified at all times. The executable policy is
`scripts/backlog-priority-policy.mjs`; this document describes its stable
contract rather than duplicating its constants.

An issue is classified when it carries a priority (`P1`, `P2`, or `P3`) or one
of the explicit non-actionable dispositions: `blocked`, `epic`,
`decision-needed`, or `acceptance-needed`. Other labels do not classify an
issue. This makes an omitted disposition fail immediately, including on a
newly opened issue; there is no grandfathered backlog ceiling or grace period.

`P1` is the actionable queue. **Every bug is `P1`** (owner directive,
2026-08-18), so the queue is uncapped: a numeric ceiling and that rule cannot
coexist, and any finite number simply reschedules the failure as the bug count
moves. `maxActionableP1` is `null`; the ceiling check is retained and still
enforces any policy that sets one, so re-capping is a one-constant change.

A `P1` issue still cannot also carry an explicit non-actionable disposition.
That is now the load-bearing rule: work that is genuinely not actionable must
say so through `blocked`, `epic`, `decision-needed`, or `acceptance-needed`
rather than through a lower priority. Non-actionable dispositions still count as
classified, so a blocked or decision-needed issue does not need a priority
simply to satisfy the policy.

What the old cap of five bought was the meaning of `P1` — "actionable now".
That meaning now comes from the label itself rather than from scarcity, and
ordering within `P1` is no longer expressed by queue length.

The GitHub workflow runs on issue lifecycle and label changes, daily for drift,
and manually through `workflow_dispatch`. Its tests derive fixtures from the
same exported policy constants to make changes to classifications or the P1
limit deliberate.
