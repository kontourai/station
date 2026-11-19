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
  normalizeShortcutKey,
  readShortcutOverrides,
  readSkillShortcuts,
  type ShortcutBinding,
  type ShortcutModifier,
  writeShortcutOverrides,
  writeSkillShortcuts,
} from '../settings/shortcutPreferences';
import {
  EDITING_RESERVED_CHORDS,
  KERNEL_RESERVED_SHORTCUTS,
} from './kernelReservedShortcuts';

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
  | 'browserFocused'
  | 'dialogOpen'
  | 'dockFocused';
export const SHORTCUT_CONTEXT_KEYS: readonly ShortcutContextKey[] = [
  'composerFocused',
  'terminalFocused',
  'browserFocused',
  'dialogOpen',
  'dockFocused',
];
/**
 * A scope a plugin turns on with the SDK's `useShortcutScope`. The host writes
 * the owner into the key (`scope:<owner>/<name>`), so one plugin's scope can
 * never satisfy another's `when`, and none can set a kernel context key.
 */
type ShortcutScopeKey = `scope:${string}`;
export type ShortcutWhen =
  | ShortcutContextKey
  | ShortcutScopeKey
  | { not: ShortcutWhen }
  | { and: ShortcutWhen[] }
  | { or: ShortcutWhen[] };

const shortcutContexts = new Map<ShortcutContextKey, boolean>();
/** Active-mount count per scope: two mounts of one scope stay on until both go. */
const shortcutScopes = new Map<ShortcutScopeKey, number>();
const warnedWhenDepths = new Set<number>();

export function setShortcutContext(key: ShortcutContextKey, value: boolean) {
  shortcutContexts.set(key, value);
}

/** Turn a scope on; the returned function turns this activation off once. */
export function activateShortcutScope(key: ShortcutScopeKey): () => void {
  shortcutScopes.set(key, (shortcutScopes.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (shortcutScopes.get(key) ?? 1) - 1;
    if (next > 0) shortcutScopes.set(key, next);
    else shortcutScopes.delete(key);
  };
}

/** Prefix of every shortcut id a plugin registers through the SDK. */
export const PLUGIN_SHORTCUT_ID_PREFIX = 'plugin.';

function isPluginShortcutId(id: string): boolean {
  return id.startsWith(PLUGIN_SHORTCUT_ID_PREFIX);
}

function skillShortcutName(id: string): string | undefined {
  if (id.startsWith('skill.')) return id.slice('skill.'.length, -'.run'.length);
}

const RESERVED_SHORTCUT_IDS: ReadonlySet<string> = new Set(
  Object.values(KERNEL_RESERVED_SHORTCUTS).map((entry) => entry.id),
);

/**
 * The physical chord a binding fires on this platform: off a Mac, `cmd` IS
 * Control (see the dispatcher), so `cmd+k` and `ctrl+k` are one chord there.
 */
export function effectiveChordSignature(
  binding: { key: string; modifiers: readonly ShortcutModifier[] },
  mac: boolean = isMac,
): string {
  const modifiers = new Set(
    binding.modifiers.map((modifier) =>
      !mac && modifier === 'cmd' ? 'ctrl' : modifier,
    ),
  );
  return `${[...modifiers].sort().join('+')}|${normalizeShortcutKey(binding.key)}`;
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
    if (when.startsWith('scope:'))
      return (shortcutScopes.get(when as ShortcutScopeKey) ?? 0) > 0;
    return (SHORTCUT_CONTEXT_KEYS as readonly string[]).includes(when)
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
  /**
   * The reserved kernel shortcut a binding would collide with, or null. Reads
   * the live registry without subscribing to it (archive#3736).
   */
  findReservedConflict: (binding: {
    key: string;
    modifiers: readonly ShortcutModifier[];
  }) => { id: string } | null;
  getDisplay: (id: string) => string;
  getAllShortcuts: () => KeyboardShortcut[];
  getDefaultBinding: (id: string) => ShortcutBinding | null;
  setBinding: (id: string, binding: ShortcutBinding | null) => void;
  restoreBinding: (id: string) => void;
  isMac: boolean;
  /** Notified when the registry's OBSERVABLE content changes. */
  subscribe: (listener: () => void) => () => void;
  /** Advances only when a registration is added, replaced, or removed. */
  getVersion: () => number;
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
  return symbols.join('') + formatShortcutKey(key);
}

/**
 * Named keys keep their keycap spelling (`Esc`, `Enter`) rather than the
 * `KeyboardEvent.key` name shouted in capitals (#4383: `ESCAPE` beside
 * `Ctrl+K`). Single characters stay upper-case.
 */
const NAMED_KEY_LABELS: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  home: 'Home',
  end: 'End',
};

function formatShortcutKey(key: string): string {
  const named = NAMED_KEY_LABELS[normalizeShortcutKey(key)];
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  // F-keys and other named keys: first letter capitalised, as typed (`F5`).
  return key.charAt(0).toUpperCase() + key.slice(1);
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
    if (shortcut.disabled || !shortcut.key) continue;
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

const TEXT_ENTRY_SELECTOR =
  'textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
/** `<input>` types that hold no editable text: Cut/Copy/Undo mean nothing there. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isTextEntryTarget(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return element.matches(TEXT_ENTRY_SELECTOR);
}

const EDITING_CHORD_SIGNATURES = new Map(
  EDITING_RESERVED_CHORDS.map((entry) => [
    effectiveChordSignature(entry.binding),
    entry.id,
  ]),
);

/**
 * #4383: a Station command bound to a text-editing chord (Ctrl+X close,
 * Ctrl+C cancel, a configured Ctrl+Z undo) must not take the chord from the
 * place the user is editing. Inside a text field every editing chord belongs
 * to the field; and Copy/Cut belong to any live text selection, so copying
 * transcript text never cancels a running turn.
 */
function editingChordOwnsKey(
  shortcut: KeyboardShortcut,
  targetElement: Element | null,
  ownerDocument: Document,
): boolean {
  const editingId = EDITING_CHORD_SIGNATURES.get(
    effectiveChordSignature(shortcut),
  );
  if (!editingId) return false;
  if (isTextEntryTarget(targetElement)) return true;
  if (editingId !== 'editing.copy' && editingId !== 'editing.cut') return false;
  const selection = ownerDocument.getSelection?.();
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().length > 0,
  );
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
  if (
    targetElement?.closest('[data-live-surface-keyboard]') &&
    shortcut.id !== 'browser.screenshot'
  )
    return true;
  const ownerDocument = targetElement?.ownerDocument ?? document;
  if (isModalDialogOpen(ownerDocument)) return true;
  if (editingChordOwnsKey(shortcut, targetElement, ownerDocument)) return true;
  const hasCommandModifier = shortcut.modifiers.some((m) => m !== 'shift');
  const isSpace = normalizeShortcutKey(shortcut.key) === 'space';
  if (
    !hasCommandModifier &&
    ((isSpace &&
      targetElement?.closest(
        'button,input,summary,[role=button],[role=checkbox],[role=switch]',
      )) ||
      ((isSpace || shortcut.key.length === 1) &&
        isTextEntryTarget(targetElement)))
  )
    return true;
  if (shortcut.key.toLowerCase() === 'escape') {
    if (ownerDocument.querySelector('[data-escape-owner]')) return true;
    return Boolean(
      targetElement?.matches(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [data-escape-owner]',
      ) || targetElement?.closest('[data-escape-owner]'),
    );
  }
  if (isPluginShortcutId(shortcut.id)) {
    // A plugin chord without Cmd/Ctrl/Alt is a printable key: it must not
    // swallow what the user is typing into a kernel field (the composer).
    if (hasCommandModifier) return false;
    return Boolean(
      targetElement?.matches(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
      ),
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
  const versionRef = useRef(0);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getVersion = useCallback(() => versionRef.current, []);

  const publish = useCallback(() => {
    versionRef.current += 1;
    for (const listener of listenersRef.current) listener();
  }, []);

  const register = useCallback(
    (shortcut: KeyboardShortcut) => {
      shortcutsRef.current.set(shortcut.id, shortcut);
      publish();
      return () => {
        // Only the registration that is still live may retract itself: a
        // later `register` under the same id has already replaced it.
        if (shortcutsRef.current.get(shortcut.id) !== shortcut) return;
        shortcutsRef.current.delete(shortcut.id);
        publish();
      };
    },
    [publish],
  );

  const resolveShortcut = useCallback(
    (shortcut: KeyboardShortcut): KeyboardShortcut => {
      const skill = skillShortcutName(shortcut.id);
      const source = skill === undefined ? overrides : skillOverrides;
      const sourceKey = skill ?? shortcut.id;
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

  const getDefaultBinding = useCallback(
    (id: string): ShortcutBinding | null => {
      const registered = shortcutsRef.current.get(id);
      if (!registered || registered.disabled || !registered.key) return null;
      return { key: registered.key, modifiers: [...registered.modifiers] };
    },
    [],
  );

  /** Signatures of every reserved chord: defaults plus live resolved bindings. */
  const reservedChords = useCallback(() => {
    const chords = new Map<string, string>();
    for (const entry of [
      ...Object.values(KERNEL_RESERVED_SHORTCUTS),
      ...EDITING_RESERVED_CHORDS,
    ])
      chords.set(effectiveChordSignature(entry.binding), entry.id);
    for (const id of RESERVED_SHORTCUT_IDS) {
      const registered = shortcutsRef.current.get(id);
      if (!registered) continue;
      const live = resolveShortcut(registered);
      if (!live.disabled && live.key)
        chords.set(effectiveChordSignature(live), id);
    }
    return chords;
  }, [resolveShortcut]);

  const findReservedConflict = useCallback(
    (binding: { key: string; modifiers: readonly ShortcutModifier[] }) => {
      const id = reservedChords().get(effectiveChordSignature(binding));
      return id ? { id } : null;
    },
    [reservedChords],
  );

  const setBinding = useCallback(
    (id: string, binding: ShortcutBinding | null | undefined) => {
      const skill = skillShortcutName(id);
      const current = skill === undefined ? overridesRef : skillOverridesRef;
      const next = { ...current.current };
      const key = skill ?? id;
      if (binding === undefined) delete next[key];
      else next[key] = binding;
      current.current = next;
      if (skill === undefined) {
        writeShortcutOverrides(next);
        setOverrides(next);
      } else {
        writeSkillShortcuts(next);
        setSkillOverrides(next);
      }
    },
    [],
  );

  const restoreBinding = useCallback(
    (id: string) => setBinding(id, undefined),
    [setBinding],
  );

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
      let reserved: Map<string, string> | null = null;
      const eventKey = normalizeShortcutKey(e.key);
      for (const registered of shortcuts) {
        const shortcut = resolveShortcut(registered);
        if (shortcut.disabled) continue;
        // A plugin never shadows a reserved kernel chord, including one the
        // user rebound after the plugin registered, or a plugin binding the
        // user moved onto it.
        if (isPluginShortcutId(shortcut.id)) {
          reserved ??= reservedChords();
          if (reserved.has(effectiveChordSignature(shortcut))) continue;
        }
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
        const keyMatch = eventKey === normalizeShortcutKey(shortcut.key);

        if (metaMatch && ctrlMatch && shiftMatch && altMatch && keyMatch) {
          if (shortcut.handler() === false) continue;
          e.preventDefault();
          break;
        }
      }
    };

    const handlePageScreenshot = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-live-surface-keyboard]')
      )
        return;
      const primary = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        primary &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 's'
      )
        handleKeyDown(event);
    };
    window.addEventListener('keydown', handlePageScreenshot, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handlePageScreenshot, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [resolveShortcut, reservedChords]);

  const store = useMemo<ShortcutRegistryStore>(
    () => ({
      register,
      findReservedConflict,
      getDisplay,
      getAllShortcuts,
      getDefaultBinding,
      setBinding,
      restoreBinding,
      isMac,
      subscribe,
      getVersion,
    }),
    [
      register,
      findReservedConflict,
      getDisplay,
      getAllShortcuts,
      getDefaultBinding,
      setBinding,
      restoreBinding,
      subscribe,
      getVersion,
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
 * `useKeyboardShortcuts` for a mount that may sit outside the provider (the
 * plugin SDK adapter): undefined there instead of a throw, so the SDK reports
 * its shortcut slot as unavailable.
 */
export function useOptionalKeyboardShortcuts():
  | ReturnType<typeof useKeyboardShortcuts>
  | undefined {
  return useContext(KeyboardShortcutsContext);
}

/**
 * Registration/binding actions without a registry subscription. Reading here
 * would go stale; subscribing registering components caused archive#3736.
 */
export function useKeyboardShortcuts(): Omit<
  ShortcutRegistryStore,
  | 'getDisplay'
  | 'getAllShortcuts'
  | 'getDefaultBinding'
  | 'subscribe'
  | 'getVersion'
> {
  return useShortcutStore();
}

const NO_REGISTRY_SUBSCRIPTION = () => () => {};
const NO_REGISTRY_VERSION = () => 0;

/**
 * `useShortcutRegistry` for always-mounted chrome that may render outside the
 * provider (shell fixtures, an isolated header): undefined there instead of a
 * throw. Inside the provider it subscribes exactly like `useShortcutRegistry`.
 */
export function useOptionalShortcutRegistry():
  | Omit<ShortcutRegistryStore, 'subscribe' | 'getVersion'>
  | undefined {
  const store = useContext(KeyboardShortcutsContext);
  useSyncExternalStore(
    store?.subscribe ?? NO_REGISTRY_SUBSCRIPTION,
    store?.getVersion ?? NO_REGISTRY_VERSION,
    store?.getVersion ?? NO_REGISTRY_VERSION,
  );
  return store ?? undefined;
}

/** Subscribe to registry content and registration identity for displayed commands. */
export function useShortcutRegistry(): Omit<
  ShortcutRegistryStore,
  'subscribe' | 'getVersion'
> {
  const store = useShortcutStore();
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store;
}
