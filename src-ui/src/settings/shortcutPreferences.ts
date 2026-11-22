/**
 * archive#settings-revamp (archive#1359 store convergence, /
 * archive#1272): keyboard-shortcut overrides now live in the registry-driven
 * device-settings envelope (`deviceSettingsStore`, `shortcutOverrides` —
 * `packages/contracts/src/device-settings.ts`) instead of the parallel
 * `station.device-settings` root archive#1359 shipped. Every exported function's
 * signature is unchanged from that era so consumers
 * (`KeyboardShortcutsContext.tsx`) need no changes.
 */
import type {
  ShortcutBinding,
  ShortcutModifier,
} from '@kontourai/station-contracts/device-settings';
import { deviceSettingsStore } from '../lib/device-settings-store';

/**
 * Legacy compat window-event name — `deviceSettingsStore` itself dispatches
 * this on every mutation (see its `notify`), so consumers that still
 * `window.addEventListener(DEVICE_SETTINGS_EVENT, …)` (rather than the
 * store's own `subscribe`) keep working unchanged.
 */
export const DEVICE_SETTINGS_EVENT = 'station-device-settings-changed';

export type { ShortcutBinding, ShortcutModifier };

export type ShortcutOverrides = Record<string, ShortcutBinding | null>;

/**
 * Retired command ids whose saved binding now belongs to the command that
 * replaced them. #5397 folded "Undo inbox dismissal" into "Undo last action",
 * so a key the person chose for the first carries over to the second, unless
 * they already chose one for it. A retired command that was turned off
 * (`null`) carries nothing: turning off the inbox Undo never meant turning
 * off every Undo. Read-time only; the next binding the person saves writes
 * the carried map back.
 */
const RETIRED_SHORTCUT_IDS: Readonly<Record<string, string>> = {
  'inbox.undoDismiss': 'app.undoLastAction',
};

export function readShortcutOverrides(): ShortcutOverrides {
  const stored = deviceSettingsStore.get('shortcutOverrides');
  let overrides = stored;
  for (const [retired, successor] of Object.entries(RETIRED_SHORTCUT_IDS)) {
    if (!Object.hasOwn(overrides, retired)) continue;
    const { [retired]: binding, ...rest } = overrides;
    overrides =
      binding && !Object.hasOwn(rest, successor)
        ? { ...rest, [successor]: binding }
        : rest;
  }
  return overrides;
}

export function writeShortcutOverrides(overrides: ShortcutOverrides) {
  if (typeof window === 'undefined') return;
  deviceSettingsStore.set('shortcutOverrides', overrides);
}

export function readSkillShortcuts(): ShortcutOverrides {
  return deviceSettingsStore.get('skillShortcuts');
}

export function writeSkillShortcuts(overrides: ShortcutOverrides) {
  if (typeof window === 'undefined') return;
  deviceSettingsStore.set('skillShortcuts', overrides);
}

export function normalizeShortcutKey(key: string): string {
  return key === ' ' ? 'space' : key.toLowerCase();
}

export function browserReservedReason(binding: ShortcutBinding): string | null {
  if (!binding.modifiers.includes('cmd')) return null;
  const key = binding.key.toLowerCase();
  // #4383: History (H), Open file (O) and Bookmark (D) are browser chords too.
  if (['d', 'h', 'l', 'o', 'r', 't', 'w'].includes(key)) {
    return 'Your browser may use this shortcut before Station can.';
  }
  if (key === 'n') {
    return 'Browsers usually reserve this shortcut for a new window.';
  }
  return null;
}
