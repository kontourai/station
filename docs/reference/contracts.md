# @kontourai/station-contracts

Canonical cross-package contract ownership for Station.

Use `@kontourai/station-contracts/*` when you need stable API/domain shapes shared across `src-server`, `packages/sdk`, `packages/cli`, plugins, or tests. New code should import these modules directly instead of reaching through `@kontourai/station-shared`.

`LayoutPanelsRecord` holds device-local side/lower-panel state by layout host
scope and conversation. `LAYOUT_PANELS_LAYOUT_BOUND` and
`LAYOUT_PANELS_SESSION_BOUND` bound retention. The v3 device envelope retires the
pre-release Coding-only panel preference; it does not preserve those old sizes.

## Ownership rules

- This package owns stable cross-package types and constants. Existing domain
  modules also expose pure boundary parsers, reducers and projection/page helpers;
  those are executable code, not evidence that a request is authorized.
- Keep module boundaries domain-oriented: `agent`, `auth`, `catalog`, `config`, `knowledge`, `layout`, `notification`, `orchestration`, `plugin`, `project`, `provider`, `runtime`, `runtime-events`, `scheduler`, `tool`.
- Keep service implementations, filesystem/network operations, build helpers and
  Node-only utilities outside this contract boundary. This inventory describes
  the current pure helpers; it is not a proposal to move general runtime services here.
- The `@kontourai/station-shared` root retains compatibility re-exports and
  selected helpers. Prefer explicit helper subpaths such as
  `@kontourai/station-shared/parsers`, `/build` and `/git`.
- Server-only provider interfaces do not belong here. Keep those in `src-server/providers/provider-interfaces.ts` or `src-server/providers/llm/model-provider-types.ts`.

`ToolCompletedEvent.mcpAppResourceUri` is an optional Station-owned completion
stamp from an already-open or shipped in-process MCP tool-definition catalog. EventStore replaces
incoming claims, and uses it only to retain bounded App envelopes in history
windows. It grants no resource or execution authority. Older readers ignore the
field; see [transcript previews](../design/mcp-ui-host.md#transcript-previews).

### Delegation file refusals

`@kontourai/station-contracts/attachment-staging` owns
`DelegationFileRefusalCode`, the closed `delegation_files_*` vocabulary.
`@kontourai/station-shared/delegation-files` supplies the runtime refusal class
and batch name/size/data validation used by CLI preflight and the server
materializer. Existing staging owner/tenant identity, grants and `stage_*` codes
remain unchanged. The [CLI](cli.md#delegate) and [SDK](sdk.md#delegatetaskapibase-input-options-with-files)
references describe cleanup and uncertain delivery outcomes.

## Modules

The authored `@kontourai/station-contracts/usage-export` module defines the
individual/personal-account request and retained-observation page, including
UTC window, stream epoch, fixed high watermark and unknown history coverage.
It neither describes an analytics authorization credential nor proves a
durable sync/restore fence. See [monitoring](../guides/monitoring.md#canonical-usage-export-source)
for current implementation and unexecuted acceptance limits.

The `@kontourai/station-contracts/html-reply` subpath defines prepared page
bytes, publication references, byte/height limits and theme variable names for
[visual replies](../user/html-replies.md). It grants no publication or
conversation access. Filesystem preparation stays in the server.

| Module | Owns |
|---|---|
| `@kontourai/station-contracts/engine-accounts` | Secret-free engine account, quota, optional identity/credit/model/spending/breakdown metadata and bounded capture-audit projections, plus provider-owned login; runtime validation stays in SDK consumers |
| `@kontourai/station-contracts/engine-sign-in` | Sign-in for engines run as commands: status with its source, offered methods (id, name, kind, terms note), key names (never values), the running attempt and what the caller may do |
| `@kontourai/station-contracts/acp` | ACP connection config, ACP connection status values, and engine catalogue entries with their install/launch/sign-in descriptor and its validator (`validateACPEngineDescriptor`), and the public agent registry's listing facts and source status |
| `@kontourai/station-contracts/engine-capability-matrix` | Per-engine capability and delivery declarations, and for ACP who decides which actions ask (`acpApprovalControl`: `station` for an engine whose approval rules Station sets at launch, today OpenCode, `engine` otherwise) |
| `@kontourai/station-contracts/agent` | Agent specs, metadata, tools, slash commands, the versioned Agent audience and the member Agent view |
| `@kontourai/station-contracts/agent-plugin` | Agent Plugins 1.0 schema identities, name grammar, and Station extension declarations |
| `@kontourai/station-contracts/skill-experience` | Inert v1 Skill definitions and explicit stage/rich-pane declarations, host-observed inventory identity, canonical start inputs and retained Session invocation views; see [experience contract](skill-experiences.md) |
| `@kontourai/station-contracts/attention` | Attention projections and exact approval/permission request references and inspection states |
| `@kontourai/station-contracts/environment-security` | Public handshake and compatibility declarations, scoped Device/Station pairing, receiver-owned additive grant kind, and secret-free `PeerEnrollmentInput`/`PeerEnrollment` metadata; explicit `access:devices` administration scope and `device-access` revocation provenance. A missing legacy kind denotes Device access; these declarations grant no Project membership or execution consent. See [peer enrollment](sdk.md#station-peer-enrollment). |
| `@kontourai/station-contracts/station-groups` | Station groups for people (#3557): the Admin/Member vocabulary and default, the governed permissions and each group's ceiling, the pure `capScopeToGroup`, and the `StationPerson`/`StationGroupAssignment` shapes `GET /api/pairing/people` returns. Groups only cap a person-tied Device's governed permissions; they grant nothing, never include `access:manage`, and are not Project roles |
| `@kontourai/station-contracts/auth` | Auth status, renew results, user identity/detail models |
| `@kontourai/station-contracts/secret-binding` | Metadata-only AuthRef bindings, instance/person ownership, distinct exact MCP environment, ACP header and instance telemetry destination grants; raw material is server-only |
| `@kontourai/station-contracts/telemetry-delivery` | Current-process product acknowledgement/queue/failure and OTLP callback/probe status; collector acceptance does not prove downstream storage |
| `@kontourai/station-contracts/authority-observation` | Closed credential-bound authority observation: current home identity, resolved principal echo (kind+id only), and verified grant tier; authorization-neutral, grants nothing |
| `@kontourai/station-contracts/automation` | Automation sources (GitHub poll and webhook), the source-safe projection without the webhook secret, source grants, exact-equality string matchers (event fields are strings; numbers arrive as canonical decimal strings; an empty `where` is refused), rules, episodes, the closed delivery outcomes and the subset that takes part in semantic dedupe, `AUTOMATION_EXECUTION_LIMITS`, the GitHub event allow-list and the `AUTOMATION_OPERATOR_SURFACE` parity table, whose mutations have no MCP verb. Shapes only: the server validates and stores them, and no route, intake or dispatch consumes them yet |
| `@kontourai/station-contracts/application-session` | Device-bound account continuations, explicit capabilities, public proof keys and challenge/credential projections; no Device or Project grant |
| `@kontourai/station-contracts/native-device-proof` | Native Device request-proof version, header, approved binding, exact one-use claims and the host-proposed binding candidate (provisional canonical UUIDv4 ID, approved Device ID, full surface and Device public JWK; no secret); `NativeDeviceProofBindingReadbackV1` projects operator-only historical binding data and separate current Device-binding status; `NativeDeviceProofSelfReceiptV1` reuses that public tuple for the owning current Device bearer through a distinct protected read; `NativeDeviceProofSelfReceiptErrorV1` versions its closed lookup/refusal codes so an unrelated HTTP error cannot establish binding absence; protocol data grants no Device, account or Project authority and supplies no runtime admission |
| `@kontourai/station-contracts/relay-enrollment` | Fresh relay-only account enrollment, finalize-delivery and signed-activation bindings; a pending identity receives no active Device authority before the exact delivered bundle is acknowledged |
| `@kontourai/station-contracts/native-relay-enrollment` | Native challenge/candidate, fixed HPKE recipient, ciphertext delivery, signed activation/status, retained fixed request and owned transition/resume DTOs. Declarations grant no authority; server/native/UI owners compose them separately, and no Device bearer crosses renderer IPC |
| `@kontourai/station-contracts/native-relay-link` | Closed v1 public route intent or unchanged native v2 invitation envelope, untrusted origin hints, fixed native channels and secret-free host delivery metadata/opaque handles; no trust, person, Device, Project or compute authority |
| `@kontourai/station-contracts/deployment-authentication` | Public operator-installed authentication provider configuration, factory, descriptor, operations and verified account-session results; see [deployment authentication](../guides/deployment-authentication.md) |
| `@kontourai/station-contracts/catalog` | Registry items, install results, skills, guidance assets |
| `@kontourai/station-contracts/child-work` | Provider-neutral child work (engine subagents and Station delegates): items, deltas, the session read model, and the one pure reducer over them. An item's optional `model` is the child's own model with its `source` (never the parent's), and `transcript` names the engine records its read-only transcript is served from. Its optional bounded `latestTool` is the latest reported child tool name, independent of `progress`; it carries no tool arguments or inferred execution state. Missing reports retain the last observed name through reducer updates and settlement, and a new resumed child has a separate identity. `usageProvisional` marks a terminal child whose usage still holds figures from while it ran; settles that report usage replace its running fields, and a field a settle reported stays sticky, even while `usageRunningFields` names other fields still running. `childWorkSettleFromItem` restates a stored settled item as a settle that keeps both, for seeding a registry from history or a session view |
| `@kontourai/station-contracts/thread-usage-tree` | A conversation's usage tree: own figures, each child's usage relation to its parent (`added`, `included-in-parent`, `not-reported`) for tokens and cost, and a roll-up total that names what it leaves out |
| `@kontourai/station-contracts/cloud-move` | Cloud preparation target/inventory, enrolled target observations, unavailable-transfer projection, and workspace package capture/inspection/verification receipts |
| `@kontourai/station-contracts/registry-trust` | Candidate registry policies, bounded applied identity/epoch shapes, and untrusted signed-package claim shapes |
| `@kontourai/station-contracts/desktop-update` | The desktop app's native-owned update state (phases, the error beside the phase it returned to, download policy, its automatic-download time and a per-run sequence) and its state event name; the native shell computes it, the window and tray read it |
| `@kontourai/station-contracts/config` | App config and template variables |
| `@kontourai/station-contracts/connection-proof` | Transport-only Station/enrollment/client/SDP bindings and independently approved signing-key trust; never account or Project grants |
| `@kontourai/station-contracts/connection-quota` | Provider-reported quota snapshots, explicit unavailable outcomes, and pure rolling-observation merging; absent provider data stays absent |
| `@kontourai/station-contracts/self-hosted-broker` | Versioned browser Origin scope, native proof-key surface and distinct v2 native offer metadata and closed invitation-authenticated older-scope observations; routing authority is separate from signing trust, account identity and Project permission |
| `@kontourai/station-contracts/relay-ice` | Closed relay-only short-lived end-user ICE receipt, exact native scope/optional surface, issue/expiry times and a 600-second ceiling; no issuer secret or application/Device/account grant |
| `@kontourai/station-contracts/workspace-isolation` | Shared/worktree policy and owned worktree Session metadata, including the original base ref and optional resolved `baseCommit`; see [source identity](../design/isolated-agent-runs.md#current-project-worktree-source-identity). A recorded starting commit is not a current-workspace or execution-isolation guarantee. |
| `@kontourai/station-contracts/execution-confinement` | Confinement levels, observed postures, workspace access, policy basis, the content-free session confinement record and the server-only confinement plan (#2494); see [confinement providers](../design/approval-posture-server-ordered.md#410-confinement-providers-2494). The record's posture is what the started engine reported applying, never the configuration Station sent, and describes the session start. Its refusal codes reach callers from a server-side `SessionStartRefusedError` raised before the engine is announced, so a refused start is settled (`rejected`), not fenced as indeterminate |
| `@kontourai/station-contracts/execution-preparation` | Version requirement, typed refusal codes and path-free receipt for version-matched portable execution; see [remote execution preparation](../design/remote-execution-preparation.md) |
| `@kontourai/station-contracts/execution-target` | Environment, Agent and workspace intent, including profile-preserving receiver-owned engine overrides and exact portable Project/resource execution; see [receiver execution offers](../design/portable-project-identity.md#receiver-execution-offers). A validated continuation without an owned-worktree binding reports its server-read bound workspace; owned worktrees retain the existing repository-root receipt form; the optional `confinement` is the started session's recorded confinement, attached after the start |
| `@kontourai/station-contracts/harness-questions` | Deprecated since 0.9.0; retained in 0.10.0 for stored events and legacy `answers` callers. Use the `input-request` shapes for new callers |
| `@kontourai/station-contracts/input-request` | `station.input-request/v1`: the envelope, `form` and `decision` bodies, accept/decline/cancel response, and the transcript record of a harness question, a tool server's elicitation or an approval; reading and validation live in shared |
| `@kontourai/station-contracts/mcp-prompts` | An agent's MCP server prompts offered as slash commands (named string arguments), the listing with unreadable servers, and a prompt run's inserted text |
| `@kontourai/station-contracts/knowledge` | Knowledge namespaces, tree/search/document metadata |
| `@kontourai/station-contracts/live-surface` | Host-neutral live surface (#90): frame header, input events, control lease, stream params, their strict wire parsers and the length-prefixed binary record envelope |
| `@kontourai/station-contracts/workspace-browser-pane` | Browser pane v2 (#90): per-device pane state referencing a server-owned browser session, its v1→v2 migration, and the `/api/browser/*` wire views the pane reads |
| `@kontourai/station-contracts/learning-review` | Owner-neutral learning lifecycle projections and explicit access gaps |
| `@kontourai/station-contracts/layout` | Layout definitions, tabs, skills, templates, and repository workspace binding (`workspaceBinding: 'repository'`); legacy Coding records retain their repository binding. A catalog contribution's optional, server-issued `lifecycleGeneration` is identity only, never a permission; a reinstall or an enablement change replaces it and it never repeats. `null` is history the server cannot vouch for, under which a host admits nothing |
| `@kontourai/station-contracts/personal-board` | Declarative dashboard sections, saved/proposed Board document and revisioned authoring inputs |
| `@kontourai/station-contracts/local-accounts` | Operator-only account projections, sign-in/session actions and one-time recovery results |
| `@kontourai/station-contracts/notification` | Notification payloads and actions |
| `@kontourai/station-contracts/orchestration` | Connected-agent/orchestration request and response shapes. A session event window may carry `latestTool: { turnId, name }` independently of its transcript caps, bounded to a 256-byte UTF-8 name and 4096-byte turn ID at the snapshot watermark. `null` means no usable current-turn tool; only an absent field permits older-server event fallback. A new turn clears the fact; steering the same turn preserves it. No arguments or inferred tool-running state are included. |
| `@kontourai/station-contracts/plugin` | Plugin manifests, previews, overrides, conflicts, install outcomes and current permission status |
| `@kontourai/station-contracts/plugin-foreground-work` | Bounded foreground-work declarations, start intents, effect depth, run states, and safe public outcomes. Published ahead of a server implementation: Station does not admit or list plugin foreground runs yet |
| `@kontourai/station-contracts/project` | Project config and metadata, and `projectIconProblem`: the one rule for a stored project icon (a short glyph, or a PNG/JPEG/WebP/ICO data URL of at most 128 KiB whose bytes match its type) that the create and update routes, the icon pickers and the renderer share |
| `@kontourai/station-contracts/project-membership` | Exact Station/local/portable Project scope, member roles/actions, single-use or verified-email invitations and administration projections |
| `@kontourai/station-contracts/provider` | Provider kinds and provider-facing contract enums/types |
| `@kontourai/station-contracts/runtime` | Session metadata, workflow metadata, runtime responses |
| `@kontourai/station-contracts/runtime-events` | Runtime event stream payloads |
| `@kontourai/station-contracts/session-inventory` | Closed Session inventory rows, gaps, and current-answer Basis projection |
| `@kontourai/station-contracts/session-work-item` | Closed immutable Session-to-work-item association observations |
| `@kontourai/station-contracts/scheduler` | Scheduler jobs, stats, capabilities, notifications |
| `@kontourai/station-contracts/system-status` | Device presentation, the answering server's runtime identity, update-provenance issue codes, and service and server update state |
| `@kontourai/station-contracts/task-room-work` | Versioned Task agent request intent, explicit engine/model/options digest identity, authorized request records, list and submission outcomes. Requester IDs are Task-scoped display pseudonyms; execution references do not grant Session access or prove completion |
| `@kontourai/station-contracts/tool` | Tool definitions, permissions, connection configs |
| `@kontourai/station-contracts/tool-library` | Safe source metadata, Project policy, requests, access summaries and Project agent drafts; [SDK client](sdk.md#project-tool-library) |
| `@kontourai/station-contracts/unified-search` | Owner-qualified typed search results, provider pages, source states, open intents, and fresh owner-resolved open targets |
| `@kontourai/station-contracts/workspace-activity-review-pane` | Canonical Activity review Pane descriptor, `activity-review:` plus 32 lowercase hexadecimal occurrence identity, instance constructor and pure canonical-instance check. These grant no source access or review authority. |
| `@kontourai/station-contracts/workspace-pane-host-contract` | The transport-independent Pane-host capability interface: navigation, notices, confirmation, device facts, the optional Skill experience and the optional, occurrence-bound related-pane capability (`PaneRelatedPanesHost`, see [Related panes](sdk.md#related-panes)) |
| `@kontourai/station-contracts/workspace-pane-host-contribution` | Package-level Pane-host actions and explicit owner-relative/default Agent selection |

`ProviderSendTurnInput` and `CanonicalRuntimeEventBase` may carry an optional
`invocationId`. Station assigns it to requested work, and producers retain it
only through an actual originating request or stream association. It is
attribution data, not authorization, a client turn key or replay permission.
Raw weak-origin observations remain untagged; consumers must not infer an
invocation from a reused native turn ID or the current thread mapping.

`ProviderContinuityCapabilities.resumeIdentity` is an additive adapter opt-in
to `require-match`. Foreground native-cursor continuations set
`ProviderSessionStartInput.requireNativeResumeIdentity` only for that declaration.
An older adapter that omits it retains its existing resume behavior.
Claude compares its SDK `init.session_id`; Codex compares the `thread/resume`
response identity. A match emits server-owned `nativeResumeIdentity: matched`
metadata. A queued prompt, requested cursor, or process start does not establish
a match. An exact-resume identity mismatch stops that activation; it does not
silently claim a fresh thread has continued the original one.
`nativeReturn: 'same-binding'` additionally permits an explicit Agent handoff
back to an earlier native thread in this Conversation. Station requires the
same Agent, Environment, connection, working directory and opaque configuration
binding, a completed accepted turn, and confirmed engine retirement. Durable
ownership fences prevent the earlier execution Session from writing or deleting
the transferred native thread. Missing bindings use the existing bounded replay
path; a known identity mismatch refuses the activation.

The resumed thread receives a bounded context seed from the execution Sessions
between departure and return. The handoff's `nativeReturn.sourceSessionId`
records the requested return; `nativeResumeIdentity: matched` records the
provider-observed identity separately. Neither proves that every historical
message fit in context, that a turn completed, or that cross-machine migration
worked. Private resume-enforcement inputs are excluded from public start inputs.

`ConversationReadPage` retains compact message Session attribution and optional
model attribution, with `provider-reported` or `selected` provenance. A row may
also carry `sender`, the agent-message provenance Station recorded; it does not
grant read authority, and absence means that attribution was not reported. Its
versioned `provenance` reports ordered execution Sessions, provider handoffs and
optional explicit fork ancestry. Missing provenance on an older server, or
`status: 'unavailable'`, means unknown. A parent reference grants no read access.
See the [provider contract](../../packages/contracts/src/provider.ts),
[foreground caller](../../src-server/services/execution-target/execution-target-execution.ts),
[Claude mapper](../../src-server/providers/adapters/claude-adapter-events.ts), and
[Codex adapter](../../src-server/providers/adapters/codex-adapter.ts).

Session inventory preserves Surface's `not-chosen` reviewed-source state and
`reviewed-source-review-not-chosen` gap when a review selected another candidate.
The row remains `contributed-to`; that state does not establish support for the answer.

A current-answer inventory is bound to the scope's exact Session and turn, not
to an available answer. It parses whatever the Surface answer state is. Consumers
render that state from the carried `basis`, so a partial Basis outage keeps the
other resolved groups. An available answer must still equal the bound answer
exactly. A non-available answer admits no `surface-answer-contribution` row.
In that scope `contributed-to` is the only support edge. A row without it is
turn lineage: only `observed-during` or `produced-by`, carrying the scope's
`turnId` (`output.turnId` for outputs). Decision and delegation rows carry an
optional `turnId` for this. The Session resource summary has no turn, so it never
appears in a current-answer inventory. See the
[parser](../../packages/contracts/src/session-inventory.ts).

Client protocol 3 admits these lineage rows in the server inventory. Older or
undeclared HTTP clients retain contribution-only groups and typed gaps; the
server never strips rows after computing a continuation digest. Inventory
continuations bind the client dialect as well as scope and authority. Output
pages filter the durable declaration index by the exact turn before paging,
and their signed cursors cannot be reused for another turn or Whole Session.
Decisions come from exact-turn request events. Delegations require an explicit
child Session handle and parent turn/tool identity; provider-only child IDs
stay an owner gap. These reads select descriptors, not tool bodies or metadata.


`AgentTools.mcpMode` selects additive (`add`) or replacement (`replace`) MCP
configuration; omission preserves the prior engine-specific behavior.
`AgentTools.mcpLoading` optionally selects Claude's native on-demand or eager
loading. The session resolver carries these as `toolServerMode` and
`toolServerLoading`. A resolved server's `allowedTools` contains exact original
MCP names (empty means none); `disabledTools` excludes names independently, and
`toolNames` is catalog metadata for known-tool exclusions. See the
[Agent Tools guide](../guides/agent-configuration.md#mcp-tool-configuration) for delivery limits.

`OrchestrationSessionSummary.openRequestIds` is present when the server reads
its durable request state. An empty array means no requests remain open;
absence means that server did not report this projection. A request settled
by its turn's abort is not listed, and does not set `pendingReview`, whether
or not a `request.resolved` was recorded for it; the
[Session API](session-api.md#respondtorequest) says which aborts settle which
requests.

`OrchestrationSessionSummary.currentSessionId` names the current durable
execution child for the row's conversation, including when no turn is open.
It is omitted when the current child is outside the caller's readable scope.
`lastRuntimeErrorMessage` carries the current terminal error when the event
fold can prove one; `lastTurnAbortReason` carries a non-recovery abort's
reason. A later successful terminal clears them. `lastRuntimeErrorUsageLimit`
is `true` when that terminal error carried an engine adapter's
`UsageLimitFailureDetails` (a Claude Code or Codex usage limit); clients hold
queued follow-ups on it until a turn starts or the user sends one.

`ConnectionRecoveryProjection.outcomeReason` says why a usage-limit stop did
not resume on its own: `auto-resume-off`, `superseded`, `request-pending`,
`session-ended`, or `user-canceled` (the user chose Cancel auto-resume). Its
`autoResumeChoice` (`resume` or `hold`) is the person's choice for that one
stop, which decides `autoResume` in place of the setting. The chat banner
reads it through the Session API's
[usage-limit routes](session-api.md#usage-limit-recovery-sessionsthreadidusage-limit).

`@kontourai/station-contracts/agent-schedule` owns what an agent schedules
for itself and what it only proposes: `AgentWakeUp`, `AgentJobProposal`,
`ConversationAgentSchedule`, their bounds (`AGENT_WAKE_UP_MAX_HORIZON_MS`,
`AGENT_WAKE_UP_MIN_DELAY_MS`, `AGENT_WAKE_UP_MAX_PENDING_PER_CONVERSATION`,
`AGENT_WAKE_UP_NOTE_MAX_CHARS`, `AGENT_JOB_PROPOSAL_MAX_OPEN_PER_CONVERSATION`,
and the hourly create limits `AGENT_WAKE_UP_MAX_CREATED_PER_WINDOW` and
`AGENT_JOB_PROPOSAL_MAX_CREATED_PER_WINDOW` over
`AGENT_SCHEDULE_RATE_WINDOW_MS`), `jobMatchesProposal`, the comparison the
scheduler's approval uses, and `isStationCheckBackTurn`, which tells a
transcript that a turn is a check-back Station sent (its internal origin and
a send key `parseWakeUpClientTurnId` accepts). A wake-up waiting for a
person's approval is in state `needs_approval`.

`@kontourai/station-contracts/station-control-refusal` owns the refusal view
a transcript shows for a station-control tool (`StationControlRefusalView`:
code, sentence, out-of-scope reason), `parseStationControlRefusal`, which
reads it only from a station-control tool's whole result, and
`stationControlToolName`. A history window carries it whole on
`ToolCompletedEvent.stationControlRefusal`, read before the window cut the
output to an excerpt; a sentence over its bound is not carried.

`ORCHESTRATION_STREAM_ACTIVITY_EVENT` names an idless SSE frame carrying the
current conversation activity after a burst of coalesced runtime events. It
updates liveness without advancing the event replay cursor.

`ChildWorkSessionView` may include bounded `settled` items with a reported
running set. A missing `children` view still means the server made no
child-work report for that row; clients retain their existing state.

Claude's early resumed-child replies require an observed matching `SendMessage`
recipient before they can seed the resumed run. Replay suppression retains the
latest 64 SDK-frame, tool-call and resume-call identities per category; identities
evicted from that bounded history are no longer recognized as replays.

## Engine-neutral failures

`@kontourai/station-contracts/provider-failure` owns the closed
`ProviderFailureKind`, `PROVIDER_FAILURE_RETRYABLE` and diagnostic-code mapping.
Server `runtime.error` constructors explicitly satisfy `ProviderRuntimeErrorEvent`
or its emitter-body type. Both require `kind`, computed `retryable` and `failurePhase`. Stored events and
third-party plugins can predate these additive fields; missing means unknown.
`SendTurnRefusedError` and pre-effect server refusals require an explicit kind, and `SessionStartRefusedError`
requires a mapped code. Their inherited getters compute eligibility from the
same constants; subclasses cannot omit the required constructor input.

`failurePhase: refused` promises no provider-visible effect. `failed` means
work may already have run and spent resources. `indeterminate` means invocation
may have happened and its outcome is unknown. A new send blocked by custody of a
previous process is instead a refused `conflict`: that new send did not run.
`retryable` describes whether
the same input is eligible for a later caller-requested attempt; it never
instructs clients to replay a failed or indeterminate action automatically.
`retryAfter`, when known, is an ISO timestamp. Account quota failures carry
`quota_exhausted` and a reported reset time when available; eligibility remains
false until that condition changes. Generic failures stay `provider_error`
unless structured engine evidence supports a narrower kind.

The fixed retryable kinds are `busy` (wait for the competing operation),
`rate_limited` (respect the reported delay), `timeout`, `engine_crashed` and
`unavailable` (session startup failed; a manual attempt may start it again).
All other kinds are non-retryable: `auth`, `quota_exhausted`,
`model_unavailable`, `provider_error`, `cancelled`, `input_unsupported`,
`session_gone`, `permission_denied`, `conflict`, `indeterminate` and `warning`.

The existing `retriable` event field retains its separate meaning. In
particular, Codex can report that it will continue the same turn; changing it
would change terminal-event folding. Warning-only diagnostics use `warning`, with `retryable: false`. Approval
expiry, lingering-child reaping and serve fallback describe observations or
partial/background work; they do not fail or replay the completed turn. Generic engine codes
can carry a more specific kind when structured quota details establish it.
No existing diagnostic code is renamed or removed.

| Diagnostic code | Kind | Retryable |
| --- | --- | --- |
| `delegation_files_unsupported` | `input_unsupported` | `false` |
| `delegation_files_duplicate_name` | `input_unsupported` | `false` |
| `delegation_files_count` | `input_unsupported` | `false` |
| `delegation_files_size` | `input_unsupported` | `false` |
| `delegation_files_invalid_name` | `input_unsupported` | `false` |
| `delegation_files_invalid_data` | `input_unsupported` | `false` |
| `delegation_files_ref_invalid` | `input_unsupported` | `false` |
| `delegation_files_unavailable` | `unavailable` | `true` |
| `delegation_files_start_refused` | `provider_error` | `false` |
| `delegation_files_turn_refused` | `provider_error` | `false` |
| `delegation_files_outcome_unknown` | `indeterminate` | `false` |
| `delegation_files_cleanup_failed` | `provider_error` | `false` |
| `stage_not_found` | `input_unsupported` | `false` |
| `stage_expired` | `input_unsupported` | `false` |
| `stage_forbidden` | `permission_denied` | `false` |
| `stage_grant_invalid` | `permission_denied` | `false` |
| `stage_cancelled` | `cancelled` | `false` |
| `stage_incomplete` | `input_unsupported` | `false` |
| `stage_invalid_upload` | `input_unsupported` | `false` |
| `stage_capacity` | `busy` | `true` |
| `foreground_invocation_unavailable` | `conflict` | `false` |
| `delegation_attempt_capacity` | `busy` | `true` |
| `continuation_place_refused` | `input_unsupported` | `false` |
| `acp-approval-takeover-failed` | `warning` | `false` |
| `acp_approval_governance_refused` | `permission_denied` | `false` |
| `adoption_continuation_in_progress` | `busy` | `true` |
| `approval-escalation-requires-restart` | `warning` | `false` |
| `approval-full-access-not-granted` | `permission_denied` | `false` |
| `attachment_input_unsupported` | `input_unsupported` | `false` |
| `authentication_rate_limited` | `rate_limited` | `true` |
| `client_protocol_invalid` | `input_unsupported` | `false` |
| `client_protocol_unsupported` | `input_unsupported` | `false` |
| `client_turn_in_flight` | `busy` | `true` |
| `client_turn_input_conflict` | `conflict` | `false` |
| `client_turn_input_unsupported` | `input_unsupported` | `false` |
| `client_turn_settled` | `conflict` | `false` |
| `confined_full_access_unavailable` | `permission_denied` | `false` |
| `confinement_mechanism_unavailable` | `permission_denied` | `false` |
| `confinement_not_observed` | `permission_denied` | `false` |
| `confinement_workspace_incompatible` | `permission_denied` | `false` |
| `continuation_engine_not_ready` | `unavailable` | `true` |
| `continuation_workspace_corrupt_worktree_binding` | `input_unsupported` | `false` |
| `continuation_workspace_different_project` | `input_unsupported` | `false` |
| `continuation_workspace_direct_mismatch` | `input_unsupported` | `false` |
| `continuation_workspace_project_context_missing` | `input_unsupported` | `false` |
| `continuation_workspace_unbound` | `input_unsupported` | `false` |
| `continuation_workspace_worktree_gone` | `input_unsupported` | `false` |
| `continuation_workspace_worktree_moved` | `input_unsupported` | `false` |
| `engine-decision-not-sent` | `warning` | `false` |
| `engine-decision-unacknowledged` | `warning` | `false` |
| `engine-session-binding-dead` | `session_gone` | `false` |
| `engine-sign-in-required` | `auth` | `false` |
| `engine-turn-failed` | `provider_error` | `false` |
| `execution_engine_changed` | `conflict` | `false` |
| `foreground_message_indeterminate` | `indeterminate` | `false` |
| `model_not_advertised` | `model_unavailable` | `false` |
| `model-override-unsupported` | `input_unsupported` | `false` |
| `muse_turn_slot_releasing` | `busy` | `true` |
| `muse-approval-decide-failed` | `warning` | `false` |
| `muse-approval-expired` | `warning` | `false` |
| `muse-approval-mode-not-applied` | `warning` | `false` |
| `muse-exit-without-terminal` | `engine_crashed` | `true` |
| `muse-held-turn-unfinished` | `warning` | `false` |
| `muse-lingering-child-reaped` | `warning` | `false` |
| `muse-serve-host-exited` | `engine_crashed` | `true` |
| `muse-serve-stop-unconfirmed` | `warning` | `false` |
| `muse-serve-unavailable` | `warning` | `false` |
| `muse-spawn-failed` | `unavailable` | `true` |
| `muse-terminal-not-completed` | `provider_error` | `false` |
| `muse-turn-idle-timeout` | `timeout` | `true` |
| `muse-turn-timeout` | `timeout` | `true` |
| `principal_unresolved` | `auth` | `false` |
| `project_identity_not_prepared` | `input_unsupported` | `false` |
| `provider_session_start_failed` | `unavailable` | `true` |
| `provider_session_starting` | `busy` | `true` |
| `provider_turn_in_progress` | `busy` | `true` |
| `provider-plan-quota-exhausted` | `quota_exhausted` | `false` |
| `resource_engine_start_capacity` | `busy` | `true` |
| `session_ended` | `session_gone` | `false` |
| `session_recovery_failed` | `unavailable` | `true` |
| `session_start_in_flight` | `busy` | `true` |
| `SESSION_START_INDETERMINATE` | `indeterminate` | `false` |
| `session-reattach-conflict` | `conflict` | `false` |
| `transcript-line-skipped` | `warning` | `false` |

The [source inventory guard](../../scripts/__tests__/provider-failure-inventory.test.ts)
recursively discovers string `*_CODE` declarations and string-literal `code` class
fields in contracts and server code,
including private constants and newly added files. Known out-of-scope constants
are explicitly allowed by file, name and value: directory/command grants and
Station Control containment are caller authority, Flow unreachable-gate claims
are evidence governance, and person/native-title control codes do not represent
turn execution or session startup. Class-field exclusions separately name application
configuration, storage, policy, and non-provider lifecycle failures. The guard refuses
a new unclassified constant or class-field code. Object-literal API/validation codes
are outside this inventory; strict `runtime.error` construction is checked separately.
Existing server import paths forward the relocated contract constants.

The inventory also reads the delegation-file refusal union in `attachment-staging.ts`
and the staging service's constructor code union independently of the mapping.
Their codes surface through delegation HTTP refusals. Invalid, missing, expired,
incomplete or already consumed file references require valid prepared inputs;
`stage_capacity` is staging-store contention, while forbidden references or grants
are permission failures. Workspace file-write unavailability can permit a manual
retry after the host recovers. The delegation start/turn refusal wrappers no longer
carry the underlying engine reason, so they conservatively use `provider_error`.
Cleanup failures also require inspection before another attempt. Unknown delegation
outcomes remain `indeterminate`; none of these kinds authorizes automatic replay.


The same guard requires every literal server `runtime.error` constructor to
satisfy a strict writer type. Its two named reader exceptions reconstruct old
observations (`monitoredRuntimeEventFrom`) or pass a small input to a terminal
predicate (`isDelegationTerminalEvent`); neither publishes a new event. The
recovery coordinator's error matches are parameter types for observed events,
not emitters. A compiler-backed test proves that the real writer type rejects
missing metadata while the legacy reader accepts it.

The [pinned wire test](../../packages/contracts/src/__tests__/provider-failure.test.ts)
states every code's expected kind and retryable value as independent literals;
changing an existing mapping to another valid kind fails. The
[projection route tests](../../src-server/routes/orchestration/__tests__/provider-failure-projection.routes.test.ts)
reach handoff, continuation and receipted-command failures, including invocation
uncertainty. The [delivery test](../../src-server/routes/orchestration/__tests__/turn-delivery.routes.test.ts)
reaches ordinary foreground refusal and same-key resend. These use fakes, not
live model calls.

Station's model-provider SSE writer recognizes `insufficient_quota` only in a
bounded structured body from a qualified upstream HTTP 429. It forwards a fixed
kind, never that body or its text. The Station-agent relay distinguishes
`quota_exhausted` from ordinary `rate_limited` and preserves the same safe text
in live events and saved failure markers. The
[relay tests](../../src-server/providers/__tests__/station-agent-adapter.test.ts)
exercise both cases through the production SSE writer.

Queue retention reads computed eligibility for its existing five provider
refusal codes, with an explicit fallback when older or hand-built errors have no
kind. The code membership bounds this migration to the behavior proved equivalent;
a coarse kind does not expand queue policy. A `muse-spawn-failed` response keeps
its old drop policy even if it carries an `unavailable` kind. The
[queue tests](../../src-ui/src/hooks/orchestration/__tests__/queueDrain.test.ts)
pin both behaviors. Code-specific automatic redrain, composer transitions,
corrective copy, workspace/adoption authority and reset/opt-in recovery policy
remain separate decisions. Broader retention for newly classified codes is deferred.

## Product telemetry observations

`@kontourai/station-contracts/product-telemetry` declares the content-free Full event
inventory and version1 batch, observation and build shapes.
`TelemetryPublisherStatus` includes the effective tier and reason alongside the
optional saved `userChoice`; a DNT override does not replace that saved choice. Stable event IDs,
producer occurrence/admission time, inventory revision and allowlisted build
provenance support reliability comparisons; they do not identify people or
replace canonical personal usage receipts. Runtime validation and disclosure
fingerprinting belong to the [shared helper](shared.md#product-telemetry).
Legacy payloads have no v1 guarantees and the strict parser rejects them.
The same module owns per-publisher tiers, the identifier-free `station_daily`
field catalog, fixed feedback reasons and bounded outbox records. Lite bodies
use the daily catalog; Full uses the version1 observation envelope.
See [Usage telemetry](usage-telemetry.md) for consent, retry and privacy limits.

## Allowance observations and recovery ordering

Codex's nullable `primary` and `secondary` groups represent unavailable windows,
not malformed data or zero usage. Nullable duration, reset and credit-balance
metadata remains unknown; an explicitly unavailable reset cannot supply a
qualified expiry deadline. Non-null malformed groups still refuse projection.

`connection-quota` retains raw provider reset values and adds optional
`resetDeadlineAt` only when an adapter can normalize a declared wire unit.
`subscriptionEnd` carries its own observation time and explicit renewal state;
missing lifecycle data is not inferred from a provider plan string. Sparse
updates preserve prior lifecycle observations without refreshing their timestamp.

`connection-recovery` owns optional `allowancePreference` (window ID and minimum
remaining percentage). It ranks existing eligible recovery accounts, grants no
new enrollment or execution authority, and preserves ordinary ordering when
expiry facts are unknown. See [account recovery ordering](../guides/connections.md#prefer-allowance-that-expires-sooner-during-account-recovery).

## Import examples

The [package export map](../../packages/contracts/package.json) is the available
subpath inventory. It selects TypeScript source. A contract declaration or parser
does not establish implementation, deployment, access, or a completed live journey.

```ts
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { UsageInsights, InsightsScanCoverage } from '@kontourai/station-contracts/insights';
import type { LearningReviewProjectionOutcome } from '@kontourai/station-contracts/learning-review';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { SessionMetadata } from '@kontourai/station-contracts/runtime';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { UnifiedSearchResult } from '@kontourai/station-contracts/unified-search';
```

`insights` owns the monitoring rollup and optional retained-scan coverage.
Complete scan integrity does not establish lifetime retention or producer
delivery. Older servers omit coverage; new consumers treat that omission as
unknown integrity. Failure classifications carry no file paths or foreign-user
counts. The [Insights route](../../src-server/routes/operations/insights.ts)
produces coverage; the SDK and existing dashboard consume it.

`learning-review` is a read-only projection contract. Its available form links
owner-issued source, candidate, evaluation, decision, activation, effect, and
retirement records; its unavailable forms contain no protected owner identity.
Station does not turn feedback, an accepted request, or transport success into
a promotion verdict. An empty effect-observation set means not observed, never
successful.

## Account preferences

`@kontourai/station-contracts/account-preferences` declares portable preference
keys, the partial account document and field-patch/reset semantics. The scope is
one verified person within one Station and trusted tenant boundary. Account
preferences contain no credentials, Device grants or Project/Station policy.
Interactive approval defaults are per engine; their presence does not authorize
execution. Device-only keys are refused by the personal preferences route.

## Native relay and account composition

The [native relay link contract](../../packages/contracts/src/native-relay-link.ts)
distinguishes public first contact from an invitation already bound to the
installation's proof key. Its receiving `NativeRelayLinkDelivery` omits the
invitation secret and exposes only routing metadata and a pending handle.
The [publication codec](../../packages/shared/src/native-relay-link.ts), published
as `@kontourai/station-shared/native-relay-link`, and
[native intake](../../src-desktop/src/native_relay_link_intake.rs) own parsing
and lifetime checks; declarations neither create a proof key nor approve a
surface. Origin hints are not Station identity. The existing operator surface
approval and independent signing-key comparison remain mandatory before the
separate native grant and account/Device/Project flows.

The [native enrollment contract](../../packages/contracts/src/native-relay-enrollment.ts)
separates installation routing proof, recipient/Device/account keys, operator
approval and signed activation. A prepared fixed request names its peer and
retained request handle; an active host result names an owned transition and
configured profile revision. Resume metadata is only a hint until the host
checks the exact owned transition. The [mounted owners](../design/native-relay-enrollment.md)
implement that validation; importing a declaration does not enable ingress.

The [application-session contract](../../packages/contracts/src/application-session.ts)
has a distinct native target without browser Origin and a fixed native revoke
leaf. Its revocation result confirms remote provider revocation only after the
real owner validates it. [ProjectInvitationAcceptance](../../packages/contracts/src/project-membership.ts)
returns exact Project scope and `grantsDeviceAccess: false`; membership is not
inferred from transport success. The provider's optional
[pending enrollment registration hook](../../packages/contracts/src/deployment-authentication.ts)
is server-private, invitation-gated and returns a still-pending real person.
Unsupported providers fail closed; it neither invents a principal nor changes
browser cookie flows.

The server provider may implement `isVerifiedSessionCurrent(session)`, a synchronous
live witness for a previously verified session. It must re-read session existence, exact
subject and timestamps, expiry and account policy, and reject pending enrollment. It
does not authenticate a caller-supplied session ID and is not part of the public
descriptor. The local-account provider implements it; adapters without it fail closed at
synchronous authority seams. `captureCurrentSession` also pins the verified identity and
cookie and refuses continuation-only authority.

The [relay-management contract](../../packages/contracts/src/relay-management.ts)
exports `RelayInvitationLifetime`, `RelaySetupApproval`, `RelayPendingDevice`
and `RelayManagementView`. The view contains public route/signing-confirmation
facts, channel-specific setup links, exact approved surfaces and pending
account-bound Device candidates; it contains no connector issuer credential.
`approvedBy` preserves actual human actor attribution. `relay:manage`, declared
in [environment security](../../packages/contracts/src/environment-security.ts),
is an explicitly operator-promoted Device scope excluded from presets/defaults.
It admits closed management leaves and does not replace Project roles or grant
Agent, terminal, or Task publication authority. Native account-managed POSTs
use their dedicated host operation, not the generic read signer. For relay
management, account-bound Devices reach only exact leaves through current native proof
and account binding/session, with separate `relay:manage` for management.
Credential-only account-bound Devices remain gated; capabilities return neutral
false without management authority. Contract availability is not a released
native journey receipt.

## Scheduler deferral events

The authenticated `/scheduler/events` stream exposes `job.deferred` as a
public scheduler wire event. Consumers should branch on these fields:

| Field | Meaning |
|---|---|
| `event` | Always `job.deferred`. |
| `job` | Scheduler job name. |
| `provider` | Scheduler provider ID. |
| `id` | Attempt observation ID when available. |
| `reason` | `scheduler_concurrency_limit`. |
| `disposition` | `waiting` while a durable retry remains live, or `released` when a first automatic occurrence is terminal without invocation. |

Older events may omit `disposition`; consumers must treat an omitted or unknown
value as terminal rather than keeping a job running indefinitely. `admitted`,
`stopped`, and `indeterminate` are metric lifecycle dispositions, not
`job.deferred` wire values. See [Monitoring](../guides/monitoring.md) for the
complete metric vocabulary and parked-depth formula.

**Compatibility with older scheduler events.** Station previously emitted `job.deferred` — and
`job.refused` for a manual run — with `reason: 'resource_posture'` plus
`posture` and `busy_percent`, when host CPU load gated scheduled work. Host
load no longer gates any work, so those events are gone: a consumer branching
on `reason === 'resource_posture'`, or subscribing to `job.refused`, will stop
receiving them. `scheduler_concurrency_limit` is the only deferral reason the
built-in scheduler now emits.

## Delegation turn supervision (#2269)

A delegated task's current turn can carry two distinct bounds. Both are PER
TURN — a follow-up turn gets its own budget; nothing here promises an
aggregate limit across a whole task or conversation. Station does not end a
live turn on a schedule it chose itself: each bound exists only when a
server-owned caller declares it, and no production caller does today
([runtime composition](../../src-server/runtime/bootstrap/station-runtime.ts)
builds the Muse adapter with neither `turnIdleTimeoutMs`
nor `turnTimeoutMs`), so production Muse turns carry no Station-imposed
bound. A turn that goes silent is surfaced instead: the stall watchdog's
`progressSilence` (below) shows "No progress from <engine> for 4m" and the stall notice with a
Stop button, and the user decides. The watchdog's window is not armed while a
tool call is open (`tool.started` without its `tool.completed`); the last
call's completion re-arms it, so a long silent tool run is shown as the running
tool, not as silence. On the exec fallback, Stop signals the
child's process group and settles the turn `turn.aborted`; the serve transport
uses its interrupt protocol, described below. The following idle/total timer
details describe the [exec adapter](../../src-server/providers/adapters/muse-adapter.ts).

| Bound | Owner | Semantics | Muse default |
|---|---|---|---|
| Idle (declared) | A server-owned caller that declares `turnIdleTimeoutMs` (none in production today) | A full window with no verified protocol activity — non-empty streamed text, a newly started tool, a tool's task finishing or being cancelled, or a newly identified tool result — ends the turn (`muse-turn-idle-timeout`). It is not armed while a tool is in flight (a `tool.started` whose Muse task has not yet reached `completed`, `failed`, or `cancelled`), nor while background work the turn launched is pending (#2300, below); the task finishing, or the tool's result, re-arms it. A call whose task finished stays open for its result; if none arrives by turn end it is closed with Muse's reported phase (`success` or `error`, with a sentence saying no result was sent), and only a call still running is closed as `unresolved`. In-flight tracking is per call id, so two tasks sharing one `call_id` share it: the first finishing re-arms idle even if the second still runs (disclosed, not handled). Malformed lines, unknown frames, heartbeats, stderr noise, and duplicate completion receipts never reschedule it. Duplicate detection itself is bounded (oldest-first past a per-turn cap): a replay past that retention reads as new activity. | None (was 30 min until #2269) |
| Total (declared budget) | A server-owned caller that declares `turnTimeoutMs` (none in production today) | Wall-clock ceiling from turn start, armed only when declared; activity never moves it. Expiry is `muse-turn-timeout` (unchanged string), attributed to that declared budget. | None |

A declared bound outside (0, 24 h] applies no bound and is logged once — a
substitute bound nobody declared would be the failure this policy removes.
No request, child, or user metadata can choose or extend either bound. Muse
1.3 reports tool starts (#2308), so a long tool call is known work rather
than silence; a deadline's error message never carries Muse's routine
stderr, and the UI names the deadline instead of suggesting a retry.

Background work (#2300). Muse's `workflow` tool returns
`{"status":"launched","taskId":…}` at once and runs the workflow in the
background; `muse exec` then reaches `run_terminal` but keeps running until
the task settles, and delivers the result in an automatic follow-up run
(`command_accepted` from `muse-runtime-background-terminal`) before it exits.
A completed `run_terminal` while the turn is still owed such a report — a
task pending, or settled but not yet reported by a follow-up run — therefore
holds the turn open: the task is a tool row
(`toolCallId: muse-task:<taskId>`, named `<tool>_background`, settled by the
task's final `task_lifecycle` phase), the follow-up run's text and tools are
published on the same turn, and `turn.completed` fires once, at the last
run's terminal, with the composed text. No second `turn.started` is minted.
That Muse also follows up a task which settles before the run that launched
it ends is unverified (the one live capture settles it afterwards). So only
when every task the turn is held for settled before it was first held, no
follow-up run was accepted, and Muse then exits cleanly (code 0, no signal)
does the turn close as it did before #2300 (`stop`, no warning); every other
exit while held gets the warning below.

Neither the idle bound nor any other Station-chosen bound applies while a
task is pending or the turn is held, whatever the turn's declared
`idleLimitMs` says: a held turn runs until Muse finishes it or someone
presses Stop (which signals the process group and closes pending rows
`cancelled`). A held turn with no user to press Stop — a delegated or
Station-initiated turn — therefore runs until Muse finishes it. A total
budget a server-owned caller declares still applies; none does in
production. A held turn that ends any other way (a follow-up terminal that
did not complete, the child exiting first, a declared budget) closes
pending rows `unresolved`, publishes a `runtime.warning`
(`muse-held-turn-unfinished`, carrying Muse's terminal and reason, or the
exit code or signal) and closes the turn with `turn.completed`
(`finishReason` from the terminal, or `other`), never `runtime.error`. That
warning is persisted in the event log and shown in the session diagnostics
log and as a toast; the transcript does not render it.

A turn that launched nothing still settles at its first `run_terminal`, and
a child that lingers after it is still reaped one window after the settle:
the declared idle window, or 30 minutes when none is declared. That reap
bounds a process that outlived its turn, not a live turn. If the
turn ended with background rows closed `unresolved` and the child is later
reaped, the reap is announced as a `runtime.warning`
(`muse-lingering-child-reaped`) rather than done silently. A send that
arrives while the previous turn has ended but its process is still exiting
waits up to 5 seconds for it; past that it is refused with the retryable
code `muse_turn_slot_releasing`, which the client's queue keeps for retry.
If Station already tried to stop that process and could not confirm it
stopped, the send is refused definitively instead (no code): the slot frees
only when that process exits on its own or the lingering-child reap, one
window later, confirms stopping it, after which the message can be sent
again. With no declared idle bound that window is measured from the settle,
so a Stop Station could not confirm is retried 30 minutes after the Stop,
not 30 minutes after the turn's last activity. A send that races a turn that is still running is refused
definitively too (#2415): the adapter refuses it before any effect, so the
dispatch is `rejected` rather than recorded as a possibly-started turn.

A turn the engine opens on its own (#2324), for example Claude answering after
background work finishes, is published as a turn whose `turn.started` and
terminal carry `metadata.trigger: 'provider'`; `isProviderTriggeredTurn` in
`runtime-events` is the one derivation consumers read. It has no prompt, moves
the session lifecycle like any turn (reasons `provider_turn_started` /
`provider_turn_completed`), and records a "Your agent replied" notification
whose interruptions the delivery router decides by focus. A send while it runs is refused with the retryable code
`provider_turn_in_progress`, and the client queues the message until it ends,
unless the send asked Station to hold it (`whenBusy: 'queue'`, below).
A send to an ACP session that is still starting (for a restored session,
reattaching to the engine's stored session) waits for the start, up to 15
seconds, through the optional adapter method `whenSessionReady`. Orchestration
awaits it before taking the thread's turn-start claim, so Stop and End are not
held behind a slow start. The send's cancellation signal ends the wait; that
signal comes only from an explicit Stop or cancel or a server deadline, never
from the client's connection, so a client may close once Station has the
message. If the session is stopped before it is ready, the send is refused
definitively and the client offers the text back. If the start fails, the
send is refused with `provider_session_start_failed`, and the client keeps the
message queued with the reason and Retry without re-sending it on its own. If
it is still starting after the wait, the send is refused with the retryable
code `provider_session_starting`, and the client queues the message and
re-sends it. A retry of the same submitted input whose idempotency key an earlier attempt still holds
waits for that attempt's turn (up to five minutes). If none arrives, or the
attempt released the key without sending, the retry is refused with the
retryable code `client_turn_in_flight` and re-sent with the same key; that
holds however long the attempt has held the key, because its turn may still
be delivered. A retry whose earlier attempt may already have reached the
engine and will never resolve is refused with the non-retryable
`foreground_message_indeterminate` instead, and nothing is sent again. That
happens at once when the attempt's owner died after it began invoking. When
the attempt's engine call failed after it began, it happens only in the
Station process that made the attempt: at once for a new retry, and at the
next poll of the wait for a retry already waiting. Another Station process
sharing the store cannot see that the attempt gave up, so there the retry is
treated as for a held key. When the client's
automatic re-sends run out, the message stays queued with a reason and Retry.
A follow-up sent with `whenBusy: 'queue'` is held by Station instead, in the
conversation's durable inbox (#3568): `POST /chat` answers `202` with a
`ConversationInboxQueuedReceipt`, its `ConversationInboxEntry` says where the
message stands, and the delivery lookup answers `queued` while it waits. See
the [Session API](session-api.md#let-station-hold-a-follow-up).
A Claude send's own `turn.started` is published when the engine starts
running it, so a send queued behind such a turn starts after it ends. That
ordering relies on the CLI's per-message lifecycle frames (`msg_lifecycle_v1`,
reported by claude 2.1.281). A CLI without them runs a send as soon as nothing
else is running. If the engine's own reply began before that send reached it,
the reply can then be attributed to the send: this residual is known and not
closed.

While such a send waits behind the engine's own turn, a Stop from the UI or
the API stops the open turn — the engine's — and the engine then runs the
queued send; a plain interrupt leaves queued sends queued. A queued send is
itself withdrawn (it gets `turn.aborted` and never a start) only when a Stop
names its own id, which happens when Station cleans up a send whose caller
aborted after it was accepted, or interrupts a recovered turn. A queued send
still waiting when the engine ends is recorded with its message and then
aborted (`engine-ended-before-start`).

An ACP send whose attachments the engine cannot take (images when its
`initialize` handshake did not advertise `promptCapabilities.image`, or any
non-image file) is refused before any engine effect with
`ATTACHMENT_INPUT_UNSUPPORTED_CODE` (`attachment_input_unsupported`, from
`provider`). Unlike the retryable codes above it is not retryable: the same send is
refused again. An ACP session whose requested model the engine's own fresh
`session/new` options did not offer (`ACP model value unsupported`, or no model
option at all) is refused by the adapter with `SessionStartRefusedError`,
carrying `MODEL_NOT_ADVERTISED_CODE` (`model_not_advertised`, from `provider`).
An engine that answers `session/new` (or `session/load`) with ACP's
`auth_required` error (code `-32000` with a message beginning "Authentication
required", as the ACP SDK builds it) is refused the same way, carrying
`ENGINE_SIGN_IN_REQUIRED_CODE` (`engine-sign-in-required`, kind `auth`, from
`provider`); the same error on a prompt is that turn's `runtime.error` with the
same code, and chat renders both as a prompt to sign in to the engine.
That type is how an adapter tells the start boundary that its start is settled:
the boundary is released and the receipt is `rejected`, where every other
adapter failure at start stays an indeterminate start that fences the thread. An
adapter throws it only once the engine has answered with a refusal and what it
spawned is torn down (an unconfirmed teardown is an `AggregateError`, an
uncertain start whose end is not announced), and it owes the service the cause and
the end of the session it had announced: a `runtime.error` carrying the code,
then a `session.exited` (`start-refused`, no exit code), because
`session.started` went out before `session/new` answered and the service binds
the thread to the adapter on it. For a fresh start the session's lifecycle then
reads `failed` with the engine's own words, also after a reload, and its binding
is ended, so a resend in the same conversation, whatever it names (another
model, the same one, or no override), continues in a successor session through
the continuation seam. The exit is consumed in order on the adapter's event
queue like any other, so a resend that lands before it has been projected sees
the session still open and fails at the send; the next send resolves a
successor. A Stop that lands during `session/new` ends the session's events as
`stopped` rather than as the refusal (the caller still receives the typed
refusal). A
raw start on the refused session id itself is refused (a different model is a
`session-reattach-conflict`). A model the engine was asked to apply and
answered differently (`ACP model application unverified`) stays an uncertain
start. The nested start claim of a task dispatch and delegation keep their own
conservative uncertainty handling. A refusal raised from a lazy engine start
inside a send (a restored session with no resume cursor but a model) is a
`failed` receipt without the code, and ends with the row `closed`. An ACP steer delivered by the cancel + re-prompt fallback, for
an engine without a native steer method, cancels the running prompt and any
tool it was running. Its steer `turn.started` carries
`steerInterruptedRun: true` so a client can say why that step shows as
cancelled.

Muse through `muse serve` (#2452). The Station runtime drives each Muse
session through one `muse serve` (MSP) host, and everything above about
`muse exec` describes its fallback: a session whose host cannot be used (no
`serve` subcommand, a failed handshake, a protocol schema Station has not
verified, or a host that applied a different approval mode than requested)
runs on exec and publishes a `muse-serve-unavailable` warning, because on
that path no approval can reach Station. On serve, a Station turn ends at
Muse's own terminal (a `cancelled` terminal nobody in Station asked for is
`finishReason: 'cancelled'`, never `stop`); the follow-up turn Muse starts
after background work is adopted as a provider turn as above; tool approvals,
a workflow subagent's included, are `request.opened` events (attributed to
the child by `payload.childWork`). A decision Station records publishes
`request.resolved` (`acknowledgement: 'engine'`), and Muse's own
`approval/resolved` then publishes `request.delivery` `acknowledged` with
Muse's outcome as `engineStatus`; a request Muse closes before Station
decides resolves from `approval/resolved`. Station's serve adapter owns an unanswered-approval
deadline, defaulting to 30 minutes (`muse-approval-expired`), after which it
declines the request and publishes `expired`. That local publication does not
prove Muse accepted the decline: if the engine does not settle it, the adapter
first requests a child stop or turn interrupt, then can end the host after
another bounded wait. These actions produce warnings. See the
[approval owner](../../src-server/providers/adapters/muse-serve-session.ts).
Workflow subagents are `child-work.updated` deltas, and an exec
session reports its child work `not-reported`.

The shared stall watchdog (`TurnStallWatchdog` / `TurnProgressTracker`)
defaults to three minutes. An Agent's positive, finite
`execution.turnStallWindowMs` overrides that window; absent or invalid values
use the default. It stays observe-only: its `progressSilence` marker says
no progress was *observed* — quiet providers (for example a Muse build
older than 1.3, which emits no `tool.started`) may be working quietly, and
the marker must never be rendered as proof of a stall. It keys on the
events the parent turn publishes (streamed text, reasoning, tool start,
progress and completion, or a session-state transition). A tool in flight does
not suspend it. `request.opened`, including input requests, suspends observation;
`request.resolved` restarts it. So a Muse turn whose subagent is waiting on
something writes only to that subagent's own session log, not to the
parent's stdout, and reads as silent after the window, which is the
signal the user acts on now that no idle timer ends it.

The source route is the [window resolver](../../packages/contracts/src/turn-stall-window.ts),
[watchdog](../../src-server/services/orchestration/turn-stall-watchdog.ts), and
[progress projection](../../src-server/services/orchestration/turn-progress-tracker.ts).

An interrupted adapter event consumer is also observation loss, not a turn
terminal. The shared consumer publishes `runtime.warning` with code
`adapter-event-stream-interrupted` and resumes consumption without changing
the affected turns' lifecycle or dispatching replacements. Only subsequent
engine evidence establishes completion or failure. This applies across engines.
Before that, a publish that fails on event-store contention (the SQLITE_BUSY
family; SQLITE_LOCKED is not retried) is retried for the same event, with the
same `eventId`, at most twice before the next event is consumed. When the
failure was the delta coalescer's flush of text buffered before that event,
the text is kept, with no window timer, and the retry delivers it first. Once
no retry is in flight its window timer is re-armed, so text left after
exhausted retries is flushed by that timer; a timer flush that still fails is
dropped with a warning, as before. An event that already committed is never
replayed, and no flushed text contains the delta being offered, so a retried
delta is never stored twice. Any other failure, and exhausted retries, are the
observation loss described above.
A failed append changes no shown or durable state that the event justifies.
The session row and a provider-started turn's boundary row are written inside
the event's own append transaction. The read model, the turn-progress and
child-work projections of the published event, client-origin retirement, a
pending cooperative stop and the live bus frame change only after the append
commits. Two admission steps run once per event, before the append, by design:
the stall watchdog observes raw text deltas as the engine produces them, and a
turn start consumes the client origin its send reserved. A retry recomputes
the event's lifecycle stamp from the state at that attempt.
Muse tool results use the shared bounded output projection before persistence;
an `outputReceipt` records truncation and whether full output is available.
EventStore's 64 KiB ingress ceiling remains a last-resort rejection boundary.

Surfaces (`orchestration.ts`: `TurnSupervisionFacts`; delegation
`snapshotFor` → `DelegatedTaskSnapshot`
`supervision`/`reason`/`transitionReason`; `station delegate status`):

- Supervision facts are forwarded from the owning adapter's own
  `turn.started` declaration (matched to the live watchdog observation by
  `turnId` identity, and dropped when the declaration's provider disagrees
  with the session's own projected provider). A stale prior turn's facts
  and a malformed declaration are dropped. The status event window is
  bounded, so a very long turn's start event can age out — that reads as
  honest unknown, never a repaired policy. Adapters that declare no
  supervision omit it. Each bound is forwarded only when declared: a
  declaration with no total budget has no `deadlineAt`, `remainingMs`, or
  `totalLimitMs`, and one with no idle bound has no `idleLimitMs`. Muse's
  production declaration carries neither, and `station delegate status`
  prints "Turn budget: none declared for this turn" and "Idle limit: none
  declared for this turn". A declaration carrying only half of a total
  budget, or a present but malformed bound, is dropped. Nothing derives a
  deadline from RPC timeouts or metadata.
- `reason` is allowlisted and re-synthesized, never forwarded as-is. The
  lifecycle fold classifies a budget-killed turn as `runtime_error` first
  (its message is always non-empty), so the terminal `runtime.error`
  event's code is read to keep idle (`muse-turn-idle-timeout`) distinct from
  absolute (`muse-turn-timeout`) expiry; only those known budget codes keep
  a detail, and it is host-authored fixed text. Unknown provider errors
  stay a redacted generic code with no detail; raw event messages,
  attribution details, and provider logs are never forwarded.
- `transitionReason` crosses only when it names the
  `SessionTransitionReason` vocabulary; anything else is dropped.

The [delegation projection](../../src-server/tools/station-control-delegation.ts)
and [CLI formatter](../../packages/cli/src/commands/delegate.ts) own these
bounded status fields. Protocol version numbers and captures cited above are
historical observations, not a claim that a current installation runs those
engine versions. Adapter fixture tests and real-provider journeys provide
different evidence.

## Provider plan quota (#2265)

A provider coding-plan quota exhaustion is a provider limit, not a Station
budget and not a transport outage. When an ACP engine's `session/prompt`
rejects with the evidenced quota shape (observed: OpenCode reporting ZAI
plan exhaustion as a JSON-RPC request failure), the owning adapter
classifies it at the terminal rejection seam
(`src-server/providers/adapters/acp-adapter.ts`, via the engine-neutral
`src-server/providers/provider-plan-quota.ts` helper, which is currently
wired only to that observed shape) and publishes `runtime.error` with:

- `code: 'provider-plan-quota-exhausted'` — the allowlisted code the
  delegation `reason` and events projections branch on;
- fixed safe `message` (`The provider plan quota was exhausted; the engine
  refused the turn.`) — the engine's raw text and any co-reported
  notification text never cross;
- bounded `details`: the plan window (`quotaWindow`, e.g. `'5 hour'`),
  the provider-reported reset text (`resetReported`, civil timestamp with
  NO timezone), `resetPrecision: 'unqualified'`, and a qualified
  `retryAfterMs` only when one was genuinely supplied alongside the
  failure (none is supplied on the observed wire, so it stays absent).

The terminal publication names the failed `turnId`, so the reason seam can
scope the quota to the current turn: a successful continuation or a newer
unrelated failure ends the quota story instead of reviving it. The
lifecycle fold still classifies the session as `runtime_error`
(failed, resumable); the quota code keeps plan limits distinct from
Station's per-turn idle/total supervision budgets and from generic
transport errors, which stay a redacted generic with no detail.

Bounds: the window must be a positive whole-hour count (`0 hour` stays
generic); the reset day must exist in its month (February 31 and February
29 on a non-leap year stay generic — display-only calendar plausibility,
never a timezone or epoch); the protocol code must be a finite number.

Session notice: the lifecycle fold's terminal attribution composes the
same fixed guidance from the re-validated facts (window, reset text
labelled timezone-less, wait/check then continue explicitly), so the
existing session failure notice (SessionsView, Home) renders it with no
UI changes and no raw provider text. A quota-coded terminal with forged
details falls back to the generic fixed copy.

Surfaces (`snapshotFor` → `DelegatedTaskSnapshot.reason`;
`projectDelegatedTaskEvent`; `station delegate status`/`events`/`wait`):

- `reason` carries the quota code, host-synthesized fixed guidance
  (wait for the reset or check the provider plan, then continue
  explicitly — Station never retries, switches models/providers, or
  spends on a fallback), and the re-validated bounded facts. Forged or
  malformed details read as the bare code.
- Delegated events project the same fixed copy plus validated facts;
  unknown quota-shaped claims stay `The delegated runtime reported an
  error.`
- `station delegate status` (and `wait`'s summary, which reuses it)
  prints the reason plus `Provider limit window` and
  `Provider-reported reset … (no timezone given; wait before continuing)`
  lines. The reset text is repeated verbatim for display — never parsed
  as UTC/machine-local, never a countdown, never an invented instant.

Follow the [classifier](../../src-server/providers/provider-plan-quota.ts),
[ACP rejection caller](../../src-server/providers/adapters/acp-adapter.ts),
[lifecycle attribution](../../src-server/services/orchestration/session-lifecycle-service.ts),
and [delegation projection](../../src-server/tools/station-control-delegation.ts)
for the implemented boundary. This classifier recognizes the named wire form;
it does not discover every provider's quota policy.

## Compatibility

`conversation-pull-request-links` defines exact provider, host, repository, and
native-ref identities for Conversation links. Explicit links, branch-derived
associations, and Task-kept declarations retain distinct `source` values.
Provider refresh results carry an observation time and either current state or
an explicit unsupported/unavailable reason. `PullRequest.headSha` and
`baseSha` are optional because a provider that omits exact revisions must not
be presented as current by inference.

`TaskRecord.closeOnMerge` is optional and absent means off. It is a person's
opt-in to move a Task to `done` when every pull request kept on it is merged;
a Task store that carries it is refused by Station builds that predate it.

`@kontourai/station-shared` still re-exports many of these types so older code can compile during convergence. That is a compatibility layer, not the canonical ownership model. New code should import the owning `@kontourai/station-contracts/*` module directly.

Server-only provider interfaces now live directly in `src-server/providers/provider-interfaces.ts`, `src-server/providers/provider-contracts.ts`, and `src-server/providers/llm/model-provider-types.ts`. The old `src-server/providers/types.ts` barrel was removed during convergence.

### Task deliverable and work-chat relationships

`task-graph` exports `TaskIdentity` (`taskId`, `taskCreatedAt`),
`TaskParentMutationInput`, `TaskChildCreateInput`, and
`TaskWorkChatMutationInput`. A child stores one optional `TaskRecord.parent`
and a monotonic `relationshipRevision`; children are found by reverse lookup.
These relationships do not roll up status or start execution.

The dedicated `createTaskRelationshipRoutes` factory exposes child creation
and listing, parent attach/reparent/detach, and work-chat link/list/unlink.
Runtime mounting and current authority adapters are integration prerequisites.
Each mutation uses an operation ID, exact incarnation, and expected revision
(except atomic child creation). TaskGraph reloads and validates under its
existing cross-process lock. Receipts retain the exact request fingerprint
and original result. Replaying an old attach after detach returns its receipt
without restoring the relationship; changing its payload conflicts.

The injected authority binds the expected canonical Project incarnation,
normalizes Project IDs/slugs, and checks current mutation/read capabilities.
Ancestor corruption, missing incarnations, cycles and cross-Project references
fail closed. Child listings contain only currently readable children, with no
hidden-child count or unavailable sentinel.

Work chats persist the Task incarnation and canonical `conversationId` with a
revision and linked state. They never replace `TaskRecord.sessionId`, create a
`spawned_session` link, grant access, or publish private followups. Runtime must
use `conversation-open-resolver` to establish current Conversation lineage and
reader capability; a Session ID or inventory row alone is insufficient.
Work-chat listings expose only currently readable canonical IDs and revisions.
`ProjectSharedTaskService` remains the separate default-private publication
owner. See the real-store relationship and mounted-route tests for the local
persistence/transport boundary; these do not qualify production composition.

### Conversation measurements

Per-model rows in `ConversationStatsResponse.modelStats` use optional token,
context, and cost measurements, matching the conversation-level response.
`turns` and `toolCalls` remain required counts. Clients that previously required
every model measurement must handle absence as unreported, distinct from a
measured zero. The server projects the stored null cost marker to an omitted
wire field; supplied null, negative, or non-finite wire measurements remain
invalid under `parseConversationStatsResponse` in the `runtime` subpath.
The [wire parser](../../packages/contracts/src/runtime.ts) checks those numeric
fields; the [server projection](../../src-server/runtime/conversation/conversation-stats-view.ts)
owns the storage-to-wire conversion. Neither proves that an engine measured
every token or that an estimated cost matches a bill.

### Source-only learning inspection

`LearningSourceObservation` on the `learning-review` subpath is a separate,
source-only outcome. An observed record exposes its exact registered store and
record IDs, source fields and provenance, plus a Station observation digest/time.
It supplies no candidate kind, deployment scope, owner projection identity,
promotion verdict, or effect result. Generic record `active` is not learning
activation. All restricted/unavailable/refused outcomes omit source identity.
The full `LearningReviewProjection` lifecycle contract is unchanged.

`OrchestrationQuoteSource` on the orchestration subpath is the versioned,
bounded exact-answer quotation read: Session, turn, message, text and SHA-256
text revision. It conveys no authorization grant or evidence verdict. The
quote-source HTTP route checks current read authority before and after owner
I/O and refuses oversized text instead of returning an incomplete source.

`PullRequestReviewSnapshot` on `pull-request-provider` binds provider-supplied
review content to an observed head/base pair and timestamp. Diff availability
and discussion completeness are explicit; a provider diff is not a claim that
all binary or oversized content was returned. Optional provider methods preserve
compatibility with adapters that do not implement in-app review.
`PullRequestReviewInput.expectedHeadSha` binds approvals to the inspected head.
`PullRequestReviewOutcome` distinguishes confirmed acknowledgements from refused
and indeterminate attempts. A forge review is not a Station gate verdict.
`PullRequestMergeInput.expectedHeadSha` optionally constrains merge admission to
the inspected revision; review-origin merges observe the resulting provider state.
The snapshot's optional `checks` and `reviewComments` are observations too.
`checks` lists the provider's CI for the observed head (GitHub's check runs and
commit statuses, GitLab's head pipeline only when it ran on that head); an
entry the reader cannot classify makes it `partial` rather than guessed, and
so does a GitHub rollup beyond the reader's 1000-context payload cap (`gh pr
view` pages the rollup itself; the cap bounds the snapshot, and only a rollup
past it is cut). A GitLab merged-results pipeline runs
on a merge commit the merge-request payload never names, so it is reported
`unavailable` with that reason rather than tied to the observed head.
`reviewComments` carries inline comments with their diff side and line, `line`
null once the forge no longer maps the comment onto the diff; `subject` is
`file` for a comment on the file as a whole, whose `line` is null without being
outdated. Either field absent means the server did not observe it, and
`unavailable` carries the reason; neither is an empty list standing in for
"none".

`PullRequestBranchMergeability` on `pull-request-provider` is a conflict
indicator's read: one open pull request's ref, source branch, optional
`sourceOwner` (GitHub's head repository owner), and mergeability,
and nothing a review needs. The GitHub adapter serves at most 100 and refuses
a longer list as unavailable rather than serving part of it. The optional
`IPullRequestProvider.listOpenPullRequestMergeability` answers it for a
repository; the route refuses a provider without it rather than falling back
to the full list. See the [GitHub adapter](../../src-server/services/pull-requests/github-pull-request-provider.ts).

`PullRequestClientContext.pushTargetOwner` optionally reports the local branch's
configured push repository owner. The resolver chooses `branch.<b>.pushRemote`,
then `remote.pushDefault`, then the branch's upstream remote, then `origin`,
and reads `git remote get-url --push` so a `pushurl` is honored. This does not
change the repository resolved for PR reads. Unrecognized push URLs, detached
checkouts, or failed push-target reads omit the owner. `/context` projects only
declared client fields; checkout paths and PR-opening head/base facts stay private.

The session conflict chip matches the local `branch`, never the upstream branch
name. When both owners are known it also requires `pushTargetOwner` and
`sourceOwner` to match case-insensitively. Missing either owner retains branch-only
matching. GitLab does not report `sourceOwner`, so its behavior is unchanged.
See the [resolver](../../src-server/services/pull-requests/pull-request-repository-context-resolver.ts)
and [chip integration tests](../../src-ui/src/__tests__/SessionPullRequestConflictChip.pushurl.test.tsx).

`AttentionInputReplyContext` on the attention subpath projects one exact open
input request's reply binding and declared file/image transport. `needs_input`
items may carry `inputReference`; approval/permission references keep their
separate meaning. `needs_input` and `review_pending` items may also carry the
optional `environmentKind: 'peer'` and `environmentName` fields
(`AttentionSessionEnvironment`). They mark a delegated task that runs on a
paired Station, where a local reply cannot reach it. The fields are additive.
Their absence means the task runs on this Station, or the server predates them.
`peerRequestReference` names the paired Station's open request (`environmentId`,
`taskId`, `requestId`, `requestType`), and `viewerCanRespond` reports this
Station's checks on the delegated `respond` route. Both are additive and
optional; neither feeds the local request routes. The source is
`OrchestrationDelegationContext.peerPendingRequest` on the orchestration
subpath, copied from the paired Station's status read and never derived here.
With the `delegatedInputAnswers` capability (`StationCapabilityFlags` on the
environment-security subpath) the reference also carries the paired Station's
`threadId`, `requestEventId` and `callerCanRespond`, and
`OrchestrationPeerPendingRequest` the matching `eventId`, `threadId`, `body`
and `callerCanRespond`. All are optional; their absence means an older Station
or no report, and clients then offer no bound answer. `OrchestrationSendTurnInput.expectedInputRequest` is a
constraint, not a grant, and is removed before the adapter receives input.

The [orchestration routes](../../src-server/routes/orchestration/orchestration.ts)
and [dispatch owner](../../src-server/services/orchestration/orchestration-service.ts)
apply the quotation and input-request checks. Source-only learning inspection
uses the [knowledge route](../../src-server/routes/knowledge/knowledge-source-routes.ts)
and its host-authorized owner, while
[forge review](../../src-server/services/pull-requests/pull-request-review.ts)
and [Conversation links](../../src-server/routes/pull-requests/conversation-pull-request-links.ts)
have separate owners. Their public types describe observations and request
constraints; they do not by themselves authorize a read or external write.

## Mobile device inspection

`@kontourai/station-contracts/mobile-device` owns `MobileDeviceTarget`,
`MobileDeviceSummary`, `MobileDeviceInventory`, and `MobileDeviceCapture`.
Host/device IDs are descriptive and carry no credentials, paths, or execution
authority. A capture is one observed frame, not stream health or app/build
identity. The contract also exports the pure `isMobileDeviceHostId` grammar
check; full response and request validation belongs to the helper, route, and
SDK boundaries;
see [Mobile device inspection](../guides/mobile-device-workspace.md).

## Native push registration

`@kontourai/station-contracts/native-push` owns the agent-activity push
registration routes (`NATIVE_PUSH_REGISTER_PATH`,
`NATIVE_PUSH_REGISTRATION_PATH`), the Android package allowlist the push
gateway delivers to, and the request/response shapes.
`NativePushRegistrationStatus`, the `GET` answer on
`NATIVE_PUSH_REGISTRATION_PATH`, carries only `registered` and the caller's
own `registrationId`, never a token or key. The registration response's
`registrationId`, `stationId` and `stationKey` are public identity checks for
incoming pushes; none of those three is a credential. The response also includes
`payloadKey`, a secret 32-byte AES-GCM key the phone uses to open sealed content.
Do not log or expose the full registration response. Android package and iOS
bundle allowlists are separate constants.

The [registration route](../../src-server/routes/operations/native-push-routes.ts)
requires the caller's paired-device identity and agent-activity eligibility;
an operator bearer alone is insufficient. Hosted mode disables these routes.
Registration records configuration and invokes the publisher callback; it
does not confirm gateway acceptance or delivery to a phone. See
[Notification delivery](../design/notification-delivery.md#station-contract).

## System status and update provenance

`HostResourceSnapshot` describes point-in-time host memory and the answering
Station process's PID, uptime, RSS and JavaScript heap. The resource-posture API
adds it optionally; its observation timestamp is independent of the cached CPU
sample. It is display-only and carries no execution or admission authority.

`@kontourai/station-contracts/system-status` owns `DevicePresentation`
(the request-bound host/paired projection), `SystemRuntimeIdentity`
(the answering server's `instanceId`/`bootId`/`sha` triple with an optional
`shaSource` label), `SystemIdentityResponse` (that triple plus an optional
`devicePresentation`), and `UpdateProvenanceIssue` (`missing` or
`invalid-stamp`). All three identity fields are required for an identity:
a server that cannot prove the whole triple reports unavailable rather than
serving a partial answer. `shaSource` names what computed `sha` — a
checkout-derived value is labeled, never presented as the build's identity.
`UpdateProvenanceIssue` is a typed reason minted by the server's install
provenance resolver; consumers render from the code and never re-parse it out
of prose. `ServiceUpdateProgress` (with its `ServiceUpdatePhase`) is the
service launcher's update state for a prebuilt-archive install, as
`GET /api/system/core-update/service-update` reads it from that install's
runtime files. Since #3851 it also carries:
- the `staged` state;
- an optional request `intent` (`stage`, `apply` or `update`);
- the staging phase (`ServiceStagePhase`) and its byte counts.

The module also owns the server's own view of its update:
`ServerUpdateState`, `ServerUpdateRunningTurns` and
`ServerUpdateDownloadPolicy`. `GET /api/system/core-update/state` serves that
view, and the `runtime-events` `server-update:changed` event carries it.
Runtime parsing of these shapes lives at the route and SDK
boundaries, not in this package.

The deployment authentication descriptor's optional `externalLogins` lists
operator-configured browser identity choices, their declared POST begin-login
paths and availability. These are presentation/capability facts, not identity
claims, Device grants or Project membership. Secret references and provider
configuration remain private to Station's operator composition.

### Engine account observation history

`EngineAccountUsage.history` optionally exposes 30 days of hourly allowance
observations, including unknown readings as gaps. It stores no raw responses,
identity values or credentials. `UsageReceipt.accountKey` is an optional opaque
engine/profile observation from the applied process environment. Its absence
means account attribution is unknown; consumers must not infer the current
active account. These fields are observations, never billing or routing authority.


### Retained usage statistics

`@kontourai/station-contracts/usage-stats` owns `UsageStats`, `DailyStats`,
`ModelUsageStats`, `UnallocatedUsage`, `TokenReports` and `EngineUsageCoverage`.
These are read-only projection shapes, not storage or authorization APIs.
Current sums reflect retained source facts and can decrease after correction or
deletion. `legacySummary` is separate unverified evidence. `unallocated` keeps
unknown date, model, principal and provider attribution visible; recorded identity
never grants access. `tokenReports` distinguishes a contributing measured zero
from an unmeasured compatibility sum. Optional reported and estimated USD amounts
retain their separate evidence scopes. See the
[Profile measurement scopes](../guides/monitoring.md#profile-usage-and-paired-people)
and [analytics rescan](api.md#rescan-analytics).

Recorded principal buckets are returned only by the authorized instance-operator
route. Ordinary analytics and rescan responses omit `byPrincipal`.

### Usage observation provenance

`@kontourai/station-contracts/usage-rollup` owns `UsageReceipt`, `UsageCoverage`,
and `UsageRollup`. A receipt's optional `sourceSequence` is durable order within
its Station/thread, not a provider-clock timestamp or an authorization grant.
Same-source cumulative replacements use that order and preserve omitted
measured components. Older peers can omit it and retain timestamp ordering.
Sparse or mixed-model/pricing evidence cannot substantiate a combined estimate.
`aggregateReceipts` is bounded logical transfer material, separate from the
receipt drilldown. See the [analytics API](api.md#read-usage-receipts-and-rollups)
for limits and observation-window semantics.


## Immutable Task output review

`@kontourai/station-contracts/project-task-room` defines
`ProjectTaskRoomOutputFeedback`: `kind: 'output-feedback'`, an exact
`target: {outputId, digest, taskCreatedAt}`, `review` and nonempty `text`.
The digest is `sha256:` plus 64 lowercase hexadecimal characters and the Task
creation time is canonical ISO UTC. Review values are `comment`,
`changes-requested` and `accepted`; all are human speech, never a Task status
transition or workflow approval. The browser DTO retains this target and the
attributed human actor in ordinary room history.

Room records accept legacy `station.project-task-room/v2` and new
`station.project-task-room/v3`; output feedback requires v3 and an operator
principal. Existing records retain their exact bytes and integrity digests.
See the [API review contract](api.md#review-an-immutable-task-output) for the
per-room old-writer fence and permanent duplicate identity behavior.

### Keyed orchestration send identity

The provider contract exports `CLIENT_TURN_INPUT_CONFLICT_CODE`
(`client_turn_input_conflict`). Existing keyed orchestration sends return this
nonretryable refusal when a known original submission digest differs. This is
an additive code, not a requirement for keys on all routes. The server captures
the digest; clients cannot supply it as provider metadata. Legacy input proof
and mixed-version limits are described in
[TurnDeduplicator](../architecture/module-map.md#turndeduplicator).

## Engine durability declarations

`ProviderDurabilityProfile` in the provider contract declares nine required cells:
steering placement, crash continuation, tool replay, pending approvals, context
carriage, fork, compaction, partial output and usage. Each cell identifies current
fidelity (`native`, `emulated` or `none`) and its user-facing limit. Compaction
also declares its owner (`station`, `engine` or `unknown`) independently of
Station's crash-recovery support. These are
delivery declarations, not permission to replay an effect with an unknown outcome.

Built-in adapters expose the profile in their metadata. The engine capability
matrix carries the same profile for clients that describe an engine before a
Session exists. Legacy third-party adapter metadata may omit it; omission is
unreported capability, never inferred support. Built-in adapter conformance
rejects omitted cells.

The engine description's **Recovery and delivery** disclosure reads these cells.
Claude and Codex declare their live steering channels as native. ACP discloses a
connection-dependent orchestration-command fallback that may interrupt and
reprompt; the ordinary chat composer does not offer ACP steering. Live steering does
not imply restart safety: no current profile promises mid-turn crash continuation,
automatic tool replay or durable approval waits. Context supplied by Station has
no accepted-through acknowledgement, and usage remains engine-reported where
available. The unknown-engine profile does not infer context, output or usage
support.

This profile does not replace existing continuity capabilities or migrate existing
provider-specific execution paths. Durable inbox placement, accepted-through
context delivery and crash-durable model/tool steps have separate implementation
owners. Profile claims must change with their adapter behavior and proof.

### Pull request review guides

`@kontourai/station-contracts/pull-request-review-guide` owns the guide,
stop, excerpt, run, and result shapes. Completed guides name `headSha`,
`generatedAt`, `modelSelection`, and ordered `stops`. Runs are `Running` or
`Failed`. Results carry `currentHeadSha` independently of the guide head and
validated `excerptContents` for rendering. Stale results omit line anchors.
The [user guide](../user/pull-request-guides.md) describes generation and limits.


## Publisher analytics declarations

`@kontourai/station-contracts/plugin-telemetry` owns
`PublisherTelemetryDeclaration`, `PluginDailyPing`, `PluginTelemetryEvent` and the Full `PluginTelemetryBatch` envelope.
The declaration is reusable by future distribution manifests. The
[shared parser](../../packages/shared/src/plugin-telemetry.ts) owns runtime bounds,
canonical inventory fingerprints and the independent plugin data revision.
`parsePluginDailyPing(payload, declaration, namespacedPublisher)` requires exact declared event/property
histograms and rejects identifying/undeclared fields. Broker acceptance is deferred.
See [Publisher analytics](../guides/plugins.md#publisher-analytics).

## Project Room contracts

`@kontourai/station-contracts/project-room` owns Room identity, messages,
checkpoints, note revisions and explicit Agent request records. Its scope is
the existing `ProjectMembershipScope`, without a synthetic Task ID. Browser
views and strict wire parsers live in the `project-room-browser` subpath.
Actor attribution comes from authenticated server authority, not message text.
Message intent IDs are scoped to the Room and author; exact retries retain one
result and changed payloads conflict. Notes use expected-revision comparison.

The limits distinguish a 16 KiB message/request, an 8 KiB note, a 512 KiB history
page and bounded retained records. A valid message count can still require
byte-based continuation. Persisted DTOs are checked against SQLite identity
columns before delivery or Agent context use. Agent capture identity and digest
must match its durable request before private Session reads or cancellation.
An accepted request is not proof of execution or publication. Ambiguous launch is not
replayed automatically. A bounded runtime completion observer or explicit reconciliation
may publish the exact completed answer after current requester, Project, execution-root
and capture checks. Observation credentials are not durable; restart requires fresh
authorized recovery. SSE is an interchangeable notification transport,
not the owner of message order, durability, authority or Task hierarchy.

Explicit Room Agent requests capture only Task summaries already shared to the
Project, even for an operator. The immutable snapshot includes Task/share
identities, title, status and observation time, with shared-subset coverage;
it includes no private Task counts, descriptions or inferred goals. At most
16 summaries and 4 KiB of Task evidence fit within the existing context budget.
Unavailable or omitted evidence is labeled rather than treated as an empty
Project. Exact share and Task incarnations are checked before dispatch and
publication. Short owner fences coordinate TaskGraph, sharing and Room writes;
no such lock spans provider execution. Unsharing can withhold a pending answer,
but does not retroactively redact text already published in the Room.

See [Room HTTP operations](api.md#shared-project-room) and the
[SDK](sdk.md#shared-project-room).

## Project knowledge registration ownership

`ProjectStartIntent` names initial `workspace | knowledge | connections | blank`
setup guidance. It grants no source or execution authority. The browser's
optional creation-recovery intent is separate from the server Project draft and
is retained across reload; older pointers default to workspace behavior.
`RepositoryProviderPage` and `RepositoryProviderSelection` describe a bounded
observed forge account page, including explicit clone transports. They are
discovery metadata, not acquisition or credential availability receipts.

The `project` subpath also owns `ProjectS3Source`,
`ProjectS3ObjectReference`, `ProjectS3ObjectPage` and `ProjectS3ObjectRead`.
A source has an immutable UUID and durable Project ID plus bucket-owner account,
region, bucket and prefix. Public projections omit the host credential-profile
name and actor. Object pages expose continuation/truncation, while reads retain
ETag, optional returned version, SHA-256, observation time and citation. These
shapes describe bounded live reads; they confer no write, execution or indexing
authority. The implementation remains default-off pending AWS acceptance.

`KnowledgeStoreRoot.projectId` is an optional durable Project binding. Older
registrations omit it; member access never infers it from `scope.projectSlug`.
The pure `isProjectKnowledgeRoot(root, projectId)` helper owns matching for
Project recall and tool delivery. `knowledgeRootIncarnationKey` includes the
binding, while remaining a metadata precondition rather than a generation proof.
The provider's optional `attachRootToProject` capability binds only an exact,
unbound legacy registration after explicit operator selection; older providers
remain source-compatible and report the missing capability.

`KnowledgeDocumentImportInput` names a UUID, exact `expectedRoot` and up to
eight filename/base64 document pairs. `KnowledgeDocumentImportReceipt` reports
per-file SHA-256, byte count, stable canonical record identity, original
availability and publication phase. Limits are exported as
`KNOWLEDGE_DOCUMENT_MAX_BYTES` (256 KiB),
`KNOWLEDGE_DOCUMENT_BATCH_MAX_BYTES` (1 MiB) and
`KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES` (8).

The optional provider `withRootRevision(expectedRoot, operation)` runs bounded
work while the persistence owner holds the exact registration revision. Older
providers may omit it; document import refuses when registration locking is
unavailable. This lease preserves source identity, while the server's scoped
write authority separately checks the current request at physical file effects.
It is not a grant to import or a file-content version.
