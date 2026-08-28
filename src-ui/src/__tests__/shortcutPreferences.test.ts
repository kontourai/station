/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * archive#settings-revamp (archive#1359 convergence): shortcutPreferences
 * is now backed by the registry-driven device-settings envelope (a module
 * singleton) rather than the raw `station.device-settings` root — reset
 * modules per test so each test gets a fresh, un-migrated store the same
 * way `device-settings-store.test.ts` does.
 */
async function freshShortcutPreferences() {
  vi.resetModules();
  return import('../settings/shortcutPreferences');
}

describe('shortcut device settings', () => {
  beforeEach(() => window.localStorage.clear());

  test('migrates unversioned bindings from the shared #1359 root on first read', async () => {
    window.localStorage.setItem(
      'station.device-settings',
      JSON.stringify({
        shortcutBindings: {
          'app.settings': { key: 's', modifiers: ['cmd'] },
        },
        modelPicker: { favorites: ['provider-model'] },
      }),
    );

    const { readShortcutOverrides, writeShortcutOverrides } =
      await freshShortcutPreferences();

    expect(readShortcutOverrides()).toEqual({
      'app.settings': { key: 's', modifiers: ['cmd'] },
    });

    writeShortcutOverrides({
      ...readShortcutOverrides(),
      'chat.new': { key: 'n', modifiers: ['cmd'] },
    });

    expect(readShortcutOverrides()).toEqual({
      'app.settings': { key: 's', modifiers: ['cmd'] },
      'chat.new': { key: 'n', modifiers: ['cmd'] },
    });
// The shared legacy root is fully retired — the envelope is the only
// home for shortcut overrides now.
    expect(window.localStorage.getItem('station.device-settings')).toBeNull();
    expect(
      window.localStorage.getItem('station-device-settings-v1'),
    ).not.toBeNull();
  });

  test('normalizes signatures and identifies browser-reserved bindings', async () => {
    const { bindingSignature, browserReservedReason } =
      await freshShortcutPreferences();

    expect(bindingSignature({ key: 'K', modifiers: ['shift', 'cmd'] })).toBe(
      'cmd+shift|k',
    );
    expect(browserReservedReason({ key: 'w', modifiers: ['cmd'] })).toMatch(
      /browser/i,
    );
    expect(browserReservedReason({ key: 'w', modifiers: ['ctrl'] })).toBeNull();
  });

  test('writeShortcutOverrides dispatches DEVICE_SETTINGS_EVENT for legacy window-event consumers', async () => {
    const { DEVICE_SETTINGS_EVENT, writeShortcutOverrides } =
      await freshShortcutPreferences();
    const listener = vi.fn();
    window.addEventListener(DEVICE_SETTINGS_EVENT, listener);

    writeShortcutOverrides({
      'app.settings': { key: 's', modifiers: ['cmd'] },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(DEVICE_SETTINGS_EVENT, listener);
  });
});
