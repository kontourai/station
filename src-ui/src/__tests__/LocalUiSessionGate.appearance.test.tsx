/** @vitest-environment jsdom */

import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import {
  APPEARANCE_CACHE_KEY,
  parseAppearanceCache,
} from '../lib/appearance-cache';
import { bindColorThemeToSettings } from '../lib/color-theme-apply';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import { renderWithIsolatedConnections } from './renderWithIsolatedConnections';

/**
 * Signed out: the startup path painted the previous account's appearance from
 * the appearance cache, and the protected tree (with the account boundary
 * that otherwise releases it) never mounts on the connect screen. Resolving
 * to "no session" must hand the page back to this device's own appearance
 * and record that as what was rendered.
 */

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionManagerModal: () => null,
}));

const ACCOUNT_CACHE = {
  version: 1,
  source: 'account',
  theme: 'light',
  colorTheme: 'catppuccin',
  colorThemeFlavor: 'mocha',
  colorThemeAccent: 'mauve',
};

describe('signed-out appearance', () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 1, values: { theme: 'dark' } }),
    );
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(ACCOUNT_CACHE));
    deviceSettingsStore.reloadFromStorage();
    stop = bindColorThemeToSettings(
      document.documentElement,
      deviceSettingsStore,
    );
  });
  afterEach(() => {
    stop();
    resetLocalUiBootstrapForTests();
    vi.restoreAllMocks();
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
  });

  test("the connect screen releases the previous account's appearance and records the device's", async () => {
    // Before the access check answers, the cached account appearance holds.
    expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
    expect(deviceSettingsStore.getSnapshot().colorTheme).toBe('catppuccin');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    renderWithIsolatedConnections(
      <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
        <div>Protected application mounted</div>
      </LocalUiSessionGate>,
    );
    expect(
      await screen.findByRole(
        'button',
        { name: 'See how Station works' },
        { timeout: 5000 },
      ),
    ).toBeTruthy();

    expect(deviceSettingsStore.getAppearanceSource()).toBe('device');
    expect(deviceSettingsStore.getSnapshot()).toMatchObject({
      theme: 'dark',
      colorTheme: 'station',
    });
    expect(document.documentElement.hasAttribute('data-color-theme')).toBe(
      false,
    );
    expect(
      parseAppearanceCache(localStorage.getItem(APPEARANCE_CACHE_KEY)),
    ).toMatchObject({ source: 'device', theme: 'dark', colorTheme: 'station' });
  });
});
