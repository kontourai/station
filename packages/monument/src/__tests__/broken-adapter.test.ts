import { describe, expect, it } from 'vitest';
import { MemoryKernelVolume, openMemoryKernelStorage } from '../memory.js';
import {
  type KernelStorageHarness,
  memoryKernelHarness,
  runKernelConformance,
} from '../testing/index.js';

/**
 * The suite's rejection path: an adapter that loses its last commit when it
 * is reopened must fail it. Without this, a suite whose reopen never reached
 * storage would pass every adapter.
 */
const dropsLastCommitOnReopen: KernelStorageHarness = {
  name: 'memory, dropping the last commit on reopen',
  async createLocation() {
    const volume = new MemoryKernelVolume();
    let beforeLastCommit = volume.committed;
    return {
      async open(options = {}) {
        // Reopening restores the image from before the last commit.
        volume.committed = beforeLastCommit;
        const inner = openMemoryKernelStorage({
          volume,
          ...(options.participants
            ? { participants: options.participants }
            : {}),
        });
        return {
          async execute(command, context) {
            const before = volume.committed;
            const result = await inner.execute(command, context);
            if (volume.committed !== before) beforeLastCommit = before;
            return result;
          },
          close: () => inner.close(),
        };
      },
      async dispose() {},
    };
  },
};

describe('the conformance suite rejects a broken adapter', () => {
  it('passes the real memory adapter (control)', async () => {
    const outcomes = await runKernelConformance(memoryKernelHarness);
    expect(outcomes.filter((outcome) => outcome.error)).toEqual([]);
  });

  it('fails an adapter that drops its last commit on reopen', async () => {
    const outcomes = await runKernelConformance(dropsLastCommitOnReopen);
    const failed = outcomes
      .filter((outcome) => outcome.error)
      .map((outcome) => outcome.name);
    expect(failed).toContain('durability: a committed command survives reopen');
    expect(failed).toContain(
      'crash: after a dedup claim is begun, the retry is indeterminate',
    );
  });
});
