import { describe, expect, it } from 'vitest';
import { MemoryKernelVolume, openMemoryKernelStorage } from '../memory.js';
import type { KernelStorage } from '../port.js';
import { createFakeProcessTable } from '../testing/index.js';

describe('memory adapter', () => {
  it('refuses a command on a second handle of the same volume from inside a transaction', async () => {
    const volume = new MemoryKernelVolume();
    const processes = createFakeProcessTable();
    const context = { liveness: processes.liveness };
    let second: KernelStorage | undefined;
    let nested: Promise<unknown> | undefined;
    const outer = openMemoryKernelStorage({
      volume,
      participants: [
        {
          name: 'nester',
          commit: () => {
            nested = second?.execute(
              {
                type: 'turnDedup.claim',
                key: 'inner',
                owner: processes.spawn(),
                now: 1,
                tracking: 'tracked',
              },
              context,
            );
            nested?.catch(() => {});
          },
        },
      ],
    });
    second = openMemoryKernelStorage({ volume });
    await outer.execute(
      {
        type: 'turnDedup.claim',
        key: 'outer',
        owner: processes.spawn(),
        now: 1,
        tracking: 'tracked',
      },
      context,
    );
    await expect(nested).rejects.toThrow(/inside another command/);
    expect(
      await second.execute({ type: 'turnDedup.read', key: 'inner' }, context),
    ).toEqual({ kind: 'absent' });
  });

  it('accepts only a real volume', () => {
    // @ts-expect-error a plain object is not a volume.
    expect(() => openMemoryKernelStorage({ volume: {} })).toThrow(TypeError);
    // @ts-expect-error nor is a string.
    expect(() => openMemoryKernelStorage({ volume: 'volume' })).toThrow(
      TypeError,
    );
  });
});
