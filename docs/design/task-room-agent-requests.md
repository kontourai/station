# Task room agent requests

Status: implementation in progress under [#3034](https://github.com/kontourai/station/issues/3034).
This slice adds the durable backend for the [shared channel](shared-task-channels.md).
The composer, autocomplete, live result projection and invited/public journeys
remain separate unfinished parts of the program.

## Owners and transport

The [work module](../../src-server/services/projects/task-room-work-module.ts)
records a request before the existing delegation owner can start an agent.
It does not replace TaskGraph, TaskDispatcher, Session commands or delegation.
Multiple requests retain independent execution identities without overwriting
the durable Task's current-session association.

The [delegation route](../../src-server/routes/orchestration/orchestration.ts)
accepts an explicit `taskRoomRequest` with `taskId` and `operationId`, alongside
the existing prompt and execution target. Initial targets are current-Station
agents in the exact Task Project. Normal dispatch scope, caller attribution,
full-access admission, readiness and workspace resolution remain in their
existing owners. Remote target support remains unfinished; no parity is claimed.

`GET /api/tasks/:taskId/room/agent-requests` reads the authorized request view.
Its `station.task-room-work/v1` version is the negotiation prerequisite for a
future client: an older server can strip unknown delegation fields, so a client
must not assume durable request support without this versioned response.
Task room updates continue using existing SSE and HTTP; no WebSocket is added.

## Durable identity and uncertainty

The private key is `(Task, requesting principal, operation)`. Reusing it with a
different prompt or agent refuses. File-mutation authority serializes independent
module instances before any provider invocation. A stable execution identity is
reserved and passed to delegation; it remains in the work record after restart.

`starting` means the request is durable but execution is not confirmed. It does
not prove a process is alive. `dispatched` records the delegation return against
the reserved identity; it is not Task completion or customer acceptance.
`indeterminate` means invocation did not produce a trustworthy acknowledgement.
`refused` means authority changed before invocation. No stored row automatically
starts another execution. A settlement write failure remains an error rather
than a successful receipt, and lookup/replay does not invoke the provider.

Scope and requesting identity are rechecked after reservation and before result
delivery, and through a server-only admission beside the actual provider start
and initial-turn effect inside OrchestrationService. Task and Project incarnation
are included so a replacement cannot inherit a
prior request. Lists distinguish refused access from an empty authorized history.
Corruption, excessive bytes, duplicate identities and capacity pressure fail
closed. The initial store retains at most 256 requests / 4 MiB and never silently
evicts them. Production retention/window protocols remain unfinished. This is
not an exactly-once guarantee against destroyed storage or archive rollback.

## Shared data

The private principal used for deduplication remains in the server store. Public
records contain a Task-scoped display identity, requested agent, prompt, request
state and execution reference. The prompt is shared Task work; private engine
transcripts, credentials and account identifiers are not part of this view.
Execution references do not themselves grant another member Session access.
Curated results, approval routing and membership-aware contribution access must
be delivered before claiming the complete team journey.

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
the initial turn. It does not run a live model.

Still required: final scoped typecheck, mutation controls and independent review;
runtime-composition authorization proof; SDK transport parsing and caching;
`@agent` autocomplete and stable draft/request handling; observed contributions
and results; multiple human principals, workspace conflict handling, remote
execution, public publication and actual provider/device acceptance.
