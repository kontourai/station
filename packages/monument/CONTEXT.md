# Monument context

`@kontourai/monument` is the engine-neutral durability kernel of epic #3558.
A survey monument is the permanent mark that outlasts everything around it.
This package holds the rules that must still give one answer after a crash.

It is a Tier 1 package under
[ADR 0005](../../docs/adr/0005-require-a-second-consumer-before-extraction.md).
It is built in Station's workspace and publishable on its own. Station is its
only consumer. Its versioning is experimental until a second consumer exists.

## Two layers

The kernel is the lower layer. An agent runtime (#3573), which holds durable
model and tool steps for in-process agents, will sit above it later. Neither
layer depends on a model loop, so a host that only supervises external engines
takes no model dependency.

## What the kernel owns

| Machine | Durable record | Rule |
| --- | --- | --- |
| Turn dedup | one claim per key, with its owner and invocation state | A dead owner's claim is reclaimed only when that owner provably never began its effect (`pending` or `untracked`). `begun` and unknown answer `indeterminate`, and the turn is never sent again. |
| Turn boundary | one row per provider invocation | `prepared` → `invoking` → `accepted` or `indeterminate`. After a crash, a dead owner's `prepared` row is removed, an `invoking` row becomes `indeterminate`, and both `accepted` and `indeterminate` rows are reported until their owner retires them. |
| Request keys | one row per caller, tool and key, with a digest | A reused key with a different digest is a conflict. A stored attempt without a result is never treated as new. |
| Owner liveness | none | There is one three-state rule: `dead`, `live` or `unknown`. A pid whose birth differs from the recorded one is `dead`, and `unknown` never frees a claim. |

Each operation is one command, executed as one atomic transaction by an
adapter. The decision for a command is a pure function of the records it
reads. Host projections join that transaction as synchronous participants: a
participant can refuse a command before it writes, or abort it after.

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
shared included. `scripts/monument-import-boundary-gate.mjs` enforces this in
`ci:fast` and in `verify:static`. Station consumes the package only through
its public entry points: `.`, `./sqlite` and `./testing`.

## Retention

- **Turn dedup:** rows past `turnDedupMaxEntries` are evicted oldest first,
  among resolved rows only. An unresolved claim is never evicted.
- **Request keys:** a claim first forgets rows older than `requestKeyTtlMs`.
  This includes unresolved rows, which reproduces Station's current
  behaviour; #3581 is fixing that in Station, and the kernel will adopt the
  semantics that lane lands.
- **Terminal-turn facts:** these are the provider turn ids a thread has seen
  end, which make a later acceptance of the same id `ambiguous`. They are
  retired together with the thread's boundaries by
  `turnBoundary.forgetThread`, and kept until then.
