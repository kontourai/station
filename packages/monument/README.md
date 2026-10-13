# @kontourai/monument

Experimental. This is an engine-neutral durability kernel. It covers
crash-consistent turn dedup, turn boundaries and request keys, behind a
command-shaped storage port. [CONTEXT.md](CONTEXT.md) describes what it owns
and what it leaves to other packages.

The API may change in any release until a second consumer exists.

It is `private: true` in this checkout. `publish-packages.yml` exchanges an
OIDC token for every public workspace, and npm can attach a trusted publisher
only to a name that already exists, so a public manifest would fail every
release until the first version is published another way. Publishing is an
owner decision.

The package ships raw TypeScript source. Consumers need a bundler or a
TypeScript-aware loader.

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

The `node:sqlite` adapter sets `synchronous = FULL` and `busy_timeout`, and
asserts both when it opens. It tries WAL with a bounded retry and reports the
journal mode it got in `storage.pragmas.journalMode`. That matches Station's
stores: converting a file to WAL needs a lock that a contended open may not
get. Read-only commands (`turnDedup.read`, `turnBoundary.list`,
`turnBoundary.hasPossibleEffect`) run in a deferred transaction, so under WAL
they are served while another connection holds the write lock. Every other
command, and every command when a participant has a `commit` hook, takes
`BEGIN IMMEDIATE`. The adapter also offers `executeSync`, which runs the same transaction
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
