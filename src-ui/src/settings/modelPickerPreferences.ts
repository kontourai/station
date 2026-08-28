/**
 * archive#settings-revamp (archive#1359 store convergence, /
 * archive#1272): model-picker preferences now live in the registry-driven
 * device-settings envelope (`deviceSettingsStore`, `modelPickerPreferences`
 * -- packages/contracts/src/device-settings.ts) instead of the parallel
 * `station.device-settings` root archive#1359 shipped. Every exported function's
 * signature is unchanged from that era so consumers need no changes.
 */
import { useSyncExternalStore } from 'react';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { DEVICE_SETTINGS_EVENT } from './shortcutPreferences';

export type ModelPickerPreferences = {
  favorites: string[];
  recents: string[];
  hidden: string[];
  order: string[];
};

const EMPTY_PREFERENCES: ModelPickerPreferences = {
  favorites: [],
  recents: [],
  hidden: [],
  order: [],
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0,
      ),
    ),
  ];
}

function normalize(
  preferences: ModelPickerPreferences,
): ModelPickerPreferences {
  return {
    favorites: stringList(preferences.favorites),
    recents: stringList(preferences.recents).slice(0, 20),
    hidden: stringList(preferences.hidden),
    order: stringList(preferences.order),
  };
}

const PREFERENCE_KEY_SEPARATOR = String.fromCharCode(31);

export function modelPreferenceKey(
  providerId: string,
  modelId: string,
): string {
  return providerId + PREFERENCE_KEY_SEPARATOR + modelId;
}

export function readModelPickerPreferences(): ModelPickerPreferences {
  if (typeof window === 'undefined') return EMPTY_PREFERENCES;
  return deviceSettingsStore.get('modelPickerPreferences');
}

export function updateModelPickerPreferences(
  update: (current: ModelPickerPreferences) => ModelPickerPreferences,
): void {
  if (typeof window === 'undefined') return;
  const current = readModelPickerPreferences();
  const next = normalize(update(current));
  deviceSettingsStore.set('modelPickerPreferences', next);
}

function subscribe(listener: () => void) {
  window.addEventListener(DEVICE_SETTINGS_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(DEVICE_SETTINGS_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useModelPickerPreferences(): ModelPickerPreferences {
  return useSyncExternalStore(
    subscribe,
    readModelPickerPreferences,
    () => EMPTY_PREFERENCES,
  );
}

/**
 * Test-only reset. The pre-convergence version reset a module-local read
* cache that made a plain `localStorage.clear` in a test's `beforeEach`
 * sufficient for isolation. The envelope-backed store is a module
 * singleton whose in-memory snapshot does NOT automatically resync just
 * because a test cleared storage out from under it (device-settings-store.ts's
 * own doc comment on `reloadFromStorage` names exactly this hazard) — this
* now delegates to that method so existing test call sites (`beforeEach(
* => { localStorage.clear; resetModelPickerPreferencesCacheForTests;
 * })`) keep working without every consumer test needing its own import of
 * `deviceSettingsStore`.
 */
export function resetModelPickerPreferencesCacheForTests(): void {
  deviceSettingsStore.reloadFromStorage();
}
