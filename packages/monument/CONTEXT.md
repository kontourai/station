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
| Owner liveness | none | There is one three-state rule: `dead`, `live` or `unknown`. A pid whose birth differs from the recorded one is `dead`, and `unknown` never frees a claim. Reconcile takes its verdicts before the transaction, one probe per process, and applies each only to a row that has not changed since. |

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
shared included. Loaders the import graph cannot see (`node:module`, `node:vm`,
`node:child_process` outside tests, `node:worker_threads`, `getBuiltinModule`,
`createRequire`, `eval`, `Function`, a referenced or member `require`,
`import.meta.resolve`), CommonJS source, nested manifests or repositories,
relative paths through `node_modules`, and symlinks under the package are
refused too, as are percent-encoded or backslash relative specifiers and any
dependency entry (the package has none, and an aliased specifier such as
`workspace:` or `npm:` is never allowed). The gate reads source text; a name
assembled at run time is out of its reach and is left to review. The package may hold only source, Markdown, its licence and
its root `package.json` and `tsconfig.json`; any other file (an extensionless
module, a JSON fixture) is refused, because Node or the published `files` list
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
URLs, unusual escape spellings, and computed paths in files that never name
the package are accepted limits, left to review.

## Retention

- **Turn dedup:** rows past `turnDedupMaxEntries` are evicted oldest first,
  among resolved rows only. An unresolved claim is never evicted.
  A resolve retried after its row was evicted answers `stale`, which a caller
  cannot tell apart from a lost claim; an exact retry of a stored row answers
  `applied`.
- **Request keys:** a claim first forgets rows older than `requestKeyTtlMs`.
  This includes unresolved rows, which reproduces Station's current
  behaviour; #3581 is fixing that in Station, and the kernel will adopt the
  semantics that lane lands.
- **Terminal-turn facts:** these are the provider turn ids a thread has seen
  end, which make a later acceptance of the same id `ambiguous`. They are
  retired together with the thread's boundaries by
  `turnBoundary.forgetThread`, and kept until then.
