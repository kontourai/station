# Veritas For Station

Station is governed by `@kontourai/veritas`. The
[Repo Map](repo-map.json) declares work areas and evidence checks; the
[Repo Standards](repo-standards/default.repo-standards.json) declare requirements.
Authority settings and attestations protect changes to those standards.
Durable configuration stays under `.veritas/`; generated evidence, feedback,
and recommendations go under `.kontourai/veritas/`. The
[0.3-to-0.5 migration record](../docs/strategy/veritas/migration-0.5-record.md)
is retained as history. Use the current configuration files above for the
active contract.

## Gate

```bash
npm run veritas:shadow          # alias: veritas readiness --working-tree
npm run veritas:readiness       # same, explicit name
npm run veritas:readiness:diff  # veritas readiness --changed-from main --changed-to HEAD
npm run veritas:coverage        # veritas readiness --check coverage --working-tree
```

For the installed CLI's readiness command, exit 0 means no blocking failures;
1 means an evidence-check or blocking-policy failure; 2 means a configuration
or runtime error. Read the report's selected scope, warnings, skipped checks
and evidence identities as well as the exit code. It is not a deployment or
all-tests-complete certificate. `veritas explain <ruleId>` or
`veritas explain --file <path>` prints targeted guidance.

Readiness reports are generated under `.kontourai/veritas/evidence/`. The
installed CLI's generated Surface projection uses
`.kontourai/veritas/surface/`; separate product/Flow read models can use their
own runtime locations. Neither path is protected policy source.

## Evidence Checks

- `style-standard` (required, default): runs `npm run lint:check`.
- `repo-governance` (required, default): Veritas artifacts, AI instruction wiring, CI/report wiring, pinned workflow actions.
- `documentation-truth` (required, default): runs `npm run docs:truth:gate`, including recorded document/source freshness scoped to the change (see [keep reviews fresh](../docs/guides/documentation.md#keep-reviews-fresh)). Unknown dependencies and semantic accuracy still need review.
- `verification-policy` (default): runs the executable selector-first verification-policy gate, so public lane wiring and agent guidance cannot drift silently. It is default-enforced, not a required evidence family.
- `architecture-boundaries` / `ui-data-access` / `runtime-contracts`: candidate or advisory proof-family inventory entries. Their current selection and blocking status must be read from the Repo Map
  and proof-family inventory. Declaration alone does not establish an executed
  assertion or readiness route.
- `connected-agents` (routed for src-server/**): behavioral integration proof for runtime changes.
- `repo-guardrails`: transitional compatibility aggregator from the old convergence checks; not routed, not required.
- `retired-surfaces` / `migration-tombstones`: candidate/advisory tombstone lanes with expiry requirements.
- `static-verification` / `sdk-builds` / `app-builds`: declared for coverage,
  not default readiness routes. The full static/build chain belongs to
  `full-regression`; `ci:fast` has its own bounded invariant list and prerequisite
  builds. Some Repo Map summary text still describes the older composition;
  the executable [lane catalog](../scripts/verification-lanes.mjs) and
  [fast runner](../scripts/run-ci-fast.mjs) are the command owners.
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

These add **no new gate**. These four rules' artifact assertions check the presence of named surfaces and
pinned tests. Test behavior requires an actual execution selected by its lane;
artifact presence does not prove the conduct in the rule's title. Review remains
responsible for that broader judgment. `scripts/__tests__/veritas-repo-map.test.ts` pins all of that: the rules exist, hold the enforcement level a human attested, every referenced path exists, and the new work areas route to nothing new.

They were authored at `enforcementLevel: Guide` (advisory) per `.veritas/authority` (`new_rule_stage: recommend`). Two have since been promoted to `Require` on catch evidence under the Promotion Rule below (#1480): `trust-surfaces-name-their-gaps`, and `verification-conduct-sentinels-and-fault-injection` after its artifact list was narrowed to entries a plausible change could remove silently. **`Require` buys exactly one thing here — a deleted pinned artifact is a readiness `FAIL` (exit 1) instead of a `WARN` (exit 0). It does not make a rule detect the conduct it is named for**; that gap is the subject of #1762. The remaining two graduate on evidence rather than a date: their `explain.summary` names the catch-log classes that trigger an assessment, and `evidence-claims-anchor-to-executed-commands`'s trigger has already fired (#1763).

## Issue-class prevention guidance

Two scoped Repo Standards rules route recurring failure-boundary review:
`session-lifecycle-recovery-contract` covers session commands, durable turn
boundaries, and recovery; `bounded-background-work-contract` covers delivery,
queues, large projections, and stalled turns. Both are `Require`: a change to
one of their named files selects a focused Evidence Check through
`evidenceCheckIds`, and a missing, skipped, or failed check blocks readiness.
Their artifact checks still prove only presence. The remaining behavioral work and exit criteria live
in [the issue-class prevention plan](../docs/plans/issue-class-prevention.md).
Use `veritas explain --file <path>` before editing a routed seam.
The pre-edit `gate:for` route presents matching guidance. Station's tracked
`.codex/hooks.json` contains the Veritas Governance Kit's Codex `PreToolUse`
definition. Tracked `.codex/config.toml` enables the hooks feature. Install the
user-level, repository-scoped dispatcher once with
`npm run veritas:codex-hook:install`; Flow Agents provisions it through Conduit
and preserves other handlers. Review and trust its exact definition in Codex.
The dispatcher uses the shared Git directory, so it covers Station worktrees and
stays silent in unrelated repositories. The required governance artifact rule
rejects missing project files; `proof:repo-governance` checks their structure.
A Conduit receipt proves installed bytes, while a normal Codex edit proves host
execution. Run readiness for edits outside the hook's coverage. The currently pinned
Veritas 1.7.4 handles `apply_patch` Add File under routed content rules; the plan records the
published-package host probe. That recorded probe is not proof that every
agent host or edit mechanism executes the hook today. Installation/trust and
host execution are separate observations; these instructions do not grant
blanket authority to change protected standards or install hooks elsewhere.

## Documentation maintenance and scope

The existing [documentation-audit skill](../.agents/skills/documentation-audit/SKILL.md)
and [maintenance guide](../docs/guides/documentation.md) require tracing claims,
updating the owning explanation and recording evidence limits. Documentation
link/reference/example/public-admission and generated-output checks cover named
structural contracts. They do not independently judge every sentence or diagram.
The review ledger records document purpose separately from source review.

`docs:truth:gate` already includes the ledger freshness test through
`docs:foundations:test`. It is selected as required Veritas evidence, including
through `ci:fast`'s readiness call and the pre-push hook. There, freshness is
scoped: a stale record blocks when the change's own diff touches its document,
a recorded source or the record itself. In the merge queue, on `main` and in
Nightly static verification the same test only reports staleness, so another
PR's change cannot dequeue this one; a Nightly sweep keeps one tracking issue
for what remains. The separate same-repository PR source-scan job reports
freshness too and is not a required status check. A normal reader build can
mark stale reviews `needs-review`; the scoped check refuses the ones the change
owns. See [keep reviews fresh](../docs/guides/documentation.md#keep-reviews-fresh). The named deploy-ledger contract separately
checks current machine data and its exact projection while preserving the
historical source review; removed classified changeset notes remain explicitly
absent. These narrow lifecycle rules do not waive current-guide or generator
source drift. See [documentation maintenance](../docs/guides/documentation.md#generated-release-records-and-removed-notes).
None of these mechanisms proves the semantics
of a prose claim or covers source dependencies absent from the ledger.

Hosted `fast-checks` now aggregates an affected-test plan, one to four planned shards, and
`fast-checks-statics`. The statics job runs `ci:fast` with the explicit statics
scope and includes its Veritas readiness call. The required documentation
evidence is unioned with default, routed or explicitly selected checks; it
does not depend on a documentation file appearing in the changed paths.
See the [activation record](init-plans/documentation-maintenance.md) for
owner approval, catch/control evidence and measured cost.

New gate proposals remain proposals until implemented, exercised on known-bad
and benign cases, and admitted through the existing governance process.
Protected standards/authority changes follow [GOVERNANCE.md](GOVERNANCE.md);
ordinary authorized documentation corrections do not create another approval
flow. This README describes the boundary and does not amend those standards.

## Brownfield Rule

If Veritas does not support a real Station verification need cleanly, record it in `docs/strategy/veritas/brownfield-gap-log.md` instead of hiding it in a one-off workaround.

## Promotion Rule

Do not promote a candidate or advisory family to required because it "feels safer." Promotion needs catch evidence (a real regression caught, a mutation normal tests miss, or repeated agent regressions with low false-positive noise). See `docs/strategy/veritas/proof-family-promotion-workflow.md`.
