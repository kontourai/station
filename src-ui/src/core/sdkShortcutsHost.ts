import type {
  SDKShortcut,
  SDKShortcutRegistration,
  SDKShortcutsContext,
  SDKShortcutWhen,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import {
  activateShortcutScope,
  type KeyboardShortcut,
  PLUGIN_SHORTCUT_ID_PREFIX,
  SHORTCUT_CONTEXT_KEYS,
  type ShortcutWhen,
  useOptionalKeyboardShortcuts,
} from '../contexts/KeyboardShortcutsContext';

const LOCAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODIFIERS = new Set(['cmd', 'ctrl', 'shift', 'alt']);

/**
 * The owner segment of a plugin shortcut id. Dots would let one owner forge
 * another's prefix (`a.b` + `c` vs `a` + `b.c`), so anything outside a
 * package-name alphabet becomes `-`.
 */
function ownerSegment(owner: string): string {
  return owner.replace(/[^A-Za-z0-9@/_-]/g, '-') || 'plugin';
}

type Translated = { ok: true; when: ShortcutWhen } | { ok: false; at: string };

/**
 * A plugin's `when` in the registry's vocabulary: host context keys pass
 * through (read-only); every other name is this owner's scope.
 */
function translateWhen(when: SDKShortcutWhen, owner: string): Translated {
  if (typeof when === 'string') {
    if ((SHORTCUT_CONTEXT_KEYS as readonly string[]).includes(when))
      return { ok: true, when: when as ShortcutWhen };
    if (!LOCAL_NAME.test(when)) return { ok: false, at: when };
    return { ok: true, when: `scope:${owner}/${when}` };
  }
  if (!when || typeof when !== 'object') return { ok: false, at: String(when) };
  if ('not' in when) {
    const inner = translateWhen(when.not, owner);
    return inner.ok ? { ok: true, when: { not: inner.when } } : inner;
  }
  const list = 'and' in when ? when.and : 'or' in when ? when.or : null;
  if (!Array.isArray(list)) return { ok: false, at: JSON.stringify(when) };
  const items: ShortcutWhen[] = [];
  for (const item of list) {
    const inner = translateWhen(item, owner);
    if (!inner.ok) return inner;
    items.push(inner.when);
  }
  return { ok: true, when: 'and' in when ? { and: items } : { or: items } };
}

/**
 * The SDK's `shortcuts` slot, bound to one plugin owner. Plugin shortcuts join
 * the kernel registry (so the shortcut list, Settings and modal suppression
 * treat them like built-ins) under `plugin.<owner>.<id>`, which no kernel id
 * uses, at priority 0: kernel view shortcuts (priority 100) keep their keys,
 * route-level fallbacks (below 0) yield, and reserved kernel chords are
 * refused here and skipped by the dispatcher. Undefined outside the shortcut
 * provider, so the SDK reports the slot unavailable.
 */
export function useSDKShortcutsHost(
  owner: string,
): SDKShortcutsContext | undefined {
  const registry = useOptionalKeyboardShortcuts();
  return useMemo(() => {
    if (!registry) return undefined;
    const segment = ownerSegment(owner);

    const check = (
      shortcut: Omit<SDKShortcut, 'run'>,
    ):
      | { registration: SDKShortcutRegistration & { ok: false } }
      | {
          registration: SDKShortcutRegistration & { ok: true };
          when?: ShortcutWhen;
        } => {
      if (typeof shortcut.id !== 'string' || !LOCAL_NAME.test(shortcut.id))
        return {
          registration: {
            ok: false,
            reason: 'invalid-id',
            message:
              'A shortcut id is 1-64 letters, digits, "-" or "_", starting with a letter or digit.',
          },
        };
      const keys = shortcut.keys;
      if (
        !keys ||
        typeof keys.key !== 'string' ||
        !keys.key.trim() ||
        !Array.isArray(keys.modifiers) ||
        keys.modifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
        new Set(keys.modifiers).size !== keys.modifiers.length
      )
        return {
          registration: {
            ok: false,
            reason: 'invalid-keys',
            message:
              'A shortcut needs a key and distinct modifiers from cmd, ctrl, shift and alt.',
          },
        };
      let when: ShortcutWhen | undefined;
      if (shortcut.when !== undefined) {
        const translated = translateWhen(shortcut.when, segment);
        if (!translated.ok)
          return {
            registration: {
              ok: false,
              reason: 'invalid-when',
              message: `"${translated.at}" is neither a host context key nor a valid scope name.`,
            },
          };
        when = translated.when;
      }
      const conflict = registry.findReservedConflict(keys);
      if (conflict)
        return {
          registration: {
            ok: false,
            reason: 'reserved',
            message: `This chord belongs to Station's "${conflict.id}" shortcut, which plugins cannot override.`,
          },
        };
      return {
        registration: {
          ok: true,
          registryId: `${PLUGIN_SHORTCUT_ID_PREFIX}${segment}.${shortcut.id}`,
        },
        ...(when === undefined ? {} : { when }),
      };
    };

    return {
      validate: (shortcut) => check(shortcut).registration,
      register: (shortcut) => {
        const checked = check(shortcut);
        if (!checked.registration.ok) return () => {};
        const entry: KeyboardShortcut = {
          id: checked.registration.registryId,
          key: shortcut.keys.key,
          modifiers: [...shortcut.keys.modifiers],
          description: shortcut.description,
          handler: () => shortcut.run(),
          priority: 0,
          ...('when' in checked && checked.when !== undefined
            ? { when: checked.when }
            : {}),
        };
        return registry.register(entry);
      },
      activateScope: (name) => {
        if (
          !LOCAL_NAME.test(name) ||
          (SHORTCUT_CONTEXT_KEYS as readonly string[]).includes(name)
        )
          throw new Error(
            `"${name}" is not a valid shortcut scope name (1-64 letters, digits, "-" or "_", and not a host context key).`,
          );
        return activateShortcutScope(`scope:${segment}/${name}`);
      },
    };
  }, [registry, owner]);
}
