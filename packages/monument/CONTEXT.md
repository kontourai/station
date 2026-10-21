# Monument context

`@kontourai/monument` is the engine-neutral durability kernel of epic #3558.
A survey monument is the permanent mark that outlasts everything around it.
This package holds the rules that must still give one answer after a crash.

It is a Tier 1 package under
[ADR 0005](../../docs/adr/0005-require-a-second-consumer-before-extraction.md).
It is built in Station's workspace and publishable on its own. Station is its
only product consumer. Its versioning is experimental until a second consumer exists.

## Two layers

The kernel is the lower layer. The private experimental
[`@kontourai/agent-runtime`](../agent-runtime/README.md) package now consumes its
public contracts for model-only Cut 0/1 of #3573. Durable tools, approvals and
Station chat/boot adoption remain later work. This Station-owned workspace
consumer does not qualify a second independent product or a Tier 2 extraction.
The kernel takes no model dependency; the upper package binds the existing
native framework loops.

## What the kernel owns

| Machine | Durable record | Rule |
| --- | --- | --- |
| Turn dedup | one claim per key, with its owner, invocation state and optional versioned input digest | A dead owner's claim is reclaimed only when that owner provably never began its effect (`pending` or `untracked`). `begun` and unknown answer `indeterminate`, and the turn is never sent again. A key whose resolved row retention evicted answers `expired`: the effect ran, and the key is never claimed afresh. |
| Turn boundary | one active fence per invocation, optionally with an opaque immutable intent binding | Ordinary intent uses `reserved` → `prepared` → `invoking` → `accepted` or `indeterminate`. Preparation links an optional pending dedup key; begin changes both fences in one transaction. After a crash, complete prepared intent is retained as a separate resumable candidate. Explicit resume compares both dead exact owners and revisions before transferring them. Dead reservations and inputless legacy preparation are removed; invoking becomes indeterminate. Legacy lifecycle, task-dispatch and engine-opened acceptance remain unchanged. |
| Request keys | one row per caller, tool and key, with a digest | A reused key with a different digest is a conflict. A stored attempt without a result is never treated as new. |
| Inbox | one entry per inbox and key: its digest, opaque payload, FIFO sequence, state and recorded placement | A reused key with a different digest is a conflict; with the same digest it answers the stored entry, and a refused or cancelled one is queued again. The head (oldest unsettled entry) is claimed with its placement in the same transaction, before the host's effect, and only one entry per inbox is `placing`. A `placing` entry is never claimed afresh: after a crash the host re-drives it under the same key. An `unconfirmed` head blocks the inbox until it is cancelled, or until the host proves its effect and resolves it to `placed` or back to `queued`; a `refused` one does not. |
| Owner liveness | none | There is one three-state rule: `dead`, `live` or `unknown`. A pid whose birth differs from the recorded one is `dead`, and `unknown` never frees a claim. Reconcile takes its verdicts before the transaction, one probe per process, and applies each only to a row that has not changed since. |

The package also owns the message-delivery decision table, persisted decision
parser and record-before-effect sequence (`deliverSessionMessage`), exported
from its public root entry point. It records a new branch before invoking a
host-supplied start or steer port, preserves a pinned branch on re-drive and
maps the result without switching branches. It owns no engine invocation,
message schema, authorization, key store or receipt store. Station's Session
Control route and delegated-result service supply those ports and retain their
existing durable request-key and consumption rows. This sequence is not a
storage command and creates no new state or inbox. Recovery-ledger core and
steer receipts remain open extraction work in #3565.

Each storage operation is one command, executed as one atomic transaction by an
adapter. The decision for a command is a pure function of the records it
reads. Host projections join that transaction as synchronous participants: a
participant can refuse a command before it writes, or abort it after.

The prepared binding contains only invocation/input/intent digests, an opaque
body reference and an optional dedup key. It supplies no body storage, host
read/resume API, automatic replay or invocation terminal attribution. Hosts
retain authorization, body verification and effect invocation. Mixed-version
writers need host fencing; additive columns alone cannot protect prepared
intent from a legacy writer's cleanup. See the [protocol](README.md#reconcile-after-a-restart).

Explicit prepared cancellation and definitive adapter refusal use separate
trusted compound commands. They compare both full owners/revisions, intent and
pending/begun link, then retain a passive same-table settlement audit and a
non-reclaimable dedup outcome together. Settlement retains opaque intent/bodyRef;
it neither stores nor deletes the host body. Passive rows occupy no active or
accepted-capacity slot, and reads/recovery/terminal retirement exclude them.
Only explicit thread forgetting removes the boundary audit. Deliberate host
dedup-prefix deletion can erase dedup retention independently and never grants
resume permission for a retained settled invocation. The kernel adds no host
API, automatic retry, dormant Session-start protocol or new deletion authority.

Station's consumer facade maps retained dedup settlement to a typed
`client_turn_settled` refusal with the actual disposition; the authorized delivery
GET answers 409 while the successful lookup DTO and unreadable-conversation
non-disclosure remain unchanged. An ordinary same-key send is refused and a new
request needs a new key, never a fabricated provider result. Station binds its
existing intent/settlement columns and stores retirement custody on the same
prepared-input audit row. Bindings without those columns retain only their
legacy commands. Explicit host thread deletion keeps its existing authority;
concurrent old writers and installed runtime behavior need separate qualification.

## What it does not own

| Concern | Owner |
| --- | --- |
| Message schema | `@kontourai/thread` |
| Invocation | `relay` |
| Routing and budgets | `dispatch` |
| Host hooks | `conduit` |
| Process runs and gates | `flow` |
| Time | `ephemeris` |
| Authentication, read models, provider adapters, UI | Station |
| The event store and its conversation history | Station; the kernel holds durability rules beside it, not a second store |

## Import boundary

The package imports only `node:` builtins, the dependencies its
`package.json` declares, and its own files. It never imports
`@kontourai/station` or any `@kontourai/station-*` package, contracts and
shared included. Loaders the import graph cannot see (`node:module`, `node:vm`,
`node:child_process` outside tests, `node:worker_threads`, `getBuiltinModule`,
`createRequire`, `eval`, `Function`, a referenced or member `require`,
`import.meta.resolve`), CommonJS source, nested manifests or repositories,
relative paths through `node_modules`, and symlinks under the package are
refused too, as are percent-encoded or backslash relative specifiers and any
dependency entry (the package has none, and an aliased specifier such as
`workspace:` or `npm:` is never allowed). The gate reads source text; a name
assembled at run time is out of its reach and is left to review. The package may hold only source, Markdown, its licence and
its root `package.json`, `tsconfig.json` and `tsconfig.build.json`; the build
config is an explicit reviewed exception. Other files (an extensionless
module, a JSON fixture) are refused, because Node or the published `files` list
would use it without the gate reading it. The same gate refuses Station code
that reaches the package other than through its exported entry points: it
resolves relative, absolute and `file:` specifiers through symlinks and
case-insensitively, refuses a symlink into the package, and, in a file that
names the package under any escape or case, refuses a module reference it
cannot read. `scripts/monument-import-boundary-gate.mjs`
enforces this in
`ci:fast` and in `verify:static`. Station consumes the package only through
its public entry points: `.`, `./sqlite`, `./adapter` and `./testing`.

**Threat model** (owner decision): the gate stops *accidental* coupling
between Station and Monument internals, the kind real code and agents
produce: an import, a test helper's path such as `vi.importActual`, a
`package.json` `imports` alias or `tsconfig` `paths` entry, a symlink, a stray
file. It does not stop deliberate evasion. Names assembled at run time, data
URLs, unusual escape spellings, computed paths in files that never name the
package, and repo-relative path strings outside `resolve`/`join` calls and
vite or vitest configs are accepted limits, left to review.

## Retention

- **Turn dedup:** when both original and incoming input digests are known, a mismatch answers `conflict` before replay, contention or dead-owner reclaim. Reclaim preserves only the original digest; legacy input stays unknown. Digest-less callers retain legacy behavior. Rows past `turnDedupMaxEntries` are evicted oldest first,
  among resolved rows only. An unresolved claim is never evicted.
  An evicted key leaves a tombstone, which holds only the key and the time
  and does not count toward the cap. A claim of a tombstoned key answers
  `expired`, and nothing writes. A rule in `turnDedupTombstoneRetention`
  forgets the tombstones under a key prefix once they are older than its
  `maxAgeMs`, on the next dedup write; a tombstone no rule covers lasts until
  `turnDedup.forgetPrefix` forgets it with its rows. A resolve retried after
  its row was evicted answers `stale`, which a caller cannot tell apart from
  a lost claim; an exact retry of a stored row answers `applied`.
- **Request keys:** a claim first forgets completed rows older than
  `requestKeyTtlMs`. An unresolved row is kept however old: its attempt may
  have had its effect, so a late retry must re-drive it with its recorded
  decision, never claim the key afresh. Past the TTL it stops holding a quota
  slot, so a claim that can never resolve does not lock its caller out of the
  per-caller cap, or everyone out of the store-wide one.
- **Inbox:** a submit first forgets the inbox's settled entries (`placed`,
  `refused`, `cancelled`) last updated before `inboxSettledRetentionMs`. An
  inbox holds at most `inboxMaxUnsettled` unsettled entries; a submit past it
  answers `capacity` and writes nothing. `inbox.forget` removes one inbox
  outright, for a host whose conversation was deleted.
- **Terminal-turn facts:** inputless legacy rows use retained provider turn ids a
  thread has seen end, which make a later acceptance of the same id
  `ambiguous`. Those default facts are retired by `turnBoundary.forgetThread`.
  A host with an event log supplies `terminalSeen` inside the transaction
  instead, fixed at storage open (the SQLite binding or an adapter
  supplying `KernelTerminalFacts` to its transaction step): observation and forgetting do not maintain a second
  terminal source. Session-terminal ordering can use the host's persisted
  sequence and an existing boundary creation-fence column; NULL legacy fences
  and inputless legacy turn generations retain timestamps. Optional fixed-at-open
  `retiredBoundaryIds` facts filter only possible-effect polling; raw rows,
  listing and recovery remain unchanged. Station binds that projection to
  canonical events using the same predicate as physical cleanup. Polling takes
  no writer lock and does not retry pending transitions. Physical cleanup runs
  before create/accepted admission decisions in their writer transaction, and
  before raw recovery at boot. Claim, prepare, observe and reconcile retain
  pending retries. Its host adapter retains admission and storage-error
  classification on the existing tables and connection.


## Invocation terminal ownership

Intent-aware acceptance uses `turnBoundary.acceptInvocation` with the full
owned pre-accept boundary and independent original begun dedup snapshot.
Current or witnessed records must match exact expected/accepted/indeterminate
images and original/resolved-only dedup images. Unknown/contradictory terminal
evidence blocks acknowledgement; overlapping expected/indeterminate images
remain conservatively ambiguous. Generic acceptance cannot bypass this command.

Owned memory and SQLite retain exact invocation facts and full pre-deletion
witnesses in the existing terminal area; SQLite schema four transactionally
preserves legacy strings and all other machine data. Witness precedes deletion
in the same transaction, and raw listing contains no completed fence. Host mode
uses only its canonical events and existing prepared-intent audit row via the
fixed-at-open synchronous find/readObservation/readRetirement/recordRetirement
bundle. The raw read verifies every field of an actual retained observation,
including false eligibility and absent boundaries; find separately owns eligible
complete-set disposition. Missing/malformed/Promise/mismatched observations
reject without a fallback or shadow source. The host
must provide the complete bundle and intent binding; legacy commands remain
available without it. No second store, public capability or async repair exists.

Ordinary retirement matches exact invocation without clocks, subject to the
actual target's native identity. Full retained eligible scope consistency runs
before provider/event filters, then code-point event selection. Session sequence,
legacy accepted/native/time, passive audit and explicit forget rules remain.
Facts/witnesses can grow without bound until explicit deletion; dedup retention
can independently make acknowledgement stale. A late contradiction after an
already committed deletion makes later acknowledgement stale without recreating
a fence or retroactively retracting release. Neither terminal disposition nor
row absence authorizes replay. Station source consumes this protocol through
its actual canonical event/audit connection and private begun claim snapshots.
Producer attribution, supported-writer fencing and actual effect-count/native/
runtime qualification remain host-owned. See [the exact protocol](README.md#invocation-terminal-acknowledgement).
