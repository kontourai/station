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

The protocol limits requests to 2 MiB, frames to 3 MiB, channel lifetime to
64 MiB, concurrent requests to four and total requests to 1,024. Response chunks
are at most 64 KiB. These transport bounds do not establish token or fiscal
budgets. Client credentials are stripped from forwarded request headers.

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

Add `--with-native-engines` to run pinned Linux Claude 2.1.322 and Codex 0.167.0
binaries through the same channel. Downloads must match exact byte counts and
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

### Native text request preparation

`--with-native-engines --with-bounded-text-wire` also exercises
[`prepareNativeTextModelRequest`](../../src-server/runtime/conversation/native-text-model-request.ts)
before generating the synthetic reply. The helper preserves text, imposes the
server-selected output cap without increasing a smaller native cap, removes
advertised tools and native beta/state headers, and selects standard service.
Responses input containing opaque reasoning, tool results or server conversation
references refuses. Pro reasoning mode refuses. This helper issues no grant,
reserves no budget and performs no fetch. A future serving caller must authorize,
quote and reserve the returned bytes, then attach its own observed credential.
The original native request hash cannot authorize different prepared bytes.

The private artifacts retain original and prepared request bodies as mode-0600
files beside their hashes. At `b3bd8d03f0d2`, actual Claude 2.1.322 emits
`max_tokens: 32000`; actual Codex 0.167.0 emits no output cap and advertises nine
tools, including provider-side web search. Transport confinement alone therefore
cannot establish provider-request budget or tool restrictions.

At `4577e4312785`, both actual native clients complete synthetic turns through
the prepared text requests: both caps are 2,048, Claude's thinking budget is
2,047 and both tool arrays are empty. Codex uses `tool_choice: none` and disables
parallel tools. The container is removed, its worker settled and pending channel
requests are zero. The preceding integration fails because the helper refuses
Claude's observed `?beta=true` route; the repair explicitly returns the standard
path and strips beta headers. That failure remains retained.

Independent cap-removal and tool-retention faults fail the intended final-byte
assertions; each source is restored byte-exactly. These checks establish request
construction and synthetic native consumption, not provider enforcement or
monotonic ledger accounting. The [official Responses reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#controlling-costs)
documents that `max_output_tokens` includes reasoning and visible output. That
does not supply a complete tariff, model entitlement or approved qualification
record. Responses pricing, source admission and native issuance remain open.

### Native qualification records

The separate `native-text-single-request-v1` contract is resolved through
[`resolveBoundedNativeApiProviderContract`](../../src-server/runtime/conversation/bounded-api-provider-contract.ts).
Its caller must supply the expected server-owned image, executable, CLI version
and request-preparation identity. The approved registry record must match all of
them and include the executable, image and preparation hashes in its source set.
The `sdkPackage` binding names the actual platform distribution for this profile;
the current implementation accepts only the Claude Linux/arm64 package. It does
not relabel a native client as the AI SDK.

Native contracts require streaming text with an empty tool array. SDK resolution
and SDK source-owner creation refuse native approvals. Native resolution refuses
SDK approvals. Existing provider usage validation and tariff accounting apply;
retained historical pricing remains inert after registry revocation. There is no
default registry, production approval, native source grant or paid launch in this
module. Hash membership validates the supplied approval's binding; it does not
independently prove image construction or runtime confinement.

At `690d47d6a47c`, the two contract/SDK-owner suites pass 146 cases. Separate
producer-comparison, SDK-separation and native-tool-check faults each fail their
intended API assertion. Byte-exact restoration passes the four selected positive
and refusal cases. These are synthetic registry fixtures, not provider evidence.
The parser split at `c86f6446c6` passes all 66 contract cases. Removing its SDK
schema's native-metadata refusal fails the intended assertion; byte-exact
restoration passes all 66 cases again. Server-test typing passes at the earlier
profile checkpoint. Native source admission and physical reservation remain
unfinished: the [existing source owner](../../src-server/services/orchestration/delegation-group-source-admission.ts)
cannot lend its SDK lease or private prototype wire as a native grant. Its group
methods must not receive invented group/seat identities for a single Task.
Codex/Responses qualification and the full inherited-authority acceptance remain open.

### Root Task source custody

[`captureRootNativeTaskSnapshot`](../../src-server/services/orchestration/delegation-group-source-admission.ts)
uses the live [durable create allocation](../../src-server/services/orchestration/create-request-claims.ts),
not a caller-supplied Task or group identity. The HTTP route carries its exact
Request object internally; that object is neither accepted from JSON nor stored
in the claim ledger. Only newly server-minted Task identities qualify. Legacy
claims without identity-origin evidence retain ordinary creation/replay behavior
but cannot gain this native custody by inference.

Current personal-operator authority is checked around protected synchronous
source reads. The seal binds actual file bytes to the Task allocation in a
separate private domain and returns references, never source text. Native and
group snapshots share the existing four-holder and twelve-MiB retained-byte
bounds. Native seal receipts have a 1,024-record refusal cap and are not evicted.
Current-custody checks fail after the create callback closes, on Request
replacement, receipt change, expiry or credential revocation. Releasing these
source buffers is not evidence of runtime or accounting cleanup.

At `0ac7fd7bff4d`, the native/create/route-claim selection passes forty cases;
the restored native/create/group-source selection passes all 47. Two actual
route cases prove that the server's Request replaces a JSON authority claim.
Four isolated faults are caught: wrong-Request borrowing, provided-Task origin,
ancestor-to-root fallback and skipped per-file authority. The last fault reads
one extra source file after a committed revocation and fails its zero-read
assertion. Each source is restored byte-exactly. Two empty table-case selections
are retained as invalid mutation attempts, not catches.

Earlier fixture failures remain separate: repeated filesystem spies recurse,
and the first revocation control does not establish a committed independent
revocation. The corrected control registers its action outside the source Home
span, verifies the revocation commits and observes the next file remaining
unread. No production guard or deadline is relaxed.

This is allocation/source custody only: it proves neither Session existence nor
native process start. Session-parent calls refuse before source capture until
genuine ancestor-source admission exists. Native execution-resolution binding,
safe producer hand-off, physical reservation and retained accounting are still
unwired; both production qualification flags remain false.

## Evidence and limits

The [real-worker process tests](../../src-server/services/connections/__tests__/native-model-stdio-channel.process.test.ts)
cover authentication, Unicode/binary framing, request limits, private-byte
withholding after revocation, cancellation before delayed cleanup, and retained
terminal/accounting ownership. Bypassing only the body-delivery check exposed
23 private bytes in the stronger test; later response failure could not hide it.

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
