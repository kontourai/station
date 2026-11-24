# Confined native model-channel lab

This opt-in contributor lab exercises a prerequisite for [#91](https://github.com/kontourai/station/issues/91).
It is not connected to ordinary Session launch, and grants no delegation,
provider access or workspace publication authority.

## Boundary and owners

[`NativeModelContainer`](../../src-server/services/connections/native-model-container.ts)
owns a single server-selected Docker namespace. Call `prepare()` before
`start()` so the caller retains custody even if startup fails. Namespace IDs
have exclusive private directories; an uncertain create response stays
unconfirmed rather than licensing another worker. Removal requires the captured
daemon, exact container/image identity and private ownership label.

The same live owner can recover a lost create reply for cleanup. A name only
locates a candidate: the original daemon, image and private nonce must match
before the full container ID is retained and removed. An absent or foreign name
remains unconfirmed. A failed close can be retried, but retirement never permits
another start or connection. Successful cleanup does not make the failed start
successful.

The namespace has no network, host bind mounts, Docker socket or added
capabilities. Its root filesystem is read-only; staging and the native home use
private tmpfs mounts. It has a 512 MiB memory/swap limit, one CPU and 64 PIDs.
The bridge runs as UID 10000; native clients run as UID 10001. These are explicit
fixture bounds, not portable resource-grant enforcement.

[`NativeModelStdioChannel`](../../src-server/services/connections/native-model-stdio-channel.ts)
forwards bounded HTTP request bytes from the loopback worker to a required host
callback. The worker receives a scoped bridge key, never a provider key, and has
no provider fetch fallback. The host callback must supply authority, reservation,
provider credentials, final-fetch checks and accounting; this module supplies
none of those owners. It returns separate response and terminal-settlement
promises and a captured delivery port. Every actual response-frame write
re-enters that port. Finished response bytes or a retired worker do not release
pending accounting. Unexpected channel loss aborts active request signals before
waiting for worker cleanup. A failed or timed-out close remains a failure.

The private bridge offers `POST /station/delegation-rpc/v1` when its host
supplies a separate RPC callback. The default bridge serves model requests.
The RPC route accepts the exact path without a query, authenticates the
scoped bridge key, and forwards only Accept and Content-Type. The model
owner receives no RPC bytes. RPC responses expose Content-Type only.
Both request types share the existing byte and concurrency limits. Each
actual response write checks the captured delivery port, and host settlement
continues to own completion after a response is sent.

The worker also has an internal stdio relay mode for an explicitly bound
loopback broker. The relay carries the scoped key in its environment and
forwards requests through the fixed RPC path. It bounds requests, concurrency,
and output. A reply must name the exact request ID, including its type, and
contain either a result or an error. An invalid reply closes the relay.
The request deadline includes writing the reply to the relay's stdout pipe.
Input closure or deadline expiry cancels pending relay requests and closes
the pipe even when its reader stops draining.

Parent issuance, native launcher configuration, effect admission, and model
accounting still require their own owners before serving inherited delegation.

The protocol limits requests to 2 MiB, frames to 3 MiB, channel lifetime to
64 MiB, concurrent requests to four and total requests to 1,024. Response chunks
are at most 64 KiB. These transport bounds do not establish token or fiscal
budgets. Client credentials are stripped from forwarded request headers.

The [fixed-text request preparer](../../src-server/runtime/conversation/native-text-model-request.ts)
is a dormant prerequisite. It validates bounded JSON, applies the selected
model and output cap, and strips tools and opaque provider state from the
final request. A future caller must authorize those final bytes through the
source, credential, and reservation owners before any provider request.

The separate brokered request profile is also dormant. It replaces native tool
declarations with the host's selected MCP tools, keeps the requested model and
output cap, and accepts only text plus matched calls and results in the
Station delegation namespace. Requests with unknown, duplicate, or incomplete
tool history are refused. For Responses requests, an explicit no-tools choice
remains in force.
The host still needs a current parent grant, effect authority, and a reservation
for each physical attempt before forwarding these bytes.

## Run the lab

Use a local Linux/arm64 Docker daemon and the repository's managed dependencies.
Select an absolute Docker executable and capture its local Unix socket endpoint;
the runtime never follows a mutable Docker context or pulls a serving image.
Run from a clean committed checkout:

```sh
export CHILD_WORK_DOCKER_EXECUTABLE=/absolute/path/to/docker
export CHILD_WORK_DOCKER_ENDPOINT=unix:///absolute/path/to/docker.sock
export CHILD_WORK_NATIVE_LAB_SOURCE_HEAD="$(git rev-parse HEAD)"
STATION_HEAVY_CHECK_SLOTS=1 npm run lab:native-model-channel -- --run-real-local-lab
```

The command acquires the normal host-wide heavy-check slot before execution.
The explicit lab pulls a digest-pinned Node base and builds its owned worker
image. It leaves image cache additions in place and removes only its confirmed
owned container. Private artifacts retain source/input hashes, Docker identity,
observations and cleanup state; the final output names that artifact directory.
The scoped bridge key is retained in the private generated runner, so this is
not key-erasure evidence.

Add `--with-native-engines` to run pinned Linux Claude 2.1.322 and Codex 0.167.0.
Each binary gets its own verified namespace and model channel. The container
owner admits one fixed text client per namespace and delivers the prompt through
the caller's stdin writer. The prompt stays out of process arguments and
environment variables. The owner bounds combined output to 1 MiB and tracks
the program result, local exec settlement, and namespace removal separately. Downloads must match exact byte counts and
SHA-256 digests. An explicit `CHILD_WORK_NATIVE_BINARY_CACHE_ROOT` may name an
existing owned artifact directory containing `claude` and `codex`; copies pass
the same integrity checks. A truncated download refuses before image creation.
Codex uses a local catalog for the synthetic `station-channel-fixture` model;
that metadata describes this fixture, not an upstream model or entitlement.
The fixture supplies synthetic Messages/Responses replies and never calls a
real model provider.

### Create-only lifecycle controls

Use the captured executable and Unix endpoint above, and select an existing
local immutable image ID. This lab neither pulls an image nor starts a worker,
native engine or model:

```sh
export CHILD_WORK_DOCKER_IMAGE_ID='sha256:<full-local-image-id>'
export CHILD_WORK_NATIVE_LAB_SOURCE_HEAD="$(git rev-parse HEAD)"
STATION_HEAVY_CHECK_SLOTS=1 npm run lab:native-container-lifecycle -- --run-real-local-lab
```

The controls hold a real create reply during cancellation, lose a reply after
Docker creates the resource, put a separately owned foreign nonce at the
original name, and remove a fixture before the original owner discovers it.
Cleanup uses recorded Docker reply IDs and daemon/image/nonce checks. A missing
name does not establish release. The owner must not create twice, start a worker
or disclose a connection after retirement.

At `62e5301dd2da`, cancellation passes but lost-reply cleanup fails with
`native_container_creation_unconfirmed`; test-owned fallback cleanup settles.
At `d7b558f07495`, all four controls pass with zero model requests and no fixture
cleanup failures. Removing the recovery nonce check fails the actual foreign
identity assertion; byte-exact restoration passes all four controls and the six
existing channel process cases. Scripts typing and read-only lint also pass.
These are same-live-controller cleanup controls. Controller-death reconstruction,
lost removal replies, paid native authority and general cleanup recovery remain
unqualified.

## Evidence and limits

The [real-worker process tests](../../src-server/services/connections/__tests__/native-model-stdio-channel.process.test.ts)
cover authentication, Unicode/binary framing, request limits, private-byte
withholding after revocation, cancellation before delayed cleanup, and retained
terminal/accounting ownership. The relay test closes stdin while a valid RPC
reply is blocked on unread stdout and verifies that the relay exits before
forced cleanup. Bypassing only the body-delivery check exposed
23 private bytes in the stronger test; later response failure could not hide it.

The [simulated exec tests](../../src-server/services/connections/__tests__/native-model-container.test.ts)
cover private stdin delivery under competing starts, preserving the result when
exec settlement fails, and closing model admission during a pending exec stop.

The isolated lab exercises real read-only-root and network refusal, private
staging, synthetic model replies and owned cleanup. With native engines, it
requires each actual CLI to issue a model-channel request and return its exact
reply. Claude must report structured success. Codex must complete one turn
without error events; exit zero does not hide model-metadata fallback. A retained
negative run demonstrated that rejection before the explicit fixture catalog
removed the metadata gap.

These fixtures do not qualify native tools, inherited grants, monotonic budgets,
provider prices or billing, staged effect publication, peer/SSH transport,
parent/child/grandchild execution, restart recovery or general descendant census.
Production admission and qualification stay with the existing owners; no feature
flag or engine policy is enabled by this prerequisite.
