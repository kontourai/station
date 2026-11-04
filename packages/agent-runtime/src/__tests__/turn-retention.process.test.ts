import { it } from 'vitest';
import { retentionBacklog } from './turn-retention-fixture.js';

// Full backlog coverage belongs to the resource-classified process-heavy lane.
it('retention bounds open and settle while draining 60 terminal turns with 80 effects each', async () => {
  await retentionBacklog(60, 80);
}, 300_000);
