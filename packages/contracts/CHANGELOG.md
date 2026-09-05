# @kontourai/station-contracts

## 0.8.0

### Minor Changes

- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.

## 0.7.0

### Minor Changes

- 1fc735a: Publish the Surface 3 answer-assessment v2 binding, protected assessment update
  notifications, and Basis pane integration as the Station public contract.
- 5cb0aaa: Add the public exact-answer retained-narrative producer binding contract and client.
- 3f6b3c2: Publish Whole Task Basis collection v4 and portable MCP page v3. The new
  mandatory retained Process stream carries kept Flow gate-evaluation projections
  independently of answers and never supplies Task aggregate standing.

## 0.6.0

### Minor Changes

- a04a5f1: Add exact, authority-scoped tool-result inspection and identity-only Keep actions
  to Basis. Whole Task collections use v3 and portable MCP pages use v2 with an
  independently bounded kept-result stream. Connect exposes non-secret activation
  epochs; SDK invocations and response bodies reject replaced read authorities.
  Execution results remain separate from semantic answer support.

### Patch Changes

- 6456e42: Add the bounded tool-output truncation receipt to canonical runtime events.
- 4dfc08a: Expose optional conversation cache-read and cache-write token measurements. Omitted fields remain unreported rather than becoming zero.
- 214eb24: Add the durable conversation context-boundary contract with bounded provenance projection.
- 8680665: Add the public external-monitor configuration, observation, decision, and bounded accounting contracts.
- f37bdbb: Add the versioned conversation intent-summary contract for derived re-entry aids.
- 3be50bb: Add server-selected Repo Map review selection and durable NOT_VERIFIED review availability status.
- 0704b6b: Add byte-free attachment staging capability, reference, receipt, and reconnect status contracts.
- 3af06aa: Add bounded, versioned whole-task Basis MCP page contracts.
- 6905e5f: Publish read-only usage receipt, pricing snapshot, coverage, and rollup contracts.

## 0.5.0

### Minor Changes

- fd9a422: Use behavior-specific names for pre-release contracts.
  
  - Runtime model catalogs now expose `source: 'built-in'` and `builtInModels`.
  - A model launch with no capability declaration records
    `evidence: 'capability-absent'`.
  - The built-in policy guard records `engine: 'typescript'`.
  - Device-setting definitions use `priorStorageKey` and `priorRead` for values
    imported from pre-unification browser storage.
  - Composed voice roles use `secondary`, and the provider-composition adapter is
    exported as `ProviderVoiceSessionAdapter` /
    `createProviderVoiceSessionAdapter`.
  - Knowledge import helpers are named `migratePreIndexKnowledge` and
    `useMigratePreIndexKnowledgeMutation`.
  - The synthesized local-only project resource helper is named
    `localProjectResourceId`.
  
  Update pre-release callers and fixtures directly; removed identifiers and
  serialized values are not read as aliases. Development homes with stored
  session events using the removed model-plan or policy-engine values should be
  recreated before reuse. The project resource observation record is now version
  2 with a `baseline` dimension; remove `project-resource-shadow.json` from a
  development home to begin a new observation record when upgrading from version
  1.
- 051d372: Document the Station-local Datum secret-binding contract: binding metadata is
  not portable, and clients must treat environment hints as credential-free.
- 62c5c0d: `ResourceResolutionResult` becomes a discriminated union that carries the
  observations each state was derived from (station#1594). **Source-breaking for
  TypeScript consumers**, deliberately: the restructure is the migration story.
  
  Before, the type was one flat interface with optional `path` and `reason`, so
  the resolver reported a derived label and discarded the two facts it derived it
  from — whether anything *declares* a realization of the resource, and what was
  *observed* at the declared place. Two defects followed from that, and this
  change closes both:
  
  - **`unbound` meant two opposite things.** "Nothing on this Station records a
    realization" and "the recorded directory is gone" were the same state, with
    the difference living only in the prose of `reason`. The session-cwd seam owes
    those opposite behaviour (terminate at `$HOME` vs fail closed naming the
    project and the path), so no mapping from the state alone could serve both.
    `unbound` now means exactly the first; the second is `missing`, which widens
    to cover a declared-but-gone `workingDirectory` — the compat-era binding —
    alongside a binding row, and carries `record: 'binding' | 'working-directory'`
    plus `declaredPath`.
  - **`stale` and `drifted` refused to state a path they had already observed.**
    Both are only ever emitted *after* an existence check has passed, so the
    resolver held a real directory and the contract forbade it from saying so.
    They now carry a required `unverifiedPath`.
  
  `path` stays the answer slot — present on `bound` and nowhere else, unchanged.
  `unverifiedPath` is a separately named observation slot whose name is the
  warning; a consumer asking "where is the verified checkout of resource X" reads
  `path`, and one asking the weaker "where is this project's realized directory"
  reads `path ?? unverifiedPath`.
  
  Also exported: `ResourceRealizationRecord`. `isWellFormedResolution` now takes
  `unknown` and narrows — with the union in place, an in-repo TypeScript producer
  of a malformed shape is already a compile error, so what remains for the
  predicate is exactly what it is for: values that arrive without a compiler.
  
  **Migration:** every producer must supply the per-state required fields, and any
  consumer reading `.path` without narrowing to `bound` is now a compile error.
  Both are intended. The contract is marked `@experimental` until the remaining
  consumer seams migrate onto it — the vocabulary has changed twice in three
  slices.
- 278bf3b: Both Review Queue read projections are now total over the project inventory,
  and both changed their published return type to say so.
  
  - `listAllReviewReceipts` / `fetchIndependentReviewReceipts` /
    `useReviewEvidenceQuery` resolve to `ReviewEvidenceAggregate`
    (`{ receipts, unavailableProjects }`) instead of
    `IndependentReviewReceipt[]`. `ReviewEvidenceAggregate`,
    `ReviewEvidenceUnavailableProject`, `REVIEW_EVIDENCE_UNAVAILABLE_REASONS`
    and `parseReviewEvidenceAggregate` are new contracts exports.
  - `fetchSurveyFlowReviews` / `useSurveyFlowReviewsQuery` resolve to
    `SurveyFlowReviewsVM` (`{ items, unavailableProjects }`) instead of
    `SurveyFlowReviewItemVM[]`, with `SurveyFlowReviewUnavailableReason` naming
    the derived reason a project could not be read.
  
  A project Station cannot read contributes zero rows plus one
  `unavailableProjects` entry carrying its reason, rather than failing the whole
  read — one corrupt file used to 500 an entire Review Queue source.
  
  Callers destructure the collection instead of consuming the array directly;
  this is a breaking export change, expressed as a minor while these packages are
  pre-1.0. The survey fetcher's compat adapter covers the old-server /
  new-client direction only — it accepts a bare item array from a Station that
  predates the aggregate. It does nothing for an old client reading a new
  server, which needs this release.
