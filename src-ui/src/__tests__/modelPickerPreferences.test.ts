// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#settings-revamp slice 3 (#1359 convergence): modelPickerPreferences
 * is now backed by the registry-driven device-settings envelope (a module
 * singleton) rather than the raw `station.device-settings` root — reset
 * modules per test for a fresh, un-migrated store.
 */
async function freshModelPickerPreferences() {
  vi.resetModules();
  return import('../settings/modelPickerPreferences');
}

describe('model picker device settings', () => {
  beforeEach(() => window.localStorage.clear());

  test('recovers safely from invalid legacy settings', async () => {
    window.localStorage.setItem('station.device-settings', '{broken');
    const { readModelPickerPreferences } = await freshModelPickerPreferences();

    expect(readModelPickerPreferences()).toEqual({
      favorites: [],
      recents: [],
      hidden: [],
      order: [],
    });
  });

  test('migrates an unversioned picker shape from the shared #1359 root', async () => {
    window.localStorage.setItem(
      'station.device-settings',
      JSON.stringify({
        shortcutBindings: {
          'chat.new': { key: 'n', modifiers: ['cmd'] },
        },
        modelPicker: { favorites: ['provider-model'] },
      }),
    );

    const { readModelPickerPreferences, updateModelPickerPreferences } =
      await freshModelPickerPreferences();

    expect(readModelPickerPreferences().favorites).toEqual(['provider-model']);

    updateModelPickerPreferences((current) => current);

    // The shared legacy root is fully retired after migration.
    expect(window.localStorage.getItem('station.device-settings')).toBeNull();
    expect(readModelPickerPreferences().favorites).toEqual(['provider-model']);
  });

  test('deduplicates lists, caps recents, and keeps exact provider identity', async () => {
    const {
      modelPreferenceKey,
      readModelPickerPreferences,
      updateModelPickerPreferences,
    } = await freshModelPickerPreferences();

    const favorite = modelPreferenceKey('bedrock-prod', 'claude-sonnet');
    const recents = Array.from({ length: 25 }, (_, index) =>
      modelPreferenceKey('provider', `model-${index}`),
    );
    updateModelPickerPreferences((current) => ({
      ...current,
      favorites: [favorite, favorite],
      recents,
    }));

    expect(readModelPickerPreferences().favorites).toEqual([favorite]);
    expect(readModelPickerPreferences().recents).toHaveLength(20);
    expect(favorite).not.toBe(
      modelPreferenceKey('bedrock-dev', 'claude-sonnet'),
    );
  });

  test('preserves preference fields while updating one field, and leaves sibling device settings untouched', async () => {
    window.localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 1, values: { theme: 'light' } }),
    );
    const { readModelPickerPreferences, updateModelPickerPreferences } =
      await freshModelPickerPreferences();
    const { deviceSettingsStore } = await import(
      '../lib/device-settings-store'
    );

    updateModelPickerPreferences((current) => ({
      ...current,
      hidden: ['provider-hidden'],
    }));
    updateModelPickerPreferences((current) => ({
      ...current,
      favorites: ['provider-favorite'],
    }));

    expect(readModelPickerPreferences()).toEqual({
      favorites: ['provider-favorite'],
      recents: [],
      hidden: ['provider-hidden'],
      order: [],
    });
    expect(deviceSettingsStore.get('theme')).toBe('light');
  });

  test('resetModelPickerPreferencesCacheForTests is a harmless no-op (envelope has no separate read cache)', async () => {
    const {
      readModelPickerPreferences,
      resetModelPickerPreferencesCacheForTests,
      updateModelPickerPreferences,
    } = await freshModelPickerPreferences();

    updateModelPickerPreferences((current) => ({
      ...current,
      favorites: ['x'],
    }));
    resetModelPickerPreferencesCacheForTests();
    expect(readModelPickerPreferences().favorites).toEqual(['x']);
  });
});
