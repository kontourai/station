/**
 * archive#settings-revamp (archive#1359 store convergence, /
 * archive#1272): keyboard-shortcut overrides now live in the registry-driven
 * device-settings envelope (`deviceSettingsStore`, `shortcutOverrides` —
 * `packages/contracts/src/device-settings.ts`) instead of the parallel
 * `station.device-settings` root archive#1359 shipped. Every exported function's
 * signature is unchanged from that era so consumers
 * (`KeyboardShortcutsContext.tsx`) need no changes.
 */
import { deviceSettingsStore } from '../lib/device-settings-store';

/**
 * Legacy compat window-event name — `deviceSettingsStore` itself dispatches
 * this on every mutation (see its `notify`), so consumers that still
 * `window.addEventListener(DEVICE_SETTINGS_EVENT, …)` (rather than the
 * store's own `subscribe`) keep working unchanged.
 */
export const DEVICE_SETTINGS_EVENT = 'station-device-settings-changed';

export type ShortcutModifier = 'cmd' | 'ctrl' | 'shift' | 'alt';

export interface ShortcutBinding {
  key: string;
  modifiers: ShortcutModifier[];
}

export type ShortcutOverrides = Record<string, ShortcutBinding | null>;

export function readShortcutOverrides(): ShortcutOverrides {
  return deviceSettingsStore.get('shortcutOverrides');
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

export function bindingSignature(binding: ShortcutBinding): string {
  return `${[...binding.modifiers].sort().join('+')}|${binding.key.toLowerCase()}`;
}

export function browserReservedReason(binding: ShortcutBinding): string | null {
  if (!binding.modifiers.includes('cmd')) return null;
  const key = binding.key.toLowerCase();
  if (['l', 'r', 't', 'w'].includes(key)) {
    return 'Your browser may use this shortcut before Station can.';
  }
  if (key === 'n') {
    return 'Browsers usually reserve this shortcut for a new window.';
  }
  return null;
}
