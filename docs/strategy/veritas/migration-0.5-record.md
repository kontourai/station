# Veritas 0.3 → 0.5 Migration Record (S1c prerequisite)

Date: 2026-06-11. Executed per `brownfield-migration-runbook.md`: every 0.3-era check family was inventoried and classified before migrating — nothing was copied 1:1. Reference consumer: the `kontourai/veritas` repo's own `.veritas/` (repo-map + repo-standards + authority + attestations, gated by `veritas readiness --working-tree`).

The gate is now `npm run veritas:shadow` → `veritas readiness --working-tree` (exit 0 ready / 1 blocking failure / >=2 config error). `veritas shadow run`, `veritas report`, `veritas budget`, and the `evaluatePolicyPack`/`loadPolicyPack` library exports no longer exist in 0.5.

## Layout migration

| 0.3 artifact | Disposition | 0.5 form |
| --- | --- | --- |
| `.veritas/repo.adapter.json` | migrated | `.veritas/repo-map.json` (work areas with owners/boundaries, explicit evidence-check objects, `evidenceCheckRoutes`, `evidenceInventoryManifests`, `activation.aiInstructionFiles`) |
| `.veritas/policy-packs/default.policy-pack.json` | migrated | `.veritas/repo-standards/default.repo-standards.json` (executable requirements with `kind` + `explain` blocks) |
| `.veritas/team/default.team-profile.json` | migrated | `.veritas/authority/default.authority-settings.json` (observe-first, recommend-stage defaults, promotion preferences) |
| `.veritas/proof-families/repo-guardrails.families.json` | migrated in place | same path, converted to the 0.5 evidence-inventory format (`items` + `evidenceCheckId`), declared via `evidence.evidenceInventoryManifests` so `readiness --check coverage` reports verification weight/freshness natively |
| `.veritas/evidence/veritas-*.json`, `.veritas/eval-drafts/**` (untracked local run records) | deleted | per `evidence-retention-policy.md`: generated evidence is not committed and is not needed to justify this change; readiness regenerates records under `.veritas/evidence/` |
| `.veritas/hooks/`, `.veritas/runtime/` (empty dirs) | deleted | recreate via `veritas setup repo-hooks` / `veritas integrations <tool> install` when hook wiring is wanted |
| — (new in 0.5) | added | `veritas.claims.json` (authored claim store via `veritas claim init`), `.veritas/attestations/` (bootstrap attestation, actor the repository owner, approval-ref `roadmap-S1c-prerequisite-veritas-0.5-migration`) |
| `.gitignore` | updated | ignores 0.5 generated dirs (`standards-feedback*`, `recommendations`, `runs`, `repo-conformance`, `surface-console`, `claims`, `init-plans`, `.surface/`); durable config stays tracked |

## Check-family dispositions

Source of truth: `.veritas/proof-families/repo-guardrails.families.json`. No `required` protection was dropped.

| Family (0.3 form) | Disposition | 0.5 form |
| --- | --- | --- |
| `repo-governance` — `proof:repo-governance` via `scripts/proof-family-lane.mjs`, used removed `loadPolicyPack`/`evaluatePolicyPack` | **required** (unchanged) | Script ported to live `loadRepoStandards`/`evaluateRepoStandards` exports; registered as the **required + default evidence check** `repo-governance` in the repo-map, so `veritas readiness` runs it on every gate. Policy rules it evaluates moved to repo-standards (`required-station-governance-artifacts`, `ai-instruction-files-synced`, `brownfield-gap-log-present`). Also checks CI wiring (ci:fast, connected-agents, `veritas readiness` evidence step) and pinned workflow actions. |
| `architecture-boundaries` — `proof:architecture-boundaries` | candidate (unchanged) | Plain npm proof lane, declared as an inventory entry but **not routed** for `packages/*` changes as of archive#2376: it returns `NOT_VERIFIED` because it has no executable assertions. |
| `ui-data-access` — `proof:ui-data-access` | candidate (unchanged) | Plain npm proof lane, declared as an inventory entry but **not routed** for `src-ui` changes as of archive#2376, until it has executable assertions. |
| `runtime-contracts` — `proof:runtime-contracts` | move-to-test / advisory (unchanged) | Lane remains declared as an advisory inventory entry but is **not routed** as of archive#2376 because it has no executable assertions. `connected-agents` (`npm run test:connected-agents`) alone remains routed for `src-server` changes as the behavioral replacement proof. Route selection — previously proven by a `scripts/veritas-report.mjs` unit test — is now owned by the repo-map `evidenceCheckRoutes` and protected by `scripts/__tests__/veritas-repo-map.test.ts`. |
| `product-route-and-schema-behavior` | move-to-test (unchanged) | Covered by `verify:static` (Vitest/tsc/biome); inventoried with `evidenceCheckId: static-verification`. No Veritas-side assertion. |
| `retired-surfaces` — `proof:retired-surfaces` | candidate (unchanged) | Plain npm proof lane, declared as evidence check, not routed by default. Expiry trigger unchanged (three clean releases). |
| `refactor-shape-tombstones` — `proof:migration-tombstones` | retire (in progress) | Advisory lane retained for the retirement window; remove when a tombstone fails without a user-visible regression. |
| `repo-guardrails` — `proof:repo-guardrails` (6.8k-line compatibility aggregator), used removed exports | candidate / transitional (unchanged) | Top-of-file Veritas usage ported to `loadRepoStandards`/`evaluateRepoStandards` + new rule id; the string-assertion body is untouched. Still a compatibility aggregator, still not the default gate. |
| `upstream-veritas-abstractions` | upstream-abstraction — **landed** | 0.5 absorbed the shapes this repo asked for: evidence-inventory manifests (proof families), route selection, candidate/advisory weights, coverage reporting. Family kept as a record. |
| `fallow-advisory` — `veritas:fallow:advisory` | advisory, **demoted from default** | Declared as external-tool evidence check (non-blocking) but removed from `defaultEvidenceCheckIds`: the `fallow` CLI is not installed in this environment and 0.5 readiness actually executes default checks (0.3 `report` only selected them). Re-add to defaults when fallow is provisioned. |
| `static-verification`, `sdk-builds`, `app-builds` | move-to-CI (unchanged behavior, honest declaration) | Declared as evidence checks for coverage/inventory, **not routed into readiness** — they run in `ci:fast` exactly as before. 0.3 `report` merely listed them as "selected"; running multi-minute builds inside every readiness gate would make the gate unusable. |

## Scripts and commands

| Old | Disposition | New |
| --- | --- | --- |
| `veritas:shadow` = `veritas shadow run --working-tree` | kept as alias | `veritas readiness --working-tree` (muscle-memory + docs compatibility) |
| — | added | `veritas:readiness`, `veritas:readiness:diff` (`--changed-from main --changed-to HEAD`), mirroring the reference repo |
| `veritas:report`, `veritas:report:working-tree` | replaced | `veritas:evidence` = `veritas readiness --check evidence --working-tree` (report generation without gating) |
| `veritas:budget` | replaced | `veritas:coverage` = `veritas readiness --check coverage --working-tree` (no `budget` verb in 0.5; coverage answers the same "what is complete/missing/stale" question) |
| `veritas:checkin:report` | retired | "check-in" is retired 0.5 vocabulary; readiness reports + standards feedback replace it |
| `scripts/veritas-report.mjs` + `scripts/__tests__/veritas-report.test.ts` | retired | Thin wrapper over removed/renamed library exports around `runVeritasReportCli`; the CLI (`veritas readiness --check evidence`) is the stable consumer surface. Its load-bearing route-selection regression test is replaced by `scripts/__tests__/veritas-repo-map.test.ts`. |
| `scripts/proof-family-lane.mjs` | ported | live exports, repo-standards path, new rule ids, `items`/`evidenceCheckId` manifest fields; required-script check now expects `veritas:readiness` instead of `veritas:report`, CI check expects `veritas readiness` instead of `veritas report` |
| `scripts/proof-repo-guardrails.mjs` | ported (minimal) | imports + standards path + rule id only |
| `scripts/run-fallow-audit.mjs` | unchanged | no Veritas API usage |
| `.github/workflows/ci.yml` "Veritas report" step | replaced | `npm exec -- veritas readiness --check evidence --run-id … --source-ref … --baseline-ci-fast-status … --changed-from … --changed-to …` (all flags verified against 0.5 `parseArgs`) |
| AGENTS.md governance block | regenerated | canonical 0.5 block via `applyGovernanceBlocks` (library export; the documented `veritas print governance-block` verb is not dispatched in published 0.5.0 — see discrepancies), plus Station-specific notes outside the marker block |

## What changed in enforcement (honest accounting)

- **Gained:** readiness now actually executes the required gate (0.3 `shadow run` evaluated policy but `report` only *selected* proof commands); protected-standards drift now fails readiness via the built-in attestation requirement; `forbid-shared-root-imports` is now an executable forbidden-pattern requirement (0.3's policy-pack `match.pattern` shape was effectively advisory — the real enforcement lived only in `proof:repo-guardrails`, where it also remains).
- **Unchanged:** every previously `required` protection (repo-governance family, CI wiring, pinned actions, instruction-file sync) still blocks; candidate/advisory lanes remain invocable npm lanes and are now route-selected by Veritas itself.
- **Lost (accepted, dispositioned):** fallow-advisory no longer runs by default (tool not installed — was already silently failing-prone; re-enable when provisioned). The 0.3 report's `resolved_phase`/`resolved_workstream` promotion metadata and `verification_budget` JSON shape are gone; coverage + evidence-inventory results are the 0.5 equivalents. `proof:repo-guardrails` is no longer listed in any default/required Veritas lane (same as 0.3) and must be invoked explicitly.

## Discrepancies found for `kontour-integration-surface.md`

1. Published `@kontourai/veritas@0.5.0` usage does **not** dispatch `print`, `apply`, `hooks claude-code`, or `boundaries check`, although `docs/reference/cli.md` documents them (sibling checkout is ahead of the published package). Use the library exports (`buildGovernanceBlock`, `applyGovernanceBlocks`, …) or `veritas integrations <tool> install` instead.
2. 0.5.0 requires a committed authored claim store (`veritas.claims.json` via `veritas claim init`); readiness exits 2 without it. Worth adding to the Veritas section.
3. `readiness --check evidence` accepts the full 0.3 `report` flag set (`--run-id`, `--source-ref`, `--baseline-ci-fast-status`, `--changed-from/--changed-to`), so CI migration is mechanical.
4. The integration-surface doc's "Version split, deliberate" paragraph (line ~65) is now stale: Station's own governance is on `^0.5.0` as of this migration.
5. **`evidenceCheckRoutes` schema/runtime key mismatch:** the published repo-map schema requires `nodeIds` (`additionalProperties: false`), but the 0.5.0 runtime matches routes on `componentIds` — schema-conformant routes silently never fire. Station's repo-map carries both keys (asserted in `scripts/__tests__/veritas-repo-map.test.ts`); recorded in `brownfield-gap-log.md` with an upstream follow-up. The route change to protected standards is covered by attestation `policy-change-2026-06-12T05-46-28-252Z…`.
6. `governance_state.state` in real 0.5.0 evidence records is `"current"` for a matching attestation (the S1b service only mapped `active`/`missing`/`expired`); fixed in `veritas-readiness-service.ts` while dogfooding.
