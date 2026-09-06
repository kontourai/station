# Preparing a personal home-transfer controller

This integration preview binds explicitly paired Stations to real Task-room
identities. It supports durable preparation and live binding checks. It does not
move a home, activate a target, resume Agents, or enable hosted tenant sharing.
The [authority design](../design/channel-home-authority.md) owns the protocol and
remaining execution requirements.

## Run separate Station identities

Use matching Station builds, Node 24, and the existing
[deployment guide](deployment.md) for a controller and the prospective source
and target. They may be separate isolated instances on one development machine;
that is useful testing, not independent-host qualification. Give each instance
its own home, identity, and ports. A controller cannot bind its own environment
as a remote home. Two participant identities cannot alias the same remote
Station identity.

The controller currently requires POSIX and one running controller process.
Create an existing private directory owned by that service user, outside every
portable Station home, and set this when starting the controller:

```bash
export STATION_HOME_AUTHORITY_DATABASE=/private/controller-state/authority.sqlite
```

Replace the example with your deployment's external path. The directory must
already exist with mode `0700`; database and SQLite sidecars must be private
regular single-link files owned by the controller user. In a container, mount
separate controller state with the service UID as owner, outside the Station
home volume. Windows controller storage and hosted tenant mode are unavailable.

SQLite uses WAL and FULL synchronization. Keep controller backups separate from
home exports and stop the controller before backing it up. Do not run a second
controller from a copied database or rename active database files. The OS user
is trusted; these path checks are not a defense against a hostile process
running as that same user.

## Pair in both directions

Use the normal owner-approved [device pairing flow](../security/remote-access-threat-model.md).
On the host creating an offer, an operator sends `POST /api/pairing/offers` with:

```json
{"endpoint":"https://station.example.test","scope":"home:transfer"}
```

Complete request, owner approval and exchange. Do this separately for each
participant and for each direction:

| Credential | Issuer | Used for |
| --- | --- | --- |
| Source participant credential | Controller | Source preparation and its own binding reads |
| Target participant credential | Controller | Target operation and binding reads |
| Controller outbound source credential | Source Station | Source room identity probe |
| Controller outbound target credential | Target Station | Target room identity probe |

A controller-issued participant ID is different from the device ID the remote
Station assigned to the controller. Record which issuer owns each ID. Ordinary
default, standard and delegation credentials do not acquire `home:transfer` on
upgrade. The scope provides no general orchestration or terminal authority.

Store credentials using private credential owners. Never put them in Project
manifests, workspace packages, source control, or request logs.

## Register outbound peers

Use the controller operator's authenticated API client to send
`POST /api/environments/peers` for each remote:

```json
{
  "environmentId": "<remote Station environment ID>",
  "apiBase": "https://source.example.test",
  "credential": "<credential issued by that remote to the controller>",
  "scope": "home:transfer",
  "label": "Source Station"
}
```

This is the server-side peer store. Client UI saved connections and native
transport credentials do not populate it automatically. Registry mutations
require current operator or verified internal authority, including after waiting
for the file mutation lock. Historical `access:manage` device grants may still
read permitted metadata, but cannot write this credential registry. Raw
credential retrieval remains internal-only.

## Enroll a room mapping

Use the actual source room's channel ID and Task IDs that exist on the remote
Stations. A Project slug or display label is not the channel ID. The channel
identity is derived from the Task's exact Project/Task scope; the remote probe
checks that scope without opening the room or draining publications.

As the controller operator, send
`POST /api/home-authority/channels/:channelId/bindings`:

```json
{
  "controllerDeviceId": "<controller-issued source participant ID>",
  "remoteEnvironmentId": "<source Station environment ID>",
  "remoteTaskId": "<source Task ID>"
}
```

Repeat for the target with its own participant/environment IDs and restored
Task ID. The API derives the outbound origin and credential from the peer store;
the body cannot supply a URL, bearer credential, tenant or remote-issued device
ID. It sends a fresh nonce to the remote room probe and checks the exact returned
nonce, environment, remote-issued device, Task and channel identities. Redirects
are refused; responses are limited to 4 KiB and the whole probe has a 15-second
deadline, including body reads.

HTTP 200 returns `kind: stored` and a `HomeTransferRoomBindingObservation` value
from the [cloud-move contract](../../packages/contracts/src/cloud-move.ts). The
public value includes the two sides' IDs, but no bearer, peer fingerprint or
private tenant namespace. Both execution flags remain false.

Identical enrollment is idempotent. Initial bindings are immutable: a different
mapping conflicts. Any outbound peer-record change, including label or timestamp
changes, invalidates the stored fingerprint. Replacement, removal and credential
rotation for an existing binding need a future explicit maintenance flow; they
are not production-supported by this preview. Do not repair bindings by editing
the database.

## Recheck and prepare

A participant can recheck only its own mapping through:

```text
GET /api/home-authority/channels/:channelId/binding
```

The operator can inspect a specified participant through
`POST /api/home-authority/channels/:channelId/bindings/:controllerDeviceId/inspect`
with `{}`. This POST is operator-only even when a participant also carries the
historical `access:manage` scope. Both reads re-probe the remote and recheck the
participant and peer record before returning a bound result.

For the separate owner registration and prepared-operation bodies, use
[personal decision preparation](../design/channel-home-authority.md#personal-controller-decision-preparation).
The prepared source participant can send `{}` to
`POST /api/home-authority/transfers/:operationId/advance`. The controller builds
its network readers only from the enrolled mappings and current peer records.
It does not accept a URL, credential, adapter, grant or checkpoint in this request.

An unsealed source returns HTTP 202 with `source-not-closed`. The source owner
must already have produced a real closing seal for this exact operation. A
general source-close UI/CLI is not shipped in this preview; this read-only network
path does not create that seal. After a separate owner action closes the source
and its state is restored, the controller reads the closing seals from both
expected endpoints, verifies the exact identities/nonce/tuple/digest, and may
commit the metadata decision. HTTP 200 `decision-committed` still has both
execution flags false. The copied target stays sealed and cannot execute.

The remote read-only endpoint is
`POST /api/home-authority/rooms/:taskId/seal-observation`. Its body contains
`channelId`, `operationId`, `sourceHomeRef`, `targetHomeRef` and `nonce`.
It exposes the existing closing checkpoint, not message/document content.
The controller uses it internally with an 8 KiB response ceiling and a 15-second
whole-RPC deadline. Individual identity and seal RPCs have their own deadlines;
a complete advance can make several calls. Lost responses are resolved by
operation ID, not by assuming rollback. A committed replay uses the stored
decision and current controller-side participant grants; it does not require
the source or its outbound peer record to remain available.

No raw closure/readiness submission, remote source-close command, target
activation or Agent launch endpoint is enabled.

Revoked participants, removed/changed peer records, failed remote authentication,
wrong identities and corrupt storage prevent a successful binding result. Missing
records use 404, denied caller authority 403, conflicting identity/mapping 409,
and unavailable storage/transport 503. A failed remote credential can appear as
unavailable transport to the controller; never interpret it as permission to use
another endpoint or start execution.

## Reproduce the integration checks

From an isolated repository worktree with managed dependencies installed:

```bash
npm run test:focused -- \
  src-server/services/orchestration/__tests__/home-transfer-room-binding.test.ts \
  src-server/services/orchestration/__tests__/home-transfer-room-probe.test.ts \
  src-server/routes/environments/__tests__/home-authority-routes.test.ts \
  src-server/routes/environments/__tests__/remote-home-transfer-decision.test.ts
```

These tests use disposable pairing registries, external SQLite and authenticated
HTTP fixtures. Runtime tests separately use real persisted TaskGraph scope and
the production principal composition, asserting no room-history effects. They
do not establish a real cloud deployment, hardware attestation, unique physical
hosts, live Agent continuation, or target activation.
