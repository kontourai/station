# Project/Task room history

`ProjectTaskRoomHistory` is Station's durable, asynchronous Project/Task
rendezvous. It is deliberately distinct from an active live-work session: a
session can start, end presence, or deliberately finish work in history, but liveness, presence, transport,
and pane rendering remain outside this module.

The module is deep. `EventStore` privately owns an asynchronous worker-thread
adapter; that worker constructs the separate SQLite connection to the existing
orchestration database. Synchronous `node:sqlite` work, including busy-timeout
waiting, never runs on the server event loop. `ProjectTaskRoomHistory.close()`
is the awaitable worker/SQLite settlement seam; the still-synchronous
`EventStore.close()` only initiates that close and never blocks with
`Atomics.wait` or claims settlement it cannot synchronously prove.
Callers receive only room intents (`open`, `append`, and `read`), never a
database, table name, raw channel proposal, channel id, actor identity, or
policy revision. An injected capability authority revalidates every operation
and resolves the opaque grant to its canonical Project UUID, Project slug,
Task, principal, capability, and policy revision. Grant shape is never treated
as authority; discover, history-read, human write, lifecycle append, resolved
link, and agent publish remain separate.

The stored record is a `station.channel-proposal/v1` embedded in a
`station.channel-sequence/v1`. Its room-local `(epoch, seq)`, proposal digest,
previous envelope digest, and rolling checkpoint are independent of both
orchestration event sequence and operational-event retention. The local
adapter's assurance is explicitly `L0`: it proves neither membership nor a
signature. Agent publishing and resolved outcome links require injected,
prevalidated authority adapters; a caller-supplied string is not authority.
The proposal idempotency digest covers resolved scope, principal, occurrence,
correlation and causation, resolved link projections, and the authority receipt.

Inputs and stored projections use an allocation-free incremental JSON byte
counter that includes syntax and escaping bytes before serialization. Body,
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
derived from the durable principal/body pair: human messages use
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
