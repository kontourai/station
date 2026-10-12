import { describe, expect, it } from 'vitest';
import type { KernelCommand } from '../commands.js';
import { MemoryKernelVolume, openMemoryKernelStorage } from '../memory.js';
import type { KernelContext } from '../port.js';
import {
  type KernelStorageHarness,
  memoryKernelHarness,
  runKernelConformance,
} from '../testing/index.js';

/**
 * The suite's rejection path: an adapter that loses its last commit when it
 * is reopened must fail it. Without this, a suite whose reopen never reached
 * storage would pass every adapter.
 *
 * Built only from the public API: every successful command is logged, and a
 * reopen replays all but the last into a fresh volume.
 */
const dropsLastCommitOnReopen: KernelStorageHarness = {
  name: 'memory, dropping the last commit on reopen',
  async createLocation() {
    const log: Array<{ command: KernelCommand; context: KernelContext }> = [];
    return {
      async open(options = {}) {
        log.pop();
        const volume = new MemoryKernelVolume();
        const replay = openMemoryKernelStorage({ volume });
        for (const entry of log)
          await replay.execute(entry.command, entry.context);
        const inner = openMemoryKernelStorage({
          volume,
          ...(options.participants
            ? { participants: options.participants }
            : {}),
        });
        return {
          async execute(command, context) {
            const result = await inner.execute(command, context);
            log.push({ command, context });
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
