# @kontourai/station-sdk

## 0.8.0

### Minor Changes

- d326e74: Add the React-free `@kontourai/station-sdk/agent` authoring and execution entry point, reusing canonical Station client operations. Keep plug-in UI on existing exports and document how a plug-in distributes an Agent that headless callers can execute.
- 4f19d35: Add a Device-bound, proof-of-possession account-session continuation for virtual
  transports. Keep provider sessions server-owned, enforce current revocation and
  response delivery, and preserve independent Device credentials on account refusal.
- 3ab0959: Let a client check for and apply an update to a Station installed from a
  prebuilt release archive. The update status reports the `archive` and
  `archive-service` install kinds with the running and newest verified release,
  and a launcher-run service's update progress (`ServiceUpdateProgress`), read
  with `requestServiceUpdateProgress` or `useServiceUpdateProgressQuery`. The
  shared package adds `prebuilt-archive` and `service-launcher-protocol`
  subpaths for the archive and service-launcher facts the CLI and server share.
- b6dcb8c: Add optional durable authority identities to Project query and reorder cache keys,
  and captured-origin startup reads with guarded cache seeding. Live request
  authority remains separate from persistent data identity.
- 058376c: Expose exact input-request reply context and a guarded foreground reply constraint. Reuse scoped attachment staging for file and image answers.
- e4d61c8: Expose monitoring event windows with explicit truncation, retain the existing array API, and reject malformed history responses. Avoid opening the live stream when querying all history.
- f654ac1: Breaking: `BrandingData.theme` is now typed `unknown` instead of `Record<string, string>`.
  The value is the branding provider's white-label overrides exactly as served
  (by convention flat `--k-*` keys for both modes plus per-mode `dark` / `light`
  objects), and nothing between the provider and the caller validates it, so a
  consumer must parse it before use. `fetchBranding` (and `useBrandingQuery`) now
  reject a non-2xx or `success: false` answer instead of resolving it as "no
  branding".
- 519f361: Extend chat contracts and SDK clients with bounded file and conversation references, streamed delivery metadata, tool-purpose projections, and owner-bound workspace checkpoint preview/restore. Add the corresponding CLI checkpoint commands and shared runtime projection fields while preserving existing event and authorization boundaries.
- b8417e5: Add bounded newest-first conversation history hydration and recover complete terminal text from a retained suffix. Expose full saved Station addresses and host-owned native profile editing without forwarding credentials to a changed origin.
- 7ef36cc: Add enrolled cloud target verification with stable boot observation, redirect refusal, bounded responses and no execution authority transfer.
- a8bbc67: Add exact Conversation pull-request links and provider-observed revision fields.
- 31278d5: Add the opt-in portable delegation attempt correlation: `DelegateTaskInput.attemptId` plus the authorized exact-attempt lookup (`lookupDelegationAttempt` / `DelegationAttemptView`). The view carries the claim state, the reserved receiver task reference for every known claim, and the exact initial turn id when accepted, so a lost acknowledgement resolves to that task and turn without re-POSTing. Never a prompt, path, digest, transcript, or provider output.
- e1af43c: A recorded approval decision is now reported apart from whether the engine
  acknowledged it (#2880). Contracts: `request.resolved` gains an optional
  `acknowledgement` (`engine`, `in-process` or `none`), and a new
  `request.delivery` event (`acknowledged` or `unacknowledged`, with
  `reason: 'no-acknowledgement' | 'invalid-reply'`) joins
  `CanonicalRuntimeEvent`. SDK: `DelegatedTaskSnapshot` gains `lastDecision`
  and `earlierUnacknowledgedDecisions` (`DelegatedTaskDecision`), whose
  `delivery` is `awaiting-acknowledgement`, `acknowledged`, `unacknowledged`,
  `in-process`, `closed-by-engine` or `not-reported`. Both unions are new
  values for existing consumers: an exhaustive `switch` over
  `CanonicalRuntimeEvent['method']` or over `delivery` needs a case (or a
  default) for them. CLI: `station delegate status` prints one line per
  decision, including earlier unacknowledged ones and requests the engine
  closed before Station answered.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.

  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- c5a4cf2: Add captured-actor preconditions for Project access mutations and an explicit,
  operator-approved collaborator-management Device scope choice. Invited admins
  can manage people and invitation links without receiving terminal access.
- c3474f5: Expose optional operator-configured browser identity choices alongside Station
  local accounts, with verified OIDC callbacks and independent account sessions.
- eb1fd17: Add host-neutral mobile device inventory and single-frame capture contracts, with an authenticated SDK subpath that validates the selected target. Honor optional response byte ceilings for JSON POST responses as well as GET requests.
- fa6338a: Delegated turn supervision can now be idle-only. `DelegatedTaskTurnSupervision.deadlineAt`, `remainingMs` and `totalLimitMs` (SDK) and `TurnSupervisionFacts.deadlineAt`/`totalLimitMs` (contracts) are optional and present together only when a total turn budget was declared; Muse declares none by default. Consumers that read them as always-present numbers must handle their absence. Contracts also add `MUSE_TURN_IDLE_TIMEOUT_CODE`/`MUSE_TURN_TOTAL_TIMEOUT_CODE` and widen the `tool.completed` status documentation (`unresolved` at a one-turn engine's turn end, engine-reported `cancelled`).
- 5570767: Muse turns no longer have a default idle bound (#2269). `TurnSupervisionFacts.idleLimitMs` (contracts) and `DelegatedTaskTurnSupervision.idleLimitMs` (SDK) are now optional and present only when an idle bound was declared for the turn; a Muse turn with no declared bound publishes a declaration with neither `idleLimitMs` nor a total budget. Consumers that read `idleLimitMs` as an always-present number must handle its absence. `station delegate status` prints "Idle limit: none declared for this turn" for such a turn.
- 0a73a73: `observePluginTreeAsync` can also report, from the same walk, the digest of a
  tree with some named entries left out. `PluginInstallConsent` gains an optional
  `gitMetadata: 'excluded'`, echoing a preview that staged the source without its
  git metadata so the install stages it the same way.
- a777b37: Add typed portable Project identity snapshots and explicit receiver-local associations, with SDK methods to read, prepare and attach an identity. Reject incompatible responses and preserve the requested association through asynchronous work.

  Attachment publishes a new local Project and its imported identity together without changing existing Project history, copying paths into shared identity, or granting membership or execution authority.
- 272c29b: Carry an optional repository-relative execution root in portable Project identities.
- 4d38391: Add scoped Project membership and invitation administration, built-in local
  username account entry and operator account/session recovery controls. Keep
  account authentication, Project membership and device/compute grants independent.
- e5dfb04: Add an authenticated SDK and CLI workflow for setting or clearing portable Project execution roots.
- 3a64f5f: Expose portable Project identity export/preparation and explicit destination
  attachment through the CLI, reusing the public identity SDK and receiver validation.
- eb6363d: Add `useProjectIdentityQuery(slug, config)` — the scoped React read for a
  Project's portable identity (#480). It follows the `useProjectQuery` scope
  contract (cache key carries API base, authority key and slug; a missing
  scope fails closed), consuming the `project-identity` subpath through the
  caller's captured request scope. Callers that know the selected local
  Project record can pass `expectedProjectId`: it joins the cache key and
  validates the response's `association.localProjectId`, so a same-slug
  delete/recreate or stale server answer never delivers the previous
  incarnation's portable identity as success (typed
  `ProjectIdentityIncarnationMismatchError`, recoverable by refetch).
  Only a 404 carrying the
  `project_identity_not_prepared` wire code is a verified not-prepared
  Project — see `projectIdentityReadFailure` / `isProjectIdentityNotPrepared`;
  a 404 without that code (older server, proxy, removed Project), denial,
  transport and malformed responses stay errors and never read as absence.
  `StationHttpError` now preserves the envelope's machine `code` for
  status+code branching (never message-text sniffing).

  `useDelegateOrchestrationTaskMutation` keeps its published call shape — a
  plain `DelegateTaskInput` resolved against the hook's `apiBase` default and
  ambient authority, unchanged for existing consumers — and additionally
  accepts a per-invocation `{ input, apiBase?, requestScope? }` envelope: the
  captured Home address and authority scalars travel through the transport's
  authority guards and the public request body stays exactly
  `DelegateTaskInput` — a Home or credential rotation across the awaits
  refuses instead of dispatching the old intent under new credentials, and
  late hook-option changes cannot redirect an in-flight dispatch.
  `delegateOrchestrationTask` accepts an optional `ClientRequestOptions`
  second parameter.

  Scope note (#480): the supported Project-placement path is the portable
  DELEGATION intent (`project-portable`) dispatched by the delegation
  launcher, where the receiving Station verifies the offer on submit. The
  FOREGROUND thread-execution path has no portable identity or receiver
  admission in this slice: a non-portable Project workspace resolved onto a
  paired Station is refused (`receiver_execution_not_offered`, zero remote
  effect) rather than silently run as an unrelated same-slug Project, and
  the thread-default environment picker no longer offers new paired
  Station selections while preserving an already-saved paired default.
  Full portable foreground identity/admission remains the next #480/#484
  slice.
- 6e9c63e: Add review-bound operator controls for publishing and revoking shared Tasks with
  exact Project, Task, share, and request-authority identity.
- f287e75: Add a narrow branch-mergeability read for conflict indicators (#2937). `@kontourai/station-contracts/pull-request-provider` exports `PullRequestBranchMergeability` and an optional `IPullRequestProvider.listOpenPullRequestMergeability`. The SDK exports `usePullRequestMergeabilityQuery` and `pullRequestMergeabilityQueryKey`, keyed by project and repository rather than session, and re-exports the `PullRequestBranchMergeability` type. `QueryConfig` gains an optional `refetchOnWindowFocus` so a slowly polled read can refresh a stale answer when the window returns.
- 44c019b: Add bounded pull-request review snapshots, exact-head review outcomes, and a scoped review client. Merge inputs may carry the reviewed head SHA as a provider precondition.
- a30cab6: Allow `fetchSSE` callers to seed the first request's `Last-Event-ID` when replacing an event-stream transport.
- c00ee0c: Allow Project list and detail queries to bind their cache and HTTP reads to an
  explicit Station request authority while preserving deliberate legacy callers.
- 3f13fff: The conversation and orchestration fetchers now throw `StationHttpError` for
  every refused request, keeping the observed status, the envelope's `code`
  (for example a station-control authority refusal), `details` and
  `Retry-After`, with a field-qualified message for a validation refusal. A
  `200` answer carrying `{ success: false }` used to throw a plain `Error`; it
  now throws a `StationHttpError` whose status is `200`, the same rule as
  `readEnvelopeOrThrow`. A body that is not JSON still keeps its status on a
  non-2xx and is still a plain `Error` on a 2xx. `respondToRequest`'s error
  still carries the failure `receipt`.
- ad9b31f: `StationHttpError` gains `details`, the refused envelope's `details` as sent.
  `readEnvelopeOrThrow` now throws `StationHttpError` for a refused envelope,
  carrying the observed status (a `200` with `success: false` too), the
  envelope's `code` (top-level, else the object `error`'s own), `details` and
  `Retry-After`, instead of a plain `Error`. `apiErrorMessage`,
  `envelopeErrorMessage` and `readEnvelopeOrThrow` share one message rule:
  validation details, a string `error`, the object `error`'s `message` then
  `code`, the top-level `message`, then the fallback. An object `error` now
  reads as its message or code rather than as serialized JSON.

  A thrown `StationHttpError`'s message names each field of a validation
  refusal — `Validation failed: command Required, name Required` — matching the
  CLI. New `envelopeReasons(details)` and `envelopeDetailsMessage(details)` on
  `@kontourai/station-sdk/client` return, respectively, the reason sentences
  for display (no field keys, each once) and the field-qualified part the CLI
  prints. `apiErrorMessage` returns the reason sentences alone, now deduplicated, and
  `envelopeErrorMessage`, which ignored `details` before, now does the same.
  `envelopeErrorCode`, and so every Project fetcher's `StationHttpError.code`,
  now falls back to the object `error`'s own `code`: a runtime 401 or 403 now
  carries `authentication_required` or `insufficient_scope` where it used to
  carry no code. `envelopeFailureMessage` is deprecated in favour of
  `envelopeError` and `apiErrorMessage`.
- 99b495b: The Agent, execution, Task output and Task room fetchers now keep what Station
  answered when it refuses a request: the observed status, the envelope's
  `code`, `details` and `Retry-After`, with a message that names each field of
  a validation refusal (`Validation failed: name Required`). A failure whose
  body is not JSON (a proxy's HTML 502) keeps its status instead of throwing a
  bare `SyntaxError`; an unreadable 2xx is still a plain `Error`.

  - The Agent fetchers (`getAgent`, `fetchAgentCatalog`, `createAgentDetailed`,
    `createAgentRaw`, `materializeEngineAgent`, `updateAgentRaw`,
    `deleteAgentRaw`) throw `StationHttpError`. A `200` carrying
    `{ success: false }` now has status `200`.
  - `ChatHttpError` now extends `StationHttpError`, so it carries `details` and
    `retryAfterMs` too, and a `catch` that tests `instanceof StationHttpError`
    first now also matches it. It gains a constructor that takes the
    `StationHttpError` the client built and whether the body was Station's
    own answer; `(status, serverMessage, code)` still works, with an optional
    fourth `stationEnvelope` argument (default `true`). The new
    `stationEnvelope` field is `false` when the body was not Station's answer —
    a proxy's HTML page, or JSON that is not an envelope — so a caller can
    keep such a failure retryable instead of treating it as a definitive
    refusal. `ForegroundMessageIndeterminateError` likewise gains a
    `(failure, detail)` form beside `(status, message, detail)`.
  - `ProjectTaskRoomProtocolError` gains optional `status`, `code`, `details`
    and `retryAfterMs`, set only when Station refused the request.
  - The protected reads stay opaque. `TaskToolResultRequestError`,
    `TaskUserInputReferenceRequestError`, `TaskBasisRequestError`,
    `SessionOutputsRequestError` and `SessionInventoryRequestError` keep their
    generic message and add the refusal's `code` and `retryAfterMs`; their
    constructors also accept the `StationHttpError` the client built.
    `getInputReplyContext`'s error keeps its generic message and adds `code`
    and `retryAfterMs`. None of them carries the route's words or `details`.
- 603aa4c: The Project fetchers (everything built on `unwrapProjectResponse`) and the
  plugin fetchers (`listPlugins`, `previewPluginRecovery`, `recoverPlugin`) now
  throw the envelope helper's `StationHttpError` for a refused request, keeping
  the observed status, `code`, `details` and `Retry-After`, with a message that
  names each field of a validation refusal
  (`Validation failed: name String must contain at least 1 character(s)`). A
  `200` carrying `{ success: false }` now throws a `StationHttpError` whose
  status is `200` instead of a plain `Error`; a body that is not JSON keeps its
  status on a non-2xx and is still a plain `Error` on a 2xx.

  **Breaking (constructor only).** `PluginCollectionHttpError`'s constructor now
  takes the `StationHttpError` the client built from the response, and an
  optional `{ grantsUnavailable }`, in place of `(status, envelope, options)`:
  `new PluginCollectionHttpError(new StationHttpError(status, message, { code }))`.
  Its `envelope` is derived from that error. A refused collection read now
  carries `retryAfterMs` whenever the response sent a delta-seconds
  `Retry-After` (Station's runtime sends one with every `429`). Code that only
  catches the error is unaffected.
- 8645b7f: The scheduler, skills, knowledge and secret-binding fetchers now throw
  `StationHttpError` for a refused request, keeping the observed status, the
  envelope's `code` (for example a station-control authority refusal such as
  `station_control_caller_required`), `details` and `Retry-After`. Their thrown
  message names each field of a validation refusal, as `readEnvelopeOrThrow`'s
  does (`Validation failed: command Required`).

  **Breaking (constructors only).** `SchedulerResponseError`,
  `SchedulerRunIndeterminateError`, `SchedulerRunFailedError` and
  `SchedulerRunRefusedError` now extend `StationHttpError`, and their
  constructors take the `StationHttpError` the client built from the response
  in place of a status and message:

  - `new SchedulerResponseError(status, message, detail)` becomes
    `new SchedulerResponseError(new StationHttpError(status, message), detail)`.
  - `new SchedulerRunFailedError(message, receipt)` (and the refused and
    indeterminate forms) becomes
    `new SchedulerRunFailedError(new StationHttpError(status, message), receipt)`.

  Code that only catches these errors is unaffected, and a run error's `code`
  is still its own fixed value. The SDK throws these errors itself; nothing in
  Station constructs them outside the SDK.

  `PluginCollectionHttpError` now extends `StationHttpError`. Its constructor
  keeps `(status, envelope)` and gains an optional third argument,
  `{ details }`. It carries the envelope's `code` on the error and on
  `envelope.code`, and keeps a refusal's `details`.

  The skills and secret-binding fetchers keep the status of a failure whose body
  is not JSON (a proxy's HTML 502) instead of throwing a bare `SyntaxError`.

  New `createLocalSkill` and `updateLocalSkill` fetchers back
  `useCreateLocalSkillMutation` and `useUpdateLocalSkillMutation`, which still
  resolve to the whole envelope.
- 797b975: Type the host context hooks and knowledge results (#2399, #2400).

  - `useAgents`, `useNavigation`, `useToast` and `useAuth` now return the
    published `AgentSummary[]`, `SDKNavigation`, `SDKToast` and `SDKAuthState`
    contracts instead of `any`. Code that read members outside a contract stops
    compiling. `SDKNavigation` does not expose these host navigation members:
    `updateParams`, `setAgent`, `setDockMode`, `collapseMaximizedDock`,
    `dockMode`, `selectedLayout`, `activeWorkspacePane` and `fontSize`.
  - `SDKContextValue`'s `agents`, `navigation`, `toast` and `auth` slots are
    typed by `SDKAgentsContext`, `SDKNavigationContext`, `SDKToastContext` and
    `SDKAuthContext`, so a host must satisfy them.
  - `showToast` accepts `(message, type?, duration?)` or a `ToastRequest` object,
    which now also takes `actions`.
  - The knowledge tree, document list, filtered list and namespace queries return
    `KnowledgeTreeNode`, `KnowledgeDocumentMeta[]` and
    `KnowledgeNamespaceConfig[]`; `KnowledgeTreeNode` and `KnowledgeSearchFilter`
    are exported. `AgentSummary` gains an optional `plugin`.
  - `useSendToChat` widens to accept a plugin-qualified `'<plugin>:<agent>'`
    reference as well as an `AgentId`; it sends only when the named plugin
    contributed that Agent. `AgentId` and `QualifiedPluginAgentId` are exported.
  - Fix: `useDockState` read a `dockState` field the host never provided, so
    `isOpen` was always false; it now reads `isDockOpen`.
  - `NavigationState` is deprecated in favour of `SDKNavigation`.
- 687d586: Add explicit account-bound Device approval and guest-only Project view contracts.
  Expose validated Project view APIs while keeping personal full-configuration APIs
  separate. Require deliberate operator approval mode selection in the pairing UI
  and CLI, and retain current account and Project membership as independent access
  requirements. This is a view-only pilot; shared execution and complete guest
  onboarding retain their separate delivery requirements.
- a2c21d7: Add explicit shared Task publication and bounded Project-member reads for Task
  summaries, human-message history, and text snapshots. Recheck current Device,
  account, Project, publication, and Task authority before releasing content.
- be60151: Expose a bounded, currently authorized answer quotation source with exact Session, turn, message and text-revision identity.
- 09bd7e6: Add applied registry-policy and untrusted package-claim contracts, explicit Node signing/digest leaves, and root/dependency trust-review transport. Keep signer fingerprints distinct from publisher identity and preserve offline retained recovery.

  Release the fixed contracts/shared/SDK group together. Shared and CLI dependency floors must include the contracts release containing the new public leaves; unreleased same-version candidate tarballs require an explicit override throughout the consumer graph and do not prove npm availability.

### Patch Changes

- 2dad041: Allow account-session reads to accept an abort signal so authority-sensitive
  guest views can cancel stale requests when the Station or signed-in account
  changes.
- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.

  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.

  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.
- d0ca944: Correct CLI help for supported option syntax, distribution boundaries, request
  deadlines, and checkpoint limitations. Update package documentation and examples
  to match current exports, hook signatures, build paths, and authorization limits.
  These documentation changes do not implement the separately tracked runtime fixes.
- ecfa545: Invalidate feedback guidelines and status after ratings are saved or removed, so clients refresh derived preferences and pending-analysis state.

  Preserve configured cache invalidations when a successful mutation's observer throws, while keeping that observer failure visible to its caller.
- 2ae242b: LayoutHeader: `canLaunchPrompts`. An optional prop a host sets to `false` when it has no prompt launcher; the header then renders no prompt action, global skill, tab prompt or quick-actions menu instead of rendering them wired to a no-op. `external` and `internal` actions still render. Absent keeps the previous behaviour.
- 15a2761: Surface classified provider-plan quota failures in delegate status and
  events (#2265). `DelegatedTaskReason`/`DelegatedTaskEvent` carry the
  serving Station's re-validated bounded facts (plan window,
  provider-reported timezone-less reset text, qualified retry-after only
  when genuinely supplied); `station delegate status` (and `wait`'s summary)
  renders them beneath the fixed guidance line. No retry, model/provider
  switch, or paid fallback is added — the task stays failed and resumable.
- 390ea80: Declare the Zod runtime dependency used by account authentication, local accounts, and project access clients so they resolve outside the Station workspace.
- 74c2f4f: A per-call request deadline that fires while a response body is being read, through `json()`, `text()`, `arrayBuffer()`, `blob()`, `formData()` or `bytes()`, now raises `StationRequestTimeoutError` with the same `method` and `mutation` facts as a deadline missed before the headers. `response.body` streams are not covered.

  Every SDK helper that unwraps a body passes that error on instead of reporting an unreadable or non-JSON body ("Orchestration API error: 200", "Request failed", "Expected JSON response"). This covers `readEnvelopeOrThrow`, `readJsonBody` and each client module's own unwrap, on both the 2xx and non-2xx branches, and every fallback written as `.catch(...)` on a chain that reads a body, including a body read inside a `.then(...)` callback on that chain. Before, a command whose headers had arrived, and whose change may have been applied, read as a plain failure.

  Where a call classifies failures into its own typed uncertainty, a mid-body deadline now gets the same classification as a deadline before the headers:

  - `adoptOrchestrationSession` throws `AdoptSessionError` with `failureClass: 'uncertain-no-response'` when the deadline fires after 2xx headers, so a continuation that may have been created is not read as a definite answer. After a refusal's headers it is `'certain-response'` with that status: Station did answer.
  - `launchContinueSessionStarter` throws `AdoptSessionError` with `failureClass: 'uncertain-no-response'` for a deadline before the headers or after 2xx headers. Before, both reached the caller as a raw `StationRequestTimeoutError`. After a refusal's headers it throws a plain error carrying the HTTP status.
  - `launchScheduledCheckStarter` throws `ScheduledCheckStarterResponseError`.
  - `resolveConversationOpen` fails with kind `'network'`.

  Helpers that wrap the whole request in a typed error of their own keep doing so for a mid-body deadline too. The answer basis, narrative binding, flow-gate evaluations, task basis and unified search helpers report it as their typed error with status 0, exactly as they report a deadline before the headers. For task basis this is a change: its inner body read used to report a mid-body deadline as a non-JSON answer with the response's status, and now reports it as status 0.

  The capability probes are unchanged: the attachment-staging probe reports `unknown`, the event-stream resume probe reports "not supported", and the session event-window probe reports "unknown", for a deadline as for any other failure.

  The deadline-bound response is still a `Response`: `response.constructor === Response` holds, and a body reader the runtime lacks is reported as absent.
- a4dfd04: Depends on `@kontourai/ui` `^1.16.0` (was `^1.12.0`), so the workspace resolves
  one version of the design kit. The SDK's own use of it (`Empty`) is unchanged.
- Updated dependencies [d326e74]
- Updated dependencies [4f19d35]
- Updated dependencies [3ab0959]
- Updated dependencies [74af29e]
- Updated dependencies [058376c]
- Updated dependencies [e172b3d]
- Updated dependencies [519f361]
- Updated dependencies [b8417e5]
- Updated dependencies [ae258f0]
- Updated dependencies [4aca094]
- Updated dependencies [7ef36cc]
- Updated dependencies [e4d61c8]
- Updated dependencies [8d785cf]
- Updated dependencies [32f4251]
- Updated dependencies [797b975]
- Updated dependencies [a8bbc67]
- Updated dependencies [31278d5]
- Updated dependencies [c3bf345]
- Updated dependencies [96290b2]
- Updated dependencies [d0ca944]
- Updated dependencies [e1af43c]
- Updated dependencies [debc0ee]
- Updated dependencies [f6f9497]
- Updated dependencies [5f54657]
- Updated dependencies [716480e]
- Updated dependencies [1344781]
- Updated dependencies [c3474f5]
- Updated dependencies [eb1fd17]
- Updated dependencies [ad2f0d3]
- Updated dependencies [fa6338a]
- Updated dependencies [5570767]
- Updated dependencies [84031dd]
- Updated dependencies [2f941ba]
- Updated dependencies [4e39225]
- Updated dependencies [0a73a73]
- Updated dependencies [d209461]
- Updated dependencies [984f9bc]
- Updated dependencies [a777b37]
- Updated dependencies [272c29b]
- Updated dependencies [17c17a1]
- Updated dependencies [ce6ec59]
- Updated dependencies [4d38391]
- Updated dependencies [e5dfb04]
- Updated dependencies [eb6363d]
- Updated dependencies [6e9c63e]
- Updated dependencies [f287e75]
- Updated dependencies [44c019b]
- Updated dependencies [9c5c353]
- Updated dependencies [b6331e9]
- Updated dependencies [687d586]
- Updated dependencies [a2c21d7]
- Updated dependencies [0d75052]
- Updated dependencies [9ccd6e4]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [a30cab6]
- Updated dependencies [be60151]
- Updated dependencies [a30cab6]
- Updated dependencies [09bd7e6]
- Updated dependencies [08370b2]
- Updated dependencies [ae8f5d4]
- Updated dependencies [ae8f5d4]
- Updated dependencies [0c3d60e]
  - @kontourai/station-shared@0.8.0
  - @kontourai/station-contracts@0.8.0

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
