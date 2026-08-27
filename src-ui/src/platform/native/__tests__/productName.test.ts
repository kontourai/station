import { beforeEach, describe, expect, test, vi } from 'vitest';

const app = vi.hoisted(() => ({
  getName: vi.fn<() => Promise<string>>(),
}));

vi.mock('@tauri-apps/api/app', () => app);

import { configuredNativeProductName } from '../productName';

describe('configuredNativeProductName', () => {
  beforeEach(() => {
    app.getName.mockReset();
  });

  test('returns the configured local Tauri package identity', async () => {
    app.getName.mockResolvedValue('Station Nightly');

    await expect(configuredNativeProductName()).resolves.toBe(
      'Station Nightly',
    );
  });

  test('falls back cleanly when the native app-name bridge is unavailable', async () => {
    app.getName.mockRejectedValue(new Error('native bridge unavailable'));

    await expect(configuredNativeProductName()).resolves.toBeNull();
  });
});
