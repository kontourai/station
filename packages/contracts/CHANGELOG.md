# @kontourai/station-contracts

## 0.9.0

### Minor Changes

- 31cac46: `tool.started` and `tool.completed` carry an optional `toolKind`
  (`EngineToolKind`, the Agent Client Protocol `ToolKind` vocabulary) when the
  engine reported one, and the shared transcript projection copies it onto the
  tool part as `MessagePart.toolKind`. A tool part bound to a pending approval
  also carries `approvalToolName`, the tool name the request itself reported.
  `toolRequestGrantLabel` now reads "Allow for this session" when the request
  reported no tool name: what such a grant covers is decided per adapter or
  engine, so the label claims only the session scope.
- c2c67c2: Add optional Agent MCP composition and loading preferences, with exact per-server tool selections for external-engine delivery. Existing declarations retain their prior defaults.
  
  Expose the existing connection-quota contract through its public package subpath for CLI and shared consumer resolution.
- 7899c97: Add the `@kontourai/station-contracts/automation` subpath for Station
  Automations: GitHub poll and webhook sources with an API-safe projection that
  omits the webhook secret, source grants, exact-equality matchers, rules,
  episode policies, the closed `AutomationDeliveryOutcome` union,
  `AUTOMATION_EXECUTION_LIMITS`, `GITHUB_AUTOMATION_EVENT_ALLOWLIST` (initially
  `workflow_run` `completed`) and the `AUTOMATION_OPERATOR_SURFACE` parity table.
  Mutating operator verbs have no station-control MCP name, so an agent cannot
  create or widen its own triggers. The types are published ahead of any route,
  intake or dispatch that consumes them.
- 31cac46: Add `ATTACHMENT_INPUT_UNSUPPORTED_CODE` for a send refused because the engine
  cannot take its attachments, `ComposerImageSupport.caveat` for an attach-time
  note when image support is unconfirmed (with the `modelSupportVaries` input),
  and `TurnStartedEvent.steerInterruptedRun` for a steer delivered by stopping the
  running step. The runtime event projection now splits a turn at a steer.
- 300a272: A child-work settle now replaces usage that is still the child's last
  running-time figure. When the first terminal settle carries no usage (Claude
  Code's `task_updated`), the child keeps its last progress figure, marked with
  the new optional `ChildWorkItem.usageProvisional: true`, and the later settle
  that reports usage (its `task_notification`) replaces it. The flag stays until
  every field of the running figure has been replaced, so a duration-only settle
  does not make a running token count final. Usage a settle reported stays sticky
  against stale duplicates, and identity and result remain fill-only. A settle
  delta can carry `usageProvisional: true` to restate a running figure, and the
  new `childWorkSettleFromItem` turns a stored settled item back into such a
  settle, so history seeding and reconnect snapshots keep the flag.
- c95a288: A child-work usage field that a settle reported now stays sticky even while
  other fields are still running-time figures (#3337). The reducer records the
  still-running fields on a provisional item as the new optional
  `ChildWorkItem.usageRunningFields` (absent while provisional means every field
  is running), and `childWorkSettleFromItem` carries it on the settle delta, so a
  replay keeps the split. A stale duration-only settle no longer overwrites the
  duration an earlier settle reported.
- f98bffd: Clients now state their client API protocol in `X-Station-Client-Protocol`
  (`CLIENT_PROTOCOL_HEADER`, parsed by `readClientProtocolHeader`). A host
  refuses a protocol below its advertised `minClientProtocol` with HTTP 426
  `client_protocol_unsupported` and a malformed header with 400
  `client_protocol_invalid`; an absent header reads as protocol 1. The SDK
  request seam sends the header where no CORS preflight can refuse it
  (`@kontourai/station-shared/client-protocol`).
- 306ebf4: Add optional `clientInputId` to turn steering and an explicit indeterminate
  result so acknowledgement retries preserve one engine invocation. Add a
  per-device Return preference. Preserve nonterminal retry errors in the runtime
  transcript projection instead of treating them as failed turns.
- b406f8d: Add an optional project default Agent for new chats. A create or update request
  can explicitly clear it; stored project records retain only a selected Agent ID.
- b586e3c: Add exact native resume and same-binding return capabilities, conversation history
  attribution and continuity provenance, and the SDK readConversation client.
- fa8ac09: `TaskRecord` gains an optional `closeOnMerge` flag: a person's opt-in to move the Task to `done` once every pull request kept on it is merged at its provider. A pull request closed without merging does not complete the Task. The flag is set with `PUT /api/tasks/:taskId/close-on-merge` by a person, never by an agent tool. A Task closes only from a status that may reach `done` (never from todo, ready, triage or blocked), the check runs when an operate-tier viewer refreshes the Conversation's pull request links (nothing polls), and un-keeping an unmerged pull request lets the merged rest close it. Older Station builds refuse a Task store that carries the flag, so clear it before a rollback.
  
  The Station Control `declare_pull_request` tool lets an agent on any engine (Claude Code, Codex, ACP) declare a pull request it opened, in the exact identity shape the conversation link routes accept. It writes the same declared-output record Station's own engine writes with `declare_output`, in the caller's own session and running turn: it is held for as long as the turn runs and lands when the turn completes. It is dropped if the turn aborts, is interrupted or ends in an error, or if Station restarts before the turn completes. A person still keeps a declared pull request onto a Task.
- ee12b92: Add the `delegatedInputAnswers` Station capability flag. A Station that
  advertises it accepts an optional `expectedInputRequest` on
  `POST /api/orchestration/delegations/:taskId/continue` and delivers the
  follow-up only as the answer to that exact open input request, refusing with
  `input_request_changed` when it is gone or replaced. Senders must gate the
  field on the flag; an older Station would drop it and deliver an unbound turn.
  The delegated-task snapshot's `pendingRequest` gains optional `eventId`,
  `body` (the presented question text) and `callerCanRespond` (the serving
  Station's own check for the reading caller). The orchestration contract's
  `OrchestrationPeerPendingRequest` and the attention contract's
  `AttentionPeerRequestReference` carry the matching optional fields.
- 22171b1: Expose host memory and Station-process resource snapshots alongside CPU
  diagnostics, and allow developer log queries to opt into periodic refresh.
- fc181b4: Expose bounded allowance observation history and optional credential-profile activity filters. Older usage without an account observation remains unattributed.
- fc181b4: Expose optional provider account/credit metadata, actual quota window durations,
  model availability and a bounded response-shape audit. Preserve metadata when
  quota percentages are unavailable.
- a91c50d: Add strict engine-account, quota and login contracts and authority-scoped hooks.
  Engine activity queries can select a provider and local Station receipts while
  preserving coverage and separating reported costs from estimates.
- 3b001e5: Add minimal engine sign-in profile contracts and an authority-scoped profile query.
  Clients with an explicit engine sign-in grant can list existing profiles without
  reading credential-management metadata or manual enrolment commands.
- e7fb9b3: The File Preview's Changes view: one previewed file's diff against HEAD.
  `workspace-file-preview` gains `WorkspaceFileChanges` (`changed`, `unchanged`,
  `untracked`, `no-commits`, `not-a-repository`, `oversized` or `refused` with
  a reason), `WorkspaceFileChangesRequest` and
  `WORKSPACE_FILE_CHANGES_MAX_BYTES`. The SDK's `workspace-file-preview`
  subpath adds `readProjectWorkspaceFileChanges` (`POST
  /api/projects/:slug/file-preview/changes`, the preview's path and session
  rules), `useProjectWorkspaceFileChangesQuery`, which asks again after a `503
  repository-busy` answer when the server's `Retry-After` says to, and
  `isRepositoryBusyError`, which names that answer. The read runs on the
  Project's own repository through the same confined read as the coding diff;
  a repository that is being written answers busy, not a refusal.
- ee12b92: The workspace Home projection names one more field,
  `delegationEnvironmentKind`: whether a work item is this Station's record of a
  delegated task running on a paired Station. Home uses it to open such an item
  in Activity rather than as a local chat. Because the projection widened, an
  existing Home role grant no longer covers it, and Home shows its fallback
  until the grant is approved again.
- 9def13d: Add immutable-version human output reviews to ordered Task room history, with current-authority duplicate receipts and connection-bound SDK hooks. Room readers accept v2 and v3 records; the first review adopts v3 for that room and persistently fences older writers. Reviewer acceptance does not change Task or workflow status.
- c965c37: Add Station Knowledge to the built-in Station role alongside Control and Docs.
  Knowledge exposes scoped read/capture tools; platform index controls remain in Control.
- eee7f74: Expose source-qualified marketplace selections, persisted source management, provider catalog boundaries and SDK query/mutation hooks. Installed skills retain source and package digest provenance.
- 8396b7b: `ModelOptionCapabilities` gains an optional `imageInput`: whether the engine
  reports that a model accepts image input. Absent means the runtime did not
  say. Station fills it for OpenCode models from OpenCode's own model listing, so
  the chat composer can refuse an image for a model that cannot read one, and
  stop warning for a model that can.
- 91ec8af: Add `@kontourai/station-contracts/plugin-command-effect`: the wire shapes for admitting a plugin command effect, settling it from a browser document, and the withdrawal summary lifecycle responses carry, plus the registered `station.plugin-command.execution/v1` operational event type.
- 91ec8af: Validate plugin command declarations in both manifest formats and publish them in the installed-plugin inventory. A ready installation's record now carries `commands` and an opaque `installationGeneration` that a command request echoes back; install previews list each command as a `command` component. Declarations that fail validation are dropped and reported as `commandsRejected`; the plugin still loads.
- d3e3396: Expose optional pull-request context `pushTargetOwner` and branch mergeability `sourceOwner` so conflict indicators can distinguish forks with the same branch name.
- 84fb656: The pull-request review snapshot (`pull-request-provider`) gains two optional
  observations from the forge. `checks` is a `PullRequestChecksObservation`:
  `available` with `PullRequestCheck[]` (`name`, `state` of
  `PullRequestCheckState`, optional `group` and `url`) and `partial`, or
  `unavailable` with a reason; GitHub's check runs and commit statuses and
  GitLab's head pipeline are its sources, and a gh that cannot report the
  field answers `unavailable`. `reviewComments` is a
  `PullRequestReviewCommentsObservation`: `available` with
  `PullRequestReviewComment[]` (`id`, `author`, `body`, `createdAt`, `path`,
  `side` of `additions` or `deletions`, `subject` of `line` or `file`, `line`
  null once the forge no longer maps the comment or when the subject is the
  file, optional `inReplyTo` and `url`) and `partial`, or
  `unavailable` with a reason. Either field absent means the server did not
  observe it; neither is an empty list standing in for none. The existing
  `mergeability` on the pull request is what the review pane now states beside
  them.
- 3accc1b: Support explicit receiver-owned engine overrides while preserving the authored Agent profile. Retain execution binding and definition expectations in handoff and reopen projections, expose bounded capability compatibility, and include engine/model/options intent in durable task-room request identity.
- 1d17ddf: `@kontourai/station-contracts/session-attention` now also owns the session
  state fold the UI words its rows from: `orchestrationLifecycleLabel`,
  `sessionAttentionKind` and `SessionStateLabel` moved here from the UI (which
  re-exports them), plus `SESSION_STATUS_WORDS`, the status ladder's words, and
  `sessionLadderWord(session)`, the ladder's word for a session summary alone.
  
  Station Control gains two read-only tools for an agent working in a Project
  (station#3413). `list_project_activity` lists the Sessions in the caller's own
  Project (or the global space), newest activity first, with each Session's
  status word (the one the UI shows), whether a turn is running, last activity,
  engine and agent, and the worktree and branch Station recorded; a page is at
  most 50 Sessions and a larger limit is refused. `get_session_digest` summarizes
  one Session from recorded events only, with no model summarizing: its title,
  Project, engine, status and turn count, and per turn (newest first) the
  request's first line, how it ended, tool calls by name, files an engine
  reported editing, pull requests declared, and Sessions Station launched from it that started within its window. A turn that called tools none of which carried an engine tool kind (Claude Code and Codex report none) says `filesReported: false`, so a missing `files` there means unknown, not none. A
  page holds at most 25 turns and 8 KiB, and a cursor pages to older turns; more is
  refused. Both read as the calling Session's owner, and a caller that is not a
  bound operator sees only its own Project (or the global space): another
  Project's, another person's, another Station's and an unconfined Session read as
  not found. The list never widens for a bound operator: it is the caller's own
  Project for every caller. Only a digest does, for a bound operator, as
  `read_conversation` does. The list narrows to the caller's Project before it
  folds, so its cost follows that Project and not the Station.
  
  `read_conversation` gains `aroundMessageId`: pass a `search_sessions` hit's
  `messageId` to read the page that contains that message, with `prevCursor` and
  `nextCursor` to walk either way, under the same 50-message, 64 KB and 16 KB
  limits. A message id that is not in the conversation is refused with
  `conversation_read_anchor_not_found`. User messages now carry the stable id a
  search hit names (`<turn start event>:user`) instead of a positional `proj-<n>`.
- 35e8916: Add Project MCP tool defaults and an opt-out for automatic Knowledge tools when a registered Project store exists. Agent tool restrictions and approval policies remain authoritative.
- 301fc96: Add explicitly granted remote-access management, typed relay invitation controls, and bounded native account proof support for IAM-authorized access changes.
  
  Publish the native relay link codec through Shared, preserving the Connect compatibility export.
- 8e17752: `ConversationListItem.titleSource` gains `'agent'`: the provenance of a title a
  station-control agent set with the new `rename_session` tool (#176). An agent
  title is not a person's, so a UI replaces it without asking, as it does a
  `generated` one; a title with `titleSource: 'user'` is still never replaced by
  an agent.
  
  Station Control gains two tools. `search_sessions` searches the calling
  session owner's own transcripts through the unified search behind
  `POST /api/search` (session and message hits only, query of 2 to 256
  characters, refused outside that range) and, for every caller including a
  bound operator, sees only the transcripts of the person the calling session
  acts for. Its hits are message hits, mostly from
  native Claude and Codex session transcripts. `rename_session` renames a
  Station-stored conversation through its own route,
  `POST /api/conversations/:id/agent-title`, and refuses with `person_title` over
  a person's title (decided atomically with the write) and with
  `runtime_title_unsupported` for a native Claude or Codex conversation, whose
  title the runtime owns, so a search hit is usually not renameable. A title is
  refused, not truncated, when over 80 characters, empty, or containing control,
  line-separator or bidirectional-control characters (leading and trailing
  spaces are trimmed). `rename_session` reaches only a conversation the calling
  session's owner owns, except that a bound operator caller is not limited to one
  owner's conversations; a caller that is not bound also stays in its own
  session's Project scope.
- cf099c6: Add versioned Task room agent request records and clients, with explicit agent selection, incarnation checks, authority-bound reads, readiness checks, and stable retries after lost acknowledgements.
- 4bbc4ce: Station's own answers are identified by a response header instead of by body
  shape alone. `@kontourai/station-contracts/http` exports
  `STATION_ENVELOPE_HEADER` (`x-station-envelope`) and
  `STATION_ENVELOPE_HEADER_VALUE`; a current Station sends the header on every
  JSON response it writes itself and never on one relayed from another Station.
  `ChatHttpError.stationEnvelope` now requires the header from an origin that
  has sent it before, so gateway JSON in Station's shape is no longer read as
  Station's refusal. A Station that does not send the header is still read by
  shape.
- 21f4fbc: A `ChildWorkItem` can carry the subagent's own `model` (`{ id, source }`),
  reported by its engine: a Claude subagent's own reply, a Codex `spawnAgent`
  result, or a Codex child thread. When the engine reports none, the field is
  absent and the Agents pane shows "model not reported", never the parent's
  model. Codex's spawn model moved from `kindLabel` to `model`. A Claude
  subagent also carries a `transcript` reference, and the new
  `GET /api/orchestration/sessions/:threadId/child-work/:childId/transcript`
  route and `useChildWorkTranscriptQuery` hook serve its transcript read-only,
  paged by message (`ChildWorkTranscriptPage`).
- 8f66f37: Add optional versioned Task brief references and saved snapshots to room agent requests. The SDK negotiates support, sends only the selected reference and verifies its acknowledgement; retries preserve the original brief. Context-free callers retain the public v1 protocol.
- a097632: Claude Code and Codex usage-limit stops now carry the provider's reset time
  into connection recovery (`UsageLimitFailureDetails`), so a stop with a known
  reset becomes a `wait-until-reset` intent instead of a manual one. A new
  `usageLimitAutoResume` setting, off by default, decides whether Station sends
  the stopped turn again after the reset. The recovery projection gains
  `outcomeReason`, which says why a waiting resume was left to the user or
  retired: automatic resume off, a newer turn, an open request, or an ended
  Session.
- fac321f: Add host-observed installed visual Skill experience identity and inventory contracts,
  and export the shared inert definition reader used by author builds and runtime inventory.
  Inventory availability follows exact package admission and current Skill precedence;
  this does not authorize execution or render a guided workflow.
- fac321f: Add optional foreground Skill experience selection, immutable invocation and Session
  history contracts, authored entry and stage transitions, and a scoped Workspace
  Pane host for reading and answering canonical questions or staging continuation.
  Execution remains behind exact installed source and current Session admission.
- 6601a65: Add inert visual Skill experience declarations and a versioned authoring contract.
  Portable author builds validate referenced definitions and bundled Skill digests;
  installed experience execution and rendering use their separate plugin admission
  and canonical Session owners.

### Patch Changes

- bda5e88: Device settings gain `codingPanels`, the Coding layout's per-session panels
  (the tool beside Chat and its width, the Terminal's open state and height,
  the inbox as the reader left it beside a tool), with `CodingSessionPanels`,
  `CodingSessionPanelsRecord`, `CODING_PANELS_SESSION_BOUND` and
  `DEFAULT_CODING_PANELS_RECORD`. Additive: the registry gains one
  direct-manipulation key and no existing field changes.
- d4fbcaf: `CONVERSATION_HANDOFF_DISCLOSURE_LABELS.authorizedTranscript` now reads
  "Recent conversation messages, up to a size limit" (was "Conversation
  transcript"). An Agent/engine handoff, and a continuation that cannot resume a
  native cursor, now seed the new engine with the most recent whole messages under
  an estimated-token budget instead of the last 6,000 characters. The seed tells
  the engine how many earlier user and assistant text messages were left out, how
  many messages had no text to carry, and that the full conversation remains
  stored in Station.
- 1aecbf3: Reject malformed date/time template format options before configuration reaches
  prompt substitution. Settings, online/offline config writes, and persisted
  configuration reads use the same validation semantics.
- c6c7d4d: A request left open by an aborted turn is settled instead of staying pending.
  `@kontourai/station-shared/request-settlement` exports
  `requestIdsSettledByTurnAbort`, the fold the server and the CLI both apply.
  `station approvals list` and `station operate` no longer offer such a request,
  `approvals list` rows carry `requestEventId`, and `approvals respond` and
  `operate` bind a decision to the request event they showed. The contracts
  change is documentation of `request.opened.turnId` and of what a
  `request.resolved` with status `cancelled` or `expired` means.
- 2d235b6: Publish retained-source statistics and measurement coverage types, conservative observation allocation, and authority-scoped station operator usage queries. Keep unknown attribution and measurements explicit.
  
  Expose separate station-usage-query and usage-rollup-query entries so lazy usage views can avoid startup analytics coupling while preserving existing root exports.
- f75829f: A conversation that stopped on a provider usage limit now shows a banner above
  the composer: "Usage limit reached · Resets <local time>", or plain manual
  wording when the provider gave no reset. It offers Resume now, which starts
  sending the stopped turn again at once, and Cancel auto-resume while an
  automatic resume waits. With the setting off it says so, and Resume now is
  still offered, with a note that the limit may not have reset yet. A stop that
  settles (a newer message, an open request, an ended Session, Cancel, or a
  resume that failed) says why, briefly, and never offers a stale action. A
  resume the provider refuses again keeps the wait for the reset, when that reset
  is at least a minute away, up to three times in a row. The recovery projection gains the `user-canceled`
  reason, and Sessions gain
  `GET /api/orchestration/sessions/:threadId/usage-limit` plus person-owned
  `POST .../usage-limit/resume` and `.../usage-limit/cancel`.
- 112beed: Add optional durable source sequence to usage receipts. Reconcile sparse cumulative observations in source order and transfer deduplicated logical receipts within the aggregate bound.

## 0.8.0

### Minor Changes

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
- 74af29e: Export `AUTH_RATE_LIMITED_ERROR_CODE` from `@kontourai/station-contracts/http`, the code a Station answers with while it throttles repeated authentication failures, so servers and clients share one spelling.
- 058376c: Expose exact input-request reply context and a guarded foreground reply constraint. Reuse scoped attachment staging for file and image answers.
- e172b3d: Add private source-room write sealing and bind Task execution to its exact room before provider startup. Keep dispatch admission durable through external claims, startup and final association, and prevent uncertain session creation from being retried without reconciliation. Introduce the dedicated home-transfer grant; public cloud handoff and target activation remain unavailable.
- 519f361: Extend chat contracts and SDK clients with bounded file and conversation references, streamed delivery metadata, tool-purpose projections, and owner-bound workspace checkpoint preview/restore. Add the corresponding CLI checkpoint commands and shared runtime projection fields while preserving existing event and authorization boundaries.
- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 7ef36cc: Add enrolled cloud target verification with stable boot observation, redirect refusal, bounded responses and no execution authority transfer.
- 8d785cf: Add a versioned transport-only Station connection binding and maintained-JOSE
  signing/one-shot verification helpers. These proofs bind an independently
  approved signing key to one client challenge, enrollment generation, certificate
  pair and exact connection descriptions; they do not grant application access.
- 32f4251: Remove `formatMcpToolRef` from `@kontourai/station-contracts/layout` and `canInstallRegistryItem` and `canRemoveRegistryItem` from `@kontourai/station-contracts/registry-lifecycle`. No Station surface called them. `parseMcpToolRef`, `isValidMcpToolRef` and the registry lifecycle types are unchanged; a caller that formatted a ref should build `${serverId}/${toolName}` and check it with `isValidMcpToolRef`.
- 797b975: Add `parseQualifiedPluginAgentId` and the `QualifiedPluginAgentId` and
  `PluginAgentReference` types to `agent-identity` (#2400). The parser splits a
  `'<plugin>:<agent>'` reference at its last colon into the plugin name and a
  clean `AgentId`, and returns `undefined` when either half is not one.
- a8bbc67: Add exact Conversation pull-request links and provider-observed revision fields.
- 31278d5: Add the `delegationAttemptClaims` station capability flag for the opt-in portable delegation attempt-claim receiver slice: a build advertising it durably claims an accepted portable create under its verified delegation grant plus `attemptId` before any execution preparation, and answers the authorized exact-attempt lookup with a bounded closed projection. Callers must gate sending `attemptId` on this flag.
- c3bf345: Publish the operator-installed deployment authentication factory, configuration,
  descriptor and session-verification contract. Keep verified person identity separate
  from device grants, Project membership and execution authority.
- 96290b2: Add the Device-local connection trust record and public-key validation helpers
  for independent approval, generation-checked rotation and retained revocation.
  These describe endpoint trust only and grant no account or Project access.
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
- debc0ee: Add the `engine:login` pairing scope, which lets a device start an engine's own device-code sign-in on the Station host. It is granted only by operator promotion, never by a preset or the default grant, so older peers can still parse every scope string they are issued.
- 5f54657: Add bounded personal-controller control-session handshake and operator review observation contracts. These prototype responses grant no room access, Agent execution, home activation or admission API.
- 716480e: Add an operator-promoted `home:control` pairing scope and show it in paired-device access controls. The permission only identifies private control-session participation; live control APIs, room access and Agent execution remain unavailable without their separate authorities.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.

  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- c3474f5: Expose optional operator-configured browser identity choices alongside Station
  local accounts, with verified OIDC callbacks and independent account sessions.
- eb1fd17: Add host-neutral mobile device inventory and single-frame capture contracts, with an authenticated SDK subpath that validates the selected target. Honor optional response byte ceilings for JSON POST responses as well as GET requests.
- ad2f0d3: Add the Muse background-work codes: `MUSE_LINGERING_CHILD_REAPED_CODE` and `MUSE_HELD_TURN_UNFINISHED_CODE` (`runtime.warning` codes for a held Muse turn's unreported background work), and `MUSE_TURN_SLOT_RELEASING_CODE` (a retryable send refusal while the previous Muse process is still exiting). Document that an adapter may suspend a turn's declared `idleLimitMs`.

  The runtime-event projection now reconciles `turn.completed.outputText` against ALL text the turn emitted, as the live chat path already does: an equal text adds nothing, and a strict extension appends only the missing suffix. This changes how reloaded transcripts render for more than Muse, in each case to match what the live view showed:

  - Muse, Codex and station-agent turns whose `outputText` is the whole turn's text no longer repeat the text written before a tool (or across several tool segments) in the final paragraph.
  - Turns with reasoning between text segments (thinking-interleaved Claude) no longer repeat the text before the reasoning.
  - When `outputText` extends the streamed text only by a trailing suffix (a coincidental prefix, text reported only at the terminal, or a trailing newline), that suffix is now appended rather than dropped.

  Turns whose `outputText` is only the final answer (Claude without interleaved reasoning) render as before.
- fa6338a: Delegated turn supervision can now be idle-only. `DelegatedTaskTurnSupervision.deadlineAt`, `remainingMs` and `totalLimitMs` (SDK) and `TurnSupervisionFacts.deadlineAt`/`totalLimitMs` (contracts) are optional and present together only when a total turn budget was declared; Muse declares none by default. Consumers that read them as always-present numbers must handle their absence. Contracts also add `MUSE_TURN_IDLE_TIMEOUT_CODE`/`MUSE_TURN_TOTAL_TIMEOUT_CODE` and widen the `tool.completed` status documentation (`unresolved` at a one-turn engine's turn end, engine-reported `cancelled`).
- 5570767: Muse turns no longer have a default idle bound (#2269). `TurnSupervisionFacts.idleLimitMs` (contracts) and `DelegatedTaskTurnSupervision.idleLimitMs` (SDK) are now optional and present only when an idle bound was declared for the turn; a Muse turn with no declared bound publishes a declaration with neither `idleLimitMs` nor a total budget. Consumers that read `idleLimitMs` as an always-present number must handle its absence. `station delegate status` prints "Idle limit: none declared for this turn" for such a turn.
- 84031dd: Add a bounded pre-grant Station-key candidate courier contract for native relay enrollment. Candidate delivery remains separate from Station-key approval, account sessions, Device grants, and Project access.
- 2f941ba: Add provider-neutral source identity and completed-turn continuation context. Declare native Codex continuation alongside Claude and expose source readiness reasons through the shared engine capability matrix.
- 4e39225: Add explicit operator-approved device binding to verified Tailscale person identity. Host pairing consent and the local access-approval CLI opt in without changing ordinary device grants, Project membership or wire scopes. Require server acknowledgment so older servers cannot silently approve device access as person binding.
- 984f9bc: Expose the server-issued portable execution consent marker with its original receiver-local Project identity. Portable continuation requires fresh admission for that identity; older markers cannot silently adopt a replacement Project.
- a777b37: Add typed portable Project identity snapshots and explicit receiver-local associations, with SDK methods to read, prepare and attach an identity. Reject incompatible responses and preserve the requested association through asynchronous work.

  Attachment publishes a new local Project and its imported identity together without changing existing Project history, copying paths into shared identity, or granting membership or execution authority.
- 272c29b: Carry an optional repository-relative execution root in portable Project identities.
- 17c17a1: Add explicit portable Project/resource execution intent and receiver capability
  negotiation. Receivers bind offered resources locally and recheck captured
  consent at provider effects; unsupported peers refuse without a local fallback.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- 4d38391: Add scoped Project membership and invitation administration, built-in local
  username account entry and operator account/session recovery controls. Keep
  account authentication, Project membership and device/compute grants independent.
- e5dfb04: Add an authenticated SDK and CLI workflow for setting or clearing portable Project execution roots.
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
- b6331e9: Publish the versioned self-hosted broker routing scope and connection-offer
  metadata. Routing generation and credentials remain separate from Station
  signing-key trust, account authentication, Device approval and Project access.
- 687d586: Add explicit account-bound Device approval and guest-only Project view contracts.
  Expose validated Project view APIs while keeping personal full-configuration APIs
  separate. Require deliberate operator approval mode selection in the pairing UI
  and CLI, and retain current account and Project membership as independent access
  requirements. This is a view-only pilot; shared execution and complete guest
  onboarding retain their separate delivery requirements.
- a2c21d7: Add explicit shared Task publication and bounded Project-member reads for Task
  summaries, human-message history, and text snapshots. Recheck current Device,
  account, Project, publication, and Task authority before releasing content.
- 0d75052: Add the `project` skill origin, so a workspace-scoped skill is distinguishable from a machine-wide one. Both are writable roots and previously reported `user`, which left no reader able to name the difference. Command-claim precedence places `project` in the same tier as `user`, matching the order discovery already resolves a name collision by.
- 9ccd6e4: Add `Skill.writable` and `Skill.writeRefusal`, so a reader can tell whether Station will write a skill's own package instead of inferring it. The server already decided this and no read model carried the decision, which left the Skills editor offering a Save that the route answers 409 for. `source` and `origin` were the fields a client had to guess from and answer a different question: a registry install in a writable root is writable, and an install record stating `source: 'local'` says nothing about which root the package sits in.

  `writeRefusal.reason` is a code — `served-in-place`, `canonical-package`, `outside-writable-root`, `unresolvable-name`, `directory-name-mismatch`, `containment-unreadable` — because the remedies genuinely differ and a reader cannot tell them apart from prose: a plugin-served prompt has no registry entry to install; a name that cannot become a directory name needs a rename; a package whose directory is simply named something else is plainly the user's own, sitting in a root Station writes, so telling that reader Station does not own it would be a false explanation of a real refusal; and a package whose path cannot be read at all may be sitting in exactly the right root with a broken link, where "install it into your workspace" repairs nothing.

  `writeRefusal.detail` is Station's own sentence about WHAT is wrong, and it contains no author-controlled text at all: not the skill's name, not its path, not an exception message. Where the package sits travels separately in `writeRefusal.packageDirectory`, which is required: every refusal has one, because the rule answers writable outright when no package was discovered. That split is the point rather than a detail of phrasing — every segment of the path is author-controlled, a plugin names its own directories, and text spliced into Station's sentence is read as Station speaking. Surfaces must render `packageDirectory` as its own element, labelled as a path, and never inside `detail`.

  The rule holds for this refusal, not yet for every message about a refused write: the write path's own failure message still interpolates the name and two paths and is surfaced verbatim, which is pre-existing and tracked in #1681. An absent `writable` is not a grant — a reader with no decision must treat the package as read-only.
- a30cab6: Expose the durable current execution Session on orchestration session summaries so reconnecting clients can rebind a conversation after an idle lineage transition.
- a30cab6: Expose authoritative unresolved request ids on orchestration session summaries so reconnecting clients can replace stale approval state.
- a30cab6: Expose current runtime error and turn-abort reasons on orchestration session summaries for exact reconnect status recovery.
- a30cab6: Carry bounded settled child work in reported session views so a reconnect snapshot can restore outcomes observed while a client was away.
- be60151: Expose a bounded, currently authorized answer quotation source with exact Session, turn, message and text-revision identity.
- a30cab6: Name the idless trailing orchestration activity frame that refreshes conversation liveness after coalesced live bursts.
- 09bd7e6: Add applied registry-policy and untrusted package-claim contracts, explicit Node signing/digest leaves, and root/dependency trust-review transport. Keep signer fingerprints distinct from publisher identity and preserve offline retained recovery.

  Release the fixed contracts/shared/SDK group together. Shared and CLI dependency floors must include the contracts release containing the new public leaves; unreleased same-version candidate tarballs require an explicit override throughout the consumer graph and do not prove npm availability.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- e4d61c8: Wake API initialization readers directly, bound diagnostic telemetry, and separate MCP transport construction from custody while preserving the published API.

  Align plugin preview component and conflict kinds with the emitted layout contract and share those types with server and UI producers.

  Canonicalize newly allocated temporary homes before admission so read-only source observation shares the writer home identity.
- d0ca944: Correct CLI help for supported option syntax, distribution boundaries, request
  deadlines, and checkpoint limitations. Update package documentation and examples
  to match current exports, hook signatures, build paths, and authorization limits.
  These documentation changes do not implement the separately tracked runtime fixes.

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
