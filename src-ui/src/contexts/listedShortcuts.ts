import {
  effectiveChordSignature,
  type KeyboardShortcut,
} from './KeyboardShortcutsContext';

// Only the shortcut list surfaces (the cheatsheet and Settings) read this, so
// it lives outside the always-loaded shortcut context to keep it off the
// entry bundle.
/**
 * The shortcuts a list should show. A lower-priority fallback that does the
 * same named thing on the same chord as a live higher-priority shortcut can
 * never fire while that one is registered — Settings' own Escape and the
 * route-level "Go up one level" fallback — so listing both reads as the same
 * command twice (#4383). It reappears the moment the owner is rebound,
 * cleared or unmounted, because then it is reachable again.
 */
export function listedShortcuts(
  shortcuts: Iterable<KeyboardShortcut>,
): KeyboardShortcut[] {
  const all = Array.from(shortcuts);
  return all.filter(
    (shortcut) =>
      shortcut.disabled ||
      !all.some(
        (other) =>
          other !== shortcut &&
          !other.disabled &&
          other.description === shortcut.description &&
          (other.priority ?? 0) > (shortcut.priority ?? 0) &&
          effectiveChordSignature(other) === effectiveChordSignature(shortcut),
      ),
  );
}
