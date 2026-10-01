# Task room agent requests

Status: implementation in progress under [#3034](https://github.com/kontourai/station/issues/3034).
This slice implements a durable request path and an explicit agent composer for
the [shared channel](shared-task-channels.md). Local controlled tests verify
selection and retry behavior; browser, actual-provider and invited/public
acceptance remain unfinished.

## Owners and transport

The [work module](../../src-server/services/projects/task-room-work-module.ts)
records a request before the existing delegation owner can start an agent.
It does not replace TaskGraph, TaskDispatcher, Session commands or delegation.
Multiple requests retain independent execution identities without overwriting
the durable Task's current-session association.

The [delegation route](../../src-server/routes/orchestration/orchestration.ts)
accepts an explicit `taskRoomRequest` with `taskId`, `taskCreatedAt` and
`operationId`, alongside
the existing prompt and execution target. Initial targets are current-Station
agents in the exact Task Project. Normal dispatch scope, caller attribution,
full-access admission, readiness and workspace resolution remain in their
existing owners. Remote target support remains unfinished; no parity is claimed.

`GET /api/tasks/:taskId/room/agent-requests` reads the authorized request view.
Its `station.task-room-work/v1` version is the negotiation prerequisite for a
client: an older server can strip unknown delegation fields, so a client
must not assume durable request support without this versioned response.
This path is mounted in the personal runtime. GET retains the existing
orchestration read grant and POST the existing operate/admission gates. The
request cards poll the journal read every five seconds and offer refresh;
request changes are not yet room-SSE events. Existing document/history updates
continue using SSE and HTTP; no WebSocket is added.

## Durable identity and uncertainty

The private key is `(Task, requesting principal, operation)`. Reusing it with a
different prompt or agent refuses. File-mutation authority serializes independent
module instances before any provider invocation. A stable execution identity is
reserved and passed to delegation; it remains in the work record after restart.

`starting` means the request is durable but execution is not confirmed. It does
not prove a process is alive. `dispatched` records the delegation return against
the reserved identity; it is not Task completion or customer acceptance.
`indeterminate` means delegation did not produce a trustworthy acknowledgement;
it can also retain a provider-effect refusal after delegation was entered.
`refused` means the earlier post-reservation authority check refused before
entering delegation. No stored row automatically
starts another execution. A settlement write failure remains an error rather
than a successful receipt, and lookup/replay does not invoke the provider.

Scope and requesting identity are rechecked after reservation and before result
delivery, and through a server-only admission beside the actual provider start
and initial-turn effect inside OrchestrationService. Task and Project incarnation
are included so a replacement cannot inherit a
prior request. The private admission also supplies the existing durable room
execution binding using the Task room's exact stored Project identity. This
preserves source-seal provider refusal and pending-execution joins without
changing the Task's current-session association. Lists distinguish refused access from an empty authorized history.
Corruption, excessive bytes, duplicate identities and capacity pressure fail
closed. The Station-wide `task-room-work.json` store retains at most 256 requests / 4 MiB and never silently
evicts them. Production retention/window protocols remain unfinished. This is
not an exactly-once guarantee against destroyed storage or archive rollback.

## Shared data

The private principal used for deduplication remains in the server store. The
authorized response projection (not anonymous publication) contains a Task-scoped display identity, requested agent, prompt, request
state and execution reference. The prompt is shared Task work; private engine
transcripts, credentials and account identifiers are not part of this view.
Execution references do not themselves grant another member Session access.
Curated results, approval routing and membership-aware contribution access must
be delivered before claiming the complete team journey.

## Composer

Typing `@` filters Project-scoped delegation choices by name, identifier and
role description. Arrow keys, Enter, Escape, pointer selection and IME
composition are supported. An **Ask an agent** action provides the same picker.
Selection creates one exact removable recipient and removes the typed lookup
fragment; entering text or picking a recipient starts no execution. Each
request currently names one agent; multiple agent requests retain independent
identities. Multi-recipient assignment remains unfinished.

Send refreshes readiness and negotiates the versioned journal route before
creating work. The composer binds draft ownership to connection authority and
Task incarnation. A changed connection cannot receive the old draft. A failed
preflight retains an editable draft; a lost create acknowledgement freezes the
intent and reuses its operation for an explicit retry. A later retry preflight
failure preserves the original uncertainty and operation. Ordinary message
writes use captured request authority and send the expected Task creation time;
the history grant rereads that incarnation and scope after principal resolution,
immediately before returning commit admission. A late response
cannot clear the draft after its captured authority expires. Unsaved navigation and
close guards protect local drafts. Draft/operation recovery across a tab reload
is not implemented yet. The cards display acknowledged request state and link
to existing execution inspection; they do not invent live progress or results.

## Current evidence and remaining proof

The module tests use real file storage and two module instances. They cover
concurrent duplication/restart, conflicting intent, lost acknowledgement,
corruption and revocation before/after invocation. The HTTP test reaches the
actual delegation route and durable module, with a controlled dispatch adapter;
it checks Project mismatch refusal, one invocation, exact parent association,
replay and absence of account IDs in the response. A second HTTP test uses real
delegation and OrchestrationService with SQLite and a session-tracking controlled
provider: its positive control starts a session and sends a turn, then revocation
during target resolution blocks another start and revocation after start blocks
the initial turn. Revocation after the durable turn enters invocation also
blocks the provider, retires that turn boundary and permits an explicit
continuation once authority returns. Only a known authority change uses the
clean-refusal classification; storage failures retain their uncertainty.
It does not run a live model.

Local focused module/HTTP tests passed seven cases at `5d2d120e3`, with
independent execution and review. Removing clean refusal classification made
the real turn boundary remain active and failed the regression; restoring it
passed. The composer/client/route and existing Task view suite passed 58 cases
while the UI slice was in progress; SDK and UI typechecks passed after adding
the contract's real package export. These are controlled diagnostic receipts,
not final browser or release proof. Direct query-hook/HTTP tests and the real
room-runtime/history-worker suite passed 62 cases after covering readiness,
credential rotation, late acknowledgements and stale Task messages. A stronger
runtime control replaces the Task while the actual history write transaction
awaits principal resolution: it committed before the final reread fix and is
refused afterward, with the prior history unchanged. The full 58-case runtime
suite also preserves the existing not-found classification for moved transfer
rooms. The real
delegation test now verifies the persisted room-execution binding, pending-work
join and provider refusal after a real source seal. These remain controlled
principal/provider fixtures, not hosted or live-model acceptance.

Still required: final mutation controls and independent UI/SDK review;
runtime-composition authorization and browser proof; durable draft recovery;
explicit brief/context binding; observed contributions and results; multiple human principals, workspace conflict handling, remote
execution, public publication and actual provider/device acceptance.
