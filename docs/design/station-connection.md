# Station connections and shared conversations

> **Status: proposed implementation contract, 2026-11-04.** This is the canonical
> design for connecting conversation surfaces to their owning Station. It does
> not describe shipped behavior or establish browser, native-device, or provider
> qualification. Source inspection used lane revision `63d72a1955`. The
> [chat composer policy](chat-composer.md) owns interaction decisions; the
> [remote access threat model](../security/remote-access-threat-model.md) owns
> authorization. Implementation must update those owners together.

The P1.1 foundation now lives in the [connection model](../../src-ui/src/connections/station-connection.ts),
[registry](../../src-ui/src/connections/station-connection-registry.ts),
[resolver](../../src-ui/src/connections/resolve-station-connection.ts), and
[authority boundary](../../src-ui/src/connections/StationConnectionsContext.tsx).
The credential bridge registers a fresh public lease scope for each source
lifetime; reconnecting the same profile cannot revive an old reader. Direct
candidates require a live credential-bound authority observation. Native
profiles require an existing exact host binding; its absence makes that route
unavailable without changing the selected profile. Broker owners retain their
current route ceiling. Relay descriptors/tunneling, stream/state adoption,
durable delivery and shared conversation controls belong to subsequent plan
steps; existing chats still use the host. Focused JS tests do not establish
installed-shell or physical-device qualification.

A chat on a paired Station uses the same conversation, messages, composer,
approval controls, delivery feedback, and live events as a chat on this Station.
Its header says `Via <Station name>`. Route details belong in connection
details. Differences in access appear at the affected control, with a short
reason. They do not select a different conversation component.

## Problem and evidence

The current [PeerChatBody](../../src-ui/src/components/chat-dock/PeerChatBody.tsx)
polls history and independently owns send, busy, error, pending-message, Stop,
and approval wiring. The dock instead uses
[ChatDockBody](../../src-ui/src/components/chat-dock/ChatDockBody.tsx),
[the foreground sender](../../src-ui/src/hooks/useActiveChatSessionMessaging.ts),
and [the SSE owner](../../src-ui/src/hooks/orchestration/ensureOrchestrationEventStream.ts).
Pending delivery is not proof of a running turn; a definite refusal is not
uncertain delivery. The replacement must preserve both distinctions.

Merely mounting the dock against a relay URL is unsafe. The
[active-chat store](../../src-ui/src/contexts/active-chats-store.ts),
[snapshot reconciliation](../../src-ui/src/hooks/orchestration/snapshotHandlers.ts),
[work observation](../../src-ui/src/contexts/work-observation.ts),
[outbound queue](../../src-ui/src/lib/outboundQueue.ts), and
[conversation open controller](../../src-ui/src/components/chat-dock/conversationOpenController.ts)
currently assume one Station in important paths. Another Station's snapshot
can exit a host chat, and host pruning or queue replay can delete or misroute
remote work. These partitions are prerequisites to peer cutover.

T3 Code's reference model is an environment registry, one connection resolver,
and environment-scoped state consumed by one chat view. Its transport is
WebSocket RPC; Station retains its existing HTTP plus SSE protocol. Its cloud
relay supplies a remotely reachable endpoint, rather than an S-to-R HTTP proxy.
Station needs the proxy described below because server-owned peer enrollment
does not pair the browser with the receiver.

## Connection model

Introduce `StationConnectionRegistry` and `resolveStationConnection`, owned by
a `StationConnectionsProvider` under the existing host authority/query provider.
Keep saved Device profiles in `packages/connect`; the registry leases them and
server peer relationships, rather than creating another credential store.
Suggested implementation owners are `src-ui/src/connections/` for the model,
registry, resolver, and React boundary.

A `StationConnection` exposes:

| Field | Meaning |
| --- | --- |
| `environmentId` | Verified target Station identity, never an unverified display-name or URL match. |
| `stationName` | Display label, refreshed from the verified descriptor; not identity proof. |
| `stationKey` | Durable target identity within the current host-storage/authority namespace. |
| `routeKind` | `host`, `direct`, or `relay`; interpreted only by connection adapters. |
| `targetApiBase` | Actual base used for reads, writes, and SSE. For relay it is S's `/api/environments/peers/:environmentId/chat-api` subtree. |
| `requestScope` | SDK credential authority: unchanged S scope for relay; the target Device profile's scope for direct; host scope for host. |
| `authorityNamespace` | Public owner partition, incorporating source authority and target request-principal identity/credential lineage. Never a bearer token. |
| `runtimeKey` | Target base, authority key, and route generation; distinguishes caches and callbacks across endpoint/credential replacement. |
| `isCurrent()` | Lease, source authority, target identity, endpoint, profile, binding, and route-generation fence. |
| `events` | Ref-counted existing orchestration SSE stream plus status/resync interface. Same projection pipeline for all routes. |
| `capabilities` | Connection ceiling in the single `ConversationCapabilities` vocabulary; narrowed by conversation/request state. |
| `transport` | Bound `ConversationTransport`; components pass conversation/turn/request ids, never an arbitrary base or credential. |
| `describeFailure` | Shared failure translator bound to target name and source/target authority. |

The [SDK authority check](../../packages/sdk/src/client/http.ts) requires
`requestScope.apiBase` to equal the configured credential authority base, with
the request URL underneath that base. A relay therefore keeps S's scope while
using the relay subtree as `targetApiBase`. Do not manufacture a scope whose
base is that subtree, relax `bindRequestAuthority`, or use S's base as the
target's query identity.

Registry entries are keyed by verified `environmentId` within a source authority
namespace. A route lease carries its own generation. Concurrent readers share
one stream and one queue supervisor for that entry. Last-reader release stops
the stream unless retained outbound work needs observation. Replaced entries
cancel old readers and cannot publish late results. Host authority change
retires all leases, including direct leases composed under that host, and clears
the old query namespace. It does not destroy durable drafts.

The resolver chooses host for the current Station; otherwise it prefers a
verified, usable, independently paired target Device profile, then the saved
server peer relationship if no direct route is usable before an operation.
A pairing offer, matching label, discovery result, or server peer credential is
not a direct Device pairing. Browser reachability, HTTPS/CORS, native binding,
and broker support are part of usability.

Route and request-principal lineage remain pinned during an operation and while
delivery is uncertain. Never retry a mutation on a second route after it may
have left the device. A refusal is not a failover instruction. Explicit reconnect
can select a replacement route only after old work is reconciled. A new direct
pairing does not silently convert an existing relay-authored conversation:
first open it under the direct principal, verify read/continue access, and
require an explicit switch with no unresolved delivery. If that principal
cannot open it, retain its relay binding. This preserves the receiver's ownership
rules while using direct routing for new eligible chats.

## One capability vocabulary and transport

`ConversationCapabilities` is the only UI vocabulary. Each entry is a decision
(`allowed`, `denied`, or `unknown`) with a typed reason translated centrally.
Unknown does not grant a new remote operation. Server scopes and wire fields
remain their public contracts; boundary adapters translate them once.

| Concern | Canonical decision(s) |
| --- | --- |
| Reading | `historyRead`, `liveEvents`, `contentRead`, `attachmentRead` |
| Writing | `send`, `startChat`, `steer`, `stop`, `queue`, `deliveryLookup` |
| Approvals | `approvalAnswer`, `approvalInspect`, `approvalTrustTool`, `approvalTrustServer`, `inputAnswer` |
| Composer | `attachments`, `modelSelect`, `agentSelect`, `projectSelect`, `mentions`, `skills` |
| Workspace and recovery | `folderSelect`, `fullAccess`, `checkpointRead`, `checkpointRestore`, `continue`, `fork` |
| Additional surfaces | `childInstruction`, `sharedHistoryRead`, `offlineRead`, `replay`, `personalDefaults`, `uiBlockActions` |

Stop presentation also takes a typed intent: interrupt the current turn
(immediate) or stop a whole delegated Task (confirmation). This is an action's
semantics, not another capability vocabulary. Approval choices are narrowed by
the exact request's offered actions and content-binding/trust eligibility.

Map `callerAccess`, `READ_ONLY_UI_BLOCK_ACTIONS`, `sessionUnanswerable`,
task-room `messageWrite/historyRead`, and implicit request-context checks into
this model at their adapters. Do not rename server response fields unnecessarily.
Distinguish server permission from busy/freshness state: effective usability is
permission plus current observation plus the action's runtime prerequisites.
A pending message alone never sets turn-busy.

`ConversationTransport` implements `send`, `stop`, `answer`,
`inspectApproval`, `steer`, and `recheckDelivery`. Methods use typed targets,
the original idempotency key, a cancellation signal, and currentness. They return
accepted, queued, definitely refused/not invoked, or indeterminate outcomes.
`send` retains the existing durable outbox contract; `stop` binds the current
turn and optional `clientTurnId`; `answer` binds request identity and content
version, and exposes the existing answer-inspection recovery.

One HTTP orchestration adapter uses the resolved connection for host, direct,
and relay. It composes existing SDK clients rather than copying their send
algorithm. Separate Task-room and externally attached-session adapters may
translate different domain APIs into the same UI port. They do not implement
new composers or approval policies, nor insert fabricated chats into the dock
store. Record views have ephemeral controller state; dock views use their
durable chat state through the same controller interface.

For relay, full access and folder selection are unavailable under the receiver's
delegation grant. Hide unsupported picker actions, and explain a current
unavailable selection at that control, for example
`Folder selection requires a direct connection to <Station>`.
Do not show a host Project's folders, models,
defaults, engine identity, or permissions as receiver choices. Model/agent and
Project catalogs are read from the target through explicitly admitted read
routes. Preserve older-host compatibility for established local behavior;
new relay features require a negotiated protocol, not a permissive fallback.

## Direct credentials are in scope

Direct routing ships in this refactor. Deferring it would violate the requested
route preference and leave two target-selection models. It reuses existing
Device trust and native/broker owners; it does not expand what a native broker
can carry. A broker route that currently permits only protected reads remains
read-only, even when a peer chat could otherwise send.

[StationCredentialBridge](../../src-ui/src/contexts/ApiBaseContext.tsx) currently
captures only the active profile at request issue. Extend the SDK resolver to
receive a request selector (URL and snapshotted `requestScope`) and extend
`packages/connect/src/react/ConnectionsContext.tsx` with an explicit
`captureCredentialEvidenceForConnection(id)` and corresponding currentness
check. Preserve the no-argument active-capture contract for existing consumers.
Do not temporarily switch the active connection to service another chat.

Resolve scoped requests by an exact registered authority/connection lease and
URL containment, never URL alone: two saved principals can share an origin.
Capture endpoint, credential generation, authority generation, connection id,
route revision, lease epoch, and native binding in one live store read. Awaited
preparation must recheck the captured evidence before egress and publication.
An unregistered, stale, mismatched, or ambiguous selector fails before fetch.
Unscoped legacy requests retain the active-host behavior; new conversation
callers always supply a scope. Resolve once per request, including SSE
reconnects; response callbacks use that original evidence.

Preserve all existing transport guarantees:

- Browser bearer/cookie credentials go only to the selected profile's exact
  origin/base. No S credential is sent to R and no peer bearer reaches JS.
- Tauri credentials stay in native custody. Capture that profile's opaque
  request binding and dispatch through `nativeTransportForBinding`. Missing
  bindings fail closed; raw fetch is not a fallback.
- Browser/native broker routes use that profile's route/application owner and
  account continuation scope. Missing, retired, or unsupported routes refuse.
  Do not turn a broker failure into direct HTTP or widen its mutation policy.
- Unauthorized/authenticated-success callbacks update only the captured profile
  and generation. A late 401 cannot retire a new credential; a late 2xx cannot
  erase a newer refusal. Account rejection stays separate from Device custody.
- Raw-egress policy lookup takes the same scope. Attachment upload, voice,
  terminal, link/media reads, and object-URL caches cannot consult the active
  host while serving another connection. Never put credentials in media URLs.
- Selection changes still fence active-host requests as today. Background
  connection leases have per-profile epochs; changing the visible tab cannot
  bind their requests to a different profile.

Mocked IPC tests establish JS composition only. Installed native-shell,
Keychain/credential-store, and physical-device qualification are separate
release obligations; see [native shell verification](../guides/native-shell-verification.md).

## State belongs to the owning Station

Persist `ChatStationBindingV1` with `version:1`, `environmentId`, `stationName`
(last verified display label), and one `affinity` variant:

- `host`: no additional route fields; resolve against the current host storage
  namespace and verified host identity.
- `device`: `connectionId` and non-secret `principalNamespace`, identifying the
  independently paired saved Device profile and its owner lineage.
- `peer`: `sourceEnvironmentId`, `sourceConnectionId`, and non-secret
  `principalNamespace`, identifying S's saved outbound relationship to the
  target `environmentId`.

The affinity preserves the principal for an existing conversation. A new chat
has automatic route preference until the resolver selects and records a usable
route; it never persists a magic `current` target. A missing original source
profile or unverifiable lineage makes a restored peer unavailable, not host.
Do not persist resolved URLs, scopes, credentials, live capability decisions,
or stream cursors. Keep the tab id independent of the conversation id.
In-memory identities include Station and authority; never use a conversation,
session, or client-turn id alone across Stations.

| Owner / current hazard | Required partition or routing |
| --- | --- |
| `activeChatsStore.activityByConversation`, activity adoption and execution-session lookup | Key by Station and conversation; pass Station to all event-to-chat lookups, including exact-tab-id fast paths. `clearConversationActivity(station)` clears one Station. Authority teardown retains an explicit clear-all operation. |
| `snapshotHandlers.planSnapshot` | Select and exit chats only in the stream's Station. A legacy chat with no Station binding counts as host; otherwise host dead sessions would never exit. |
| Child-work and background-task snapshot reconciliation | Forget/stale only entries owned by that stream's Station; preserve foreign reporters and tasks even with colliding ids. |
| `WorkObservation` | Partition epochs, sequence fences, readers, failures, and open-generation tokens by runtime key, within the existing QueryClient. A B epoch cannot cancel A opens or erase A failures/watermarks. |
| React Query | Keep root first: `[root, targetApiBase, authorityKey, ...parameters]`. Include route generation where needed to fence replacement. Fix fetch target as well as key. Scope invalidations to that prefix. |
| Query consumers | Migrate sessions, inventory, inbox head, agents/tools, model-picker/engine catalogs, Project defaults and Projects. Fix `OfflineSessionIndex` and all `work-observation` prefix matches. Ambient SDK hooks remain for other host surfaces; conversation hooks use explicit targets. |
| Already base-scoped stream owners | Reuse sequenced events, semantic buffers, query-client registry, child-work store, stream status/listeners, replay capture, approval toast and queue-drain owners; audit composite ids inside them. Register each peer's stream with the host authority's QueryClient. Retire route state before reusing a base under new authority. |
| Outbound queue | Every beginLive, held-intent sync, queue drain, lookup, check and replay supplies `{station}` with the target's environment id, target base, and principal namespace. No global `currentStation` fallback on conversation paths. Legacy rows without a Station are host-only; bind them from their original host storage namespace before starting peer flushers, or hold them when that identity cannot be established. Never retain the current `!row.station => true` membership rule for peer replay. |
| Queue supervisors | One stably keyed flushing/flushRequested pair per connection, including overlapping-pass protection and cleanup; lookup and sending use that connection's transport and stream availability. A host flusher never sends B's row. |
| Open/revalidate/rehydrate | Use the chat connection for `resolveConversationOpen`, model/engine inputs, canonical cwd, lifecycle hydration, and the dock view model's active-session record. B cannot be marked absent from A's list. |
| Pruning | Host inventory pruning excludes non-host chats. A peer disappears only on its own verified inventory/open result and ordinary retained-work rules; unreachable/403/404 due to old protocol is not deletion proof. |
| Other stores | Scope `conversationsStore` caches, attachment staging and object URLs, approval caches, model/project choice memory and inbox dismiss/snooze keys by target and authority. Audit all storage keys reached from a shared surface. |
| Host services | Keep `ServerEventsMount`'s general events on the host. Peer orchestration streams use `general=false` and `sharedRealtime=false`; they must not update host account/config/project shell state. |
| Unsupported remote enrichments | Disable mentions, offline saving, replay, legacy `/messages` hydration, personal approval defaults and skill/workspace integrations until they have target-scoped protocols. Do not substitute host data. Expected-engine validation uses the target's catalog; omit an unavailable optional hint rather than borrowing the host engine. |

The disabled enrichments are explicit capability limitations, not deferred
repairs to the ten duplication findings. Device-local return-key settings,
speech input, accessibility, draft preservation and layout remain shared.
Checkpoint, attachment, approval and delivery reads use connection scope.
Host authority teardown still clears every in-memory partition and cancels
old publishers. Connection-only rotation clears only its runtime partition;
durable possibly delivered evidence remains held.

## Relay tunnel policy

S is the source Station holding a server-owned peer credential for receiver R.
Keep [peer-chat-routes](../../src-server/routes/environments/peer-chat-routes.ts)
as the authenticated boundary. Introduce one pure, tested method/path policy
used both there and by
[EnvironmentSecurityService.authorizeCredential](../../src-server/services/ssh/environment-security-service.ts).
Replace `PEER_CHAT_WRITE_LEAF` with this policy's allowed mutation set, only for
current owner-device standing. The existing operator path remains. Do not
exempt the whole peer subtree.

A source `peerChatTunnelV1` capability advertises the expanded protocol only in
personal mode while the preview is enabled. Mirror it on
[StationCapabilityFlags](../../packages/contracts/src/environment-security.ts)
and the consumed-capability test table. An authenticated
`GET /api/environments/peers/:id/chat-connection` descriptor returns verified
target identity, receiver protocol flags and the source operation ceiling.
It returns no peer credentials or secret connection configuration. Missing
support shows an update/reconnect action; it never enables polling.

Allow families by explicit method and enumerated leaves, deny all others. In
the table, `:id` is one validated decoded segment, not an arbitrary suffix.

| Allowed family | Admitted operations |
| --- | --- |
| Discovery for this lease | The descriptor above; exact target `/.well-known/station/v1` read when an SDK compatibility probe needs it. |
| Conversation observation | GET orchestration `events`, `sessions` and bounded `sessions/:id`, conversation `event-window`, and `/api/conversations/:id/open`. Preserve existing bounded-window requirements. |
| Conversation operations | GET per-conversation inbox, turn-deliveries, and needed read-only context; POST inbox and DELETE its exact entry. Explicitly enumerate supported context leaves; no `/api/conversations/*` wildcard admitting handoff. |
| Foreground send and continue | POST orchestration `chat` and `chat/:id/continue` with receiver schemas reparsed and a mandatory current-Station target/environment. |
| Commands | POST `commands` restricted to `interruptTurn`, `steerTurn`, `steerTurnOnce`, `inspectSteerInput`, `respondToRequest`, `stopSession` and `discardDraft`; GET exact command receipt(s). These are the actual wire discriminants. |
| Transcript and requests | GET session content, request/content-binding, input-request and child-work transcript/instructions leaves required by shared readers. Child instructions write stays denied until separately admitted and tested. |
| Checkpoints and usage | GET checkpoint/restore history, usage-limit/tree/stat reads consumed by shared controls; POST exact restore-preview/restore only. No goal or other session mutation wildcard. |
| Target choices | GET exact Projects list, agents list/detail, orchestration provider list/commands/models, `/api/connections/agents` and `/api/connections/models`. Read projected catalogs only, never secret/config indexes or model-inventory requiring inference scope. |
| Attachments | GET exact attachment bytes and staging capability; POST staging prepare/reconcile, PUT one stage, DELETE one stage. Bound each body with its domain limit. |

Always deny peer/enrollment/pairing/auth/access/users/people/groups, config,
settings/secrets, connections writes and credential/sign-in leaves, ACP,
terminals, unattended grants, station-control, `chat/background`,
`chat/delegated`, delegations, handoff, adoption and unknown-work release.
Canonicalize once; reject encoded separators, nested encodings, traversal,
invalid segments, unsupported query keys and excessive query/body sizes.
Request budget, CSRF, scope coverage and agent-origin checks remain active.

Keep body reparsing for every admitted mutation. Reject spoofed actor,
delegation, preparation and background fields; do not forward arbitrary JSON.
Explicitly preserve supported `whenBusy:'queue'` in the relay chat schema:
the current `foregroundMessageObjectSchema` drops it. Inbox/continue payloads
must retain idempotency and expected-binding fields while forbidding a saved
environment or caller cwd.

An important correction to the investigation: today's foreground bridge
requires an explicit `environment:{kind:'current'}`.
[normalizeExecutionTarget and handleForegroundMessage](../../src-server/routes/orchestration/orchestration.ts)
consult a Project default only when that environment is absent, so the existing
bridge does not, by that default alone, establish an onward-hop exploit.
The wider continuation and inbox families can resolve persisted targets/defaults.
Before admitting them, verify the resolved execution remains on R at the receiver
dispatch boundary for a verified delegation-kind caller; refuse an onward target.
Use the real verified caller kind, never a client header/body flag. Preserve
separately authorized portable delegation protocols. Advertise the receiver's
safe foreground continuation/inbox contract as `delegationLocalConversationV1`.
An older receiver without that contract has those operations unavailable. Missing
evidence about a path is not permission to tunnel it.

Attachment uploads need a deliberate adapter. The current SDK uploads with an
ephemeral stage grant as `Authorization`, which cannot authenticate a request
to S's chat subtree. For relay, send through the scoped SDK transport using S
authority, carrying the stage grant in one explicitly supported
`X-Station-Attachment-Upload-Grant` header. S forwards that grant as R's
Authorization only on the validated PUT-stage leaf; all other target requests
use the saved peer bearer. Never forward inbound browser Authorization, cookies,
or arbitrary headers. R still validates stage ownership, id, expiry, payload
type and size. The grant is not the peer credential; never log it or place it
in a query string. Native/broker raw-egress restrictions remain in force; do not
fake upload progress when a transport cannot measure it.

### Live SSE and authority currency

[fetchRemoteStation](../../src-server/services/remote-stations/remote-station-forwarder.ts)
buffers `response.text()` under a whole-body timeout; it cannot carry a live
SSE stream or safely preserve arbitrary binary attachment bytes. Add a separate
byte-preserving forwarder for bounded media responses and a streaming forwarder
for SSE with a headers-only timeout,
client-disconnect abort, `redirect:'error'`, backpressure, and bounded error
response handling. Copy only Accept, Last-Event-ID, X-Station-Client-Session and
X-Station-Stream-Epoch, plus the server-selected receiver credential and canonical
protocol header. Forbid general/shared-realtime events on relay streams.

Before fetching, after the identity handshake, before forwarding headers, and
before each emitted body chunk, recheck source request currency, preview,
peer origin/credential generation and verified environment id. A bounded
periodic currency check terminates an idle revoked stream too. Cancellation
releases its timer/reader and aborts upstream. Preserve SSE bytes, frame ids,
ordering and reconnect cursors; do not convert frames to polling or synthesize
success snapshots. The receiver currently logs `authorization-expired` as a
close reason; it does not send that named SSE event. The client observes a
disconnect and the next authenticated reconnect/read establishes the refusal.
Keep it attributed to receiver recovery; do not wait for a nonexistent frame.
Use the existing response-guard pattern from
[project-response-guard](../../src-server/services/projects/project-response-guard.ts).

Publish only allowlisted content/SSE/resume headers, no remote cookies,
redirects, bearer material or forged Station-envelope markers. Preserve the
in-process `RELAYED_RESPONSE_HEADER` so the envelope middleware does not claim
R's answer as S's. Do not change that middleware's trust semantics.

### Failure attribution and ownership on R

The [request-principal owner](../../src-server/runtime/bootstrap/orchestration-request-principal.ts)
resolves the peer credential to R's device principal labelled with S's name,
or an independently bound person where that resolver establishes one. S's
people generally share that owner on R. Its inventory can include S's portable
delegated work. Do not show this as a per-person private inbox or fabricate
person attribution, presence, personal defaults or verified human authorship.

R's delegation grant still lacks folder-selection, full-access and
person-only capabilities. Approvals are available only where R offers them,
with request content checks; trust choices remain R's decision. Direct pairing
can have different access and ownership. Identical components do not imply
identical principals or capabilities.

The SDK currently reports any same-origin 401 to the configured credential's
unauthorized callback. Passing R's 401 through S would therefore retire S's
credential. Normalize target auth refusals at S to a typed **424** failure with
`details.failureAuthority:'target'`, `remoteStatus:401|403`, target environment,
original mutation key where applicable, and a definite pre-dispatch refusal
disposition. S's own 401/403 remain S failures. This normalized failure is a
source-authored observation of a receiver refusal, including an SSE handshake
refusal. It carries S's normal verified response envelope and explicitly names
the target; do not attach the raw-response RELAYED marker to that locally
constructed observation. Raw R responses still carry RELAYED and cannot acquire
S's envelope. This preserves the middleware's trust distinction.

The SDK/transport accepts a definite relay-refusal outcome only from this typed,
current, source-verified observation bound to the expected target and mutation
key. Recognized non-auth pre-effect rejections can use the same observation
contract; unknown failures cannot. Code/status text from an unverified body is
not delivery evidence. Keep a lost or unverified response indeterminate, and
let any already-confirmed start outrank a later refusal. The shared translator
understands the original target status. This is an internal preview contract,
not a change to R's API.

Use one `describeStationFailure` entry point, composing the established
[chat error translation](../../src-ui/src/utils/chatErrorTranslation.ts) for
provider/domain failures. It returns safe copy, recovery action, retryability,
authority and delivery disposition. All UI sinks consume the translated result.
Examples: `Reconnect to <Station>` for target 401;
`This connection cannot send to <Station>` for target 403;
`Reconnect to <source>` for source 401.
Unknown errors get a useful fixed fallback. Raw `error.message` or `.code` is
diagnostic data, never UI copy. Preserve domain-specific safe hints and their
capability gates.

An upstream definite rejection is refused, retaining an editable draft. Only
loss of an answer after possible dispatch is indeterminate: preserve the key
and offer Check delivery. Retry requires the existing outbox's proof of
non-delivery or its explicit safe recovery contract. Rechecking delivery is an
explicit/bounded recovery operation, not periodic transcript polling.

## Shared surface owners and deletions

Extract `ConversationBody` and `useConversationController` from the dock's
established transcript/composer path. `ChatDockBody` becomes the dock shell
adapter, with record/compact densities chosen as presentation options. Densities
change spacing and transcript framing, not authority, return-key behavior,
delivery, approval content checks or Stop semantics. Keep virtualization, tool
expansion, Markdown, attachments and accessibility shared.

| Audit finding | End state / retired implementation |
| --- | --- |
| 1. Mutable session detail versus dock | MutableSessionDetail uses ConversationBody at record density. Remove its transcript/reply/request-card/Stop/error orchestration; retain session metadata and evidence panels. Retire SessionTranscript and SessionReplyComposer after all callers migrate. |
| 2. Attached-session third stack | AttachedSessionDetail uses the same body and composer, with its real attached-session permissions and existing continue-as-owned-child action. Delete its MessageBubble loop, textarea, SVG send and hard-coded Enter handler. Read-only attachment must remain read-only. |
| 3. Five Stops | One ConversationStopControl and controller implement immediate turn interrupt versus confirmed Task stop, busy state and translated failures. ComposerStopButton becomes the sole styled leaf or is absorbed into that control; remove all other Stop UI/confirmation policy. |
| 4. Delivery notes | MessageDeliveryNote accepts a DeliveryPort (state/check/retry/edit/discard) instead of reading activeChatsStore. Migrate child instruction, review, queued, unsent and peer states; remove their independent status sentences and retry policy. Preserve any semantically distinct queued/received/refused/uncertain state. |
| 5. Approval controls | One useApprovalAnswering with the connection/Task port, plus existing sheet/strip/input components. Migrate ToolCallDisplay, ChatMessageList, attention cards and details. No direct per-surface answer/check mutation or reduced trust/content gate. |
| 6. Target and capability leaks | ConversationConnectionContext is required by shared surfaces. Replace ChatRequestContext and host fallback reads. File/media bytes, checkpoints and content use its target and capabilities. Delete the context-exists-means-text-only rule and parallel capability derivations. |
| 7. Remote start fork | One target-aware start controller and target catalog/Project picker for ordinary chats. Portable Run on a Station stays a distinct Task action with its existing consent. Remove usePeerChatStart and PeerChatBody and the ChatDockContentArea peer branch. Both dock headers show the owning Station. |
| 8. Shared-task history fork | One SharedTaskHistoryList with records, paging, loading/empty/partial/error recovery and capability inputs. Owner/guest/member adapters retain their APIs and redaction. Replace all three record maps and the member preformatted fallback. |
| 9. Mobile/desktop Inbox | One useInboxPanelController owns activation currency, search/filter, snooze/dismiss/undo and errors. Existing shells own layout/gestures/focus elements. Remove their duplicate mutation wiring; stale results cannot focus another conversation. |
| 10. Failure translation | One authority-aware translator for network failures, composed with domain translations. Migrate describeReadFailure, SessionDetailErrors, child-work/inventory/review and other audited user-facing sinks; remove local 401/403 classifiers and raw message/code output. |

Registry/adapters are domain boundaries, not permission to build route-specific
UI copies. Shared-task history records are not fabricated chat messages; reuse
the history renderer where that contract fits and shared action controls elsewhere.

## Persisted state and preview

[peer-chat.ts](../../src-ui/src/lib/peer-chat.ts) and
[active-chats-state.ts](../../src-ui/src/contexts/active-chats-state.ts) own the
legacy read and serialization boundary. Add a versioned `stationBinding` and a
pure migration. No binding means host only when no legacy peer marker exists.
A malformed remote marker becomes a retained unavailable binding, never host.

Migration preserves tab id, ordering, title, draft, receiver conversation/session,
agent override/fingerprint, Project identity/name, model/provider options and
original pending id/text. Use typed fixtures containing the actual old persisted
envelope and inspect the new persisted envelope after reload.

For `pending.dispatched:false`, transactionally import one held outbox intent
with the same clientTurnId. For true or missing `dispatched`, import possibly
sent evidence requiring target lookup; never auto-send. Deduplicate by namespace,
environment, conversation and clientTurnId. Write durable queue import before
marking the chat migrated. Repeating migration after a crash or from two tabs
must find the same row. Merge newer existing evidence without downgrading started
to pending. If persistence/import fails, retain the legacy binding and block
cutover for that tab with a retry action.

Populate normal conversation identity only after Station partitions exist.
Read legacy fields throughout one compatibility window; new dispatch never
writes a second legacy pending journal. Retain a passive compatibility envelope
or original backup sufficient for safe rollback, with its dispatch bit protected;
an older build must not auto-send a message the new build may have sent.
Do not silently erase corrupt entries, pending work, or unknown future versions.

`paired-station-chats` stays personal-only, off by default. Preview off stops
all non-host chat operations, streams and automatic queue work, and retains
readable locally held content/drafts with the standard enable action. Re-enable
revalidates identity and delivery before resuming. Host chats remain operational.
No polling or old PeerChatBody fallback. Direct connections already usable by
the app remain valid profiles; the preview controls this multi-Station chat
composition, not the target's underlying access grant.

## Documentation and acceptance

Implementation updates these owners in the same PR as the behavior they describe:

- [Chat composer](chat-composer.md): replace the polling/forked-body description,
  name shared controls, route indication, refusals and recovery.
- [Remote access threat model](../security/remote-access-threat-model.md):
  replace the two-leaf owner-standing exception with the shared method/path
  policy; document SSE revocation, target failure attribution and onward-hop
  checks. Preserve server-owned enrollment's identity/credential limits.
- [Module map](../architecture/module-map.md): add registry/controller/transport
  ownership and Station partitions; revise outbound dispatch, observation and
  native request composition claims.
- [Machine relationships](../guides/machine-relationships.md),
  [SDK reference](../reference/sdk.md), and
  [API reference](../reference/api.md): document direct versus server peer grants,
  scoped request selectors, capability negotiation and relay failures.
- [Getting started](../user/getting-started.md) and
  [Settings](../user/settings.md): explain choosing a Station, the Via label,
  receiver Project selection, direct-only controls and preview-off retention in
  product language. Add this design to the owning documentation map.
- [UI instructions](../../src-ui/AGENTS.md) and
  [testing guide](../guides/testing.md): route new surfaces to the shared owners
  and the cheap drift guard. Review freshness records after committing reviewed
  bytes under the [ledger rules](../guides/documentation-review-ledger.md).

Acceptance requires real two-Station authorization/relay journeys and ordinary
user actions, plus deterministic collision/race tests. Cover local and remote
idle, streaming, approval, definite refusal, uncertain delivery, reconnect,
revocation, preview off, restored legacy pending messages, and concurrent A/B
snapshots/queues. Inspect screenshots at 390 and 1440 pixels in both themes,
including a writable idle composer and capability-limited controls. Source
scans prove adoption rules only. Browser fixtures do not establish physical
native-device qualification; retain that limit in release evidence.

