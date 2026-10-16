# @kontourai/monument

Experimental. This is an engine-neutral durability kernel. It covers
crash-consistent turn dedup, turn boundaries and request keys, behind a
command-shaped storage port. [CONTEXT.md](CONTEXT.md) describes what it owns
and what it leaves to other packages.

The API may change in any release until a second consumer exists.

It remains `private: true` in this checkout until its first functional release
is qualified and the manifest is changed in a reviewed PR. CI publishing uses
npm Trusted Publisher for `kontourai/station`, workflow `publish-packages.yml`.
A registry bootstrap or placeholder enables setup; it does not qualify a
functional package release.

The published package is compiled ES modules (`dist/*.js`) with type
declarations (`dist/*.d.ts`), built by `npm run build`. It runs on plain Node 24
with no bundler or loader. The `sqlite` and `testing` declarations refer to
`node:` types, so TypeScript consumers need `@types/node`. Inside this
workspace, Station resolves the same entry points to `src/*.ts`; the published
entry points are `publishConfig.exports`, which only pnpm applies.
`scripts/monument-pack-smoke.mjs` installs the packed tarball in a scratch
directory and checks all of this.

## Entry points

| Import | Contents | Runtime needs |
| --- | --- | --- |
| `@kontourai/monument` | The port (`KernelStorage`, `CommitParticipant`), commands and results, the pure decision functions (including `planTurnBoundaryReconcile`), owner liveness, and the in-memory adapter | none |
| `@kontourai/monument/adapter` | For adapter authors: `KernelTransaction`, `runKernelTransactionStep`, `isReadOnlyKernelCommand` | none |
| `@kontourai/monument/sqlite` | The `node:sqlite` adapter, and the table bindings that let it run over a host's existing tables | Node 24 |
| `@kontourai/monument/testing` | The conformance suite, the crash-point store, a fake process table, and the in-memory and `node:sqlite` harnesses | Node 24 (`node:assert`, `node:sqlite`) |

## The port

```ts
const result = await storage.execute(
  { type: 'turnDedup.claim', key, owner, now: Date.now(), tracking: 'tracked' },
  { liveness: ownerLivenessFromProbe(probe) },
);
```

Each `execute` call is one atomic transaction. The adapter runs the command's
decision inside it and commits every write, including every participant's
writes, or none of them. The promise settles after the commit or the rollback.

The `node:sqlite` adapter sets `synchronous = FULL` and `busy_timeout` on a
connection it opens, and asserts both. It tries WAL with a bounded retry and
reports the journal mode it got in `storage.pragmas.journalMode`. That matches
Station's stores: converting a file to WAL needs a lock that a contended open
may not get. A connection the host hands over (`database`) is the host's: its
pragmas are left as they are and reported in `storage.pragmas`, so a host that
relaxes durability on purpose is not silently undone. Pass
`configureConnection: true` to hand the pragmas to the adapter.
Read-only commands (`turnDedup.read`, `turnBoundary.list`,
`turnBoundary.hasPossibleEffect`) run in a deferred transaction, so under WAL
they are served while another connection holds the write lock. Every
writing command, and a read observed by a participant with `observeReads`,
takes `BEGIN IMMEDIATE`. A `commit` hook alone does not opt into reads.
The adapter also offers `executeSync`, which runs the same transaction
synchronously, for hosts whose call sites are synchronous. `executeSync` is
specific to node:sqlite and is not part of the portable contract.

## A host's existing tables

By default the `node:sqlite` adapter owns its `monument_*` tables. A host that
already keeps these records in tables of its own can bind them instead, so its
tables stay the source of truth and an older binary that writes them directly
keeps working:

```ts
const storage = openSqliteKernelStorage({
  database: hostConnection,
  tables: {
    turnDedup: {
      table: 'host_turn_dedup', // dedup_key, value, created_at, owner_json
      tombstoneTable: 'host_turn_dedup_expired', // dedup_key, expired_at
      ownerIdField: 'token', // the owner's id inside owner_json
      legacyUntrackedKeyPrefixes: ['chat:'],
    },
    requestKeys: { table: 'host_request_keys', resultColumn: 'result_json' },
    turnBoundary: 'unused',
  },
});
```

- The host creates a bound table. The adapter checks its columns at open and
  never creates or alters it, and creates no `monument_*` table for a machine
  it is not given: bind it, or mark it `'unused'`, and its commands are
  refused. An area left out keeps the adapter's own tables.
- `ownerIdField` is the `owner_json` field that names the owner. It is read
  and written under that name, never as `id`, so a writer from before the
  kernel still parses the rows.
- `legacyUntrackedKeyPrefixes` names keys whose claimants recorded no
  invocation: a row with no invocation record at all reads as `untracked`. A
  record that is present but unrecognised stays unknown and fails closed.
- `ownerErrorMessage` replaces the reason in the error for an `owner_json`
  the adapter refuses, for a host whose callers already match on its text.

`executeSync` refuses to run inside a transaction the host holds. A host that
must retire kernel records in the same transaction as its own (deleting a
thread and its dedup keys) passes `{ withinHostTransaction: true }`: the
command is a savepoint in that transaction, so it commits or rolls back with
it, and a command that throws or is refused undoes only itself.

## Host boundary rows and terminal facts

Station's production boundary coordinator uses this binding for create,
transition, remove, accepted-turn recording, terminal observation and listing.
Station retains sealed-task admission, storage-error classification and
process-owner reconciliation. The binding supports the default
`owner_json` layout (`ownerEncoding: 'json'`) and separate `owner_id`,
`owner_pid`, `owner_birth`, `owner_identity_kind` columns (`'columns'`). Both
layouts retain `boundary_id`, `thread_id`, `state`, `purpose`,
`provider_turn_id`, `created_at` and `updated_at`. These column names are fixed,
unlike the configurable dedup owner field and request-key result column.
`boundary_id` must have a primary key or a non-partial unique index by itself;
compound and partial indexes cannot support the adapter's upsert.

```ts
const storage = openSqliteKernelStorage({
  database: hostConnection,
  tables: {
    turnDedup: 'unused',
    requestKeys: 'unused',
    turnBoundary: {
      table: 'host_boundaries',
      ownerEncoding: 'columns',
      terminalFacts: 'host',
      terminalSeen: (db, thread, turn) => hostTerminalSeen(db, thread, turn),
      terminalSequence: (db, thread, eventId) => hostTerminalSequence(db, thread, eventId),
      creationSequence: {
        column: 'created_sequence',
        read: db => readDurableEventHead(db),
      },
    },
  },
});
const context = { liveness };
```

The fence and terminal callbacks run synchronously inside the command
transaction. Terminal callbacks only read facts; a host with an event log uses that log as its sole
terminal authority. `terminalSeen` replaces, rather than supplements, the
kernel's default terminal table. Observing a terminal or forgetting boundaries
does not add or delete default terminal facts when that callback is present.
Terminal callbacks are fixed at open. Command context carries only liveness
and limits; it cannot change the terminal authority. Adapter authors pass
`KernelTerminalFacts` as the final argument to `runKernelTransactionStep`
(`./adapter`), from their storage-open configuration.
Opening `terminalFacts: 'host'` without `terminalSeen`, or `'kernel'` with either
host callback, is rejected before any command. Host mode creates no terminal table. With every area bound or unused, the adapter creates no `monument_*` tables.

`creationSequence` is optional and specific to a bound SQLite table. Its
column must already exist. The adapter captures its durable head under the
writer lock only for a new row; updates preserve the original fence, including
NULL, and preserve the host's owner and creation fields. No table is migrated
or backfilled. A nested writing boundary command reserves the writer before
any decision reads, even if the host's savepoint was deferred.

`turnBoundary.observeTerminal` carries the host's `terminalEventId`.
For a session terminal and a fenced row, the decision retires the row only
when `terminalSequence(thread, eventId)` returns a persisted sequence strictly
above the fence. A missing terminal retains fenced rows. Rows with no fence
and turn-scoped terminals retain the timestamp generation check; lifecycle
and task-dispatch rows retain their separate settlement owners.

This API does not move Station's runtime terminal reconciler. Its current
`hasPossibleEffect` deletes event-retired rows. Replacing that path with a
read-only command requires an event-authoritative read view and an explicit
choice of when physical retirement runs; opting a writing participant into
reads would take the write lock and does not satisfy that requirement.

`hostBoundaryConformanceCases` in `./testing` is a portable contract for hosts
that bind a creation fence. Its harness supplies a durable creation-sequence
source and terminal callbacks, without exposing SQL to the cases. It verifies
capture and preservation across transition/reopen, terminal lookup, missing
facts, strict ordering (earlier, equal, later), and acceptance against the fixed
host terminal authority. The default-table suite
remains separate because those tables have no creation-fence column.

## Reconcile after a restart

Probing whether a process is alive can take seconds, so it never happens under
the write lock. A host lists the rows, plans the command, and commits it:

```ts
const listed = await storage.execute({ type: 'turnBoundary.list' }, context);
const command = planTurnBoundaryReconcile(listed.records, { probe }, now);
const { interrupted } = await storage.execute(command, context);
```

`planTurnBoundaryReconcile` probes each process once. Inside the transaction
a verdict applies only to a row that still has the exact owner (id, pid,
identity kind, birth), `createdAt` and `updatedAt` it was planned for. The
kernel trusts the verdicts it is given: a command built by hand rather than by
the planner decides for itself who is dead.

## Participants

A `CommitParticipant` joins every writing command. For read-only commands
(`turnDedup.read`, `turnBoundary.list`, `turnBoundary.hasPossibleEffect`) it
is called only if it sets `observeReads`. On node:sqlite, a read with such a
participant takes the write lock. A refusal from `admit` rolls the whole
transaction back, including any earlier participant's writes. A kernel result
that happens to be `refused` (`turnDedup.beginInvocation` on a claim the
caller does not own) is an ordinary answer: it commits, with every
participant's writes.

## Conformance

```ts
import { describe, it } from 'vitest';
import { registerKernelConformance } from '@kontourai/monument/testing';

registerKernelConformance({ describe, it }, myHarness);
```

The cases depend only on `node:assert`, so Jest and `node:test` can run them
through the same `{ describe, it }` shape. `runKernelConformance` returns
per-case outcomes without a runner.

The crash-point store (`openCrashPointStore`) wraps any harness location and
lets a test do four things:

- hold the next commit and wait for its `entered` signal;
- crash, so a held commit never lands;
- fail the next commit inside the real transaction;
- reopen the location the way a restarted process would.

## Licence

Apache-2.0
