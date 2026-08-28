# Design: Instance Registry (`<STATION_HOME>/instances.json`)

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

## Schema

```json
{
  "version": 1,
  "instances": {
    "<id>": {
      "port": 3141,
      "uiPort": 3000,
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
- `claimInstanceEntry(id, entry, { home?, protectedTypes? })` — locked,
  ownership-checked **replacement** (station#3047): refuses a
  `protectedTypes` entry (dead or alive) or an entry owned by a live process
  (birth-aware, fail-open; `entry.pid` may refresh its own), else writes
  exactly `entry`. The guard runs inside the mutation lock — this is the
  owned-upsert primitive #2904's review asked for.
- `replaceInstance(id, entry, home?)` — locked unconditional exact write; for
  compensation paths restoring a captured prior entry.
- `updateStatus(id, status, pid?, home?)` — locked status/pid update.
- `removeInstance(id, home?)` — locked delete; no-op (not an error) if `id` is
  absent.
- `removeOwnedInstance(id, { home?, pid, ownTypes })` — locked delete with
  the identity (pid) and ownership (type) checks inside the lock; the stop
  path's counterpart to `claimInstanceEntry`.
- `entryOwnedByLiveProcess(entry, selfPid?)` — the liveness-ownership
  predicate the claim guard uses, exported for pre-checks.
- `findRunning(home?)` — read-only; the subset of instances whose `pid` is set
  and alive (`process.kill(pid, 0)`).

### The `component` field on `GET /api/system/instance`

The sibling HTTP route this slice also adds
(`src-server/routes/system/system-status-routes.ts`, `GET /api/system/instance`,
station#1985/#1983) self-reports `component: 'command-station'` alongside
whatever build/port fields it can determine — it does not read this registry
file (see [Explicit non-goals of this slice](#explicit-non-goals-of-this-slice)).
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
per-record backup/restore ceremony. That ceremony exists to protect a
concurrent reader from ever observing a half-written file; here the entire
read-modify-write happens inside the single lock acquisition, so there is no
window in which a reader could observe a torn intermediate state a backup
would need to roll back from. The directory fsync wires
`fsyncDirectorySync`'s `checkIdentity` callback with a dev/ino snapshot of the
`STATION_HOME` directory taken before the rename, so a directory replaced
mid-publish fails closed rather than silently fsyncing the wrong directory.

This is proven, not just documented: `packages/shared/src/__tests__/instance-registry.test.ts`
spawns two real child processes racing `upsertInstance` against the same
registry file (the exact shape `packages/shared/src/__tests__/lifecycle-events.test.ts`'s
existing race test already uses) and asserts the union of both children's
writes lands with no lost update and no torn read.

`readInstanceRegistry` is fail-closed the same way
`packages/cli/src/commands/profile-store.ts`'s `readProfileStore` is: absence
is normal (an empty registry), but a corrupt, non-owner, wrong-mode, or
symlinked file throws naming the path rather than being silently overwritten
or replaced.

Two disclosed limits of the discipline (verified by probe, not assumed):

- **The parent-trust check covers the immediate parent only.** A symlinked
  `STATION_HOME` is rejected; a symlink at a *deeper* ancestor is allowed —
  the same scope `readProfileStore` checks. Deeper ancestors are trusted like
  every other store in this repo.
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
  `claimInstanceEntry` (replace, never merge): installing over a foreign
  (CLI) entry previously inherited its pid/birth into a `type: 'service'`
  chimera that could flip Desktop's home-ownership decision off a live CLI
  process. Install now refuses while a live process owns the id (pre-check
  before any backend mutation, re-checked under the lock), replaces a dead
  entry cleanly, and derives origin policy/env only from a prior
  service-typed entry.
- **Desktop sidecar producer and consumer.** Desktop resolves one absolute
  `STATION_HOME`, reads service candidates through the packaged Node bridge,
  and probes them before spawning. It attaches only to one verified live
  service; otherwise it publishes, updates, and removes its own `type:
  'sidecar'` record through the same bridge. Rust never writes
  `instances.json` directly, so owner checks, atomic publishing, and the
  cross-process mutation lock remain shared-module responsibilities.
- **Producers (updated, station#2904 slice 2).** `station start` now publishes
  into this registry (`'worktree'` when the checkout's `.git` is a file,
  `'inline'` otherwise; pid + birth fingerprint; best-effort with a stderr
  note on failure) and `station stop` removes the entry — identity-checked on
  pid, ownership-checked on type, including the already-absent stop path so a
  crashed instance's entry is reaped on the next stop. The CWD-scoped
  `.station/instances/*` mechanism still exists and remains the only record
  visible when the registry write was declined or failed. Desktop neither
  selects a service from stale registry data alone nor treats a sidecar
  record as a durable-service candidate.

  **The one-owner invariant** this registry serves: every server process has
  exactly one owner that assigned its identity, port, and data dir, enforced
  at the layer native to each surface — the OS-level single-instance lock for
  the Desktop app (#3045), this registry plus the shared-home warning (and a
  planned same-home refuse) for the CLI, and the home-scoped sidecar claim as
  the cross-surface floor. Producers never adopt or delete an entry another
  surface owns.
- **Manifest migration bridge.** On the pre-registry bridge (no registry entry
  yet) `station service install` seeds the registry's origins from the existing
  `<home>/service/*.json` manifest and re-validates them; the manifest is now a
  derived mirror + one-time migration fallback rather than the authority. The
  broader `.station/instances/*` mechanism is still untouched and unmigrated.
- **No `STATION_HOME_SCHEMA_VERSION` bump.** This file is purely additive.

## Distinction from `.station/instances/*`

`docs/reference/cli.md`'s "Instance State Mechanism" section documents the
pre-existing, **CWD-anchored** mechanism: `station start` writes
`.station/instances/<instance-id>.json` in the *current working directory* of
the checkout that launched it, recording that one checkout's server/UI PIDs so
`station stop` can find and terminate the matching instance.

`<STATION_HOME>/instances.json` (this document) is **home-scoped**: one file
per Station home (`~/.station` by default, or wherever `STATION_HOME` points),
intended to describe every instance associated with that home regardless of
which checkout or working directory started it. That is a real distinction,
not a naming collision to "fix":

| | `.station/instances/<id>.json` | `<STATION_HOME>/instances.json` |
|---|---|---|
| Scope | Per-checkout (CWD-anchored) | Per-home (host-wide) |
| Cardinality | One file per instance | One file, many instances inside it |
| Owner | `station start`/`station stop` (CLI lifecycle) | `station service install` (durable service), Desktop's shared-registry bridge (desktop-owned sidecar), and — since station#2904 slice 2 — `station start`/`stop` themselves (types `'inline'`/`'worktree'`) |
| Purpose | "Which PID/port did *this checkout* start, so I can stop it?" | "What instances exist under *this home*, across checkouts?" |

A future slice may derive one from the other, or keep them independent
producers of overlapping information — that design is deferred until the
registry has actual producers/consumers wired (see the non-goals above).
