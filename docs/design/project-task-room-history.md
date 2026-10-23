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
A response timeout, worker error, exit, or broken worker protocol settles all
in-flight storage requests as `unavailable`. The adapter terminates that worker
and waits for its connection to close before a later request lazily starts a
replacement. Requests wait for the latest retirement even if a concurrent
failure replaces it during a microtask. Retirement waits, including `close()`,
are bounded by the five-second worker response budget; a timeout returns
`unavailable` without starting a replacement. A rejected termination is treated
as retired, allowing a later request to start a replacement after the cooldown;
`close()` reports `unavailable`. For one second after a generation fails,
requests return `unavailable` without spawning a worker. This caps repeated startup,
migration and WAL setup at one attempt per second per history during polling
storms while allowing recovery on the next poll after the cooldown and
retirement complete. Each request can start at most one worker; failed operations are
never automatically replayed, and there is no background restart loop. Closing
the history disables replacement. This recovers availability after a worker
failure; it does not remove contention with synchronous main-thread writers on
the same database. Authorization and controller admission still run inside the
history transaction, preserving revocation and source-seal ordering.

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

The attached-session follower uses yielding EventStore writes for envelopes,
owner records, transcript events, session/cursor updates, and colliding alias
deletion. Each synchronous attempt temporarily sets `busy_timeout=0`, completes
or rolls back, and restores the prior timeout before an asynchronous backoff
(2–64 ms). A Session FIFO preserves background write order. Each queued write
has a five-second contention budget once it reaches the front; exhaustion
rejects the poll without advancing its cursor. Before reading Claude's first
page, the follower durably pins the source's initial window start through the
same yielding write path, including an explicit zero anchor for a small file.
An interrupted page replays from that anchor after append-only growth,
rediscovery, cache eviction or restart; existing event IDs suppress duplicate
inserts. The anchor remains bound to the source handle and configuration-home
affinity. It retains bounded cursor state rather than page contents. This fixes
[#3708](https://github.com/kontourai/station/issues/3708) while preserving the
initial 2 MiB retention window: older bytes outside it are not backfilled, and
source deletion or truncation cannot be recovered from a cursor alone. If a file
shrinks below the saved offset, a warning is logged and the next poll pins a new
initial window so following resumes. A legacy attachment without source-home
affinity keeps its migration anchor in memory until a successful read; a failed
read preserves its durable cursor and does not grant affinity.
Codex and Grok already start at byte zero; OpenCode starts before the first
message in its ordered database query, so they have no moving cold window.
Deterministic ingress refusals keep their existing logged-skip policy.

An unchanged, event-free page performs no session write
([#3551](https://github.com/kontourai/station/issues/3551)). A meaningful
session write re-reads the stored row inside its own queued write attempt,
re-run after each contention backoff, and refuses if another writer deleted it,
made it Station-owned, changed its subject or affinity, or advanced its cursor.
A page with new events checks the row once, then each append compares the raw
stored owner, subject and cursor columns inside its queued attempt. A refusal
writes nothing, drops the thread's in-memory follow state and logs one warning
per thread; the next poll rebuilds from the durable cursor.

Scheduled message-search imports use the same yielding path. Their projection
and watermark commit in one transaction. On contention budget exhaustion, the
next pass retries the unchanged durable window after two seconds; restart also
resumes from that watermark. A non-contention error stops scheduled backfill
until restart and logs a warning with the error, database path and recovery
action.

Background follower and search-backfill writes yield between contention
attempts instead of busy-waiting on the main thread. Every other main-thread
writer remains synchronous, including constructor migrations, foreground/provider event and
Session updates, command/turn/delivery receipts and checkpoints, adoption and
recovery/credential ledgers, native/voice run transitions, attachment quota and
reference writes, operational-event journals, conversation history and lineage,
steer inputs, native session bindings, declared outputs, Session work-item
associations, Task memory summary revisions and record versions, and Learning
dismissal and promotion rows (#4003, `EventStore.taskMemoryStore()`, one
`BEGIN IMMEDIATE` transaction per write), and source-seal/provider-admission transactions. These writers can still collide with room workers and block the
event loop; [#3701](https://github.com/kontourai/station/issues/3701) remains open.
This change does not establish universal deadlock freedom or worker recovery
after another writer blocks the event loop.

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
