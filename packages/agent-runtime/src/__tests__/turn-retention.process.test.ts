import { it } from 'vitest';
import { retentionBacklog } from './turn-retention-fixture.js';
import {
  activeTurnWalBacklog,
  checkpointEventLoop,
} from './turn-wal-fixture.js';

// Full backlog coverage belongs to the resource-classified process-heavy lane.
it('retention bounds pre-COMMIT open and settle work while draining 60 terminal turns with 80 effects each', async () => {
  await retentionBacklog(60, 80);
}, 300_000);

it('one active turn cannot prevent bounded WAL across 300 turns with 20 effects each', async () => {
  await activeTurnWalBacklog();
}, 300_000);

it('checkpointing a large WAL keeps the main event loop responsive', async () => {
  await checkpointEventLoop();
}, 60_000);
