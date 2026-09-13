# @kontourai/station-contracts

## 0.8.0

### Minor Changes

- 4f19d35: Add a Device-bound, proof-of-possession account-session continuation for virtual
  transports. Keep provider sessions server-owned, enforce current revocation and
  response delivery, and preserve independent Device credentials on account refusal.
- 058376c: Expose exact input-request reply context and a guarded foreground reply constraint. Reuse scoped attachment staging for file and image answers.
- e172b3d: Add private source-room write sealing and bind Task execution to its exact room before provider startup. Keep dispatch admission durable through external claims, startup and final association, and prevent uncertain session creation from being retried without reconciliation. Introduce the dedicated home-transfer grant; public cloud handoff and target activation remain unavailable.
- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 7ef36cc: Add enrolled cloud target verification with stable boot observation, redirect refusal, bounded responses and no execution authority transfer.
- 8d785cf: Add a versioned transport-only Station connection binding and maintained-JOSE
  signing/one-shot verification helpers. These proofs bind an independently
  approved signing key to one client challenge, enrollment generation, certificate
  pair and exact connection descriptions; they do not grant application access.
- a8bbc67: Add exact Conversation pull-request links and provider-observed revision fields.
- c3bf345: Publish the operator-installed deployment authentication factory, configuration,
  descriptor and session-verification contract. Keep verified person identity separate
  from device grants, Project membership and execution authority.
- 96290b2: Add the Device-local connection trust record and public-key validation helpers
  for independent approval, generation-checked rotation and retained revocation.
  These describe endpoint trust only and grant no account or Project access.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.
  
  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- eb1fd17: Add host-neutral mobile device inventory and single-frame capture contracts, with an authenticated SDK subpath that validates the selected target. Honor optional response byte ceilings for JSON POST responses as well as GET requests.
- 2f941ba: Add provider-neutral source identity and completed-turn continuation context. Declare native Codex continuation alongside Claude and expose source readiness reasons through the shared engine capability matrix.
- 4e39225: Add explicit operator-approved device binding to verified Tailscale person identity. Host pairing consent and the local access-approval CLI opt in without changing ordinary device grants, Project membership or wire scopes. Require server acknowledgment so older servers cannot silently approve device access as person binding.
- a777b37: Add typed portable Project identity snapshots and explicit receiver-local associations, with SDK methods to read, prepare and attach an identity. Reject incompatible responses and preserve the requested association through asynchronous work.
  
  Attachment publishes a new local Project and its imported identity together without changing existing Project history, copying paths into shared identity, or granting membership or execution authority.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- 4d38391: Add scoped Project membership and invitation administration, built-in local
  username account entry and operator account/session recovery controls. Keep
  account authentication, Project membership and device/compute grants independent.
- 44c019b: Add bounded pull-request review snapshots, exact-head review outcomes, and a scoped review client. Merge inputs may carry the reviewed head SHA as a provider precondition.
- 0d75052: Add the `project` skill origin, so a workspace-scoped skill is distinguishable from a machine-wide one. Both are writable roots and previously reported `user`, which left no reader able to name the difference. Command-claim precedence places `project` in the same tier as `user`, matching the order discovery already resolves a name collision by.
- 9ccd6e4: Add `Skill.writable` and `Skill.writeRefusal`, so a reader can tell whether Station will write a skill's own package instead of inferring it. The server already decided this and no read model carried the decision, which left the Skills editor offering a Save that the route answers 409 for. `source` and `origin` were the fields a client had to guess from and answer a different question: a registry install in a writable root is writable, and an install record stating `source: 'local'` says nothing about which root the package sits in.
  
  `writeRefusal.reason` is a code — `served-in-place`, `canonical-package`, `outside-writable-root`, `unresolvable-name`, `directory-name-mismatch`, `containment-unreadable` — because the remedies genuinely differ and a reader cannot tell them apart from prose: a plugin-served prompt has no registry entry to install; a name that cannot become a directory name needs a rename; a package whose directory is simply named something else is plainly the user's own, sitting in a root Station writes, so telling that reader Station does not own it would be a false explanation of a real refusal; and a package whose path cannot be read at all may be sitting in exactly the right root with a broken link, where "install it into your workspace" repairs nothing.
  
  `writeRefusal.detail` is Station's own sentence about WHAT is wrong, and it contains no author-controlled text at all: not the skill's name, not its path, not an exception message. Where the package sits travels separately in `writeRefusal.packageDirectory`, which is required: every refusal has one, because the rule answers writable outright when no package was discovered. That split is the point rather than a detail of phrasing — every segment of the path is author-controlled, a plugin names its own directories, and text spliced into Station's sentence is read as Station speaking. Surfaces must render `packageDirectory` as its own element, labelled as a path, and never inside `detail`.
  
  The rule holds for this refusal, not yet for every message about a refused write: the write path's own failure message still interpolates the name and two paths and is surfaced verbatim, which is pre-existing and tracked in #1681. An absent `writable` is not a grant — a reader with no decision must treat the package as read-only.
- be60151: Expose a bounded, currently authorized answer quotation source with exact Session, turn, message and text-revision identity.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.
  
  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.
  
  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.

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
