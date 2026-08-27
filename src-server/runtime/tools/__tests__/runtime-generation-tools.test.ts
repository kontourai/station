import { describe, expect, test, vi } from 'vitest';
import {
  executeRuntimeGenerationToolWithinLease,
  guardRuntimeGenerationTools,
} from '../runtime-generation-tools.js';

describe('runtime generation tools', () => {
  test('does not nest execution leases when a guarded tool is projected again', async () => {
    const execute = vi.fn().mockResolvedValue('done');
    const firstLease = vi.fn(async (operation) => operation());
    const secondLease = vi.fn(async (operation) => operation());
    const first = guardRuntimeGenerationTools(
      [{ name: 'write', execute }],
      () => true,
      firstLease,
    );
    const projected = guardRuntimeGenerationTools(
      first,
      () => true,
      secondLease,
    );

    await expect(projected[0].execute?.({}, undefined)).resolves.toBe('done');
    expect(firstLease).toHaveBeenCalledOnce();
    expect(secondLease).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  test('executes a guarded tool inside an existing configuration lease', async () => {
    const execute = vi.fn().mockResolvedValue('done');
    const lease = vi.fn(async (operation) => operation());
    const [guarded] = guardRuntimeGenerationTools(
      [{ name: 'write', execute }],
      () => true,
      lease,
    );

    await expect(
      executeRuntimeGenerationToolWithinLease(guarded, { value: 1 }),
    ).resolves.toBe('done');
    expect(lease).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({ value: 1 }, undefined);
  });
});
