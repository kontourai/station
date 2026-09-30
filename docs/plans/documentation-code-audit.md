# Documentation and architecture audit

Status: source audit complete; documentation maintenance policy activated with
owner approval. Follow-up product proposals remain separate. Baseline:
`ff2d743b4e45605d0a8500bd15ca4e1a86185ca6` (2026-09-26); upstream changes
reviewed through `64452b7f0` for landing, including verification budgets,
Station-control scope, Codex approval IDs, typed SDK refusals and queue recovery,
portable Nightly publication and installation, and the desktop account-proof
and application-signaling foundations, and the reasoning-disclosure styling.
This is the audit record, not a deployment receipt. GitHub owns live delivery
state; the review ledger records each document's scope and evidence limits.

## Outcome

A reader can learn what Station does, explore its concepts as a tree, follow a
real journey into implementation and evidence, and identify improvements with
the relevant tradeoffs in view. Every tracked Markdown file receives a
disposition. Every current behavioral claim is reviewed against actual code;
missing documentation is found by walking the implementation in the other
direction. Comments become shorter without losing the reasons past defects
must not recur.

The [learning atlas](../learn/README.md) provides interactive navigation over
canonical documents. The ordinary Markdown remains the content authority.
The [maintenance guide](../guides/documentation.md) and repository
[audit skill](../../.agents/skills/documentation-audit/SKILL.md) define how
future changes maintain the same standard.

## Baseline inventory

The baseline has 388 tracked Markdown files, including 61 READMEs. There are
three Markdown files containing Mermaid fences; some contain several diagrams.
The contributor module map has 1,235 lines. These are inventory measurements,
not defect counts or audit completion percentages.

| Area | Baseline Markdown files | Required treatment |
| --- | ---: | --- |
| `docs/` | 222 | Separate current explanation/reference from proposals, generated output, historical records, and operating policy; inspect every file |
| Root | 8 | Product promises, contribution instructions, context, security, and source routing |
| Packages | 15 | Published versus checkout behavior, exports, prerequisites, examples, compatibility |
| Examples | 32 | Build/install/run instructions, actual contract usage, provider prerequisites, known limitations |
| Changesets | 72 | Historical release intent; preserve chronology and distinguish it from publication evidence |
| Agent skills and Veritas | 6 | Guidance, coverage, ownership, authority, and what enforcement actually proves |
| GitHub, deployment, packaging, patches, schemas | 9 | Contributor/operator instructions and external versus local path boundaries |
| Experiments | 3 | Experimental status and reproducibility; no product availability inference |
| Scripts, server, UI, native, tests | 21 | Local instructions, fixture purpose, code ownership, native prerequisites |

Regenerate the interactive library from tracked files after additions, moves,
or removals. Its complete file list exposes the review denominator; inclusion
does not mark a file semantically reviewed. New files expand the scope.

## Review units

| Unit | Trace and review |
| --- | --- |
| Product and vocabulary | README promises, concepts, glossary, UI names, implemented versus planned capabilities |
| Startup and storage | CLI distribution, instance identity, configuration, bootstrap, home schema, transactions, migrations, backup/recovery |
| Projects and Tasks | Identity, workspaces, task graph, assignment, dispatch, receipts, restart and cancellation |
| Sessions and engines | Foreground admission, ownership, provider invocation, turn boundaries, persistence, replay, attachment/adoption, recovery |
| Work surfaces | Navigation, layouts, Pane contracts, commands, settings, files, terminals, browser/device surfaces, responsive behavior |
| Knowledge and learning | Source observation, indexing, retrieval, namespace/storage ownership, graph views, learning review |
| Extensions | Plugin install/admission/grants, providers, capabilities, SDK/contract exports, examples and supply-chain policy |
| Identity and connections | Account identity, Device pairing, Project membership, connection selection, direct/relay paths, authority propagation |
| Shared and remote work | Shared documents, presence, room boundaries, peer dispatch, runner placement, transfer, ambiguity and reconciliation |
| Background activity | Scheduling, monitoring, operational events, notifications, retry/retention, voice/media |
| Native and delivery | Tauri shells, adapters, platform differences, releases, installers, service supervision, actual device/deployment evidence |
| Governance and verification | Tests, examples, CI, Veritas, proof scope, source generation, documentation and comment maintenance |

For each unit record: canonical document and affected READMEs; claim; source
symbol and caller; evidence and whether executed; discrepancy or missing
explanation; correction; remaining limitation. Also inspect inbound links,
duplicated explanations, glossary consistency, diagram edges, failure paths,
and external prerequisites.

The [review ledger](../learn/review-ledger/) records each inspected file's
purpose, review scope, source revision, supporting code/tests, and limits.
Classification is separate from source review. Current explanations have
documented-claim reviews; historical records, proposals, policies and fixtures
retain their separate purpose. The reader shows each review's scope and limits
above the document and flags changed prose or supporting code. A review of a
document's claims is not a proof of every possible implementation behavior.

## Abstraction review

The tree's nodes represent responsibilities, not directory names. For each
node assess its public interface, concrete composition point, state owner,
authorization boundary, lifecycle, failure contract, and real callers/tests.
Identify missing abstractions only after tracing repeated caller obligations.
File size, comment volume, and a large import list are investigation leads,
not proof that a new abstraction is needed.

Classify findings as a confirmed mismatch, a documentation gap, or an
implementation question requiring more evidence. Keep architectural refactors
separate from behavior-neutral documentation/comment edits. Preserve an
existing interface when it already hides the relevant complexity.

GitHub owns follow-up implementation. The
[abstraction review](../architecture/abstraction-review.md) links source-backed
findings to existing owners and individual audit issues. Issue acceptance names
the documentation owners to revisit when the behavior changes. Keep evidence
and links here; do not copy live issue status into a parallel checklist.

## Stages and exit conditions

1. **Inventory and navigation.** Complete tracked-file library, overview-to-code
   reading route, interactive concept tree, searchable documents and deep links.
   Source navigation and semantic review status are visibly distinct.
2. **Current truth by subsystem.** Trace every review unit above, update each
   affected README/guide/reference/diagram, and document implemented journeys
   that lack an explanation. No unit closes from source-path checks alone.
3. **History and comments.** Disposition every remaining Markdown file;
   preserve historical evidence and successor links. Review comments by owning
   subsystem, remove narration, shorten rationale, retain directives, public
   contracts, and regression knowledge. Record unreviewed files explicitly.
4. **Prevention.** Reuse existing link/index/example/contract checks, fill
   demonstrated coverage gaps, route feature changes to documentation owners,
   and prove new checks catch representative drift with benign controls.
5. **Final editorial pass.** After technical review, simplify current guides,
   READMEs, navigation, diagram labels, retained comments, and canonical MCP
   topics using the maintenance guide's
   [clear-language guidance](../guides/documentation.md#edit-for-clear-language).
   Remove inflated phrasing, repetition, vague claims, and unnecessary jargon.
   Preserve exact names, conditions, defaults, failure cases, evidence limits,
   and reasons for past fixes. Regenerate derived content and review the diff
   for changed meaning. Record any remaining editorial work; passing technical
   checks does not complete this stage.
6. **Reader acceptance.** Walk the atlas from a fresh reader's perspective,
   exercise search, hierarchy, cross-links, document outlines and narrow-screen
   behavior. Follow success and failure/recovery journeys into real code and
   evidence. Verify generated output and retained source paths at the final
   revision; publish only through an authorized delivery step.

## Initial findings

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Architecture navigation starts at a large implementation catalog | Root README and `docs/architecture/module-map.md` | Add an overview-first reading path and concept navigation |
| CLI documentation conflates distribution boundaries and omits current local operations | `packages/cli/src/distribution.ts`, command dispatch, and the CLI availability table | Reconcile the package README and architecture explanation with current command admission |
| Knowledge overview hardcodes one backend at an injected provider boundary | `KnowledgeService` constructor and runtime service bootstrap | Explain configured providers; audit the broader knowledge journey separately |
| Reference gate omits user guides and nested READMEs | `LIVE_DOC_DIRECTORIES` and `LIVE_DOC_FILES` in the source-reference gate | Expand focused coverage with failure and benign-path tests |
| Comment prose can itself become stale | The documentation aggregate's historical 12-lane narration; provider/reference scope narration | Keep the invariant and issue provenance, remove duplicated historical mechanics |
| The streaming diagram includes a handler absent from composition | `createStreamingPipeline` composes Reasoning, ToolCall, Metadata, and Completion | Remove TextDeltaHandler from the diagram and link the composition owner |
| Monitoring prose conflates observations with the durable orchestration stream | `MonitoringEmitter` uses an EventEmitter and best-effort persistence | Name the separate channel and its durability limit |
| The MCP carries an independent prose copy with stale vocabulary and abstraction claims | The former `station-docs-content.ts` described Provider as user-facing, every Project as directory-backed, and core as having no domain logic | Move shipped prose to canonical Markdown, correct those claims, generate manual and architecture topics with content identity |
| The Task introduction implies Session history is not persistent | `src-server/services/orchestration/event-store.ts` and its reopen/history tests | Distinguish durable work identity from an execution episode without denying persisted Session history |
| The glossary says Browser/live-surface work is unimplemented and state `1.0` is still current | `runtime-routes.ts` composes personal-host browser and live-surface routes; `BrowserPreviewWorkspacePane` loads the streamed pane and migrates legacy state | Correct the current glossary; label ADRs 0017/0019 and the two preview-design records as dated history with a current explanation |
| The glossary says every lease claim increments the epoch | `LiveSurfaceControlLeaseState.setHolder` separately updates epoch and fence; release/reclaim and continuing-holder tests exercise the distinction | Explain both counters, stale-input refusal, and the live-human restriction; shorten the source comment while retaining D2/S3 regression rationale |
| The CLI README says nearly all operations are HTTP and its help always matches admission | Existing-service control invokes OS service managers; `bundledAvailabilityNote` lists all of `service` despite `assertCommandAvailable` admitting status/start/stop | Correct the README's local-operation scope and document the help discrepancy; the help implementation still needs correction |
| The glossary treats every wrong-version home as requiring reset | `ensureStationHomeSchemaSync` refuses future versions with `STATION_HOME_SCHEMA_DOWNGRADE_REFUSED`; `stationHomeSchemaNeedsReset` does not select them | Distinguish legacy/invalid homes, current bootstrap, and newer-schema refusal; do not imply the empty production registry provides migrations |
| Entry-point docs say detection never creates an engine connection | `StationRuntime` calls `adoptDetectedNativeEngines`; candidates include Claude, Codex, and Muse, and registry adoption respects recorded removal | Distinguish startup adoption from discovery and sign-in in README, setup, and Connections |
| Context files repeat retired Agent types, virtual Agents, engine labels, and incomplete lifecycle states | Persisted `AgentRegistry`, `EngineCapabilityMatrix`, and `SESSION_LIFECYCLE_STATES` | Replace the root's duplicate glossary with responsibility routes; correct the runtime and extension contexts, including `idle` and per-engine delivery |
| Introductory promises imply all Tasks automatically finish through gates | `attachFlowRunForSessionStart` leaves workspaces without valid Flow definitions unbound; Starter launch records `NOT_VERIFIED` independently of dispatch | Explain execution, review, and gate results as separate facts; retain the constitution as policy rather than claiming universal implementation |
| First-use instructions bury actions in implementation details | Starter registry, owner adapters, first-run UI, and composer reference expansion | Keep concise user actions; preserve exact retry, correlation, and receipt behavior in `docs/guides/starter-work.md` with source and test routes |

### Entry-point and context review

The first-use review passed 144 tests across Starter registry/module/owner and
route behavior, first-run choices and saving, and composer mentions. A separate
79-test run covered native-engine adoption and the engine capability matrix.
These are fixture-backed behavior checks, not a live engine, device, or release
claim. Code inspection also corrected file-mention wording: the sender expands
a project-relative selection into a quoted full workspace path.

The review ledger currently distinguishes release-intent notes and dated
changelogs from current contributor instructions. Policy and ADR classification
preserves their intent without treating goals, original observations, or
publication plans as current runtime guarantees. No percentage derived from
these classifications represents completed semantic coverage.

### Notification and privacy follow-through

The privacy inventory now describes iOS Live Activity cards, ordinary Android
and iOS notification pushes, encrypted content versus visible routing metadata,
and configured vector-provider data. Its Markdown outputs were regenerated;
Apple's generated privacy manifest bytes did not change. The 52 focused
privacy/FCM/APNs tests passed. Tauri iOS context checks reported ten checked,
none skipped or failed; no physical Apple or Android device was attached.

Public policy publication and store-console disclosures remain outside this
local result. Source code establishes transport fields and gates, not a
third-party provider's retention or linkage practices. The existing store
classifications need owner review against those practices before a disclosure
submission; [Apple's guidance](https://developer.apple.com/app-store/app-privacy-details/)
includes third-party linkage in that assessment. No store submission or public
policy publication was performed by this audit.

The [abstraction review](../architecture/abstraction-review.md#notification-suppression-now-shares-its-policy-owner)
records a separate, executed classification difference between FCM and APNs.
The FCM comment now states that difference; its emitted executable code is
unchanged. Selecting a common suppression policy requires a behavior change,
not an editorial cleanup.

### Independent review and subsequent subsystem corrections

Fresh-context review corrected two entry-point overclaims: Flow attachment
requires explicit `metadata.flowDefinition` at the production caller, and
Starter launch replay checks current readiness before returning saved work.
The reviewer accepted the corrected delta separately from the original pass.

The reader verifier executed a source-digest guard mutation: removing the
comparison made the intended freshness assertion fail, and byte-identical
restoration passed. It also reproduced an old-reader/new-build mismatch.
Immutable source URLs and dependency-bound lazy payloads fix that scenario.
Follow-up review found truncated-existing assets; publication now writes a
complete temporary file, links it without overwriting an existing object, and
checks exact bytes on collisions. Independent refusal/restoration probes passed.
This does not claim a whole-build transaction or power-loss durability.

The plugin guide and portable-format reference now distinguish actual secret
storage from declarative secret slots, settings persistence from activation,
legacy installation from retained portable materializations, and real consumer
interfaces from generic provider registration. The subsequent fix round
separates explicit approval from reconciliation and withholds content until
activation; independent review accepted the corrected wording.

Session/ACP documentation now follows canonical foreground execution, returned
Session/Conversation identities, optional receipt durability, cursor-based ACP
restoration, and current catalog/status fields. The diagnostic script was
repaired and fixture-tested; no live provider execution is implied. Access
documentation now describes published shared-work reads, authenticated SSH
transport, bound Station-control authority, current scope exceptions, and the
separate native route/key preparation state.

Knowledge review added the missing store/index abstractions and corrected
model-identity, excerpt freshness, explicit rebuilding, partial outcomes,
migration recovery, and current example limitations. Thirteen focused files
passed 156 tests; a later five-file UI/MCP/reader check passed 60. Nine
comment-only source edits preserve identical executable output. Migration UI
copy was corrected separately because a source read can recover a pending
transaction. Live embedding, Neo4j, speech, and device outcomes remain outside
those fixture checks.

### Browser and lease evidence, 2026-09-26

At source revision `7f11f9000204dea178f176ffb75571612f0a8fab`, the focused run
below passed all 53 tests across three files. It exercises
the lease state machine, actual runtime route composition with fixture
services/producers, and the Browser pane's UI states with a test API. It does
not launch a production browser, prove hostile-page containment, test a
physical phone, or establish release delivery.

```bash
npm run test:focused -- src-server/services/live-surface/__tests__/control-lease.test.ts src-server/runtime/routes/__tests__/runtime-routes-live-surface.test.ts src-ui/src/workspace-panes/browser-pane/__tests__/BrowserPane.test.tsx
```

The subsequent lease-comment cleanup produces identical JavaScript with
comments removed. A separate
`npm run test:focused -- packages/shared/src/__tests__/station-home-schema.test.ts`
run passed all 32 tests, including the refusal to reset or migrate a
future-version home. Neither run changes application behavior.

The later Browser and live-surface review covered acquisition, profiles, target
admission, Agent grants, cleanup, Device producers and current guides. Its scope
and separate execution limits are recorded in the review ledger; the earlier
glossary correction alone did not establish those claims.

### Monitoring, notifications, native recovery, and disclosure review

The full monitoring and browser Web Push guides were rewritten against their
callers and independently reviewed. The monitoring guide retains all 28 old
section anchors and distinguishes declared metrics, actual recording paths,
and unverified collector delivery. Its generated declaration catalog contains
309 creation calls; its checker rejects unsupported syntax rather than silently
omitting declarations. Native recovery guides now distinguish existing source
and harnesses from physical-platform results that this audit did not obtain.

The [abstraction review](../architecture/abstraction-review.md) links the
monitoring, notification, and live-surface findings to GitHub. Issue acceptance
requires the implementation and affected documentation to change together.
The live-surface transport recommendation is source-grounded but has no
saturated-browser latency measurement; it is not a reproduced freeze.

Privacy renderers now preserve affirmative flags across duplicate entries and
use one supplied inventory throughout the output. Thirty tests pass; restoring
the old renderer caused 19 expected failures, and exact restoration returned
30 passes. The prose distinguishes declared classifications from verified
data flows and publication. Existing classification values were retained;
inventory completeness, legal/store review, and publication remain separate
unfinished work, explicitly visible in the generated policy.

Source snapshot review also caught symlink escapes, encoded Windows path
separators, and conflicting footnote IDs. Confined reads and corrected IDs
passed independent refusal and restoration probes. These were defects in the
new, unpublished reader, not evidence of a released Station vulnerability.

## Foundation implemented in this tranche

- A local reader with ten concept branches and the current module catalog,
  full-library search, document outlines, local Markdown/code snapshots, and
  keyboard/deep-link navigation. Its generated inventory lists every tracked
  Markdown file and reports current counts at build time.
- The same canonical manual and architecture sections compile into static
  MCP topics. Existing IDs remain; parent filtering exposes the tree. Payloads
  carry source locations and a documentation digest. Runtime retrieval remains
  credential-free and has no filesystem/network access.
- Server builds reject stale generated MCP content. Documentation tests reject
  omitted/duplicate module assignments, missing reading sources, stale compiled
  prose, invalid navigation, and lost headings. Browser tests exercise the
  actual reader and diagram rendering.
- Source-reference coverage now includes user guides, all tracked READMEs,
  agent instructions, and repository skills. The broader scope caught two
  moved route references and a malformed citation in the meeting-notes README.
- Root agent guidance routes feature changes through the maintenance guide and
  audit skill. The initial proposal became the owner-approved required
  documentation evidence check described below.
- Initial comment cleanup retains security/history constraints. The streaming
  pipeline and documentation aggregate have identical emitted executable code
  before and after comment removal.

These were the initial changes. Later subsystem reviews, contextual comment
cleanup, examples, captures and source-delta reviews extend this foundation;
their evidence belongs to the corresponding document records.

### Code-health disposition

The foundation review found no introduced unused exports/types or duplication.
Two introduced complexity findings are retained as advisory: `validateCatalog`
and `compileStationDocs`. They validate a finite static input contract and
assemble one content snapshot; neither handles live Station state. The catch
tests cover missing/duplicate/unknown module assignments, missing source
sections, headings inside code fences, and divergence between canonical prose
and the actual shipped payload. A real stdio client also retrieved a generated
architecture topic from the compiled bundle without credentials.

Splitting the validation conditions solely to lower a function score would
relocate the same obligations. Revisit the boundaries when another consumer or
new catalog shape adds a separate responsibility. These findings do not certify
the prose's semantic accuracy; that comes from the separate claim reviews.

Later reader changes add three advisory findings: the local-link resolver,
rendered-link checker, and explicit-anchor visitor. Their branches distinguish
local evidence from external links, validate rendered IDs, and admit only the
restricted anchor syntax. Refusal probes cover source escapes and malformed
links; renderer tests cover headings, anchors, and footnotes. Keep these
responsibilities together while their inputs remain small and explicit.

The metric generator adds three advisories: declaration parsing, meter-owner
discovery, and confined output publication. They enforce a deliberately narrow
syntax and one write lifecycle. Forty-seven tests plus independent real-CLI
probes cover omitted/unsupported declarations, input/output symlinks, encoding,
and literal rendered metadata. The completed code-health delta gate found no
introduced dead code, duplicate blocks, or blocking finding. An earlier audit
timed out and was not counted as passing; the later materially changed delta
has its own completed result. No full branch-coverage claim follows from an
estimated complexity score.

## Veritas adoption

The [policy activation record](../../.veritas/init-plans/documentation-maintenance.md)
contains the exact additive configuration, a recorded-source drift catch,
restoration controls, costs, and the owner-approved activation.
The trial showed that default evidence alone only warns; required evidence
produces the intended blocking result. The owner approved activation on 2026-09-27.

The guidance is: when a feature changes a user journey or contract, name its
documentation owner, update affected diagrams/READMEs/examples, or give a
specific source-backed reason no documentation changed. Route that guidance
through the existing `gate:for` and Veritas path-guidance mechanism, with the
audit skill as the workflow and the maintenance guide as the content contract.

Start new policy at Guide. Candidate deterministic evidence should check
catalog coverage, referenced paths and symbols where parsing is reliable,
generated-reference drift, executable examples, and affected-path disposition.
A reviewer still judges whether the explanation is accurate and sufficient.
Requiring a Markdown diff does not establish any of those properties.

Before promoting a check to Require, retain a representative stale-doc or
deleted-source catch, a legitimate no-documentation-impact control, a historical
record control, and measured cost. Use the existing
[promotion workflow](../strategy/veritas/proof-family-promotion-workflow.md)
and [Protected Standards authority](../../.veritas/GOVERNANCE.md). Do not mint
human authority, duplicate Veritas's evaluator, or weaken existing checks.

## Completion ledger

- Reviewed: all tracked Markdown dispositions, current documented claims and
  canonical reading routes, module interfaces, diagrams, affected comments,
  READMEs and examples. The generated library owns the current inventory and
  module counts. Each record retains its own evidence limits.
- Implemented: shared reader/MCP generation, source-impact and catch-up reports,
  an audit skill, source-bound screenshots and short clips, and the required
  Veritas documentation check. Proposed product improvements live in linked GitHub issues.
- Verification: at `d2cf36b34`, `ci:fast` passed on macOS and `verify:static`
  passed on an isolated Linux worktree with Node 24.18.0. The Linux run needed
  the CI-pinned actionlint and matching ShellCheck installed first. Earlier
  queue timeouts and failed prerequisite/type checks remain separate receipts.
  Later proposal-only edits need their own documentation checks; these local
  results do not represent hosted regression, deployment or physical-device proof.
- Separate owner work: Knowledge Kit publication,
  privacy inventory completeness and legal/store approval. The audit does not
  establish live provider behavior, physical-platform results, hosted deployment,
  every possible code path, or the absence of further defects.

Completion requires resolving or explicitly accepting every finding and giving
every file and review unit a final disposition. A green docs gate is supporting
evidence, not a substitute for that ledger.
