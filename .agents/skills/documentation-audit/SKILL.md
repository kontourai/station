---
name: documentation-audit
description: Audit Station documentation, READMEs, architecture diagrams, and code comments against implementation and behavior evidence; maintain the learning path when features change. Use for documentation audits or feature changes that alter a documented journey or contract.
---

# Documentation audit

Use [Maintaining documentation](../../../docs/guides/documentation.md) as the
content contract. Start from the affected canonical owner in the
[documentation map](../../../docs/README.md); use the
[audit plan](../../../docs/plans/documentation-code-audit.md) for a repository-wide
pass. Follow the repository's worktree, pre-edit routing, and verification rules.

## Feature change

Start with `npm run docs:impact -- <changed-paths...>` (also included in
`gate:for`) to find recorded downstream documentation owners. For accumulated
work, run `npm run docs:impact -- --catch-up --json`: review the changed inputs
against the history baseline and covering notes, not just its last edit date.
Account for unmapped changes and preserve the coverage baseline until they are
resolved. The report is advisory and cannot establish semantic correctness.
The documentation checks block only stale records that your change touched;
re-review those in the same PR. See
[keep reviews fresh](../../../docs/guides/documentation.md#keep-reviews-fresh).

Trace the changed behavior from its user entry point through contract,
authorization, implementation, persistence, event projection, and visible
outcome. Follow real callers; a symbol with a promising name is not proof.
Review failure, cancellation, restart, and platform differences when relevant.

Update the owning explanation, affected README, diagram, reference, and runnable
example together. Generate tables from their existing authority. A code change
may leave documentation accurate; record that conclusion with the reviewed
paths and reason rather than making a token prose edit.

For each material claim, retain the implementation owner, evidence owner, and
what the evidence actually establishes. Keep source inspection, executed
behavior, live provider/device proof, and release state separate. A proposed
design and a test file that exists do not establish shipped behavior.

## Repository-wide pass

Split the pass into subsystem PRs of roughly 20 to 40 documents, and land
each one before starting the next. Keep each slice small enough to review its changed claims; reviews of unrelated
landed work do not invalidate the branch's notes.

Inventory every tracked Markdown file with NUL-delimited `git ls-files` output,
including hidden directories, package/example/fixture READMEs, agent instructions,
changesets, and historical records. Record each file's purpose and disposition:
current, generated, proposal, historical, or fixture. Directory names alone do
not establish lifecycle; a strategy directory can contain current policy.

Audit subsystem by subsystem in both directions: document claims to code, and
implemented user journeys to discoverable documentation. Keep an explicit
unreviewed set. Do not report an inventory, source-path scan, or passing gate as
a complete semantic review. Preserve useful historical records with their
status and successor rather than making old evidence appear current.

Update the [review ledger](../../../docs/learn/review-ledger/) after the
review, recording scope, code/test owners, checks, and limits. Refresh an
existing record with `npm run docs:review:record -- <path> --note "<what you
checked>"` rather than editing its files; commit the reviewed bytes first.
`--show-delta <path>` prints the input diff since the history baseline.
`--rereview` remains accepted for a deliberate review of unchanged inputs.
Drop a citation with `--drop-source`; the command records its review note.
Keep document classification separate from source review. A changed document
or supporting source needs an explicit note about the inspected claims.

The ledger keeps human decisions in records and reviews in append-only notes;
see [ledger layout and merges](../../../docs/guides/documentation.md#ledger-layout-and-merges).
Two branches reviewing different edits of one source add separate notes and
leave the shared record untouched. An old branch carrying digest bindings can
use `node scripts/migrate-review-ledger.mjs --path-only` during its merge of main
to discard only derived binding conflicts. Resolve conflicting human decisions
by inspecting both changes.

For a diagram, trace every behavioral edge and boundary; label optional paths
and distinguish request, event, and storage flows. Check rendered output and
keyboard navigation for interactive learning pages, including deep links,
failure states, and a narrow viewport. The reader must be able to move from a
plain-language overview to exact code and evidence without guessing filenames.

## Findings and follow-through

Use the maintenance guide's [improvement workflow](../../../docs/guides/documentation.md#turn-findings-into-maintained-improvements).
Reconcile findings with current code and open or folded GitHub issues. Within
the task's authorization, file missing work with evidence, a suggested approach,
behavioral acceptance cases, and the documentation owners to update. Otherwise
retain a reviewable issue draft. Keep only evidence and links in audit records.

When implementing a linked fix, replace the old limitation with the verified
behavior in the same PR. Review diagrams, examples, learning/MCP inputs, and
ledger claims as well as the main guide. An issue's closed state is not proof
that either the behavior or its explanation has changed.

## Comments

Remove narration and stale claims only after reading the surrounding caller
and tests. Keep short explanations of non-obvious invariants, security or
concurrency boundaries, compatibility constraints, and past defects that a
maintainer could otherwise reintroduce. Put long rationale in the owning guide
or ADR and link it at the hazardous decision when useful.

Preserve public API documentation, licenses, tool directives, generated markers,
and TODOs with unresolved obligations. Test fixtures may contain deliberate
bad comments. Do not strip comments with a repository-wide regex or use a
deletion quota. When extracting rationale, preserve its issue/test reference.
Keep behavior changes separate and verify comment-only deltas are behavior-neutral.

## Final editorial pass

After the technical review, follow the maintenance guide's
[clear-language guidance](../../../docs/guides/documentation.md#edit-for-clear-language).
Review current documentation, READMEs, navigation and diagram labels, retained
comments, and canonical MCP topics. Remove inflated phrasing, vague claims,
repetition, and unnecessary jargon. Keep exact terms, conditions, failure
cases, evidence limits, and the reasons past defects must not recur.

Edit generator inputs, regenerate their outputs, and check the diff for changes
in meaning. Preserve historical and exact-text records. Track unfinished
editorial work separately from technical review; neither substitutes for the
other.

## Verification and handoff

Run the routed documentation and focused checks. Inspect generated output, not
just a successful generator exit. Record the exact revision and separate
CONFIRMED, FAIL, and NOT_VERIFIED claims. Hand off remaining files and journeys
with concrete next actions. Follow Veritas's existing promotion and authority
rules; a required artifact's presence does not prove its prose is true.
