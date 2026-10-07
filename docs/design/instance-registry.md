# Design: Instance Registry (`<STATION_HOME>/instances.json`)

> **Reading status: current storage contract with recorded race evidence.**
> [Shared registry](../../packages/shared/src/instance-registry.ts),
> [CLI lifecycle](../../packages/cli/src/commands/lifecycle.ts),
> [service management](../../packages/cli/src/commands/service.ts), and the
> [Desktop bridge](../../src-server/tools/instance-registry-bridge.ts) are the
> implementation owners. The historical race and platform claims below need
> their own evidence; current owner links alone do not re-prove them.

> Status: **landed and wired for durable services and Desktop sidecars**. The module
> (`packages/shared/src/instance-registry.ts`, published as
> `@kontourai/station-shared/instance-registry`) is built and tested — including
> a real two-child-process race proof of its cross-process safety. `station
> service install` is its durable-service producer, while Desktop uses the
> packaged registry bridge to consume service records and to publish/remove its
> desktop-owned Command Station sidecar. This document describes the shared
> schema and lock discipline those callers must preserve.

## Why this file exists

The Command Station epic (#1672) needs a durable, host-wide record of every
Station instance running on a machine — not just the one a given CLI invocation
happens to be talking to. `<STATION_HOME>/instances.json` is that record: one
file per Station home, keyed by an arbitrary instance id, describing each
instance's port, type, and last-known status.

This is a **different concept** from the existing
`.station/instances/<instance-id>.json` mechanism `station start`/`station stop`
already use — see [Distinction from `.station/instances/*`](#distinction-from-stationinstances) below. Same word, two different scopes; this section exists so a
future reader who finds one does not assume it is the same thing as the other.

An instance is a Station process/lifecycle record, not a physical machine,
saved Station entry, authenticated environment, principal, tenant, Project
binding, room home, or execution offer. One machine can run several instances.
The cross-concept topology and authority boundary is defined in
[station-topology.md](station-topology.md).

## Schema

```json
{
  "version": 1,
  "instances": {
    "<id>": {
      "port": 3141,
      "uiPort": 3000,
      "host": "127.0.0.1",
      "checkout": "~/dev/station",
      "channel": "stable",
      "buildSha": "abcdef0123456789abcdef0123456789abcdef01",
      "builtAt": "2026-07-10T18:00:00.000Z",
      "type": "service",
      "status": "running",
      "pid": 12345,
      "startedAt": "2026-07-10T18:00:01.000Z",
      "env": { "STATION_CHANNEL": "stable" }
    }
  }
}
```

- `version` is always `1` in this slice. There is no
  `STATION_HOME_SCHEMA_VERSION` bump — this file is additive, sibling state to
  the home schema, not part of it.
- `instances` is a map keyed by an arbitrary caller-chosen instance id (not
  necessarily the same id space as `STATION_INSTANCE_ID`).
- `InstanceConfig.host` is the address the UI listener bound, recorded by `station start`; `station open` links to it. Absent on older entries and on the Desktop sidecar, which read as `localhost`.
- `InstanceConfig.type` is one of `'service' | 'sidecar' | 'worktree' | 'inline'`.
  `port` and `type` are the only fields required on first insert; every other
  field is optional and set field-by-field as it becomes known — the same
  "each field survives independently" doctrine `readBuildProvenance`
  (`src-server/routes/system/system-status-routes.ts`) already applies to build
  provenance, applied here to instance metadata.

## API

`packages/shared/src/instance-registry.ts`, imported as
`@kontourai/station-shared/instance-registry` (never the package root — see
`forbid-shared-root-imports` in `.veritas/repo-standards/default.repo-standards.json`):

- `resolveInstanceRegistryPath(home?)` — `<home>/instances.json`.
- `readInstanceRegistry(home?)` — absence returns `{ version: 1, instances: {} }`;
  a corrupt, non-owner, wrong-mode, symlinked, or invalid-shape file **throws**,
  naming the path.
- `writeInstanceRegistry(registry, home?)` — locked, atomic full-payload
  publish.
- `upsertInstance(id, partial, home?)` — locked create-or-merge-update.
  Merge semantics make it wrong for producers publishing a complete entry
  over a possibly-foreign one (station#3047): every field the partial omits
  survives from the existing entry.
- `claimInstanceEntry(id, entry, { home?, protectedTypes?, adoptTypes? })` — locked,
  ownership-checked **replacement** (station#3047): refuses a
  `protectedTypes` entry (dead or alive) or an entry owned by a live process
  (birth-aware, fail-open; `entry.pid` may refresh its own), else writes
  exactly `entry`. A caller may explicitly adopt an owned type through
  `adoptTypes`; service reconfiguration uses this for `service` entries while
  its backend protocol owns replacement. `protectedTypes` still wins over
  adoption. The guard runs inside the mutation lock — this is the
  owned-upsert primitive #2904's review asked for.
- `replaceInstance(id, entry, home?)` — locked unconditional exact write; for
  compensation paths restoring a captured prior entry.
- `claimHostOwner(id, { home?, type, ownerPids?, publish })` — the one
  atomic host-owner claim (#2961, [ADR 0020](../adr/0020-distribution-two-trains-channels-as-pointers.md)
  D4). Cooperating Desktop `sidecar` and durable `service` producers admit
  at most one live host through this protocol. Under one mutation lock it reaps other ids' provably stale
  non-service records, refuses while any other id holds a live host owner of
  either type (reporting those owners), guards the claimant's own id (a
  sidecar never displaces a service record; a service adopts its own unit's
  record even while live; any other own-id record is adoptable only when one
  of `ownerPids` recorded it or its process is gone), and then publishes what
  `publish` builds from the current entry. A sidecar is live unless stopped
  or its pid + birth prove it gone; a service is live only while a supervisor
  has published a live pid.
- `liveHostOwners(registry, exceptId)` — the same live-owner observation over
  a plain read, for advisory pre-checks.
- `updateStatus(id, status, pid?, home?)` — locked status/pid update.
- `removeInstance(id, home?)` — locked delete; no-op (not an error) if `id` is
  absent.
- `removeOwnedInstance(id, { home?, pid, ownTypes, removeWhenOwnerGone? })` —
  locked delete with the identity (pid) and ownership (type) checks inside the
  lock; the stop path's counterpart to `claimInstanceEntry`.
  `removeWhenOwnerGone` also admits a record whose different recorded pid is
  provably gone (the Desktop supervisor releasing a record that names its
  already-reaped child); a live foreign pid is never removed.
- `entryOwnedByLiveProcess(entry, selfPid?)` — the liveness-ownership
  predicate the claim guard uses, exported for pre-checks.
- `findRunning(home?)` — read-only; excludes records without a numeric pid,
  processes proven dead, and recorded birth fingerprints proven to belong to
  a reused pid. Unknown liveness or a failed birth lookup retains the record;
  the result is not proof that every returned process is running.

Shape validation checks the version, instance map, finite numeric port and
recognized type. It is not a closed validator for every optional metadata
field. Producers and consumers must validate the fields they use; registry
metadata alone does not authenticate a process or grant lifecycle authority.

### The `component` field on `GET /api/system/instance`

The sibling HTTP route this slice also adds
(`src-server/routes/system/system-status-routes.ts`, `GET /api/system/instance`,
station#1985/#1983) self-reports `component: 'command-station'` alongside
whatever build/port fields it can determine — it does not read this registry
file (see [Producers, consumers, and remaining non-goals](#producers-consumers-and-remaining-non-goals)).
It is documented here because both concepts share this design doc's context.

- **Value space today: exactly `'command-station'`.** That is the server
  runtime's name per the #1983 naming decision — the frontend bundle stays
  named "Station" (the product name a user sees); `'command-station'` is the
  server-side runtime process a prober is actually talking to.
- **Why it exists.** A future Station bundle (a plugin host, a worker
  process, a future sidecar) could expose its own additive `/api/system/*`
  surface. `component` lets a caller polling multiple local endpoints
  distinguish "this response came from the Command Station server runtime"
  from any other Station-shaped bundle, without guessing from response shape
  alone.
- **Future bundles must NOT reuse this exact value.** Each additive Station
  bundle that adds a comparable self-report field picks its own distinct
  `component` value; `'command-station'` stays reserved for this server
  runtime so a prober's `component === 'command-station'` check keeps
  meaning exactly what it says.

## Cross-process lock discipline

The registry reuses `acquireFileMutationLock`
(`packages/shared/src/lifecycle-events.ts`) rather than inventing a new lock
primitive. That function already implements birth-fingerprint-verified
ownership, `O_EXCL` temp + `linkSync` publish, stale-guard reclaim, and
live-owner detection via `process.kill(pid, 0)` — it is the same primitive the
CLI's lifecycle journal uses, and it already lives in `packages/shared`.

Every mutating call (`writeInstanceRegistry`, `upsertInstance`, `updateStatus`,
`removeInstance`) acquires `<path>.mutation` exactly once for its whole
read-modify-write, closing the TOCTOU/CAS gap named in this repo's
"serialized-updater" learning (station#1588/#1600/#1606: a JSON-file store
without a lock around its read-modify-write has a race). The payload publish
itself is temp-write + `fsyncSync` + `renameSync` + a directory `fsync` (via
`fsyncDirectorySync` from `packages/shared/src/fs-windows-compat.ts`, already
Windows-safe) + re-open-and-verify — the same atomic-write-with-verify shape
`packages/cli/src/commands/lifecycle.ts`'s `writeInstanceState` uses, minus its
per-record backup/restore ceremony. The mutation lock serializes writers;
readers do not acquire it. Publishing a complete temporary file by atomic rename
lets a reader observe the old or new payload instead of partially written JSON.
A failure after rename can still leave the new payload visible and must not be
interpreted as rollback. The directory fsync wires
`fsyncDirectorySync`'s `checkIdentity` callback with a dev/ino snapshot of the
`STATION_HOME` directory taken before the rename, so a directory replaced
mid-publish fails closed rather than silently fsyncing the wrong directory.

POSIX ownership/mode checks do not establish Windows ACL custody. The shared
registry reader does not inspect Windows DACLs, and directory fsync is skipped
on Windows while its identity callback still runs. Platform caller checks and
actual durability/recovery qualification remain separate.

The fixture in `packages/shared/src/__tests__/instance-registry.test.ts`
spawns two real child processes, each performing ten `upsertInstance` calls
against the same registry. It requires both children to exit successfully and
the final read to contain their combined entries. That exercises concurrent
writers and final readability; it is not a crash, power-loss, or independent
reader stress test. A historical pass is not a new platform qualification.

`readInstanceRegistry` is fail-closed the same way
`packages/cli/src/commands/profile-store.ts`'s `readProfileStore` is: absence
is normal (an empty registry), but a corrupt, non-owner, wrong-mode, or
symlinked file throws naming the path rather than being silently overwritten
or replaced.

Two disclosed limits of the discipline (verified by probe, not assumed):

- **The registry's parent-trust check covers the immediate parent only.** A symlinked
  `STATION_HOME` is rejected; a symlink at a *deeper* ancestor is allowed —
  the same scope `readProfileStore` checks. Deeper ancestors are trusted like
  the registry's trust model. Separately, `admitStationRuntimeHome` canonicalizes
  existing ancestry and refuses shared Station control containers; this does not
  add owner/mode validation to every ancestor of an otherwise admitted home.
- **A relative `STATION_HOME` is out of contract.** `resolve()` anchors it at
  each calling process's own cwd, so two processes with different cwds would
  derive two disjoint registries with no error. Every supervisor in this repo
  injects an absolute `STATION_HOME` (`resolveLifecycleHomeTarget` resolves it
  before spawn); the cross-process guarantee holds only under that invariant.

## Producers, consumers, and remaining non-goals

- **Durable-service producer: `station service install`.** As of
  station#1983/#1672, `station service install` writes the registry as the
  durable authority for a user service's operator environment, including
  `env.ALLOWED_ORIGINS`. As of station#3047 that write is a
  replacing claim (never a merge): installing over a foreign
  (CLI) entry previously inherited its pid/birth into a `type: 'service'`
  chimera that could flip Desktop's home-ownership decision off a live CLI
  process. Since #2961 that claim is `claimHostOwner`. Install refuses a
  foreign live owner of its id and a live Desktop sidecar or other live
  service on the home (pre-checks followed by a locked claim before backend
  startup),
  adopts a service-typed entry during its own reconfiguration, replaces a dead
  entry cleanly, and derives origin policy/env only from a prior service-typed
  entry. Installation records its own live PID/birth as a reservation before
  the backend can spawn (`status: installing`). The supervisor replaces that
  reservation with its own PID before starting Station; readiness marks it
  running, so an installer exit cannot expose an unfenced startup window.
  Backend failure restores the captured prior registry entry and policy.
- **Service supervisor.** Before it starts Station, the supervisor claims the
  home through `claimHostOwner`. With no installed policy it creates a service
  owner record with its PID and birth; existing service policy is preserved.
  When the registry is absent, it initializes the fresh-home schema before
  publishing bootstrap metadata; unknown markerless data still refuses.
  A conflicting live owner keeps the supervisor alive without running Station.
  It polls at 5, 10, 20, then at most 30-second intervals and logs only when the
  refusal reason changes, claiming and starting when that owner is gone.
  An unreadable registry still refuses startup with a nonzero exit. A won claim
  publishes `starting` unless a live update launcher or replaced generation of
  this unit already fences it. On initial startup, an `installing` reservation
  transfers to the supervisor before start. During recovery, the supervisor
  waits while a live installer holds that reservation. Readiness publishes
  `running`; lost ownership
  at readiness or on an existing five-second health tick stops and reaps
  only the captured child generation, preserves replacement lifecycle records,
  retracts only this supervisor's own PID and birth, and returns to
  the same wait. Recovery also waits for a live replacement service at the
  same id, rather than adopting its reservation. The tick reads the same
  validated registry as the claim and
  checks the service id, type, PID and birth without renewing ownership.
  Only a successful read showing a missing or different owner triggers
  recovery. An unreadable tick read (including an unavailable process birth)
  keeps Station running and retries on the next health tick. Publication I/O
  failure stops Station before a bounded retry;
  subsequent claim I/O failure exits nonzero. Retraction remains best effort.
  The Dockerfile's existing bare `service run` command self-claims a fresh home
  without a policy-registration step. Direct `command-station.js` remains
  unfenced: a container invoking it can serve a shared home alongside a
  registry claimant, and a `0.0.0.0` bind is reachable through exposed/published
  container ports. The fence is cooperative, not a global OS server lock.
- **Desktop sidecar producer and consumer.** Desktop resolves one absolute
  `STATION_HOME` and, after runtime preparation, claims the home through the
  packaged Node bridge's `claimSidecar`, which runs `claimHostOwner`. The
  claim result is the ownership decision; there is no separate pre-read. A
  won claim is the only way to spawn a sidecar. A claim refused by exactly one
  live service makes that service the reported home owner; Desktop reports it
  without setting an API base or attaching automatically, and opening it
  remains a user choice. Any other refusal (another desktop's sidecar,
  several owners) or an unreadable registry selects no owner and spawns
  nothing. A preparation that found a live service still uses the atomic
  claim for ownership. If the service exited meanwhile, Desktop releases
  its won reservation and stays `Unowned`: that home was left unprepared.
  Runtime preparation retains a service liveness read to skip maintenance
  on a serving home; it is a preparation safety check, not display-only.
  The status refresh retains a display-only read; it cannot select a sidecar
  (`adoptable_refreshed_owner` maps that decision to `Unowned`). The supervisor re-claims before every
  respawn, publishes the child PID/birth immediately after spawn with
  `status: starting` through the same owner-checked claim (`publishSidecar`),
  then publishes `running` after Listening. A live child therefore retains
  ownership while an orphan's watchdog shuts it down; stale recovery cannot
  reap it merely because Desktop died. There remains a small spawn-to-bridge
  publication interval: this cooperative protocol is not an atomic OS
  parent-death facility. Publication failure kills and reaps the child. It and releases with the owner-checked
  `removeOwnedInstance` (`releaseSidecar`). Rust never writes
  `instances.json` directly, so owner checks, atomic publishing, and the
  cross-process mutation lock remain shared-module responsibilities.
- **Producers (updated, station#2904 slice 2).** `station start` now publishes
  into this registry (`'worktree'` when the checkout's `.git` is a file,
  `'inline'` otherwise; pid + birth fingerprint; best-effort with a stderr
  note on failure) and `station stop` removes the entry — identity-checked on
  pid, ownership-checked on type, including the already-absent stop path so a
  crashed instance's entry is reaped on the next stop. The separate CLI lifecycle
  state mechanism still exists and remains the only record
  visible when the registry write was declined or failed. Desktop neither
  selects a service from stale registry data alone nor treats a sidecar
  record as a durable-service candidate.

  **The one-owner invariant** this registry serves: every server process has
  exactly one owner that assigned its identity, port, and data dir, enforced
  at the layer native to each surface — the OS-level single-instance lock for
  the Desktop app (#3045), the CLI's shared-home start check, and the home-scoped
  host-owner claim shared by Desktop sidecars and durable services (#2961). The CLI now refuses a new start when its registry observations
  find another live instance on that home. Existing co-located restarts and
  explicit `--allow-shared-home` bypass that check; failed registry reads can
  leave the collision set empty. This is a guarded launch policy, not a global
  proof that two writers cannot coexist. Producers use ownership checks before
  adopting or deleting another surface's entry.
- **Manifest migration bridge.** On the pre-registry bridge (no registry entry
  yet) `station service install` seeds the registry's origins from the existing
  `<home>/service/*.json` manifest and re-validates them; the manifest is now a
  derived mirror + one-time migration fallback rather than the authority. The
  separate CLI lifecycle records are not replaced by this registry.
- **No `STATION_HOME_SCHEMA_VERSION` bump.** This file is purely additive.

## Distinction from `.station/instances/*`

`docs/reference/cli.md`'s "Instance State Mechanism" section documents the
**CWD-anchored source-checkout** mechanism: `station start` writes
`.station/instances/<instance-id>.json` in the *current working directory* of
the checkout that launched it, recording that one checkout's server/UI PIDs so
`station stop` can find and terminate the matching instance.

Prebuilt server archives instead put those per-instance lifecycle records in
`<root>/state/<channel>/instances/`, outside the extracted version. The resolved
home determines the root; service status and stop calls carry that same home.
Archives share their shipped build and refuse an in-place build. An archive
installed under the installer's `versions/` layout can upgrade through its
recorded installer; a loose extracted archive still requires manual replacement.
See [the CLI reference](../reference/cli.md#instance-state-mechanism) for root
selection and manual archive replacement. This differs from the source-checkout
mechanism without replacing the shared registry described here.

`<STATION_HOME>/instances.json` (this document) is **home-scoped**: one file
per selected Station runtime home (see [topology](station-topology.md)),
intended to describe every instance associated with that home regardless of
which checkout or working directory started it. That is a real distinction,
not a naming collision to "fix":

| | `.station/instances/<id>.json` | `<STATION_HOME>/instances.json` |
|---|---|---|
| Scope | Per-checkout for source; home-derived channel state root for prebuilt archives | Per-home |
| Cardinality | One file per instance | One file, many instances inside it |
| Owner | `station start`/`station stop` (CLI lifecycle) | `station service install` (durable service), Desktop's shared-registry bridge (desktop-owned sidecar), and — since station#2904 slice 2 — `station start`/`stop` themselves (types `'inline'`/`'worktree'`) |
| Purpose | "Which processes did this lifecycle target start, so I can stop them?" | "What instances exist under *this home*, across checkouts?" |

Both mechanisms now have real producers and consumers. Deriving one from the
other remains a separate design choice; neither file can simply replace the
other without preserving those callers' ownership and recovery behavior.
