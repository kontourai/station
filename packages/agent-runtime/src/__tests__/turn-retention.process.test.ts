import { it } from 'vitest';
import { retentionBacklog } from './turn-retention-fixture.js';
import {
  activeTurnWalBacklog,
  checkpointEventLoop,
  concurrentCheckpointWaiters,
} from './turn-wal-fixture.js';

// Full backlog coverage belongs to the resource-classified process-heavy lane.
it('retention bounds synchronous open and settle work excluding COMMIT while draining 60 terminal turns with 80 effects each', async () => {
  await retentionBacklog(60, 80);
}, 300_000);

it('one active turn cannot prevent bounded WAL across 300 turns with 20 effects each', async () => {
  await activeTurnWalBacklog();
}, 300_000);

it('checkpointing a large WAL keeps the main event loop responsive', async () => {
  await checkpointEventLoop();
}, 60_000);

it('concurrent checkpoint waiters recheck the WAL bound before writing', async () => {
  await concurrentCheckpointWaiters();
}, 60_000);
