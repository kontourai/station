# Veritas For Station

Station is governed by `@kontourai/veritas` 1.5: a Repo Map (`repo-map.json`) describing work areas and evidence checks, Repo Standards (`repo-standards/default.repo-standards.json`) as executable requirements, authority settings, and attestations for Protected Standards. Durable governance remains under `.veritas/`; generated evidence, claim inputs, standards feedback, recommendations, and conformance output live under `.kontourai/veritas/`. The current contract inventory is in `docs/strategy/veritas/migration-1.5-record.md`; the 0.3-to-0.5 history remains in `migration-0.5-record.md` beside it.

## Gate

```bash
npm run veritas:shadow          # alias: veritas readiness --working-tree
npm run veritas:readiness       # same, explicit name
npm run veritas:readiness:diff  # veritas readiness --changed-from main --changed-to HEAD
npm run veritas:coverage        # veritas readiness --check coverage --working-tree
```

Exit 0 = ready; 1 = an evidence check or blocking requirement failed (report still produced); >=2 = config error. `veritas explain <ruleId>` or `veritas explain --file <path>` prints targeted guidance.

Readiness reports are generated under `.kontourai/veritas/evidence/`; Surface read models remain under `.surface/runs/`.

## Evidence Checks

- `repo-governance` (required, default): Veritas artifacts, AI instruction wiring, CI/report wiring, pinned workflow actions.
- `verification-policy` (default): runs the executable selector-first verification-policy gate, so public lane wiring and agent guidance cannot drift silently. It is default-enforced, not a required evidence family.
- `architecture-boundaries` / `ui-data-access` / `runtime-contracts`: candidate or advisory proof-family inventory entries. They remain visible for promotion work, but are not readiness routes until they execute assertions.
- `connected-agents` (routed for src-server/**): behavioral integration proof for runtime changes.
- `repo-guardrails`: transitional compatibility aggregator from the old convergence checks; not routed, not required.
- `retired-surfaces` / `migration-tombstones`: candidate/advisory tombstone lanes with expiry requirements.
- `static-verification` / `sdk-builds` / `app-builds`: declared for coverage; they run in `ci:fast`, not inside readiness.
- `fallow-advisory`: external-tool advisory evidence; requires the `fallow` CLI and is not a default check.

Check-family dispositions live in `.veritas/proof-families/repo-guardrails.families.json`, declared to Veritas through `evidence.evidenceInventoryManifests` so `veritas readiness --check coverage` reports verification weight and freshness.

## Delivery-Conduct Standards (just-in-time guidance)

`docs/strategy/multi-agent-delivery-protocol.md` is codified as four Repo Standards rules so any agent about to edit a governed file gets the rule that applies, not the whole document:

| Rule | Reached from | Says |
| --- | --- | --- |
| `trust-surfaces-name-their-gaps` | trust/provenance/readiness/flow/attribution components, `packages/contracts/src/turn-provenance.ts` | a missing fact renders as a named gap; per-record claims come from the record; streaming and persisted tell one story |
| `evidence-claims-anchor-to-executed-commands` | `src-server/services/evidence/**`, `src-server/services/flow/**` bridges | claim patterns anchor to the leading command; a mention never routes; a partial run never satisfies a full-scope claim |
| `read-paths-join-exactly-and-never-write` | sidecar/trust-bundle joins, freshness and fold modules | exact match or `unavailable` naming candidates; read paths perform no writes; no producer, no claim |
| `verification-conduct-sentinels-and-fault-injection` | the protocol document and four pinned honesty tests (`guardrail-known-bad-fixtures`, `verification-receipt`, `vitest-worktree-exclusion`, `catch-log`) | sentinel-form exit evidence; commit-first fault injection with byte-identical restore; an uncaught injection is a stop signal |

Read them with `veritas explain --file <path>` (or `--work-area product.src-ui.trust-surfaces` / `product.src-server.evidence-services`, the two work areas added for these surfaces — both routed to the lane their parent area already runs, so naming a surface adds guidance and no evidence command).

These add **no new gate**. Each rule's deterministic part is the existence of the surface it governs and of the pinned regression tests that already prove it inside `npm run ci:fast`; the conduct itself is held by the review layer described in the protocol. `scripts/__tests__/veritas-repo-map.test.ts` pins all of that: the rules exist, hold the enforcement level a human attested, every referenced path exists, and the new work areas route to nothing new.

They were authored at `enforcementLevel: Guide` (advisory) per `.veritas/authority` (`new_rule_stage: recommend`). Two have since been promoted to `Require` on catch evidence under the Promotion Rule below (#1480): `trust-surfaces-name-their-gaps`, and `verification-conduct-sentinels-and-fault-injection` after its artifact list was narrowed to entries a plausible change could remove silently. **`Require` buys exactly one thing here — a deleted pinned artifact is a readiness `FAIL` (exit 1) instead of a `WARN` (exit 0). It does not make a rule detect the conduct it is named for**; that gap is the subject of #1762. The remaining two graduate on evidence rather than a date: their `explain.summary` names the catch-log classes that trigger an assessment, and `evidence-claims-anchor-to-executed-commands`'s trigger has already fired (#1763).

## Brownfield Rule

If Veritas does not support a real Station verification need cleanly, record it in `docs/strategy/veritas/brownfield-gap-log.md` instead of hiding it in a one-off workaround.

## Promotion Rule

Do not promote a candidate or advisory family to required because it "feels safer." Promotion needs catch evidence (a real regression caught, a mutation normal tests miss, or repeated agent regressions with low false-positive noise). See `docs/strategy/veritas/proof-family-promotion-workflow.md`.
