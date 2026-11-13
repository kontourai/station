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
STATION_HEAVY_CHECK_SLOTS=1 node --import=tsx scripts/heavy-check-slot.mjs native-model-channel scripts/child-work-native-model-channel-lab.ts --run-real-local-lab
```

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
