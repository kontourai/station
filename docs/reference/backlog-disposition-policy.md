# Backlog disposition policy

Every open GitHub issue is classified at all times. The executable policy is
`scripts/backlog-priority-policy.mjs`; this document describes its stable
contract rather than duplicating its constants.

An issue is classified when it carries a priority (`P1`, `P2`, or `P3`) or one
of the explicit non-actionable dispositions: `blocked`, `epic`,
`decision-needed`, or `acceptance-needed`. Other labels do not classify an
issue. An omitted disposition is reported by the next audit, including on a
newly opened issue; there is no grandfathered backlog ceiling or grace period.

`P1` is the actionable queue. A `bug` label no longer implies `P1`, and no
label implies any priority: priority is a triage judgement recorded by whoever
triages, and the audit below is what reports an issue that lacks one. Specific
automation may still choose a priority for the issues it opens — the main-red
tracker in `.github/workflows/main-health.yml` files itself as `bug` and `P1`
— but that is its own triage decision, not a rule derived from a label.

The queue is uncapped. `maxActionableP1` is `null`; the ceiling check is
retained and still reports against any policy that sets one, so re-capping is a
one-constant change. The cap of five was dropped in 2026-08 because "every bug
is `P1`" made a finite ceiling incoherent. That rule is gone (owner decision,
2026-09-09) and the queue was deliberately left uncapped rather than
re-capped, since restoring a ceiling would flag a backlog nobody has
re-triaged. Whether to cap it again is open.

A `P1` issue still cannot also carry an explicit non-actionable disposition.
That is now the load-bearing rule: work that is genuinely not actionable must
say so through `blocked`, `epic`, `decision-needed`, or `acceptance-needed`
rather than through a lower priority. Non-actionable dispositions still count as
classified, so a blocked or decision-needed issue does not need a priority
simply to satisfy the policy.

The GitHub workflow runs daily and manually through `workflow_dispatch`. Its
findings are report-only: each is a warning annotation, the job summary
lists them with the open, actionable `P1` and unclassified counts, and one
**Backlog policy findings** tracking issue carries the counts and the first
50 entries of each list (closed when nothing is reported). The run still
succeeds. The issue is written by a separate job that installs nothing. It
writes only to an issue the workflow bot opened, posts only a report stamped
with its own checkout's revision (which shows the report is current, not who
wrote it), refuses posted text over GitHub's body limit, and breaks `@`
mentions, including entity-encoded ones. Issue numbers are in code spans so
the listed issues gain no timeline cross-references. A permanently red daily run was ignored, so failing on
findings carried no signal. The run fails when it cannot judge the backlog:
live labels that drift from `.github/labels.json`, a malformed manifest, an
API failure or an incomplete issue read. It
does not run on issue events: that produced a run per label click and a red
between filing and labelling every issue, and main-health does not watch it. Its tests derive fixtures from the
same exported policy constants to make changes to classifications or the P1
limit deliberate.
