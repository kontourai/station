# @kontourai/station-contracts

Canonical cross-package contract ownership for Station.

Use `@kontourai/station-contracts/*` when you need stable API/domain shapes shared across `src-server`, `packages/sdk`, `packages/cli`, plugins, or tests. New code should import these modules directly instead of reaching through `@kontourai/station-shared`.

## Ownership rules

- Put stable cross-package types here.
- Keep module boundaries domain-oriented: `agent`, `auth`, `catalog`, `config`, `knowledge`, `layout`, `notification`, `orchestration`, `plugin`, `project`, `provider`, `runtime`, `runtime-events`, `scheduler`, `tool`.
- Do not put runtime helpers, parsers, build helpers, or Node-only utilities here.
- Use `@kontourai/station-shared` root only for compatibility re-exports. Runtime helpers belong on explicit subpaths such as `@kontourai/station-shared/parsers`, `@kontourai/station-shared/build`, and `@kontourai/station-shared/git`.
- Server-only provider interfaces do not belong here. Keep those in `src-server/providers/provider-interfaces.ts` or `src-server/providers/llm/model-provider-types.ts`.

## Modules

| Module | Owns |
|---|---|
| `@kontourai/station-contracts/acp` | ACP connection config and ACP connection status values |
| `@kontourai/station-contracts/agent` | Agent specs, metadata, tools, slash commands |
| `@kontourai/station-contracts/agent-plugin` | Agent Plugins 1.0 schema identities, name grammar, and Station extension declarations |
| `@kontourai/station-contracts/attention` | Attention projections and exact approval/permission request references and inspection states |
| `@kontourai/station-contracts/auth` | Auth status, renew results, user identity/detail models |
| `@kontourai/station-contracts/authority-observation` | Closed credential-bound authority observation: current home identity, resolved principal echo (kind+id only), and verified grant tier; authorization-neutral, grants nothing |
| `@kontourai/station-contracts/application-session` | Device-bound account continuations, explicit capabilities, public proof keys and challenge/credential projections; no Device or Project grant |
| `@kontourai/station-contracts/relay-enrollment` | Fresh relay-only account enrollment, finalize-delivery and signed-activation bindings; a pending identity receives no active Device authority before the exact delivered bundle is acknowledged |
| `@kontourai/station-contracts/deployment-authentication` | Public operator-installed authentication provider configuration, factory, descriptor, operations and verified account-session results; see [deployment authentication](../guides/deployment-authentication.md) |
| `@kontourai/station-contracts/catalog` | Registry items, install results, skills, guidance assets |
| `@kontourai/station-contracts/cloud-move` | Cloud preparation target/inventory, enrolled target observations, unavailable-transfer projection, and workspace package capture/inspection/verification receipts |
| `@kontourai/station-contracts/cloud-move` | Cloud preparation target/inventory, unavailable-transfer projection, and workspace package capture/inspection/verification receipts |
| `@kontourai/station-contracts/registry-trust` | Candidate registry policies, bounded applied identity/epoch shapes, and untrusted signed-package claim shapes |
| `@kontourai/station-contracts/config` | App config and template variables |
| `@kontourai/station-contracts/connection-proof` | Transport-only Station/enrollment/client/SDP bindings and independently approved signing-key trust; never account or Project grants |
| `@kontourai/station-contracts/self-hosted-broker` | Versioned Station/enrollment/routing-generation/Origin scope and offer metadata; routing authority is separate from signing trust, account identity and Project permission |
| `@kontourai/station-contracts/execution-target` | Environment, Agent and workspace intent, including exact portable Project/resource execution; see [receiver execution offers](../design/portable-project-identity.md#receiver-execution-offers) |
| `@kontourai/station-contracts/knowledge` | Knowledge namespaces, tree/search/document metadata |
| `@kontourai/station-contracts/live-surface` | Host-neutral live surface (#90): frame header, input events, control lease, stream params, their strict wire parsers and the length-prefixed binary record envelope |
| `@kontourai/station-contracts/workspace-browser-pane` | Browser pane v2 (#90): per-device pane state referencing a server-owned browser session, its v1→v2 migration, and the `/api/browser/*` wire views the pane reads |
| `@kontourai/station-contracts/learning-review` | Owner-neutral learning lifecycle projections and explicit access gaps |
| `@kontourai/station-contracts/layout` | Layout definitions, tabs, skills, templates |
| `@kontourai/station-contracts/local-accounts` | Operator-only account projections, sign-in/session actions and one-time recovery results |
| `@kontourai/station-contracts/notification` | Notification payloads and actions |
| `@kontourai/station-contracts/orchestration` | Connected-agent/orchestration request and response shapes |
| `@kontourai/station-contracts/plugin` | Plugin manifests, previews, overrides, conflicts, install outcomes and current permission status |
| `@kontourai/station-contracts/plugin-foreground-work` | Bounded foreground-work declarations, start intents, effect depth, run states, and safe public outcomes |
| `@kontourai/station-contracts/project` | Project config and metadata |
| `@kontourai/station-contracts/project-membership` | Exact Station/local/portable Project scope, member roles/actions, single-use or verified-email invitations and administration projections |
| `@kontourai/station-contracts/provider` | Provider kinds and provider-facing contract enums/types |
| `@kontourai/station-contracts/runtime` | Session metadata, workflow metadata, runtime responses |
| `@kontourai/station-contracts/runtime-events` | Runtime event stream payloads |
| `@kontourai/station-contracts/session-inventory` | Closed Session inventory rows, gaps, and current-answer Basis projection |
| `@kontourai/station-contracts/session-work-item` | Closed immutable Session-to-work-item association observations |
| `@kontourai/station-contracts/scheduler` | Scheduler jobs, stats, capabilities, notifications |
| `@kontourai/station-contracts/system-status` | Device presentation, the answering server's runtime identity, and update-provenance issue codes |
| `@kontourai/station-contracts/tool` | Tool definitions, permissions, connection configs |
| `@kontourai/station-contracts/unified-search` | Owner-qualified typed search results, provider pages, source states, open intents, and fresh owner-resolved open targets |
| `@kontourai/station-contracts/workspace-pane-host-contribution` | Package-level Pane-host actions and explicit owner-relative/default Agent selection |

## Import examples

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

**Removed in this release.** Station previously emitted `job.deferred` — and
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
(`station-runtime.ts` builds the Muse adapter with neither `turnIdleTimeoutMs`
nor `turnTimeoutMs`), so production Muse turns carry no Station-imposed
bound. A turn that goes silent is surfaced instead: the stall watchdog's
`progressSilence` (below) shows "No output for …" and the stall notice with a
Stop button, and the user decides. Stop signals the child's process group
and settles the turn `turn.aborted`.

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

The shared 3-minute stall watchdog (`TurnStallWatchdog` /
`TurnProgressTracker`) stays observe-only: its `progressSilence` marker says
no progress was *observed* — quiet providers (for example a Muse build
older than 1.3, which emits no `tool.started`) may be working quietly, and
the marker must never be rendered as proof of a stall. It keys on the
events the parent turn publishes (streamed text, reasoning, tool start,
progress, and completion); a tool in flight does not suspend it (only an open
approval request does). So a Muse turn whose subagent is waiting on
something writes only to that subagent's own session log, not to the
parent's stdout, and reads as silent after the window, which is the
signal the user acts on now that no idle timer ends it.

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

## Compatibility

`conversation-pull-request-links` defines exact provider, host, repository, and
native-ref identities for Conversation links. Explicit links, branch-derived
associations, and Task-kept declarations retain distinct `source` values.
Provider refresh results carry an observation time and either current state or
an explicit unsupported/unavailable reason. `PullRequest.headSha` and
`baseSha` are optional because a provider that omits exact revisions must not
be presented as current by inference.

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

`AttentionInputReplyContext` on the attention subpath projects one exact open
input request's reply binding and declared file/image transport. `needs_input`
items may carry `inputReference`; approval/permission references keep their
separate meaning. `OrchestrationSendTurnInput.expectedInputRequest` is a
 constraint, not a grant, and is removed before the adapter receives input.

## Mobile device inspection

`@kontourai/station-contracts/mobile-device` owns `MobileDeviceTarget`,
`MobileDeviceSummary`, `MobileDeviceInventory`, and `MobileDeviceCapture`.
Host/device IDs are descriptive and carry no credentials, paths, or execution
authority. A capture is one observed frame, not stream health or app/build
identity. Runtime validation belongs to the helper, route, and SDK boundaries;
see [Mobile device inspection](../guides/mobile-device-workspace.md).

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
of prose. Runtime parsing of these shapes lives at the route and SDK
boundaries, not in this package.

The deployment authentication descriptor's optional `externalLogins` lists
operator-configured browser identity choices, their declared POST begin-login
paths and availability. These are presentation/capability facts, not identity
claims, Device grants or Project membership. Secret references and provider
configuration remain private to Station's operator composition.
