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

For a diagram, trace every behavioral edge and boundary; label optional paths
and distinguish request, event, and storage flows. Check rendered output and
keyboard navigation for interactive learning pages, including deep links,
failure states, and a narrow viewport. The reader must be able to move from a
plain-language overview to exact code and evidence without guessing filenames.

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

## Verification and handoff

Run the routed documentation and focused checks. Inspect generated output, not
just a successful generator exit. Record the exact revision and separate
CONFIRMED, FAIL, and NOT_VERIFIED claims. Hand off remaining files and journeys
with concrete next actions. Follow Veritas's existing promotion and authority
rules; a required artifact's presence does not prove its prose is true.
