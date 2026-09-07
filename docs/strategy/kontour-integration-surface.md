# Kontour Integration Surface

> The exact public contracts Station consumes from the Kontour product family. Every claim in this document was verified against the sibling repos (not recalled from memory) on the date below. Re-verify against the pinned package versions before implementing against any contract listed here.

*Last updated: 2026-07-24*
*Package contract snapshot verified on 2026-07-24: `@kontourai/surface@2.12.0`, `@kontourai/flow@1.3.0`, `@kontourai/veritas@1.5.0`, one exact `@kontourai/flow-agents` dependency for policy, sidecar, and Survey-gate contracts, `@kontourai/survey@2.0.0`, and `@kontourai/conduit@0.2.1`. Fieldwork was separately re-verified on 2026-08-08 at exact `@kontourai/fieldwork@0.6.1`. Console and Console Kit sections retain their dated package-specific verification notes. Historical interoperability findings name the exact older versions that produced them; they are evidence snapshots, not current dependency claims.*

---

## Dependency mechanics (decision)

**Station consumes published `@kontourai/*` packages from npm.** Package and lockfile versions—not sibling-checkout state—define the production contract. Consuming from npm structurally enforces constitution non-negotiable #1 (public contracts only): Station physically cannot import a sibling's internals. Local `npm link` is permitted for short-lived debugging of an upstream fix, never committed. Version bumps are explicit `package.json` changes reviewed like any dependency update.

When Station needs something a primitive doesn't expose, the move is an upstream PR to that product, then a version bump here — never a fork, vendored copy, or reach into `../<repo>/src`.

### Conduit 0.2.1

Station consumes Conduit's public `createStrandsAdapter`,
`createVoltAgentAdapter`, shared conformance probe/report functions, and exported
types. The package also ships its JSON schema and reference evidence as package
assets. Station binds those adapters to its existing `IAgentHooks` seam and
generates host-bound evidence against the exact Strands and VoltAgent versions
in `package-lock.json`; Conduit's adapter-contract reference rows are not
treated as runtime proof. Version 0.2.0 was rejected during integration because
its registry tarball omitted the compiled public export target. Version 0.2.1's
registry tarball and root import were reverified before adoption.

---

## Corrections to founding-doc assumptions

Verification surfaced two places where the founding strategy docs were wrong; both are corrected in this revision:

1. **Veritas has no MCP server.** It is an MCP *client* (its evidence checks can call MCP tools via `McpServerPool`). Agents consume Veritas output through (a) the CLI (`veritas readiness --format json`), (b) the evidence record under `.kontourai/veritas/evidence/` identified by `reportArtifactPath`, and (c) **Surface's** MCP server (`surface mcp --input <bundle>`) serving the record's embedded `TrustBundle` projection. Veritas also ships `veritas integrations <codex|claude-code|cursor|copilot> install` for harness guidance files.
2. **The Flow Agents capability matrix tops out at L2** (Claude Code, Codex, Kiro are the L2 reference implementations; L3 is not defined anywhere in `flow-agents`). Station's ambition of a fully native integration is therefore an *upstream proposal to define L3*, not a claim against an existing rung.

---

## Product-by-product surface

### @kontourai/flow — the gate engine (S1a's primary dependency)

> **Partially stale as of the Flow 3 bump (#290 S1, 2026-08-01).** The API
> table and the "load-bearing facts" below were verified against flow@0.1.19 /
> 1.3.x and have NOT yet been re-verified against the pinned 3.9.0. Known
> corrections already landed in code: `saveRun` is unexported; `trustArtifact`
> / `claimType` / `claimStatus` / `claimSubject` are gone from Station's attach
> options (Flow ignored them); expectations are `kind: 'trust.bundle'` matched
> against a Hachure bundle (schema v5, per-claim `facet`), not `surface.claim`;
> generated run state lives under `.kontourai/flow/runs`; the duplicate-run
> error carries `code: flow.run_location.allocation_collision`; and
> `trusted_producers` is enforced by Station, not Flow (see
> `docs/adr/0011-enforce-the-trusted-producer-pin-station-side.md`). The
> section-wide re-verification is #290 S6 — read the code, not this table,
> until then.

**Consumption:** library import (preferred) + `flow` CLI. File-backed; durable
definitions and config under `.flow/` in the project workspace, generated run
state under `.kontourai/flow/`.

Key library API (from the package's main export):

| Concern | Exports Station uses |
|---------|---------------------|
| Run lifecycle | `startRun(definitionPath, opts)` → `{runId, dir, state}`; `loadRun`, `saveRun`, `listRuns`, `ensureFlowLayout` |
| Evidence | `attachEvidence(runId, opts)` (supports `gate`, `kind`, `trustArtifact`, `route_reason`, `supersede`); `normalizeTrustArtifact` |
| Gate evaluation | `evaluateGate(def, state, manifest, gateId, config)` → `GateOutcome` with `status: "pass" \| "block" \| "route-back" \| "wait"`; `evaluateRun`, `applyEvaluation`, `acceptException` |
| Route-back | `routeBackDecision(state, gate, routeReason, evidence?, opts?)` → `{status, route_back_to, attempt, max_attempts, limit_exceeded, recovery_step?}` |
| Reports | `renderAndWriteReport` (writes `report.json` + `report.md`), `renderMarkdownReport`, `renderResume`, `reportJson` |
| Console projection | `projectFlowRun`, `projectFlowRunFromFiles`, `startFlowConsoleServer` |
| Definition | `validateDefinitionWithDiagnostics`, `initialState`, `openGates`, `gatesForStep` |

Load-bearing facts:

- **Built-in evidence kinds already include `veritas-readiness` and `surface.claim`** (alongside `command`, `file`, `ci`, `human-attestation`, `trace-link`) — the Veritas→Flow evidence path is anticipated by Flow itself.
- **Gate-satisfying caveat (verified during S1a implementation):** `FlowExpectation.kind` is exclusively `"surface.claim"`, and `evidenceMatchesExpectation` only matches surface.claim entries. Evidence attached with a bare `kind: "veritas-readiness"` is recorded for the audit trail but cannot satisfy a gate. To satisfy gates with Veritas output, attach with `trustArtifact: true` (which normalizes the entry to `surface.claim` with integrity verification) or set `claimType`. Plan gate expectations accordingly.
- **Veritas→Flow trust-artifact reality (verified empirically during S1c, flow@0.1.19 + veritas@0.5.0):** `trustArtifact: true` rejects **both** the full Veritas evidence record **and** the bare extracted `trust.bundle` with `trust artifact artifact_type must be trust-report or trust-snapshot`. `normalizeTrustArtifact` requires (a) top-level `artifact_type` (or `type`) of `trust-report`/`trust-snapshot` and (b) a `claim`/`claims[0]` carrying a string `type` — the record has neither, and Surface TrustBundle claims carry `claimType` (values like `veritas-affected-surface`, `software-evidence-check`, `veritas-policy-result`), not `type`, so no claim intrinsic to the Veritas artifact is Flow-matchable. **The working path is a Station-asserted claim over the record file:** `attachEvidence(..., { file: <record>, claimType: 'governance.merge-readiness', claimStatus: 'trusted', producer: 'veritas' })` normalizes the entry to `surface.claim` and matches a gate expectation of `claim.type: governance.merge-readiness` with `accepted_statuses: ["trusted"]` (verified: readiness-gate passes). Station's `FlowReadinessBridge` (`src-server/services/flow-readiness-bridge.ts`) owns this assertion; an upstream candidate is a Flow/Surface adapter that accepts record or bundle shapes natively.
- **Typings are loose:** the published `.d.ts` uses `MutableRecord`/`any` for most options and returns. Option names in this doc were verified against the dist implementation; consumers should declare their own precise interfaces (Station's `FlowRunService` does).
- On-disk layout per run: `.kontourai/flow/runs/<run-id>/{definition.json, state.json, evidence/manifest.json, evidence/<id>.*, report.json, report.md}`; workspace config at `.flow/config.json` (trusted producers, gate overrides); definitions in `.flow/definitions/`. Generated run state moved out of `.flow/` in Flow 3; there is no legacy `.flow/runs` read or write (#290).
- Run state carries `current_step`, `gate_outcomes[]`, `transitions[]`, `exceptions[]`, `next_action` — everything Station's run panel needs to render without interpreting semantics.
- `routeBackDecision` gives Station the full route-back contract (target step, attempt count vs. budget, recovery step on exhaustion); Station's job is only to surface it into the chat session and call `attachEvidence(..., {supersede})` + `evaluateRun` on retry.

**S1a mapping:** `FlowRunService` wraps `startRun`/`loadRun`/`attachEvidence`/`evaluateRun`/`acceptException`/`renderAndWriteReport`. Session completion = `evaluateRun` outcome, surfaced verbatim.

### @kontourai/veritas — repo standards & merge readiness (S1b)

**Consumption:** `veritas` CLI + on-disk artifacts. No MCP server (see corrections). Library exports exist (`runMergeReadiness`, `generateVeritasReport`, `buildReadinessCoverage`, `produceSurfaceStateForVeritasRecord`) but the CLI/artifact path is the stable consumer surface.

- `veritas readiness [--check evidence|boundaries|coverage] [--working-tree] --format json` → readiness run summary; `reportArtifactPath` points at the evidence record.
- **Verified output reality (re-verified against a real 1.5.0 run):** stdout is *not* pure JSON — inherited evidence-check output precedes a trailing pretty-printed JSON object, so Station parses the trailing object. The summary remains thin (`mode`, `evidenceCheckRan`, `evidenceCheckFailure`, `reportArtifactPath`, `reportRunId`, …) with **no per-requirement statuses**. Exit 0 = ready; 1 = a report was produced but readiness failed (JSON still emitted); ≥2 = a hard/configuration error. Consumers must follow `reportArtifactPath` rather than reconstructing a filename.
- The evidence record under `.kontourai/veritas/evidence/` embeds a Surface schema-v5 `trust.bundle` whose claims use `facet`, plus `trust.report`, `selected_evidence_checks`, `policy_results`, `recommendations`, `governance_state`, and `override_or_bypass`. This is the hand-off object. Station uses Surface 2.x directly so its in-product readiness and Trust views consume that bundle without a cross-major validator mismatch.
- **The seven readiness statuses (`satisfied/missing/stale/failing/advisory/recheckable/accepted`) are Station's presentation vocabulary, not literal Veritas output.** Station derives them in `veritas-readiness-service.ts`: evidence checks → satisfied/failing/missing; policy results use Veritas 1.5 `enforcementLevel` (`Require` → failing, `Guide`/`Observe` → advisory) with legacy `stage` fallback; governance attestation → satisfied/missing/stale; recommendations → advisory; recorded override/bypass → accepted; trust-report stale/recompute queues → stale/recheckable.
- Durable consumer-readable governance stays under `.veritas/`: `repo-map.json`, `repo-standards/`, `authority/`, and `attestations/`; authored claims stay in root `veritas.claims.json`. Generated evidence, claim inputs, feedback, recommendations, and conformance output stay under `.kontourai/veritas/`; Surface read models stay under `.surface/runs/`.
- **Current Station contract (2026-07-19):** Station governs itself with `@kontourai/veritas@^1.5.0`, uses canonical `.kontourai/veritas/` generated paths, and authors claim `facet` fields. The gate remains `npm run veritas:shadow` → `veritas readiness --working-tree`. The readiness panel deliberately invokes the *target workspace's own* Veritas binary and retains read fallback for legacy `.veritas/evidence/` records, but newly generated Station records use the 1.5 contract. The historical 0.3→0.5 disposition record remains useful history; it is not current-version guidance.

**S1b mapping (as built):** readiness panel = workspace's `veritas readiness --working-tree --format json` → evidence record → derived requirement statuses + `buildTrustReport(trust.bundle)` → `ReadinessPanel`. **S1c half (as built):** the same record attached to Flow gates via `FlowReadinessBridge` — *not* `trustArtifact: true`, which rejects both record and bundle (see the Flow section's verified trust-artifact reality); the bridge asserts `claimType: 'governance.merge-readiness'` / `claimStatus: 'trusted'` over the record file, supersedes prior readiness evidence on the gate, and the orchestration completion gate auto-runs it once when a verdict would bounce for missing readiness evidence.

### @kontourai/surface — trust state foundation (S1b, S2)

**Consumption:** library import + `surface` CLI + MCP server + web component.

- Core types: `TrustBundle` (current `schemaVersion` 5; required `source`, `claims[]`, `evidence[]`, `policies[]`, `events[]`), `TrustReport`, `Claim`, `Evidence`, `VerificationPolicy`, `VerificationEvent`. Claims use `facet`; Surface temporarily tolerates legacy `surface` on read but new stores and fixtures must emit `facet`.
- SDK: `TrustBundleBuilder`, `buildTrustReport(bundle)` → `TrustReport` (with `transparencyGaps[]`), `validateTrustBundle`, `buildTrustAnalyticsProjection`.
- **MCP server:** `surface mcp --input <bundle.json>` (stdio JSON-RPC). Tools: `surface_summary`, `surface_stale_claims`, `surface_missing_evidence`, `surface_get_claim`, `surface_policy`. This is the MCP integration Station registers in its registry (curated entry `surface-mcp`), pointed at the active change's bundle.
- **Input handling (re-verified on 2.12.0):** the default adapter expects a bare `TrustBundle`. `--adapter veritas` safely unwraps `trust.bundle` from a Veritas evidence record and also tolerates an already-bare bundle, so Station's curated Surface MCP integration can consume the exact `reportArtifactPath` without a manual extraction step.
- **Trust Panel:** `<surface-trust-panel>` custom element (module at `dist/src/trust-panel/surface-trust-panel.js`); feed via `src` attribute (report JSON URL) or `.report` property (a `TrustReport`). First candidate for the S1b panel before any bespoke UI.

### Station-authored MCP-UI servers — direction-(a) reference

**Consumption:** Station serves its own data as compliant MCP-UI servers that render in any MCP-UI host (including Station's own). First example: `examples/station-sessions-mcp` (curated registry entry `station-sessions-mcp`).

- **`station-sessions-mcp` (stdio):** tool `sessions_panel`, resource `ui://station-sessions/panel`, declared SEP-1865 dialect (`_meta.ui.resourceUri`), `mimeType: text/html;profile=mcp-app`. Built with the official `@modelcontextprotocol/ext-apps/server` helpers — same pattern as `examples/mcp-ui-demo`.
- **Self-contained snapshot:** at resource-read it fetches Station's local REST API (`GET /orchestration/sessions`, env `STATION_API_BASE`) and server-side-renders inline-styled HTML with no scripts/external assets, so it renders under the host's hardened sandbox (opaque origin + deny-all CSP) with zero CSP relaxation.
- **Contract-verified:** renders through the host's `mcp-tool-ui` layout path; `renderSessionsPanel` is unit-tested for self-containment + field escaping. Slice 1 is read-only (no `tools/call` from the panel → no dependency on the host approval/audit path). Live updates (SSE/poll, dedicated-frame `connect-src`) and action buttons (which would route `tools/call` through Station's approval+audit machinery) are deferred follow-ups.

### @kontourai/survey — review chains & workbench (S2)

**Consumption:** library import + subpath exports. *(Version note, 2026-06-12: S2 built against `^0.7.2` — all contract points below held from the 0.5.2 verification; new subpath exports since: `./review-workbench/element`, `./review-workbench/server-review-session`.)*

- **Browser-bundling landmine (verified S2):** the main export and even `./example-data/*` transitively pull `@kontourai/surface`'s node-only modules (`node:http`, `node:fs`) into browser bundles, and no `sideEffects: false` means nothing tree-shakes. **Only the `./review-workbench` subpath is browser-safe.** Upstream proposal SV1 filed.
- **Trust-bundle derivation from workbench state is server-side by design:** `deriveReviewSessionApplyResultForSnapshot` + `candidateReviewRecord` reconstruct `SurveyInput` from a session snapshot; never trust browser-computed apply results (Survey's own server-apply guidance — Station's plugin follows it).
- Workbench: `mountReviewWorkbench(root: HTMLElement, startState?, options?)` from `@kontourai/survey/review-workbench`, CSS via `@kontourai/survey/review-workbench.css`. Not a web component — a DOM mount function, which suits a Station plugin layout fine.
- Persistence: implement `ReviewSessionEventStore` (`load(session)` / `save(session, events)`) backed by Station project storage; reference impls exist (in-memory, localStorage, async-persistent).
- Record types: `RawSource`, `Extraction`, `Candidate`/`CandidateSet`, `ReviewOutcome` (`verified|assumed|rejected|proposed`), `EscalationRecord`; bundle input `SurveyInput`.
- Projection: `buildSurveyTrustBundle(input, {reviewProofs?})` → Surface `TrustBundle` — so a completed review session renders in the same trust panel as everything else.
- **MCP-UI server (SEP-1865) — contract-verified against Station's host (2026-06-29; the first real Kontour MCP-UI server verified end-to-end):** Survey ships `survey-review-mcp` (stdio; `src/mcp/review-mcp.ts`, PR #87; `@kontourai/survey@1.1.0`, bin `survey-review-mcp <session path>`) — an SDK-free newline-delimited JSON-RPC 2.0 server (protocol `2025-06-18`, capability ext `io.modelcontextprotocol/ui`). It serves the review card as a **declared SEP-1865 resource** `ui://survey/review-card/queue` (`mimeType: text/html;profile=mcp-app`), **dual-dialect**: the declared `ui://` resource (read by Station's resolver via `resources/read`) AND the legacy mcp-ui.dev embedded resource in tool results. The UI pointer is emitted under **both** the FLAT canonical `_meta["ui/resourceUri"]` key (what `@modelcontextprotocol/ext-apps`'s `registerAppTool` emits) and the nested `_meta.ui.resourceUri` convenience key. **Gap found + fixed:** Station's `mcp-ui-resolver.extractResourceUri` read only the nested key, so a strictly-canonical Apps server (flat key only) resolved to `missing_resource`; the resolver now reads the flat canonical key first (regression-tested with Survey's exact shapes — flat-only, nested-only, and both). Render flows through the existing hardened sandbox (opaque origin + deny-all CSP) and, post-#139, the per-server render permission (allow + revoke). Curated registry entry: `survey-mcp` (`examples/registry/integrations/survey-mcp/`).

### @kontourai/fieldwork — hosted extraction and review application

**Consumption:** exact `@kontourai/fieldwork@0.6.1` dependency inside the
`examples/fieldwork-review` plugin. Station calls only the published
`createFieldworkApplication()` facade: `run({ taskPath, sourcePath?, root })`,
`open({ runDirectory, presentation, embeddingOrigin })`,
`reviewedOutput(runDirectory)`,
per-open-service `close()`, and application `close()` through the plugin
server's host-invoked `dispose()` lifecycle.

- Station resolves task and source inputs as existing regular files whose real
  paths remain under the selected project's configured workspace. Absolute
  paths, traversal, and symlink escapes are rejected before the facade runs.
- The plugin supplies
  `<project>/plugin-data/fieldwork-review/runs` as the Fieldwork run root and
  keeps Station's own content-free run index alongside those artifacts.
  Symlinked owned-storage components are rejected, and an unreadable or invalid
  existing index fails closed without replacement.
- Station's plugin-server lifecycle retains the optional `dispose()` export and
  invokes it before update, uninstall, module reload, and runtime shutdown.
  Fieldwork Review uses that contract to close every open capability service;
  it also closes the selected service on ordinary layout/project transitions,
  bounds concurrent services, and expires idle services.
- Fieldwork owns the application lifecycle, proposal review surface, Survey
  review behavior, and reviewed export. Station lists bounded summaries,
  forwards only bounded lifecycle telemetry, and gives the browser the
  capability URL returned by `open`; it neither proxies nor reconstructs
  source text, prompts, credentials, provider receipts, review records, or
  reviewed output.
- The Station layout is React Query-driven host chrome. It embeds the returned
  loopback review URL only in a titled sandboxed iframe with `no-referrer`;
  `allow-same-origin` remains necessary because Fieldwork's protected browser
  API is served from that separate loopback origin. Station requires the
  browser's canonical HTTP(S) `Origin` on each open request and passes it
  explicitly so Fieldwork authorizes only that host origin to frame the UI.

### @kontourai/flow-agents — process discipline layer (S3)

> **Reintegration pending (2026-08-27):** Flow Agents has had a major upstream
> rewrite. The contract notes below describe the pre-rewrite integration and are
> retained as the verified historical record; the sidecar workflow harness has
> been retired from this repo ahead of reintegrating against the rewritten
> package. Re-verify everything in this section at reintegration time.

**Consumption:** hook scripts + sidecar schemas + skills + adapter pattern; Station enforces the four policy classes natively at the orchestration layer (S3 item 1, shipped 2026-06-12 — `src-server/services/agent-policy-service.ts`; per-runtime enforcement depth declared in `docs/design/agent-engine-unification.md`), keeps durable workflow sidecars at the same seams (S3 item 2, shipped 2026-06-12 — `src-server/services/workflow-sidecar-service.ts` + `orchestration-workflow-sidecar.ts`), and serves the package's canonical skills to managed agents (S3 item 3, same date — `src-server/services/flow-agents-skills-source.ts`).

*Version note (2026-06-29): Station consumes `@kontourai/flow-agents@^2.2.0`. The package has a public library export (`@kontourai/flow-agents`) for sidecar writer/validator primitives, schema vocabularies, canonical skills, and local artifact-root helpers. Station consumes those exports instead of reimplementing sidecar JSON formatting, status/phase vocabulary, or Flow Agents artifact-root selection locally.*

*Version note (2026-07-07, archive#218): Station now pins exact `@kontourai/flow-agents@3.3.0` (no caret). The `legacyFlowAgentsArtifactRoot`/`LEGACY_FLOW_AGENTS_DIR` exports named above were removed upstream in 3.x (`.flow-agents` is now exclusively the package's own durable install/config root, `DURABLE_FLOW_AGENTS_DIR` — a different concept); Station now implements that legacy-compat helper locally in `local-artifact-paths.ts` instead of importing it. Full subcommand-by-subcommand CLI behavior audit (2.2.0 -> 3.3.0): `.kontourai/flow-agents/s218-flow-agents-3x/cli-audit-2.2.0-to-3.3.0.md`.*

*Version note (2026-07-20, station#592): Station pins exact `@kontourai/flow-agents@3.4.3`. Builder sessions now have a canonical Flow-run projection managed by `flow-agents builder-run start|sync|recover --session-dir .kontourai/flow-agents/<slug>`; `sync` projects the run into the sidecar rather than Station reconstructing gate state.*

*Version note (2026-07-22, station#693): Station pins exact `@kontourai/flow-agents@5.2.0`. Its orchestration lifecycle calls Flow Agents' public `bindHostWorkflowSession()` contract whenever a thread starts or resumes a task. The actor key is a stable, privacy-safe derivative of the Station thread rather than the selected model runtime, so the same task can move between supported runtimes without losing steering or stop-gate scope. Station passes that same actor into canonical hooks and no longer writes or derives Flow Agents current-pointer internals. Policy, sidecar, and Survey review now consume this one package identity.*

*Version note (2026-07-24, station#933): Station pins exact `@kontourai/flow-agents@5.3.0`, which ships a stable `./console-contract` subpath exporting the workflow-status -> Console process-status table, `mapWorkflowStatusToConsoleProcessStatus`, `deriveConsoleProcessBlockedReason`, and the projection/status types. Station retired the hand-mirrored copy of that table in `workflow-process-projection-mirror.ts` and now imports the real functions/types from this subpath (`operating-state-service.ts`); that file retains only its own critique-detection helpers (`hasUnresolvedLiveCritique`/`filterCritiquesForSlug`), which the subpath does not (yet) export, with a trip-wire test that fails loudly if it starts to.*

- Four policy classes as canonical scripts under `scripts/hooks/`: `workflow-steering.js` (non-blocking context injection), `quality-gate.js` (post-write lint/format), `stop-goal-fit.js` (blocking with `FLOW_AGENTS_GOAL_FIT_STRICT=true`), `config-protection.js` (blocking on protected config writes).
- Two invocation forms; **Form 2 (native import) is Station's path**: `const {run} = require('.../config-protection.js'); run(rawJson, {truncated, maxStdin})` → string or `{exitCode, stderr?, stdout?}`. The Strands TS adapter (`integrations/strands-ts/src/policy.ts`, `PolicyGate.checkToolCall`) is the reference for native embedding with fail-open fallback.
- Adapter contract: event wiring (host events → hooks), adapter wrapper (host payload → canonical payload, exit code → host response), telemetry wrapper, install script. Env contract: `FLOW_AGENTS_HOOK_RUNTIME`, `SA_HOOK_PROFILE` (`minimal|standard|strict`), `SA_DISABLED_HOOKS`.
- Sidecars: canonical artifact root is `.kontourai/flow-agents/<task-slug>/`; legacy `.flow-agents/<task-slug>/` is a Station-owned compatibility root only (as of 3.x the package no longer exports a legacy-read helper for it — see the 2026-07-07 version note above). `state.json` schema (v1.0) requires `task_slug`, `status` (14-value enum), `phase` (11-value enum), `next_action {status, summary}`, `updated_at`; `state.json` also gained an optional `branch` field in 3.x (ADR 0021), additive. A Builder-backed state also carries `flow_run`: required `run_id`, `definition_id`, `definition_version`, `status`, `current_step`, `run_ref`, and unique `open_gate_ids`, with optional route-back counters. This is the canonical Flow routing surface: Station preserves it through sidecar summaries and renders `current_step` plus concrete `open_gate_ids`; agents route from those fields and use `next_action`'s `status`/`summary` and optional `skills`/`operations`/`command` to perform the next work before `builder-run sync`. The package ships both machine-readable schemas (`schemas/workflow-state.schema.json`, `workflow-handoff.schema.json`, draft 2020-12) and exported writer/vocabulary/path primitives (`writeJson`, `writeState`, `statuses`, `phases`, `readSidecar`, `writeSidecar`, `flowAgentsArtifactRoot`, `defaultArtifactRootForRead` — `legacyFlowAgentsArtifactRoot`/`LEGACY_FLOW_AGENTS_DIR` were removed in 3.x, station now owns that helper locally). Station validates against the shipped schemas and delegates sidecar JSON writes, status/phase vocabulary, and Flow Agents root selection to those exports.
- **Skills (verified shipped in the 2.2.0 package; confirmed unchanged live in the installed 3.3.0 package, 2026-07-07):** canonical skills under `skills/<name>/SKILL.md` currently include `agentic-engineering`, `browser-test`, `dependency-update`, `eval-rebuild`, `github-cli`, and `search-first`. Station registers the package `skills/` dir as a read-only discovery source (no conversion, no copied content; local skills win on name collision; `FLOW_AGENTS_SKILLS_ROOT` overrides). The package owns the skill list; Station tests enumerate the installed package shape instead of freezing an older catalog.
- Capability matrix: L0 telemetry, L1 steering + warning stop-check, L2 all four policies with blocking (Claude Code, Codex, Kiro). **Station's target — full native integration at the orchestration layer, uniform across all of Station's runtimes — is the proposed L3; the definition gets contributed upstream as part of S3.**

### @kontourai/console + console-core — suite operating plane (S4)

**Consumption:** HTTP ingestion (`POST /records`) + the verified record contract, implemented natively; the package itself is a devDependency used by tests and the DoD proof (in-process hub). Station is a producer.

*Version note (2026-06-12, re-verified against the npm 0.3.0 tarball via `npm pack` for S4 item 1): the tarball ships a complete working `dist/` — the S2 console-kit defect does not repeat; the hub (`createConsoleHubServer` / `npx kontour serve`), `validateEvent`, and the flow bridge all run from npm. **But the published root package.json has no `main`/`exports`/`types`** — `import '@kontourai/console'` fails; only the four bins and unguarded deep file-path requires work (upstream C1). The producer helpers (`KontourEmitter`, `LocalFileSink`, `CompositeSink`, `InMemorySink`) exist in the shipped `emitter.js` but are **not** re-exported from the foundation index, and `emitter.d.ts` is empty (`export {};`) — no typed consumption path exists at all (upstream C2).*

*Version note (2026-07-20, C-series refresh — station#587, source-verified against `kontourai/console` `main` at commit `1435b82`; not yet reflected in a published npm release):* **C2 resolved in source, 2026-07-16** (`console#222`, closing upstream `console#71`): `emitter.ts`'s producer surface (`KontourEmitter`, `LocalFileSink`, `CompositeSink`, `InMemorySink`, `ApiSink`) was converted to named exports so `emitter.d.ts` emits real declarations, and `console-foundation/index.ts` now re-exports them with types — the "no typed consumption path" gap above is closed at the source level. **C1 resolved in source, 2026-07-20** (`console#235`, implementing `console#228`, explicitly "closing the C1/C2 discrepancy from kontourai/station#580"): the root `package.json` gained `main`/`types`/`exports` pointing at the `console-server` foundation dist already shipped in the tarball's `files` array; `@kontourai/flow` was added as a **declared root dependency** (a review-caught gap in the same PR — the shipped `.d.ts` type-only-imports `@kontourai/flow/console-contract` but root never declared the dependency, which fails `TS2307` for an isolated consumer); and a second, previously undisclosed typing gap was fixed alongside it (`validateEvent`, `validateProjection`, `extractActionDescriptors`, `inspectLocalKontour`, plus the surface/flow mapping helpers, had runtime-only `module.exports` entries with no type declaration at all). `cli/scripts/test-tarball.ts` now packs the root tarball, installs it offline, and compiles a strict-mode TS consumer against it (wired into the package's own `npm test` as `test:tarball`) — the class of break that shipped 2.6.0 without an entry can no longer pass that repo's CI. **Not yet published:** root `package.json` is at version `2.7.0` in source; the last published npm version is `2.6.0`. Root releases intentionally exclude `console-server`-only changes from triggering a root release (`release-please-config.json`, enforced by `check:release-package-versions`), so this fix ships on the **next owner-gated root release**, not automatically — `npm view @kontourai/console` on the live `2.6.0`/`2.7.x`-labeled artifact still returns no `main`/`exports`/`types` until then. Re-verify the published tarball (not just source) before Station changes its consumption pattern. **Also new since the prior note:** `console-server` is no longer bundled-only — as of `console#223` (implementing `console#70`/`#71-lib`, 2026-07-17) it is **separately published as its own package, `@kontourai/console-server`** (renamed from the workspace's old `@kontourai/console` internal name; seeded at `0.1.0`; its own release-please component), reversing an earlier decision (`console#192`) that kept it `private`. The root `@kontourai/console` package still bundles and points its own `main`/`exports` at `console-server/dist` (the code overlap is an accepted trade-off, not a bug) — so this is no longer a "root vs. workspace of the same name" framing: they are two distinct published packages with overlapping compiled output by design.*

- Hub HTTP contract (verified live against the 0.3.0 dist): `POST /records` (one `ConsoleRecord` per request, 202 on accept, `DeliveryResult` body), `GET /state` (`OperatingState`), `GET /stream` (SSE: `ready`/`state`/`record.accepted`/`telemetry.updated`), default `127.0.0.1:3737`; hub projections **deduplicate by record id**, so re-emission is state-safe.
- Event shape (verified against the shipped `validateEvent`): `schema: "kontour.console.event"`, `version: "0.1"` (warning otherwise), `id`, `type`, `occurredAt`, and **required objects `producer`, `scope`, `subject`, `payload`**; `subject` and link refs need `{product, kind, id}` strings; `links[]` entries need `{from, relation, to}`. Projection vocabulary (current-operating-state): `process.started|progressed` → processes, `gate.opened|passed|failed|routed_back` → gates (`payload.after.status` wins; `after.processRef` binds gate→process), `evidence.attached`, `learning.*`; unknown types still land in the timeline.
- Pattern followed: the Flow bridge (`deriveFlowRunEvents`/`bridgeFlowRun`) derives deterministic, stable-ID events (`evt-flowbridge-<runId>-<seq>`) from `.flow` run files. Station's bridge mirrors it from event-sourced session state: `src-server/services/console-bridge.ts` derives `evt-stationbridge-<threadId>-<seq>` records from the orchestration event store; `console-bridge-service.ts` delivers them (hub POST + a `LocalFileSink` byte-layout-compatible JSONL writer: `.kontour/events/<producer.id>/<scope.kind>-<scope.id>.jsonl`), off by default via `STATION_CONSOLE_HUB_URL` / `STATION_CONSOLE_FILE_SINK`. Schema validity is regression-tested against the package's real shipped `validateEvent`.
- `@kontourai/console-core` exports the read-side shapes (`OperatingState`, `ConsoleProcess`, `ConsoleGate`, `TimelineItem`, `buildProcessFlow`) if Station ever renders Console projections (same publish caveat applies to the aggregate root).

### @kontourai/console-kit → @kontourai/ui — design system (S2; migrated S5)

> **Superseded (2026-06):** `@kontourai/console-kit` was renamed to **`@kontourai/ui`** ([`ui#5`](https://github.com/kontourai/ui/issues/5)). `@kontourai/ui@1.1.0` ships a complete `dist/` (CK1 resolved) and re-exports the real primitives + `ProductIcon` + tokens, so Station now consumes the **published package** and the local mirror (`console-kit.tsx`, mirrored `ProductIcon`) was **deleted** (`s1c-dogfood-log.md` #016). Station's dep is `@kontourai/ui@^1.1.0`; imports are `@kontourai/ui/react`, `@kontourai/ui/{tokens,fonts.css,react/styles.css}`. The historical console-kit detail below is retained for provenance — read `@kontourai/console-kit` as `@kontourai/ui` throughout.

**Consumption:** the published `@kontourai/ui` primitives + tokens (was a CSS-class mirror under console-kit's CK1 publish gap; adopted 2026-06-12 as S2 item 4, migrated to the real package in S5).

- Tokens: `@kontourai/console-kit/tokens` (`--k-bg`, `--k-panel`, `--k-text`, `--k-brand`, `--k-positive/caution/negative`, spacing/radius/type scales); dark default, `[data-theme="light"]`. Also published: `/themes.css` (product theme classes `theme-console|flow|survey|surface` — Station applies none; it is the host, not one product), `/fonts.css` (Google Fonts faces behind `--k-font-*`), `/react/styles.css` (the shared primitive stylesheet).
- React: `Badge`, `Button`, `Empty`, `Metric`, `Panel`, `Progress`, `StatusBadge`, `Topbar` + `toneForValue` utilities from `@kontourai/console-kit/react`.
- Web components (`<k-badge>`, `<k-panel>`, `<k-status-badge>`, …) from `/elements` for framework-free contexts.
- **Publish gap (CK1) — RESOLVED.** The console-kit 0.1.1 tarball omitted `dist/`, so its `./react`/`./elements` JS entries were dead for npm consumers; Station mirrored the primitives' markup locally (`console-kit.tsx`) as a stopgap. `@kontourai/ui@1.1.0` ships a complete `dist/` with the real primitives + `ProductIcon`, so the mirror was deleted and Station imports `Badge`/`Empty`/`Metric`/`StatusBadge`/`toneClass`/`ProductIcon` from `@kontourai/ui/react` directly. (Historical: the consumable surface during the gap was the CSS class contract — `.panel`/`.panel-head`, `.badge`/`.status` + `.tone-*`, `.metric`, `.empty`, `.btn`, `.topbar`, `.eyebrow`.)
- **Station's adoption shape:** token definitions global (`index.css`; they only define `--k-*` custom properties on `:root`/`[data-theme="light"]`, no overlap with Station's `--bg-*`/`--text-*`, and Station's ThemeToggle already drives `data-theme` on the document element, so light/dark flips both systems); `--k-*` consumption and the primitive classes scoped to Kontour-facing surfaces (trust panel, readiness panel, flow run console, gate verdict cards). Wrapper-class scoping of the token *definitions* was rejected — it would fork the vendor file, which the consumer guide forbids. One collision audited: the bare `.empty` primitive class vs `.autocomplete-item.empty` in MonitoringView (defensively re-asserted there).
- Scope decision (recorded in roadmap S2 item 4): **Kontour-facing surfaces only for now; base chrome unchanged until the S4 suite-coherence pass.**
- Tone vocabulary reality: `toneForValue`'s matchers don't cover Veritas/Surface vocabulary (`satisfied`, `failing`, `missing`, `advisory`, `disputed`, `unverified` all fall through to the fallback; `stale` matches *negative*). Station's product-semantic maps live in `src-ui/src/components/kontour/station-tones.ts`; vocabulary gaps are upstream CK4.

---

## The S1 evidence pipeline, end to end (verified against the contracts above)

```
agent session starts (project has .flow/definitions/<def>.json)
  └─ FlowRunService: startRun() → .kontourai/flow/runs/<run-id>/
agent works; Station attaches evidence as it accrues:
  ├─ test/CI output            → attachEvidence(kind: "command" | "ci")
  ├─ veritas readiness         → `veritas readiness --working-tree --format json`
  │     └─ .kontourai/veritas/evidence/<id>.json (embeds Surface TrustBundle)
  │           → attachEvidence(file: <record>, claimType: "governance.merge-readiness",
  │                            claimStatus: "trusted", producer: "veritas")
  │             (trustArtifact: true rejects record AND bundle — see Flow caveats)
  └─ human attestation         → attachEvidence(kind: "human-attestation")
agent (or user) requests completion:
  └─ evaluateRun() → per-gate GateOutcome
        ├─ pass        → applyEvaluation → renderAndWriteReport → done, with receipts
        ├─ route-back  → routeBackDecision → prompt injected into session; retry with supersede
        ├─ block       → surfaced; acceptException(authority, reason) is the only human override
        └─ wait        → session stays open, panel shows what's missing
panel rendering: TrustBundle → buildTrustReport() → <surface-trust-panel .report>
suite visibility (S4): run files → deterministic ConsoleEventRecords → POST /records
```
