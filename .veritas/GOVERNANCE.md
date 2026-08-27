# Veritas Governance Surface

Station governs itself with Veritas 1.5 (Repo Map + Repo Standards + readiness). The gate is `npm run veritas:shadow` (an alias for `veritas readiness --working-tree`); use `veritas explain <ruleId|--file path>` for targeted guidance.

Zone 1 is human-owned Protected Standards and must not be weakened without review and a `veritas attest policy-change` record:

- `.veritas/repo-map.json`
- `.veritas/repo-standards/`
- `.veritas/authority/`
- `veritas.claims.json`
- `AGENTS.md` / `CLAUDE.md` (governance block)

Zone 2 is additive policy growth. Agents may add:

- new work areas for real repo boundaries,
- new evidence checks for independently runnable validation,
- advisory or recommend-stage requirements,
- brownfield gap-log entries when Veritas lacks a useful abstraction (`docs/strategy/veritas/brownfield-gap-log.md`).

Zone 3 is generated output and is not committed (see `docs/strategy/veritas/evidence-retention-policy.md`):

- `.kontourai/veritas/evidence/`, `.kontourai/veritas/external/`, `.kontourai/veritas/claims/`
- `.kontourai/veritas/standards-feedback-drafts/`, `.kontourai/veritas/standards-feedback/`
- `.kontourai/veritas/recommendations/`, `.kontourai/veritas/repo-conformance/`
- `.surface/runs/`

Reviewed setup plans under `.veritas/init-plans/` are repo-local intent, not disposable evidence; commit them only when they are deliberately part of a governance change.

Check-family dispositions (required/candidate/advisory/move-to-test/retire) live in `.veritas/proof-families/repo-guardrails.families.json` and are explained in `docs/strategy/veritas/migration-0.5-record.md`. Do not promote a family to required without catch evidence (`docs/strategy/veritas/proof-family-promotion-workflow.md`).
