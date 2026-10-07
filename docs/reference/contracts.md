# @kontourai/station-contracts

Canonical cross-package contract ownership for Station.

Use `@kontourai/station-contracts/*` when you need stable API/domain shapes shared across `src-server`, `packages/sdk`, `packages/cli`, plugins, or tests. New code should import these modules directly instead of reaching through `@kontourai/station-shared`.

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

## Modules

| Module | Owns |
|---|---|
| `@kontourai/station-contracts/engine-accounts` | Secret-free engine account, quota, optional identity/credit/model/spending/breakdown metadata and bounded capture-audit projections, plus provider-owned login; runtime validation stays in SDK consumers |
| `@kontourai/station-contracts/acp` | ACP connection config and ACP connection status values |
| `@kontourai/station-contracts/agent` | Agent specs, metadata, tools, slash commands, the versioned Agent audience and the member Agent view |
| `@kontourai/station-contracts/agent-plugin` | Agent Plugins 1.0 schema identities, name grammar, and Station extension declarations |
| `@kontourai/station-contracts/skill-experience` | Inert v1 Skill definitions and explicit stage/rich-pane declarations, host-observed inventory identity, canonical start inputs and retained Session invocation views; see [experience contract](skill-experiences.md) |
| `@kontourai/station-contracts/attention` | Attention projections and exact approval/permission request references and inspection states |
| `@kontourai/station-contracts/auth` | Auth status, renew results, user identity/detail models |
| `@kontourai/station-contracts/authority-observation` | Closed credential-bound authority observation: current home identity, resolved principal echo (kind+id only), and verified grant tier; authorization-neutral, grants nothing |
| `@kontourai/station-contracts/automation` | Automation sources (GitHub poll and webhook), the source-safe projection without the webhook secret, source grants, exact-equality string matchers (event fields are strings; numbers arrive as canonical decimal strings; an empty `where` is refused), rules, episodes, the closed delivery outcomes and the subset that takes part in semantic dedupe, `AUTOMATION_EXECUTION_LIMITS`, the GitHub event allow-list and the `AUTOMATION_OPERATOR_SURFACE` parity table, whose mutations have no MCP verb. Shapes only: the server validates and stores them, and no route, intake or dispatch consumes them yet |
| `@kontourai/station-contracts/application-session` | Device-bound account continuations, explicit capabilities, public proof keys and challenge/credential projections; no Device or Project grant |
| `@kontourai/station-contracts/native-device-proof` | Native Device request-proof version, header, approved binding, exact one-use claims and the host-proposed binding candidate (provisional canonical UUIDv4 ID, approved Device ID, full surface and Device public JWK; no secret); `NativeDeviceProofBindingReadbackV1` projects operator-only historical binding data and separate current Device-binding status; `NativeDeviceProofSelfReceiptV1` reuses that public tuple for the owning current Device bearer through a distinct protected read; `NativeDeviceProofSelfReceiptErrorV1` versions its closed lookup/refusal codes so an unrelated HTTP error cannot establish binding absence; protocol data grants no Device, account or Project authority and supplies no runtime admission |
| `@kontourai/station-contracts/relay-enrollment` | Fresh relay-only account enrollment, finalize-delivery and signed-activation bindings; a pending identity receives no active Device authority before the exact delivered bundle is acknowledged |
| `@kontourai/station-contracts/native-relay-enrollment` | Native challenge/candidate, fixed HPKE recipient, ciphertext delivery, signed activation/status, retained fixed request and owned transition/resume DTOs. Declarations grant no authority; server/native/UI owners compose them separately, and no Device bearer crosses renderer IPC |
| `@kontourai/station-contracts/native-relay-link` | Closed v1 public route intent or unchanged native v2 invitation envelope, untrusted origin hints, fixed native channels and secret-free host delivery metadata/opaque handles; no trust, person, Device, Project or compute authority |
| `@kontourai/station-contracts/deployment-authentication` | Public operator-installed authentication provider configuration, factory, descriptor, operations and verified account-session results; see [deployment authentication](../guides/deployment-authentication.md) |
| `@kontourai/station-contracts/catalog` | Registry items, install results, skills, guidance assets |
| `@kontourai/station-contracts/child-work` | Provider-neutral child work (engine subagents and Station delegates): items, deltas, the session read model, and the one pure reducer over them. An item's optional `model` is the child's own model with its `source` (never the parent's), and `transcript` names the engine records its read-only transcript is served from. `usageProvisional` marks a terminal child whose usage still holds figures from while it ran; settles that report usage replace its running fields, and a field a settle reported stays sticky, even while `usageRunningFields` names other fields still running. `childWorkSettleFromItem` restates a stored settled item as a settle that keeps both, for seeding a registry from history or a session view |
| `@kontourai/station-contracts/thread-usage-tree` | A conversation's usage tree: own figures, each child's usage relation to its parent (`added`, `included-in-parent`, `not-reported`) for tokens and cost, and a roll-up total that names what it leaves out |
| `@kontourai/station-contracts/cloud-move` | Cloud preparation target/inventory, enrolled target observations, unavailable-transfer projection, and workspace package capture/inspection/verification receipts |
| `@kontourai/station-contracts/registry-trust` | Candidate registry policies, bounded applied identity/epoch shapes, and untrusted signed-package claim shapes |
| `@kontourai/station-contracts/config` | App config and template variables |
| `@kontourai/station-contracts/connection-proof` | Transport-only Station/enrollment/client/SDP bindings and independently approved signing-key trust; never account or Project grants |
| `@kontourai/station-contracts/connection-quota` | Provider-reported quota snapshots, explicit unavailable outcomes, and pure rolling-observation merging; absent provider data stays absent |
| `@kontourai/station-contracts/self-hosted-broker` | Versioned browser Origin scope, native proof-key surface and distinct v2 native offer metadata and closed invitation-authenticated older-scope observations; routing authority is separate from signing trust, account identity and Project permission |
| `@kontourai/station-contracts/relay-ice` | Closed relay-only short-lived end-user ICE receipt, exact native scope/optional surface, issue/expiry times and a 600-second ceiling; no issuer secret or application/Device/account grant |
| `@kontourai/station-contracts/execution-preparation` | Version requirement, typed refusal codes and path-free receipt for version-matched portable execution; see [remote execution preparation](../design/remote-execution-preparation.md) |
| `@kontourai/station-contracts/execution-target` | Environment, Agent and workspace intent, including exact portable Project/resource execution; see [receiver execution offers](../design/portable-project-identity.md#receiver-execution-offers) |
| `@kontourai/station-contracts/harness-questions` | Types for normalized harness questionnaires and batches of choice/custom answers; validation lives in shared |
| `@kontourai/station-contracts/mcp-elicitation` | A tool server's form-mode elicitation normalized to Station's rendered field subset, its accepted content, and the accept/decline/cancel result; validation lives in shared |
| `@kontourai/station-contracts/mcp-prompts` | An agent's MCP server prompts offered as slash commands (named string arguments), the listing with unreadable servers, and a prompt run's inserted text |
| `@kontourai/station-contracts/knowledge` | Knowledge namespaces, tree/search/document metadata |
| `@kontourai/station-contracts/live-surface` | Host-neutral live surface (#90): frame header, input events, control lease, stream params, their strict wire parsers and the length-prefixed binary record envelope |
| `@kontourai/station-contracts/workspace-browser-pane` | Browser pane v2 (#90): per-device pane state referencing a server-owned browser session, its v1→v2 migration, and the `/api/browser/*` wire views the pane reads |
| `@kontourai/station-contracts/learning-review` | Owner-neutral learning lifecycle projections and explicit access gaps |
| `@kontourai/station-contracts/layout` | Layout definitions, tabs, skills, templates |
| `@kontourai/station-contracts/local-accounts` | Operator-only account projections, sign-in/session actions and one-time recovery results |
| `@kontourai/station-contracts/notification` | Notification payloads and actions |
| `@kontourai/station-contracts/orchestration` | Connected-agent/orchestration request and response shapes |
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
| `@kontourai/station-contracts/system-status` | Device presentation, the answering server's runtime identity, and update-provenance issue codes |
| `@kontourai/station-contracts/task-room-work` | Versioned Task agent request intent, authorized request records, list and submission outcomes. Requester IDs are Task-scoped display pseudonyms; execution references do not grant Session access or prove completion |
| `@kontourai/station-contracts/tool` | Tool definitions, permissions, connection configs |
| `@kontourai/station-contracts/unified-search` | Owner-qualified typed search results, provider pages, source states, open intents, and fresh owner-resolved open targets |
| `@kontourai/station-contracts/workspace-pane-host-contribution` | Package-level Pane-host actions and explicit owner-relative/default Agent selection |

`AgentTools.mcpMode` selects additive (`add`) or replacement (`replace`) MCP
configuration; omission preserves the prior engine-specific behavior.
`AgentTools.mcpLoading` optionally selects Claude's native on-demand or eager
loading. The session resolver carries these as `toolServerMode` and
`toolServerLoading`. A resolved server's `allowedTools` contains exact original
MCP names (empty means none); `disabledTools` excludes names independently, and
`toolNames` is catalog metadata for known-tool exclusions. See the
[Agent Tools guide](../guides/agents.md#mcp-tool-configuration) for delivery limits.

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
`session-ended`, or `user-canceled` (the user chose Cancel auto-resume). The
chat banner reads it through the Session API's
[usage-limit routes](session-api.md#usage-limit-recovery-sessionsthreadidusage-limit).

`ORCHESTRATION_STREAM_ACTIVITY_EVENT` names an idless SSE frame carrying the
current conversation activity after a burst of coalesced runtime events. It
updates liveness without advancing the event replay cursor.

`ChildWorkSessionView` may include bounded `settled` items with a reported
running set. A missing `children` view still means the server made no
child-work report for that row; clients retain their existing state.

## Import examples

The [package export map](../../packages/contracts/package.json) is the available
subpath inventory. It selects TypeScript source. A contract declaration or parser
does not establish implementation, deployment, access, or a completed live journey.

```ts
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { LearningReviewProjectionOutcome } from '@kontourai/station-contracts/learning-review';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { SessionMetadata } from '@kontourai/station-contracts/runtime';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { UnifiedSearchResult } from '@kontourai/station-contracts/unified-search';
```

`learning-review` is a read-only projection contract. Its available form links
owner-issued source, candidate, evaluation, decision, activation, effect, and
retirement records; its unavailable forms contain no protected owner identity.
Station does not turn feedback, an accepted request, or transport success into
a promotion verdict. An empty effect-observation set means not observed, never
successful.

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
Stop button, and the user decides. On the exec fallback, Stop signals the
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
`provider_turn_completed`), and notifies "Your agent replied" when the owner
is offline. A send while it runs is refused with the retryable code
`provider_turn_in_progress`, and the client queues the message until it ends.
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
`provider`). Unlike the two codes above it is not retryable: the same send is
refused again. An ACP steer delivered by the cancel + re-prompt fallback, for
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
gateway delivers to, and the request/response shapes. The response's
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
runtime files. Runtime parsing of these shapes lives at the route and SDK
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
