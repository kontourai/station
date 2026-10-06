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
  /**
   * Returns `false` when it had nothing to do, so the key is left alone —
   * not prevented, and offered to the next matching shortcut and then to the
   * browser (e.g. its own Back). Any other return consumes the key.
   */
  handler: () => void | boolean;
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
 * Derive modal state from rendered aria-modal="true" surfaces. A context flag
 * previously missed custom modals and let global shortcuts fire beneath them
 * (archive#3767, archive#3759). Non-modal popovers leave shortcuts active.
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
 * Publish registry changes to subscribed readers without re-rendering registering
 * components. Provider-state updates previously caused a registration/render
 * loop and React maximum-depth failure (archive#3736).
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
 * Include registration order and identity: priority ties depend on order, and a
 * replaced handler must invalidate readers even when metadata is unchanged.
 * JSON encoding preserves boundaries that control characters could forge in a
 * delimiter-joined signature. Stable registering hooks avoid the archive#3736 loop.
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

/**
 * Use the viewer's platform spelling for chords (#1649); consumers must not
 * advertise a Mac-only Command key on other platforms.
 */
export function formatShortcutChord(
  modifiers: readonly ShortcutModifier[],
  key: string,
  mac: boolean = isMac,
): string {
  const symbols = modifiers.map((modifier) => {
    if (modifier === 'cmd') return mac ? '⌘' : 'Ctrl+';
    if (modifier === 'ctrl') return mac ? '⌃' : 'Ctrl+';
    if (modifier === 'shift') return mac ? '⇧' : 'Shift+';
    if (modifier === 'alt') return mac ? '⌥' : 'Alt+';
    return '';
  });
  return symbols.join('') + key.toUpperCase();
}

export function orderShortcuts(
  shortcuts: Iterable<KeyboardShortcut>,
): KeyboardShortcut[] {
  return Array.from(shortcuts).sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
  );
}

/**
 * Enabled shortcuts sharing a chord, including lower-priority entries whose
 * suppression should remain explainable (archive#2576).
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
 * The live dispatcher must call this modal/input guard. An earlier replacement
 * left it tested but unused, reopening the modal leak (archive#3767, archive#2579).
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

      return formatShortcutChord(shortcut.modifiers, shortcut.key);
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
          if (shortcut.handler() === false) continue;
          e.preventDefault();
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
 * Registration/binding actions without a registry subscription. Reading here
 * would go stale; subscribing registering components caused archive#3736.
 */
export function useKeyboardShortcuts(): Omit<
  ShortcutRegistryStore,
  'getDisplay' | 'getAllShortcuts' | 'subscribe' | 'getSignature'
> {
  return useShortcutStore();
}

/** Subscribe to registry content and registration identity for displayed commands. */
export function useShortcutRegistry(): Omit<
  ShortcutRegistryStore,
  'subscribe' | 'getSignature'
> {
  const store = useShortcutStore();
  useSyncExternalStore(store.subscribe, store.getSignature, store.getSignature);
  return store;
}
