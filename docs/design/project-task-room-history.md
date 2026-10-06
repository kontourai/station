# Project/Task room history

> **Reading status: current persistence-module note.**
> [EventStore](../../src-server/services/orchestration/event-store.ts) composes
> the [history module](../../src-server/services/orchestration/project-task-room-history.ts)
> and its [SQLite worker](../../src-server/services/orchestration/project-task-room-history-worker.ts).
> [Room runtime](../../src-server/services/orchestration/project-task-room-runtime.ts)
> and [routes](../../src-server/routes/orchestration/project-task-rooms.ts) add
> caller authority and transport. The core's `L0` assurance below does not
> become a membership or signature guarantee merely through that composition.

`ProjectTaskRoomHistory` is Station's durable, asynchronous Project/Task
rendezvous. It is deliberately distinct from an active live-work session: a
session can start, end presence, or deliberately finish work in history, but liveness, presence, transport,
and pane rendering remain outside this module.

`EventStore` privately owns an asynchronous worker-thread
adapter; that worker constructs the separate SQLite connection to the existing
orchestration database. In this room-history path, synchronous `node:sqlite`
work and busy-timeout waiting run on that worker. `ProjectTaskRoomHistory.close()`
is the awaitable worker/SQLite settlement seam; the still-synchronous
`EventStore.close()` only initiates that close and never blocks with
`Atomics.wait` or claims settlement it cannot synchronously prove.
Callers submit room intents (`open`, `append`, and `read`) rather than raw
database operations or caller-authored channel authority. Open results and
cursors expose channel identity; history records include resolved principal
and grant evidence. An injected capability authority revalidates every operation
and resolves the opaque grant to its canonical Project UUID, Project slug,
Task, principal, capability, and policy revision. Grant shape is never treated
as authority; discover, history-read, human write, lifecycle append, resolved
link, and agent publish remain separate.

The history interface also offers `findByProposal` for exact-proposal reconciliation,
`readSourceSeal` to inspect a transfer seal, and `sealSource` with a
`home-transfer` grant. The retained private local-owner adapter can invoke
`sealSource`; it has no production callsite. The public controller observes
existing seals. Sealing can report pending publication or execution instead of
claiming the source is ready to move. The
[transfer-controller guide](../guides/home-transfer-controller.md) owns that
separate admission and handoff journey.

The stored record is a `station.channel-proposal/v1` embedded in a
`station.channel-sequence/v1`. Its room-local `(epoch, seq)`, proposal digest,
previous envelope digest, and rolling checkpoint are independent of both
orchestration event sequence and operational-event retention. The local
adapter's assurance is explicitly `L0`: it proves neither membership nor a
signature. Agent publishing and resolved outcome links require injected,
prevalidated authority adapters; a caller-supplied string is not authority.
The proposal idempotency digest covers resolved scope, principal, occurrence,
correlation and causation, resolved link projections, and the authority receipt.

Personal output reviews use the closed `output-feedback` body: an output ID,
SHA-256 digest, Task creation time, comment, and a human review statement.
`accepted` records what that reviewer said about that version; it neither changes
Task status nor establishes evidence standing. Agents cannot author this body.
The mounted runtime binds the target's Task creation time into the write grant.

The worker checks permanent proposal identity before fresh output admission.
An exact, currently authorized retry therefore survives output deletion and
history pruning. A new proposal must match a retained output's identity and
digest, including when no home-controller admission port is configured.
Output validation releases its separate lock before the room commits; this
proves identity at admission, not atomic retention through the room transaction.

The first feedback append activates room record version 3 in the same SQLite
transaction as its record. A persistent per-room format marker and INSERT
trigger reject older version-2 writers after activation. New readers preserve
existing version-2 bytes and read mixed version-2/version-3 history. The marker
survives restart and record pruning. Older readers reject the unfamiliar format.
The invited-share projection still excludes output feedback.

Inputs and stored projections use an incremental JSON byte counter that
includes syntax and escaping without allocating the serialized payload. Body,
request, envelope, receipt, and complete-page budgets are independent.
The page item ceiling is derived once from the closed worst-case record shape
(agent principal, full lifecycle/run link, correlation, causation, and grant)
times 100 records plus the page/checkpoint/cursor wrapper; both worker and
parent validation consume that same contract constant.
The production retained-history horizon is 10,000 records with an independent
64 MiB payload cap; permanent idempotency identities have a separate 50,000
entry hard capacity. Smaller horizons exist only through the test factory.

Reads snapshot the head checkpoint on their first page. Continuations must
present the exact channel, epoch, through-sequence, checkpoint, and historical
anchor. Later appends do not stale that snapshot. A moving retention floor may
prune already consumed rows, while a required pruned row produces an explicit
gap. A fresh late join after truncation also receives a gap instead of silently
treating the retained suffix as complete history. Every gap carries an
authority-issued resume cursor: presenting it explicitly acknowledges the loss
and replays the retained suffix, while repeating a cursorless read keeps
reporting the gap. Retention stores an explicit
chain anchor and leaves bounded permanent identity receipts behind, so an exact
retry returns its original receipt even after payload pruning. A parse, digest,
sequence, byte-count, identity, policy, anchor, or head inconsistency is
`unavailable`, never an empty page. The fixed identity capacity makes the
idempotency horizon honest: a full room rejects new proposals with `capacity`
rather than silently forgetting old identities.

If concurrent retention overtakes an older snapshot, the gap and resume cursor
clamp their anchor to that snapshot's `throughSeq` and use the exact historical
receipt/checkpoint/envelope at the clamped sequence. No cursor or checkpoint may
claim an anchor beyond its own watermark.

SQLite `data_version` is a wake hint for the room SSE adapter only while it has
subscribers. The adapter re-reads the bounded document projection and
reauthorizes before delivery; SQLite notifications are never treated as replay
truth or as permission to disclose stored content.

Capabilities and agent authorization are checked before work, immediately
before a write after the worker owns its SQLite transaction, and again before a
read batch is disclosed. A revocation that arrives during link resolution or
SQLite contention therefore commits and reveals nothing. Resolved `receipt`
links are a first-class outcome-link kind distinct from the authority receipt
that proves how any link was resolved.
Every persisted grant receipt is closed and type-checked, and its capability is
derived from the durable principal/body pair: human messages and output reviews use
`message-write`, lifecycle facts use `lifecycle-append`, outcome links use
`revision-link`, and every agent-authored record uses `agent-publish`.

Validated append intents and cursors are deeply cloned and frozen before the
first authority await. Caller mutation, accessors, and proxies can neither
change a later digest nor execute after authority work begins. Starting close
advances a generation fence: pending operations cannot later disclose content
or return commit success, and all close rejection/malformed outcomes totalize
to `unavailable` without an unhandled fire-and-forget rejection.

`live-work-presence-ended` records have one explicit reason: `departed`,
`withdrawn`, or `expired`. They do not mean `live-work-finished`; the latter is
a separate deliberate lifecycle body with a terminal outcome and optional exact
run, revision, and receipt-backed outcome links. This preserves an honest
material history when a participant leaves or TTL expires before work settles.

This core intentionally does not assert SSE delivery, SDK/UI composition, two
distinct-human identity, hosted membership, or restart-resolvable revision
content. Those are composed only after their respective authority and transport
adapters exist.
