import { describe, expect, test, vi } from 'vitest';
import type { ServiceLifecycleArgs } from '../commands/service.js';
import { runServiceMenu } from '../commands/service-menu.js';

const lifecycle = {
  baseDir: '/tmp/home',
  serverPort: 3141,
  uiPort: 3000,
} as unknown as ServiceLifecycleArgs;

describe('runServiceMenu', () => {
  test('non-TTY delegates to runServiceCommand with no action (the usage fallback)', async () => {
    const runService = vi.fn(async () => undefined);
    await runServiceMenu(lifecycle, {
      isInteractive: false,
      runService,
    });
    // No action word: the real runServiceCommand throws the canonical usage
    // error, so the non-TTY message can never drift from an explicit bad call.
    expect(runService).toHaveBeenCalledWith([], lifecycle);
  });

  test('a TTY selection dispatches that action through runServiceCommand', async () => {
    const runService = vi.fn(async () => undefined);
    await runServiceMenu(lifecycle, {
      isInteractive: true,
      select: async () => 'install',
      runService,
    });
    expect(runService).toHaveBeenCalledWith(['install'], lifecycle);
  });

  test('a cancelled menu dispatches nothing', async () => {
    const runService = vi.fn(async () => undefined);
    await runServiceMenu(lifecycle, {
      isInteractive: true,
      select: async () => null,
      runService,
    });
    expect(runService).not.toHaveBeenCalled();
  });

  test('returns the receipt runServiceCommand returns (rollback contract intact)', async () => {
    const receipt = { compensations: [] };
    const runService = vi.fn(async () => receipt);
    const result = await runServiceMenu(lifecycle, {
      isInteractive: true,
      select: async () => 'install',
      runService,
    });
    expect(result).toBe(receipt);
  });
});
