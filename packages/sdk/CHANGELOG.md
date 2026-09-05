# @kontourai/station-sdk

## 0.8.0

### Patch Changes

- Updated dependencies [4aca094]
- Updated dependencies [f6f9497]
- Updated dependencies [d209461]
- Updated dependencies [ce6ec59]
  - @kontourai/station-contracts@0.8.0
  - @kontourai/station-shared@0.8.0

## 0.7.0

### Minor Changes

- 1fc735a: Publish the Surface 3 answer-assessment v2 binding, protected assessment update
  notifications, and Basis pane integration as the Station public contract.
- 5cb0aaa: Add the public exact-answer retained-narrative producer binding contract and client.
- 3f6b3c2: Publish Whole Task Basis collection v4 and portable MCP page v3. The new
  mandatory retained Process stream carries kept Flow gate-evaluation projections
  independently of answers and never supplies Task aggregate standing.

### Patch Changes

- Updated dependencies [1fc735a]
- Updated dependencies [5cb0aaa]
- Updated dependencies [3f6b3c2]
  - @kontourai/station-contracts@0.7.0

## 0.6.0

### Minor Changes

- a04a5f1: Add exact, authority-scoped tool-result inspection and identity-only Keep actions
  to Basis. Whole Task collections use v3 and portable MCP pages use v2 with an
  independently bounded kept-result stream. Connect exposes non-secret activation
  epochs; SDK invocations and response bodies reject replaced read authorities.
  Execution results remain separate from semantic answer support.
- d926a67: Expose exact authorized terminal tool-result reads and identity-only Task Keep
  operations through typed clients and CLI commands. Protected reads validate
  Thread projections, withhold stale content, and preserve generic failure states.

### Patch Changes

- 214eb24: Add typed execution-client methods for reserving, reading, and cancelling conversation context boundaries.
- 8680665: Expose scheduler monitor configuration through the typed scheduler client.
- f37bdbb: Expose versioned conversation intent summaries through the chat runtime SDK.
- 0704b6b: Add portable attachment staging client operations for capability, preparation, upload, reconciliation, and cancellation.
- 6905e5f: Add explicit-apiBase and React query access to the read-only usage rollup.
- Updated dependencies [6456e42]
- Updated dependencies [a04a5f1]
- Updated dependencies [4dfc08a]
- Updated dependencies [214eb24]
- Updated dependencies [8680665]
- Updated dependencies [f37bdbb]
- Updated dependencies [3be50bb]
- Updated dependencies [0704b6b]
- Updated dependencies [3af06aa]
- Updated dependencies [6905e5f]
  - @kontourai/station-contracts@0.6.0

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

### Patch Changes

- 9d85cd8: Add a portable, typed plugin collection fetcher shared by SDK hooks, the Station CLI, and station-control MCP.
- 426d121: Delegation creation now projects only authored prompt, target, and optional
  parent-task input. Conversation and session handles remain server-produced
  response identities.
- Updated dependencies [fd9a422]
- Updated dependencies [051d372]
- Updated dependencies [62c5c0d]
- Updated dependencies [278bf3b]
  - @kontourai/station-contracts@0.5.0
