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
live turn on a schedule it chose itself: the total bound exists only when a
server-owned caller declares it, and no production caller does today
(`station-runtime.ts` builds the Muse adapter without `turnTimeoutMs`), so
production Muse turns carry the idle bound only.

| Bound | Owner | Semantics | Muse default |
|---|---|---|---|
| Idle (no verified progress) | Owning adapter (Muse first) | A full window with no verified protocol activity — non-empty streamed text, a newly started tool, or a newly identified tool result — ends the turn (`muse-turn-idle-timeout`). It is not armed while a tool is in flight (a `tool.started` whose Muse task has not yet reached `completed`, `failed`, or `cancelled`); the task finishing, or the tool's result, re-arms it. A call whose task finished stays open for its result and is closed as `unresolved` at turn end if none arrives. Malformed lines, unknown frames, heartbeats, stderr noise, and duplicate completion receipts never reschedule it. Duplicate detection itself is bounded (oldest-first past a per-turn cap): a replay past that retention reads as new activity. | 30 min |
| Total (declared budget) | A server-owned caller that declares `turnTimeoutMs` (none in production today) | Wall-clock ceiling from turn start, armed only when declared; activity never moves it. Expiry is `muse-turn-timeout` (unchanged string), attributed to that declared budget. | None |

The idle bound fails closed: absent, zero, negative, NaN, infinite, or above
the 24 h cap resolves to its default. A declared total outside (0, 24 h]
applies no total budget and is logged once — a substitute budget nobody
declared would be the failure this policy removes. No request, child, or
user metadata can choose or extend either bound. Muse 1.3 reports tool
starts (#2308), so a long tool call is known work rather than silence; a
deadline's error message never carries Muse's routine stderr, and the UI
names the deadline instead of suggesting a retry.

Out of scope pending #2300: a Muse child that emits `run_terminal` and then
keeps running. The adapter stops reading its stdout at that terminal, and
`settleTurn` does not clear the idle deadline, and its callback has no
settled-turn guard, so a lingering child is reaped one idle window on (or
at a declared total), as it was before #2308. A turn that settles with a
tool in flight had its idle deadline disarmed; settling closes those tools
and re-arms it one full window from settle, so the lingering child is
reaped on that same schedule. Changing what happens after the terminal
belongs to #2300.

The shared 3-minute stall watchdog (`TurnStallWatchdog` /
`TurnProgressTracker`) stays observe-only: its `progressSilence` marker says
no progress was *observed* — quiet providers (for example a Muse build
older than 1.3, which emits no `tool.started`) may be working quietly, and
the marker must never be rendered as proof of a stall.

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
  supervision omit it. A declaration with an idle window and no total
  budget (Muse's production default) is forwarded as idle-only — no
  `deadlineAt`, `remainingMs`, or `totalLimitMs` — and `station delegate
  status` prints "Turn budget: none declared for this turn". A declaration
  carrying only half of a total budget is malformed and dropped. Nothing
  derives a deadline from RPC timeouts or metadata.
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
