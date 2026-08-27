// Fault-injection harness for
// longrunning-fixture-child.abnormal-exit.test.ts. Deliberately NOT run
// inside vitest: spawned as its own standalone process so it can be killed
// by an external SIGTERM with no chance to run any afterEach -- exactly the
// station#1812 failure mode (scripts/lib/owned-process.mjs terminating a
// hung/timed-out corpus group, or a plain Ctrl-C). Node 24 runs plain-typed
// `.ts` files directly, so this needs no build step or loader.
import { spawnLongRunningFixtureChild } from './longrunning-fixture-child.js';

const proc = await spawnLongRunningFixtureChild();
process.stdout.write(`${proc.pid}\n`);
// Keep the event loop alive so the parent test controls exactly when this
// harness gets signalled.
setInterval(() => {}, 60_000);
