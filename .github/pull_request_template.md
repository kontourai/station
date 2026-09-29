## User outcome

Describe the user-visible outcome this change delivers.

## Issue and closure condition

- Issue: #
- Closure condition satisfied by this PR:
- For defect fixes, classify the cause as a newly introduced regression, inherited defect, fixture defect, or unresolved. Link the introducing revision when established; a timeout alone does not establish flakiness.

## Documentation impact

- Impact/catch-up report: affected recorded owners and disposition of unmapped changes (update, reviewed unchanged, or concrete no-impact reason):

- Affected public docs and generated sources (exact repository-relative paths):
- Architecture or behavior changes: canonical explanation, learning-tree branch, source/evidence references, and regenerated shipped MCP topics where affected:
- For a documented limitation being fixed: issue link, current explanations corrected in this PR, and affected review-ledger claims re-reviewed against the new behavior:
- Comment cleanup: non-obvious invariants and historical defect rationale retained or moved, with their destination:
- For integration/deployment/adapter changes: external-team guide/example, prerequisites, operational lifecycle, and implemented versus planned behavior (see `docs/guides/integrating-station.md`):
- No documentation impact (explicit reason; do not write "none", "N/A", or leave this blank):
- Intentional NOT_VERIFIED platform/UI claims retained or introduced (claim and reason, if applicable):

## Evidence

### Exact commands and receipts

List every command run and its result or receipt location.

Changes altering rendered UI: attach inspected before/after screenshots in the
PR body; CI artifacts, logs, or local files alone do not establish a visual
claim. New or materially changed test files: state the measured wall cost for
each (the `test:focused` duration line is the receipt).

### NOT_VERIFIED

| Claim or surface | Owner | Reason |
| --- | --- | --- |
|  |  |  |

## Personal or manual verification

Describe what you personally inspected or exercised, including the environment.

### New code-health findings

Use the `ci:fast` code-health report to separate newly introduced findings from
inherited debt. For new complexity, duplication, or dependency candidates, state
what was fixed or why the existing structure/contract is intentional, with caller
or behavior evidence. Estimated coverage is not executed coverage. Do not claim
an exhaustive audit from a completed scan or remove real entrypoints to quiet it.

## Risk and rollback

- Risks:
- Rollback:

## AI-assisted work

- AI tool or tools used:
- Material areas affected by AI-assisted work:
- Personal inspection performed:
