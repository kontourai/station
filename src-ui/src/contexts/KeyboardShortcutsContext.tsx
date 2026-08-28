import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  DEVICE_SETTINGS_EVENT,
  readShortcutOverrides,
  readSkillShortcuts,
  type ShortcutBinding,
  type ShortcutModifier,
  writeShortcutOverrides,
  writeSkillShortcuts,
} from '../settings/shortcutPreferences';

export interface KeyboardShortcut {
  id: string;
  key: string;
  modifiers: ShortcutModifier[];
  description: string;
  handler: () => void;
  /** Higher-priority shortcuts own the key before route-level fallbacks. */
  priority?: number;
  when?: ShortcutWhen;
  disabled?: boolean;
}

/** Add a registered shortcut's current chord without changing unbound labels. */
export function withShortcutHint(
  label: string,
  id: string,
  getDisplay: (id: string) => string,
): string {
  const display = getDisplay(id);
  return display && display !== 'Not set' ? `${label} (${display})` : label;
}

export type ShortcutContextKey =
  | 'composerFocused'
  | 'terminalFocused'
  | 'dialogOpen'
  | 'dockFocused';
export type ShortcutWhen =
  | ShortcutContextKey
  | { not: ShortcutWhen }
  | { and: ShortcutWhen[] }
  | { or: ShortcutWhen[] };

const shortcutContexts = new Map<ShortcutContextKey, boolean>();
const warnedWhenDepths = new Set<number>();

export function setShortcutContext(key: ShortcutContextKey, value: boolean) {
  shortcutContexts.set(key, value);
}

/**
 * "A modal dialog is open" — DERIVED from the document, never claimed.
 *
 * archive#3767: this used to be a claim (`acquireShortcutContext('dialogOpen')`)
 * that exactly one component in the app ever made, `ResponsiveDialogSurface`.
 * Every other modal surface — the command launcher, the shortcuts cheatsheet,
 * the command palette, the delegation launcher, the mobile task switcher — is
 * `role="dialog" aria-modal="true"` with its own overlay and focus trap, and
 * none of them knew to claim it. So the app's global chords stayed live
 * underneath them: the dock-toggle chord typed into the launcher's own input
 * collapsed the dock behind it, and Escape on the cheatsheet ALSO ran the
 * route-level "go up one level" fallback (archive#3759).
 *
 * A label a surface must remember to set is a label that some surface will
 * forget. `aria-modal="true"` is the same fact, already in the DOM, already
 * required for the surface to be a modal at all, and it cannot drift from
 * what is rendered. `components/notifications/BannerHost.tsx` reached the
 * same conclusion independently for its own Escape handling; it reads this
 * helper now rather than re-querying, so the shell has one answer.
 *
 * Not "is anything focus-trapped": a non-modal popover (`aria-modal="false"`,
 * e.g. `first-run/Coachmark.tsx`) annotates the page and deliberately leaves
 * the shortcuts live.
 */
export function isModalDialogOpen(ownerDocument?: Document): boolean {
  const doc =
    ownerDocument ?? (typeof document === 'undefined' ? null : document);
  return doc?.querySelector('[aria-modal="true"]') != null;
}

export function getShortcutContext(key: ShortcutContextKey): boolean {
  if (key === 'dialogOpen') return isModalDialogOpen();
  return shortcutContexts.get(key) ?? false;
}

export function evaluateShortcutWhen(
  when: ShortcutWhen,
  lookup: (key: ShortcutContextKey) => boolean = getShortcutContext,
  depth = 0,
): boolean {
  if (depth > 8) {
    if (!warnedWhenDepths.has(depth)) {
      warnedWhenDepths.add(depth);
      console.warn('Keyboard shortcut `when` expression exceeded depth 8');
    }
    return false;
  }
  if (typeof when === 'string') {
    return [
      'composerFocused',
      'terminalFocused',
      'dialogOpen',
      'dockFocused',
    ].includes(when)
      ? lookup(when as ShortcutContextKey)
      : false;
  }
  if ('not' in when) return !evaluateShortcutWhen(when.not, lookup, depth + 1);
  // Boolean-algebra identities make an empty conjunction true and an empty
  // disjunction false, while keeping generated expressions composable.
  if ('and' in when)
    return when.and.every((item) =>
      evaluateShortcutWhen(item, lookup, depth + 1),
    );
  return when.or.some((item) => evaluateShortcutWhen(item, lookup, depth + 1));
}

function areDirectComplements(left?: ShortcutWhen, right?: ShortcutWhen) {
  return (
    (typeof left === 'string' &&
      !!right &&
      typeof right === 'object' &&
      'not' in right &&
      right.not === left) ||
    (typeof right === 'string' &&
      !!left &&
      typeof left === 'object' &&
      'not' in left &&
      left.not === right)
  );
}

/**
 * The registry as a subscribable store, not as React state.
 *
 * `register` used to bump a `registryRevision` state on the provider, which
 * rebuilt the context value and re-rendered EVERY consumer of this context.
 * Any consumer whose registering effect depended on a callback identity then
 * registered again on that render, and the two fed each other: React error
 * archive#185 (maximum update depth), which took out every route the moment the
 * first command-enabled skill existed (archive#3736). Writes now go to a ref
 * and are published through `subscribe`, so registering re-renders only the
 * surfaces that actually READ the registry — and only when what they read
 * changed.
 */
interface ShortcutRegistryStore {
  register: (shortcut: KeyboardShortcut) => () => void;
  getDisplay: (id: string) => string;
  getAllShortcuts: () => KeyboardShortcut[];
  setBinding: (id: string, binding: ShortcutBinding | null) => void;
  restoreBinding: (id: string) => void;
  isMac: boolean;
  /** Notified when the registry's OBSERVABLE content changes. */
  subscribe: (listener: () => void) => () => void;
  /** Content signature of the registry; stable while nothing observable moved. */
  getSignature: () => string;
}

/**
 * The registry's complete OBSERVABLE identity — everything a reader can see.
 *
 * Three things belong in it that a first cut left out :
 *
 *  - registration ORDER, because equal-priority dispatch resolves by it and
 * `getAllShortcuts` returns it. Sorting it away meant two registrations
 *    could swap which one fires and no reader was told;
 * - a per-registration TOKEN, because `getAllShortcuts` hands readers the
 *    HANDLERS. Two registrations under one id with identical metadata and
 *    different handlers replace the map entry silently, so an open command
 *    palette kept invoking the action the keyboard had already stopped
 *    invoking. Handlers cannot be compared, so what is compared is the write:
 *    every `register` call gets a number, and re-registering changes it;
 *  - a JSON encoding, because the previous NUL/SOH joins were not injective —
 *    a control character inside a description could forge a boundary.
 *
 * Re-registration therefore publishes. That is the point, and it does not
 * re-open archive#3736: the loop needed registration to re-render a component
 * that then registers again, and only READERS re-render now — while
 * `useKeyboardShortcut`'s deps are stable, so a reader's re-render does not
 * re-register.
 */
function registrySignature(
  entries: Iterable<[KeyboardShortcut, number]>,
): string {
  return JSON.stringify(
    Array.from(entries, ([shortcut, token]) => [
      shortcut.id,
      shortcut.key,
      [...shortcut.modifiers],
      shortcut.description,
      shortcut.disabled === true,
      shortcut.priority ?? 0,
      shortcut.when ?? null,
      token,
    ]),
  );
}

const KeyboardShortcutsContext = createContext<
  ShortcutRegistryStore | undefined
>(undefined);

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().indexOf('MAC') >= 0;

export function orderShortcuts(
  shortcuts: Iterable<KeyboardShortcut>,
): KeyboardShortcut[] {
  return Array.from(shortcuts).sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
  );
}

/**
 * Two live shortcuts claiming one chord. Today `priority` arbitrates
 * silently, so the loser simply never fires and nothing says why — the
 * settings surface and cheatsheet can now say it (archive#2576). A disabled
 * shortcut does not conflict; a priority TIE on a shared chord is the
 * ambiguous case worth shouting about, and a decided priority is still worth
 * listing so the loser's silence is explicable.
 */
export interface ShortcutConflict {
  chord: string;
  shortcuts: KeyboardShortcut[];
  /** True when priorities tie, so which one fires is registration order. */
  ambiguous: boolean;
}

export function findShortcutConflicts(
  shortcuts: Iterable<KeyboardShortcut>,
): ShortcutConflict[] {
  const byChord = new Map<string, KeyboardShortcut[]>();
  for (const shortcut of shortcuts) {
    if (shortcut.disabled) continue;
    const chord = [
      ...[...shortcut.modifiers].sort(),
      shortcut.key.toLowerCase(),
    ].join('+');
    const bucket = byChord.get(chord);
    if (bucket) bucket.push(shortcut);
    else byChord.set(chord, [shortcut]);
  }
  const conflicts: ShortcutConflict[] = [];
  for (const [chord, bucket] of byChord) {
    if (bucket.length < 2) continue;
    const top = Math.max(...bucket.map((s) => s.priority ?? 0));
    const topShortcuts = bucket.filter((s) => (s.priority ?? 0) === top);
    const ambiguous =
      topShortcuts.length > 1 &&
      !(
        topShortcuts.length === 2 &&
        areDirectComplements(topShortcuts[0].when, topShortcuts[1].when)
      );
    conflicts.push({ chord, shortcuts: orderShortcuts(bucket), ambiguous });
  }
  return conflicts.sort((a, b) => a.chord.localeCompare(b.chord));
}

/**
 * The one predicate the live dispatch loop consults before firing a shortcut.
 *
 * archive#3767: this was exported, documented as the guard, and called by
 * nothing but its own unit test since archive#2579 replaced it in the dispatcher
 * with a `dialogOpen` claim plus an Escape-only variant. A test measuring a
 * predicate the product does not run is not coverage, and the modal hole it
 * was still asserting had been open ever since. It is the live path again.
 */
export function shouldIgnoreShortcut(
  shortcut: KeyboardShortcut,
  event: KeyboardEvent,
): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  const targetElement = target instanceof Element ? target : null;
  const ownerDocument = targetElement?.ownerDocument ?? document;
  if (isModalDialogOpen(ownerDocument)) return true;
  if (shortcut.key.toLowerCase() === 'escape') {
    if (ownerDocument.querySelector('[data-escape-owner]')) return true;
    return Boolean(
      targetElement?.matches(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [data-escape-owner]',
      ) || targetElement?.closest('[data-escape-owner]'),
    );
  }
  if (!shortcut.id.startsWith('dock.')) return false;
  return Boolean(
    targetElement?.matches(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
    ),
  );
}

export function KeyboardShortcutsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const shortcutsRef = useRef(new Map<string, KeyboardShortcut>());
  const [overrides, setOverrides] = useState(readShortcutOverrides);
  const [skillOverrides, setSkillOverrides] = useState(readSkillShortcuts);
  const overridesRef = useRef(overrides);
  const skillOverridesRef = useRef(skillOverrides);
  const listenersRef = useRef(new Set<() => void>());
  const signatureRef = useRef('');
  /** One number per `register` call, so replacing a handler is observable. */
  const registrationTokensRef = useRef(new Map<string, number>());
  const nextTokenRef = useRef(0);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getSignature = useCallback(() => signatureRef.current, []);

  /** Publish only a CHANGE to what a reader can observe. */
  const publish = useCallback(() => {
    const next = registrySignature(
      Array.from(shortcutsRef.current, ([id, shortcut]) => [
        shortcut,
        registrationTokensRef.current.get(id) ?? 0,
      ]),
    );
    if (next === signatureRef.current) return;
    signatureRef.current = next;
    for (const listener of listenersRef.current) listener();
  }, []);

  const register = useCallback(
    (shortcut: KeyboardShortcut) => {
      nextTokenRef.current += 1;
      const token = nextTokenRef.current;
      shortcutsRef.current.set(shortcut.id, shortcut);
      registrationTokensRef.current.set(shortcut.id, token);
      publish();
      return () => {
        // Only the registration that is still live may retract itself: a
        // later `register` under the same id has already replaced it.
        if (shortcutsRef.current.get(shortcut.id) !== shortcut) return;
        shortcutsRef.current.delete(shortcut.id);
        registrationTokensRef.current.delete(shortcut.id);
        publish();
      };
    },
    [publish],
  );

  const resolveShortcut = useCallback(
    (shortcut: KeyboardShortcut): KeyboardShortcut => {
      const source = shortcut.id.startsWith('skill.')
        ? skillOverrides
        : overrides;
      const sourceKey = shortcut.id.startsWith('skill.')
        ? shortcut.id.slice('skill.'.length, -'.run'.length)
        : shortcut.id;
      if (!Object.hasOwn(source, sourceKey)) {
        return shortcut;
      }
      const override = source[sourceKey];
      if (override === null) {
        return { ...shortcut, disabled: true };
      }
      return {
        ...shortcut,
        ...override,
        disabled: false,
      };
    },
    [overrides, skillOverrides],
  );

  const getDisplay = useCallback(
    (id: string) => {
      const registered = shortcutsRef.current.get(id);
      if (!registered) return '';
      const shortcut = resolveShortcut(registered);
      if (shortcut.disabled) return 'Not set';

      const modifierSymbols = shortcut.modifiers.map((mod) => {
        if (mod === 'cmd') return isMac ? '⌘' : 'Ctrl+';
        if (mod === 'ctrl') return isMac ? '⌃' : 'Ctrl+';
        if (mod === 'shift') return isMac ? '⇧' : 'Shift+';
        if (mod === 'alt') return isMac ? '⌥' : 'Alt+';
        return '';
      });

      return modifierSymbols.join('') + shortcut.key.toUpperCase();
    },
    [resolveShortcut],
  );

  const getAllShortcuts = useCallback(
    () =>
      Array.from(shortcutsRef.current.values()).map((shortcut) =>
        resolveShortcut(shortcut),
      ),
    [resolveShortcut],
  );

  const setBinding = useCallback(
    (id: string, binding: ShortcutBinding | null) => {
      if (id.startsWith('skill.')) {
        const slug = id.slice('skill.'.length, -'.run'.length);
        const next = { ...skillOverridesRef.current, [slug]: binding };
        skillOverridesRef.current = next;
        writeSkillShortcuts(next);
        setSkillOverrides(next);
        return;
      }
      const next = { ...overridesRef.current, [id]: binding };
      overridesRef.current = next;
      writeShortcutOverrides(next);
      setOverrides(next);
    },
    [],
  );

  const restoreBinding = useCallback((id: string) => {
    if (id.startsWith('skill.')) {
      const slug = id.slice('skill.'.length, -'.run'.length);
      const next = { ...skillOverridesRef.current };
      delete next[slug];
      skillOverridesRef.current = next;
      writeSkillShortcuts(next);
      setSkillOverrides(next);
      return;
    }
    const next = { ...overridesRef.current };
    delete next[id];
    overridesRef.current = next;
    writeShortcutOverrides(next);
    setOverrides(next);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = readShortcutOverrides();
      const nextSkills = readSkillShortcuts();
      overridesRef.current = next;
      setOverrides(next);
      skillOverridesRef.current = nextSkills;
      setSkillOverrides(nextSkills);
    };
    window.addEventListener(DEVICE_SETTINGS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(DEVICE_SETTINGS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const shortcuts = orderShortcuts(shortcutsRef.current.values());
      for (const registered of shortcuts) {
        const shortcut = resolveShortcut(registered);
        if (shortcut.disabled) continue;
        if (shortcut.when && !evaluateShortcutWhen(shortcut.when)) continue;
        if (shouldIgnoreShortcut(shortcut, e)) continue;
        const hasPrimary = shortcut.modifiers.includes('cmd');
        const hasControl = shortcut.modifiers.includes('ctrl');
        const hasShift = shortcut.modifiers.includes('shift');
        const hasAlt = shortcut.modifiers.includes('alt');

        const metaMatch = e.metaKey === (isMac && hasPrimary);
        const ctrlMatch = e.ctrlKey === (hasControl || (!isMac && hasPrimary));
        const shiftMatch = hasShift === e.shiftKey;
        const altMatch = hasAlt === e.altKey;
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();

        if (metaMatch && ctrlMatch && shiftMatch && altMatch && keyMatch) {
          e.preventDefault();
          shortcut.handler();
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [resolveShortcut]);

  const store = useMemo<ShortcutRegistryStore>(
    () => ({
      register,
      getDisplay,
      getAllShortcuts,
      setBinding,
      restoreBinding,
      isMac,
      subscribe,
      getSignature,
    }),
    [
      register,
      getDisplay,
      getAllShortcuts,
      setBinding,
      restoreBinding,
      subscribe,
      getSignature,
    ],
  );

  return (
    <KeyboardShortcutsContext.Provider value={store}>
      {children}
    </KeyboardShortcutsContext.Provider>
  );
}

function useShortcutStore(): ShortcutRegistryStore {
  const context = useContext(KeyboardShortcutsContext);
  if (!context) {
    throw new Error(
      'useKeyboardShortcuts must be used within KeyboardShortcutsProvider',
    );
  }
  return context;
}

/**
 * For REGISTERING and for binding changes. Deliberately does not expose the
 * registry's contents: a component that reads them without subscribing goes
 * stale the moment another surface registers, and a component that re-renders
 * on every registration is what archive#3736 was.
 */
export function useKeyboardShortcuts(): Omit<
  ShortcutRegistryStore,
  'getDisplay' | 'getAllShortcuts' | 'subscribe' | 'getSignature'
> {
  return useShortcutStore();
}

/**
 * For READING the registry — the cheatsheet, the palette, the settings list,
 * and any label that carries a chord. Subscribes, so it re-renders when the
 * registry's content changes and never when it merely gets rewritten.
 */
export function useShortcutRegistry(): Omit<
  ShortcutRegistryStore,
  'subscribe' | 'getSignature'
> {
  const store = useShortcutStore();
  useSyncExternalStore(store.subscribe, store.getSignature, store.getSignature);
  return store;
}
