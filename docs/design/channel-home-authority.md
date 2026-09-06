# Channel home authority and planned transfer

> Status: implementation design for [#495](https://github.com/kontourai/station/issues/495)
> AC2 and the [#580](https://github.com/kontourai/station/issues/580) authority
> prerequisites. This document does not introduce a runtime authority service.
> [Conversation state](conversation-state.md#34-the-lease-is-the-fence-the-epoch-is-only-the-label)
> owns the consistency model. Offline home restore remains a separate operation.

## Required outcome

After a planned transfer, the source cannot publish accepted room writes or
start accepted execution under the transferred authority. The target opens the
exact verified closing checkpoint before it becomes a writer. An uncertain
transfer freezes admission; neither a timeout nor a copied directory authorizes
rollback to the source or promotion of the target.

The existing `station-home-lifecycle` lease is scoped to a canonical local path
and host process identities. It protects local maintenance, including offline
backup. It cannot exclude a writer on a different machine. The conversation
handoff module reserves a successor Agent/engine session, but does not transfer
channel-home ownership. Preserve both owners and compose them at their actual
boundaries rather than extending either receipt to imply distributed authority.

## Authority interface

Keep the authority record outside the portable Project manifest and outside the
home archive being moved. Bind it to a deployment tenant, exact channel, source
home identity, target home identity, policy revision and transfer operation ID.
Use the existing `ChannelHomeRecord` for the public home projection. A manifest
locator is a hint; an authenticated authority response is required before use.

The server-private authority interface needs these operations:

| Operation | Durable result |
| --- | --- |
| Inspect | Current holder and lease, authority revision, and any pending transfer |
| Prepare | Exact source/target intent reserved against the observed authority revision |
| Renew | Conditional renewal of the same holder and lease; never an implicit new claim |
| Record source closure | Verified immutable closing checkpoint after source admission is sealed and accepted work has settled |
| Record target readiness | Target verification bound to that checkpoint and transferred content digest |
| Commit | One conditional ownership transition binding closure, readiness and policy; repeated operation IDs resolve to the original result |
| Resolve uncertainty | Read durable state for the exact operation; never infer non-commit from a missing response |

Authorization belongs to existing principal and capability owners. A caller's
tenant string, Project slug, possession of a backup, or operator token copied
from the source is not a home-identity proof. Do not expose raw lease-store
mutation through an HTTP route and add authorization afterward.

The storage adapter must provide a real linearizable conditional transition.
Several independent SQLite databases or object copies do not provide it. A
single centrally served SQLite authority may be an initial single-host adapter;
that service is itself a single point of availability and cannot be promoted
by copying its database. Multi-node adapters must preserve the same conditional
transition and uncertainty semantics. For example, etcd documents atomic
comparison/transaction operations in its [v3 API](https://etcd.io/docs/v3.6/learning/api/).
Backend choice does not replace the write-path integration below.

## Explicit participant pairing

The runtime exposes `GET /api/home-authority/identity` for a separately paired
participant carrying the explicit `home:transfer` permission. The `home-transfer`
pairing preset contains only that permission. Existing default, standard,
delegation and inference grants do not gain it on upgrade. It grants neither
agent execution nor terminal access nor pairing administration.

An operator creates a fresh offer on the intended controller with
`POST /api/pairing/offers`, authenticated through the existing operator path:

```json
{"endpoint":"https://controller.example.test","scope":"home:transfer"}
```

Use the normal request, owner approval and exchange ceremony described in the
[remote access model](../security/remote-access-threat-model.md). Create a
separate pairing for each participant; do not copy the controller's operator
credential or reuse one participant credential for both homes. An integration
uses the exchanged credential through its authenticated client to read
`GET /api/home-authority/identity`. Store credentials using the integration's
private credential owner, never in a Project manifest or workspace package.

The response contract is `PairedHomeIdentityObservation` in
[`cloud-move`](../../packages/contracts/src/cloud-move.ts). It names the
controller environment and its current paired-device ID, with `scope: personal`
and both execution-transfer/resume flags false. The pair of IDs is meaningful
only within that controller's registry. It survives an ordinary controller
restart while the registry remains intact. It is not physical-machine
attestation, a lease, or evidence that a credential has not been copied.

The route reads the middleware-authenticated principal, then rechecks the real
pairing registry before and after reading controller identity. Revoked pairings,
ordinary device grants and operator credentials are refused. Responses are
uncacheable; lookup errors return a generic unavailable result. Hosted mode is
refused until paired identity is bound to actual tenant membership. A trusted
tenant header alone does not bind this process-wide device registry to a tenant.

Tests exercise real pairing records and the HTTP authentication middleware,
separate participants, controller registry reopen, revoked credentials, revocation
during a read, forged query fields, hosted refusal and sanitized errors. This is
an enrollment observation prerequisite. The optional personal decision preparation below binds these participants to
channel records. Actual source closure, restored-target verification and execution
admission remain unfinished; no activation endpoint is exposed.

## Personal controller decision preparation

One personal Station process can compose the pairing service with an external
SQLite decision store. Before starting that controller, create an owner-only
POSIX directory outside its Station home and set:

```bash
mkdir -m 700 /private/controller-state
export STATION_HOME_AUTHORITY_DATABASE=/private/controller-state/authority.sqlite
```

The parent directory must already exist; no authority database is created until
an authenticated decision request arrives. The database uses private permissions,
WAL journaling and FULL synchronization. It stays outside home exports and is
opened and closed around each operation. Use one controller process and its own
pairing registry: sharing a database between separately running controller
processes does not synchronize their pairing revocations. Do not copy or promote
this controller to create failover. Keep controller backups separate and stop the
controller before backing it up. This slice adds no automated controller restore.
Database and existing WAL/SHM/journal files must be private, regular single-link
files owned by the controller user. Parent and database identity are rechecked
around opening. The controller OS account is trusted: Node SQLite opens filenames,
so these checks do not defend against an actively hostile same-user process
renaming paths during a call. Do not rename, replace or copy active store files.

After pairing distinct source and target participants as above, an integration
uses these authenticated routes:

| Method and path | Caller and body | Result |
| --- | --- | --- |
| `POST /api/home-authority/channels/:channelId/owner` | Controller operator credential; `{"sourceDeviceId":"<source paired ID>","policyRevision":"policy-1"}` | Initial revision-zero binding. A different existing owner cannot be replaced. |
| `GET /api/home-authority/channels/:channelId` | Current source's transfer-scoped credential | Current personal owner decision. |
| `POST /api/home-authority/transfers` | Source's transfer-scoped credential; `{"channelId":"<channel>","operationId":"<unique operation>","targetDeviceId":"<target paired ID>","policyRevision":"policy-1","expectedRevision":0}` | A durable prepared decision conditional on the existing owner and policy revision. |
| `GET /api/home-authority/transfers/:operationId` | Source or target participant credential | Original decision for resolving a lost response. Both participant grants must remain active. |

The operator chooses the existing channel identity and policy revision; this
registration does not discover a channel, create a room or grant execution.
Source identity and the private controller namespace come from server-owned
security state. Bodies cannot supply tenant IDs or source home references.
Requests are limited to 2 KiB and unknown body fields are rejected. The source
and target pairings must be distinct, active and explicitly transfer-scoped.
The transaction guard rechecks pairing and controller identity around storage
access and before commit; revoked grants cannot mutate a decision.

A stored response is HTTP 200 with `kind: stored` and a `value` conforming to
`PersonalHomeDecisionObservation` in the
[cloud-move contract](../../packages/contracts/src/cloud-move.ts). It omits the
private storage namespace and checkpoint content. Both execution-transfer and
resume flags remain false. Denied, missing, conflicting and unavailable results
use 403, 404, 409 and 503 respectively; invalid and oversized input uses 400/413.
With the database setting absent, decision routes return unavailable. Hosted
requests are refused. Ordinary default device credentials cannot administer the
binding even though their historical scope contains `access:manage`: the service
requires current operator credential identity.

Retry the same operation ID with the same intent after an uncertain response;
read it back before deciding what happened. A different intent under that ID
conflicts. Revocation may make resolution unavailable to the former participant;
it does not authorize a new writer. There is no timeout-based reassignment or
cancel/unseal/commit endpoint in this slice.

HTTP tests use real owner-approved pairing, external SQLite connections and the
runtime authentication middleware to initialize, prepare and read back decisions.
Store tests cover restart, wrong participants and revocation. These are durable
preparation tests, not source sealing, target verification or two-host execution
handoff evidence.

## Planned-transfer decision storage

The private [planned transfer store](../../src-server/services/orchestration/planned-home-transfer-store.ts)
provides a SQLite implementation of `PlannedHomeTransferStore`. Consumers await
its operations; asynchronous database or remote-service adapters can implement
the same interface. A composing
service supplies a centrally owned database outside portable home archives.
The adapter requires a file-backed SQLite database with durable journaling and
`synchronous=FULL` or `EXTRA`, checked at initialization and in every transaction.
A later durability downgrade makes operations unavailable. These settings do
not certify the underlying filesystem or storage hardware.
A composing authority service uses `createAuthorizedSqlitePlannedHomeTransferStore`
with a required caller-bound synchronous authorization predicate. The adapter first checks it before acquiring the write lock, then checks again
under the transaction lock before access and before commit. Revocation rolls back the entire decision change and
returns `denied`; a failed authority lookup returns `unavailable`. Promise-valued
guards are refused, never treated as truthy grants. The callback must be owned
by the service, not supplied by a request body. The guarded entry rejects an absent guard. The separate unguarded constructor
retains the private storage-only API; it is not safe to expose directly.

The adapter itself performs no home authentication, membership authorization,
lease issuance, renewal or target activation. No runtime write path currently
uses its decisions as execution authority.

The store reserves an exact tenant/channel/source/target/policy intent against
an owner revision. One pending transfer per tenant/channel prevents competing
preparations. Source closure binds the real room checkpoint and working-state
digest; target readiness must name that exact closure digest and target home.
Commit updates the owner decision and operation record in one transaction.
Repeating a committed operation returns its original result, including after
reopening the database. A missing response is resolved by operation ID, never
by assuming that the commit failed. There is no timeout-driven reassignment or
unseal operation.

Tenant-qualified keys prevent storage lookups from mixing identically named
channels and operations. This is storage partitioning, not tenant authorization:
the future service must derive the tenant and authenticate both homes before
calling it. Identifiers, exact record shapes and stored JSON reads are bounded;
corrupt records are unavailable rather than treated as missing enrollment.

Tests exercise independent processes that both observe the same source revision
before racing preparation, transaction rollback after an injected commit-write
failure, duplicate decisions after reopening, and tenant-qualified lookups.
They do not prove network partitions, a deployed witness, accepted-writer
fencing, or live session continuation. Those remain integration requirements.

## Private coordinator and verified decisions

The paired authority's server-private `advance` operation composes the
[planned coordinator](../../src-server/services/orchestration/planned-home-transfer-coordinator.ts)
with its caller-bound transaction guard. Only the prepared source participant
may advance; both participant grants and the controller identity must remain
current. The integration supplies trusted source history and target history
owners with their respective grants. These are server-owned adapters, not request
JSON, manifest locators or user-submitted checkpoint assertions. An authenticated
remote-home transport and enrollment binding still need to supply these owners
before this can become a public one-click flow. Passing the same history object
as both owners is refused before sealing. Distinct objects alone are not proof
that a target store belongs to the paired target: wrappers can alias a source
store. That runtime enrollment binding is still an explicit prerequisite, so
this private API must not be mounted as a public advance/commit endpoint or used
as execution authority. The tests prove checkpoint verification for the supplied
stores, not authenticated remote-store ownership.

The coordinator resolves the stored operation before doing work. It seals the
source through `ProjectTaskRoomHistory.sealSource`, records that exact closing
checkpoint and document digest, reads the restored target through
`readSourceSeal`, and compares its canonical digest before recording readiness.
A retry from target-ready verifies the target again before the conditional
ownership decision commit. There is one canonical seal-digest implementation
shared with the decision store.

Publication-pending and execution-pending source outcomes remain pending. An
unsealed or unavailable target remains target-unavailable; unavailable can include
corrupt restored data, which needs repair rather than timeout promotion. Wrong
operation, target or checkpoint evidence conflicts. Lost commit responses remain
resolvable from the durable operation; a retry of a committed decision returns
that decision without sealing or copying again. If another driver commits before
a closure/readiness acknowledgement arrives, the first driver returns the
already-committed decision instead of reporting a conflicting intent.
No error automatically unseals
the source. Revocation during the asynchronous source seal can leave a sealed
source and an unadvanced controller record; that is a frozen recovery case, never
permission to restart the source.

`decision-committed` is deliberately smaller than a completed move. Both execution
flags stay false; source and copied target remain sealed. This driver does not
copy files, enroll remote transports, activate target writes, renew a lease or
launch an Agent. Public HTTP routes still expose only registration, preparation
and readback; there is no route accepting raw closure/readiness evidence or an
ownership commit command.

Coordinator tests use actual file SQLite, EventStore room owners, closing seals,
a stopped-source database copy and restored readers. They cover retry after a
lost decision acknowledgement, target corruption and wrong seal, pending source
outcomes and revocation. Paired-authority integration tests connect the real
pairing registry to those same room owners and prove that a target caller cannot
advance and that revocation during source closure leaves the source sealed.
These tests do not establish independent-host transport, provider continuation
or target activation. Those remain the next acceptance boundaries.

## Fence the operation, not only admission

1. **Admission:** source closure durably prevents new room mutations and new
   execution starts. The barrier is observed after restart and by every local
   process sharing the source stores.
2. **In-flight work:** wait for admitted writes to settle or retain an explicit
   unresolved state. Provider invocation with an uncertain result is not
   equivalent to an unstarted attempt. Do not create a successor that might
   duplicate that attempt.
3. **Closure:** capture the closing checkpoint only after the barrier and drain.
   The history and working-document publication outbox must agree at this
   boundary; a checkpoint cannot hide an unpublished committed edit.
4. **Target verification:** read the restored state through its real store
   owners, verify the exact checkpoint and immutable references, and bind the
   receipt to the selected target. A workspace digest alone is insufficient.
5. **Ownership commit:** transition atomically against the same source lease,
   policy and transfer ID. Delayed responses and repeated requests return the
   same decision. No target execution is accepted before this decision.
6. **Publication and acceptance:** enforce authority at the durable write and
   delivery boundaries, including queued work and replay. A lease checked
   before an `await` does not fence a write that completes after ownership has
   changed. Clients must validate the relevant authority, not merely compare
   epoch numbers supplied by the home.

Lease expiry requires an explicit clock/expiry contract for both holder and
verifier, including suspension, delayed renewal responses, clock changes and
early revocation. Do not invent that contract from a database timestamp or
assume a JavaScript timer stops a suspended process. Until the chosen adapter
and write sinks meet it, automatic witnessed promotion remains unavailable.

## Production integration points

The initial private source barrier is `ProjectTaskRoomHistory.sealSource`.
It requires a dedicated `home-transfer` grant from an operator principal,
reauthorized while the history worker holds its write transaction. It validates
retained history, refuses pending revision/lifecycle publications, and stores
one immutable source/target intent plus closing checkpoint. A repeated intent
returns the same seal; a changed intent conflicts. History and document workers
consult that seal inside their commit transactions. Reads and exact duplicate
receipts remain available. There is no unseal operation.

`ProjectTaskRoomHistory.readSourceSeal` lets the target inspect a copied
closing seal using a read grant. It validates the retained history and exact
closing checkpoint in one read transaction, bounds stored seal fields before
loading them, and reauthorizes before returning the result. An unsealed room
stays unsealed; corrupt or missing evidence never creates a replacement seal.
Inspection grants no target write authority: copied sealed rooms still refuse
new writes. A transfer coordinator must separately compare this observation
with the authenticated source receipt and selected target identity before
activation. No coordinator or activation endpoint is exposed by this reader.

New seals also contain a digest of the room's document snapshots and replay
metadata, captured inside the closing transaction. The document owner validates
each snapshot before hashing its exact source bytes. Verification recomputes
that digest, so unchanged history cannot mask altered document data. Capture is
bounded to 128 documents of at most 512 KiB each; larger or deferred snapshots
remain unavailable for sealing. The digest is integrity evidence, not a home
signature or ownership grant. Legacy seals without a captured document digest
stay sealed but cannot claim this verification; the target must not manufacture
the missing source evidence from its own copy.

This barrier does not yet have a public runtime/HTTP caller. The supplied home
references are intent bindings, not independently verified host identities.
Target activation, the external authority adapter and cross-host acceptance
remain to be composed before exposing a move command.
An immutable server-owned session/room binding now joins the existing
`orchestration_turn_boundaries` records to the source seal in the same SQLite
transaction. Pending bound execution prevents closure, including indeterminate
invocation after restart. A sealed room refuses a new bound turn claim before
its provider callback runs. Binding cannot be changed to another room or added
to a session with an active unbound invocation. This is an association, not a
second execution ledger or a grant inferred from session metadata.

Session creation now uses the same durable boundary owner with a distinct
start claim and no invented provider turn ID. Production interactive starts,
credential-recovery starts and lazy materialization acquire it at adapter
invocation, after resource and launch-policy checks. Confirmed startup clears
the claim; an ambiguous adapter failure retains possible-effect truth and
reports an indeterminate, non-retryable outcome. The resulting diagnostic
`runtime.error` does not clear that record, either live or during replay.
The existing interrupted-turn banner consumer also excludes session-start and
dispatch records. Displaying a notice is not evidence that those effects ended;
its final storage deletion refuses those record kinds even if given a stale
or misrouted acknowledgement. Their unresolved admission survives another boot.

Task dispatch supplies its exact persisted Project/Task scope through the
server-only start options. Startup binds that scope before invoking an adapter,
including when the room has not yet been opened. Public session metadata does
not create a binding. Hosted binding is refused until tenant-owned stores are
composed. Existing bindings cannot reopen sealed admission.

The dispatcher retains one `task-dispatch` admission record across external
assignment claiming, provider startup, graph association and publication
preparation. The adapter receives a capability bound to the exact session;
its startup acknowledgement cannot release the enclosing dispatch record.
Provider terminal events do not settle that broader ownership, either live or
through replay. A late provider result cannot undo an indeterminate dispatch.
Known completion or compensation releases the record; uncertain effects or
publication preparation retain it. Preparation requires the worker's actual
durable acknowledgement; an unavailable write cannot be treated as success.
The outbox refuses a different payload under an existing intent and refuses
new lifecycle entries after the source seal. Tasks without an Agent have no
Agent-start publication to prepare. A crashed dispatch therefore needs explicit
dispatch reconciliation, not an assumption that provider exit completed every
other phase.

At startup, the room lifecycle readiness path repairs only demonstrably
completed dispatches. It joins the immutable session binding, a unique
completed Task association without an active reservation, and the persisted
provider session. It durably prepares the lifecycle publication and rechecks
the Task association before releasing the exact dead owner's record. A live
or unverifiable owner is never taken over. Missing, changed, corrupt or
uncertain evidence leaves admission blocked; this path never starts a provider
or repeats an external assignment claim. Each startup attempts at most 128
records. Unresolved external effects still require separate reconciliation.

Legacy sessions and other execution ingress still need verified scope binding.
A move caller must not claim full home or Project quiescence from one private
room seal: new Task creation and other home mutations require their own
admission boundary. Lifecycle cleanup remains allowed after a seal so the old
source can stop idle sessions. Only a reviewed compatible runtime may operate
a sealed source; downgrading to code that predates the barrier is not fencing.
The barrier tests exercise real SQLite worker connections and restart; they
do not substitute for the independent-process, network-partition acceptance
journey below.

| Existing owner | Integration required |
| --- | --- |
| ProjectTaskRoomRuntime | Resolve authenticated home authority; fence message, edit and publication admission; name moved/frozen/unavailable outcomes |
| Room history and working-state workers | Enforce the durable source seal inside their commit transactions; return exact closure evidence |
| ExecutionTargetExecution and TaskDispatcher | Refuse starts under a transferred authority and retain indeterminate provider starts; apply the same policy to direct and queued ingress |
| Scheduler and background delivery | Reauthorize exact tenant, principal and home at execution/delivery, not only when scheduling |
| Room SDK and viewing clients | Verify home/lease bindings for accepted live data and reconnect; show a named recovery divergence point |
| StationHomeArchive | Carry data under offline maintenance; never mint or copy live ownership |

Peer-only recovery without a witness remains an explicit recovery from a copy,
with a named divergence checkpoint. It must not reuse the planned-transfer
success outcome. Downloaded data cannot be retracted after revocation.

## Acceptance evidence

The delivery test must run independent source and target processes, with a
separate authority process or real selected backend. Each process uses an
isolated home and identities. Exercise actual authenticated mutation and
execution ingress rather than calling only the lease adapter.

- Race source writes with closure and target activation. Every accepted write
  belongs to one authority interval, and the target starts from the exact
  closing checkpoint.
- Hold a source operation across transfer, suspend/resume its process, and
  delay renewal responses. A pre-transfer admission cannot publish accepted
  post-transfer work.
- Cut each network direction during preparation, copy, closure, readiness and
  commit. Lost replies remain resolvable by operation ID; uncertainty never
  enables both homes.
- Interrupt the copy and corrupt target content. Target admission remains
  closed and the transfer outcome does not claim completion.
- Restart each owner at every durable boundary. A copied old source and a
  restarted source cannot resurrect the previous authority.
- Exercise wrong-tenant, wrong-home, revoked-policy and repeated-operation
  requests, including requests with a reused ID but different target or digest.
- Verify provider continuation separately: exact successor identity, original
  references, declared credential/workspace gaps, and no duplicated provider
  invocation. A working room transfer alone cannot prove agents continued.

These are prerequisites to advertising the cloud-move guarantee. Adapter unit
tests, local maintenance tests and deployment health checks each prove a
smaller boundary and must retain that scope in their receipts.
