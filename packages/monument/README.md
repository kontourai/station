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
| `@kontourai/monument` | The port (`KernelStorage`, `KernelTransaction`, `CommitParticipant`), commands and results, the pure decision functions, owner liveness, and the in-memory adapter | none |
| `@kontourai/monument/sqlite` | The `node:sqlite` adapter, plus its test location and conformance harness | Node 24 |
| `@kontourai/monument/testing` | The conformance suite, the crash-point store, a fake process table and the in-memory harness | `node:assert` |

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
