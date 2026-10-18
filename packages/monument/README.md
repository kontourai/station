# @kontourai/monument

Experimental. This is an engine-neutral durability kernel. It covers
crash-consistent turn dedup, turn boundaries and request keys behind a
command-shaped storage port, plus engine-neutral message delivery decisions
and record-before-effect sequencing. [CONTEXT.md](CONTEXT.md) describes what it owns
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
| `@kontourai/monument` | The port (`KernelStorage`, `CommitParticipant`), commands and results, the pure decision functions (including `planTurnBoundaryReconcile`), owner liveness, message delivery decisions and sequencing, and the in-memory adapter | none |
| `@kontourai/monument/adapter` | For adapter authors: `KernelTransaction`, `runKernelTransactionStep`, `isReadOnlyKernelCommand` | none |
| `@kontourai/monument/sqlite` | The `node:sqlite` adapter, and the table bindings that let it run over a host's existing tables | Node 24 |
| `@kontourai/monument/testing` | The conformance suite, the crash-point store, a fake process table, and the in-memory and `node:sqlite` harnesses | Node 24 (`node:assert`, `node:sqlite`) |

## Message delivery

`decideSessionDelivery(mode, busy)` selects start or steer: `auto` starts an
idle session and steers a busy one, `start` refuses a busy session, and `steer`
refuses an idle one. `parseSessionDeliveryDecision` reads a persisted
`start:<threadId>` or `steer:<threadId>` decision without changing its id.

`deliverSessionMessage(ports, input)` records a new decision synchronously
through `input.recordDecision` before calling the selected `start` or `steer`
port. A supplied `decided` branch bypasses both the busy check and recording.
The sequence passes `deliveryId` as `clientTurnId` or `clientInputId`, maps
refused and indeterminate outcomes, and never tries the other branch. A thrown
recording or port error propagates; a failed recording invokes no effect.

`conversationKeyDecision` classifies a key across every Session of a
conversation. `startUnlessDelivered` returns a known started turn without
calling the start port, refuses an unresolved live claim with
`client_turn_in_flight`, and returns indeterminate for an expired key or an
unknown effect. An age-only indeterminate claim remains in flight because
its live owner can still deliver. Only a key no Session holds can start.
Station supplies the authorized ledger inspection and start ports; the inbox,
foreground continuation and delegated-result callers use this same rule.

This sequence has no storage of its own. The host supplies already-authorized
ports and owns invocation, persistence, delivery-id deduplication and receipts.
The optional recording callback is durable only if the host makes it so.
Station's Session Control route records in its request-key table; delegated
result delivery records in its existing consumption row. Neither creates an
additional queue. The package's public-API delivery tests own the decision and
ordering contract; Station's mounted route tests also inspect its real SQLite
key row when each effect port is entered. Adapter conformance remains the
contract for storage commands; this primitive adds none.

This completes only the delivery primitive of #3565. Recovery-ledger core and
steer receipts remain separate extraction work. The package remains private
`0.1.0` until its reviewed functional release.

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
Turn-dedup claims accept an optional versioned `inputDigest`. A mismatch with a
known original returns `conflict` before replay, contention or reclaim. Reclaim
never attaches a retry's digest to a legacy row. Memory snapshots preserve the
field; SQLite stores it with the current owner. A bound host may additionally
supply `turnDedup.inputDigestColumn` after adding that nullable column. The
adapter requires agreement with the owner JSON marker, so an older writer
replacing the owner does not leave trusted stale proof. Owned SQLite tables
upgrade additively on open. Older binaries and callers without digests cannot
enforce this contract; legacy rows remain unknown.

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
tables stay the source of truth. Legacy rows retain their encoding; mixed-version
writers of the prepared-intent protocol need host-enforced writer fencing:

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
  refused. An area left out keeps the adapter's own tables. The `inbox` area
  has no bound form: it is the adapter's own table or `'unused'`.
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
process-owner reconciliation. Its current legacy boundary binding configures
neither intent nor settlement columns: it cannot author or decode a settled
boundary audit, and encountering that tag makes the host observation unavailable.
Host terminal SQL preserves the raw row rather than treating it as permission to
delete or replay. The separate Station dedup binding can read settlement in
`owner_json`; its claim/inspection facade refuses the key with the typed
`client_turn_settled` error and actual disposition. The authorized delivery lookup
maps that refusal to [HTTP 409](../../docs/reference/session-api.md#find-out-what-became-of-a-send).
These consumer rules add no host preparation, cancellation or resume API and do
not qualify mixed-version writers.

The binding supports the default
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
    inbox: 'unused',
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
Opening `terminalFacts: 'host'` without `terminalSeen`, or `'kernel'` with any
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

A host can also supply optional `retiredBoundaryIds(threadId)` facts, fixed at
open (the SQLite binding receives `database` first). Only
`turnBoundary.hasPossibleEffect` excludes those IDs from its raw thread rows.
`get`, `listThread`, `listAll`, listing and recovery still see the retained rows;
the default memory and SQLite terminal behavior is unchanged. No command or
context can replace these facts.

Station uses its canonical event log for that read projection, with the exact
same predicate as physical retirement: session sequence strictly above the
creation fence, timestamp fallback for NULL legacy fences, turn timestamp and
provider-ID matching, and the existing lifecycle, task-dispatch, admission-error
and recovery-terminal exclusions. Settled audit rows are also excluded from both
terminal projection and physical retirement. Its polling path takes a deferred read
transaction, does not drain pending transitions, and can read committed facts
while a peer holds the WAL writer. An uncommitted terminal is invisible; after
commit the next poll can answer inactive while the boundary row remains.

Physical cleanup joins write-only participant admission for both create and
accepted-turn recording, before occupancy and capacity decisions. It rolls back
with the command or outer event append. Boot cleanup still precedes raw owner
recovery. Claim, prepare, observe and reconcile paths retain pending-transition
retries; until a writer retries, polling conservatively reads the unresolved
stored fact. No Station participant opts into `observeReads`.

`hostBoundaryConformanceCases` in `./testing` is a portable contract for hosts
that bind a creation fence. Its harness supplies a durable creation-sequence
source and terminal callbacks, without exposing SQL to the cases. It verifies
capture and preservation across transition/reopen, terminal lookup, missing
facts, strict ordering (earlier, equal, later), acceptance against the fixed
host terminal authority, and live read-projection facts across reopen while raw
listing and dead-owner recovery retain the rows. The SQLite binding also rejects
a projection callback in kernel-terminal mode at open. The default-table suite
remains separate because those tables have no creation-fence column.

## Reconcile after a restart

New ordinary turns can reserve a boundary before capturing input:
`reserved` → `prepared` → `invoking` → `accepted` (or `indeterminate`).
Legacy inputless `prepared` claims, session lifecycle claims and task dispatch
retain their existing behavior. Engine-opened turns still record acceptance
directly. Invocation terminal attribution is unchanged in this kernel cut.

`turnBoundary.prepare` takes `boundaryId`, its private `ownerId`, `now` and an
immutable `intent`: `{ invocationId, inputDigest, intentDigest, bodyRef, dedupKey? }`.
These strings are opaque host facts. `inputDigest` identifies final adapter input,
separately from a host's original submission digest. Monument stores no body,
send options, credentials or capabilities. The host owns their serialization,
body retention, authorization and admission.

For a linked key, `dedupOwnerId` names its independently private claim token.
Preparation atomically links that owner's pending dedup row with
`preparedInvocationId` and `preparedUpdatedAt` beside its owner encoding, and
moves the reservation to prepared. Exact retries are idempotent; changing any
intent field conflicts. A link and its prepared revision must both be valid
nonempty strings or both absent. SQLite rejects a partial pair; portable
decisions retain either surviving marker as non-replayable evidence. Only
absence of both markers permits legacy pending behavior.
Ordinary dedup claim, release and begin cannot bypass
a linked intent, even with begun, unknown or untracked invocation evidence.
Prepared cancellation and definitive-refusal settlement use the distinct guarded
commands below. Legacy boundary transition/remove cannot begin or
erase a captured prepared intent. A dead linked pending key answers `prepared`.

`turnBoundary.beginInvocation` compares the boundary owner and complete intent,
plus the linked key's owner, pending state and backlink. One transaction changes
dedup to begun and boundary to invoking. A lost-acknowledgement retry can answer
applied only for the matching invoking/begun pair; it acknowledges the same begin
and never authorizes a second adapter call. Any failure rolls both writes back.

`turnBoundary.resumePrepared` only transfers ownership. It takes the complete
intent, the observed boundary owner/creation/update timestamps and dead verdict,
a new `owner`, and (for a linked key) `dedup: { previousOwner, createdAt, updatedAt,
owner }`. The dedup `updatedAt` is its stored `preparedUpdatedAt`. Both prior owners
must have exact identities and independently answer dead through context liveness;
hosts should supply verdicts captured before entering the transaction. Both
records must still match their observed revisions, pending link and intent.
Live, unknown, missing, expired, resolved or begun evidence refuses transfer.
Invoking and later boundaries can never be resumed or prepared again.

Bound SQLite tables opt in with `intentColumns`, an object mapping each intent
field (including optional-value `dedupKey`) to its own nullable TEXT column. All
five column names are validated and copied at open. Old hosts need no new
columns; intent-bearing writes require the explicit binding. JSON and column
owner layouts use the same protocol. Owned tables migrate older versions additively
to the current schema. Version two added intent columns and reserved to the
unique active-thread index; version three adds passive settlement audit.
Prepared dedup links remain in `owner_json`, with no
new host dedup columns.

Reconciliation removes dead reservations and inputless legacy preparation. It
retains complete prepared intent in a separate `resumable` candidate list while
invoking becomes indeterminate as before. A candidate is not replay permission:
explicit resume must still validate both fences and the host must verify the
body and fresh authority. There is no automatic resume, host resume API, generated
key, input blob store or invocation terminal attribution in this package change.

### Explicit prepared settlement

`turnBoundary.cancelPrepared` settles only ordinary prepared/pending intent that
never began. `turnBoundary.recordDefinitiveRefusal` settles only invoking/begun
intent: issuing that distinct command is the host's explicit assertion that the
adapter definitively refused the effect. An error, timeout or dead process does
not establish that fact. The kernel trusts the authorized host's assertion and
does not infer it from provider output or liveness.

Both commands take `boundaryId`, complete `intent`, `settlementId`, `now`, a
`boundary: { owner, createdAt, updatedAt }` snapshot and, for a linked key,
`dedup: { owner, createdAt, updatedAt }`. The dedup update revision is its stored
`preparedUpdatedAt`. Each independently private full owner and revision must
still match; resolved, tombstoned, unknown/untracked, wrong-stage or inconsistent
backlink evidence refuses. No key is invented for keyless intent.

One transaction records a `PreparedTurnSettlement` on both existing rows, dedup
first and boundary second. The boundary becomes passive `settled` with its
opaque intent/bodyRef retained. The audit records the id, disposition
(`cancelled` or `definitively-refused`), settlement time, boundary identity and
both original snapshots. Dedup stays unresolved without a fabricated provider
turn value; a later claim returns a distinct `settled` outcome. Ordinary release,
begin and resolve cannot reinterpret this as a fresh invocation. The host must
surface the disposition and require a deliberate new request with a new key.

An exact retry acknowledges `applied` only while both retained settlement audits,
the command id/time/disposition, original snapshots, current intent and linked
record facts still match. A different id/time/fact, a missing record or a partial
settlement refuses. An acknowledgement never invokes an adapter or reopens the
settled turn.

Raw boundary listing retains settlement audit. Settled rows hold no active
occupancy or accepted-capacity slot, have no possible effect, and are excluded
from dead-owner recovery and terminal retirement. Generic transition/remove
cannot erase the boundary audit; existing explicit `forgetThread` can remove it.
The host's retained body is untouched. Existing explicit `turnDedup.forgetPrefix`
still has its deliberate deletion authority: it can erase key/tombstone and
dedup settlement retention while the boundary audit/body remain. Key absence
never permits resuming that retained settled invocation. Restrict these broad
host deletion authorities separately from ordinary delivery commands.

Owned SQLite schema version three adds nullable `settlement_json` without
rewriting legacy records. Bound hosts opt in with `settlementColumn`, a copied,
fixed-at-open unique nullable TEXT column. New settlement commands fail before
writes without that binding; old hosts and their legacy commands need no column.
Both owner layouts and execute interfaces use the same audit/transaction path.
No host cancellation API, retry policy, invocation-aware terminal rule or dormant
Session-start child protocol is implemented by these portable commands.

Probing whether a process is alive can take seconds, so it never happens under
the write lock during reconciliation. A host lists the rows, plans the command, and commits it:

```ts
const listed = await storage.execute({ type: 'turnBoundary.list' }, context);
const command = planTurnBoundaryReconcile(listed.records, { probe }, now);
const { interrupted, resumable } = await storage.execute(command, context);
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
