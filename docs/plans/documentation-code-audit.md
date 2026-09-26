# Documentation and architecture audit

Status: in progress. Baseline: `ff2d743b4e45605d0a8500bd15ca4e1a86185ca6`
(2026-09-26). This is the execution ledger, not a completion receipt. GitHub
owns live delivery state; no deployment or comprehensive semantic audit is
implied by this plan.

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
5. **Reader acceptance.** Walk the atlas from a fresh reader's perspective,
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

## Foundation implemented in this tranche

- A local reader with ten concept branches, 65 current module sections,
  full-library search, document outlines, source links, and keyboard/deep-link
  navigation. Its inventory now includes 393 Markdown files.
- The same canonical manual and architecture sections compile into 91 static
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
  audit skill. Existing Protected Standards remain unchanged; a new Veritas
  requirement remains the proposal below.
- Initial comment cleanup retains security/history constraints. The streaming
  pipeline and documentation aggregate have identical emitted executable code
  before and after comment removal.

This is the foundation and initial correction tranche. It does not close the
repository-wide semantic audit or comment review.

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
the prose's semantic accuracy; that remains the program's open review work.

## Veritas adoption

Proposed guidance: when a feature changes a user journey or contract, name its
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

- CONFIRMED: baseline inventory, initial source traces and corrections, shared
  reader/MCP content generation, and the maintenance workflow.
- In progress: the remaining subsystem claim reviews, full comment review,
  and the Veritas policy proposal. Foundation verification receipts are reported
  separately from those open program requirements.
- NOT_VERIFIED: exhaustive semantic review of all 388 baseline files; all
  subsystem journeys and diagrams; repository-wide comment review; new Veritas
  enforcement; physical platforms, live providers, and hosted publication.

Completion requires resolving or explicitly accepting every finding and giving
every file and review unit a final disposition. A green docs gate is supporting
evidence, not a substitute for that ledger.
