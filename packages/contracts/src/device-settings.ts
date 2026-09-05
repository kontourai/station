/**
 * The device-scope client-settings
 * registry (docs/design/settings-architecture.md §3 "S3. Device") — the
 * device-scope companion to `settings-registry.ts`.
 *
 * One definition per setting persisted to the single versioned browser
 * store (`station-device-settings-v1`, `src-ui/src/lib/device-settings-store.ts`).
 * Unlike `APP_SETTINGS_REGISTRY`, these settings never round-trip to the
 * server — they are this browser/client's own preferences. Each entry also
 * names the prior, pre-unification localStorage key it replaces so the
 * store can run a one-time migration and Export/Import can still read old
 * files.
 */

import type { SettingValueDescriptor } from './settings-registry.js';

export interface FeatureSettings {
  /** Text-to-speech readback of the latest agent response via the active TTS provider. */
  ttsReadbackEnabled: boolean;
  /** Subscribe to Web Push notifications for high-priority alerts. */
  pushNotificationsEnabled: boolean;
  /** Show the global voice pill for speech-to-speech (S2S) sessions. */
  voiceS2SEnabled: boolean;
  /** Show mobile pairing QR code and network discovery in Settings. */
  mobilePairingEnabled: boolean;
  /** Reveal streamed assistant text at a steady paint cadence on this device. */
  smoothReveal?: boolean;
  /** Per-category foreground notification sounds for this device. */
  notificationSounds: NotificationSoundPreferences;
}

/** A short synthesized sound; `none` keeps a category visually notified but quiet. */
export type NotificationSound = 'chime' | 'bell' | 'pulse' | 'none';

/**
 * Categories that Station currently delivers to the foreground notification
 * seam. New or third-party categories deliberately fall back to `chime`
 * rather than making an unconfigured notification silent.
 */
export const NOTIFICATION_SOUND_CATEGORIES = [
  'approval-request',
  'pairing-request',
  'job-failure',
  'job-missed',
  'scheduler-unhealthy',
  'turn-failed',
  'turn-completed',
  'turn-stopped',
] as const;

export type NotificationSoundCategory =
  (typeof NOTIFICATION_SOUND_CATEGORIES)[number];

export type NotificationSoundPreferences = Record<
  NotificationSoundCategory,
  NotificationSound
>;

export const NOTIFICATION_SOUND_VALUES = [
  'chime',
  'bell',
  'pulse',
  'none',
] as const satisfies readonly NotificationSound[];

export interface InboxSectionsState {
  snoozed: boolean;
  earlier: boolean;
}

/**
 * kontourai/station-archive#3314: the project sidebar's "Open chats" and "Drafts"
 * sections — each independently collapsible AND removable from the sidebar
 * altogether. Boolean fields on purpose (not a tri-state enum), so the
 * device-settings store's shared composite boolean-field validator covers
 * imported values without a bespoke check.
 */
export interface SidebarSectionsState {
  openChatsCollapsed: boolean;
  openChatsHidden: boolean;
  draftsCollapsed: boolean;
  draftsHidden: boolean;
}

/**
 * The keyboard-shortcut override
 * shape, moved here from the app-side `shortcutPreferences.ts` so the
 * registry can declare it as a first-class device setting instead of a
 * field inside the parallel legacy `station.device-settings` JSON root.
 */
export type ShortcutModifier = 'cmd' | 'ctrl' | 'shift' | 'alt';

export interface ShortcutBinding {
  key: string;
  modifiers: ShortcutModifier[];
}

/** `null` means the shortcut is explicitly disabled (cleared), distinct from absent (uses its built-in default). */
export type ShortcutOverrides = Record<string, ShortcutBinding | null>;
export type SkillShortcuts = Record<string, ShortcutBinding | null>;

/**
 * The model-picker favorite/recent/hidden/order lists — moved here from
 * `modelPickerPreferences.ts` for the same #1359-convergence reason as
 * `ShortcutOverrides` above.
 */
export interface ModelPickerPreferences {
  favorites: string[];
  recents: string[];
  hidden: string[];
  order: string[];
}

/**
 * Chat dock placement
 * (docs/design/settings-architecture.md §3 S4 "Chat/session"). Mirrors
 * `DockMode` in `src-ui/src/types.ts` exactly (same literal union) — kept as
 * its own alias here rather than importing across the contracts/src-ui
 * boundary, matching this module's dependency-free contract.
 */
export type ChatDockMode = 'left' | 'bottom' | 'right';

/**
 * How far the person got through the three-chapter first run.
 *
 * Device-scope on purpose: "have I been shown the tour on this machine" is a
 * property of this browser/app install, exactly like
 * `onboardingSetupDismissed` beside it — not of the Station instance. The
 * ANSWERS the About-you chapter collects are a different thing and live
 * server-side in `AppConfig.userProfile`, because the model needs them.
 *
 * `chapter` is where a resume lands; `deferred` snoozes automatic presentation
 * without discarding that resume point; `tourStepId` is the tour step the user
 * had reached when they left, so a partial tour resumes where it stopped
 * rather than restarting. An unrecognised `tourStepId` (a step retired since
 * it was written) is treated as "start of the tour", never as a crash.
 */
export type FirstRunChapter =
  | 'connect'
  /**
   * archive#3027: "which agents do you use?" — the installed-engine
   * checklist, between Connect (which guarantees a reachable server) and
   * About you (so the tour lands on a picker with something in it).
   */
  | 'engines'
  | 'about-you'
  | 'tour'
  | 'done';

export interface FirstRunProgress {
  chapter: FirstRunChapter;
  /** "Not now" on this device: resumable and deliberately distinct from `done`. */
  deferred?: boolean;
  tourStepId?: string;
}

export const DEFAULT_FIRST_RUN_PROGRESS: FirstRunProgress = {
  chapter: 'connect',
};

/**
 * The persisted per-device region arrangement (#928 slice D).
 *
 * Mirrors `RegionId` in `src-ui/src/regions/region-model.ts` exactly (same
 * literal union), kept as its own alias here for the same reason as
 * `ChatDockMode` above: this module imports nothing from `src-ui`. The UI
 * pins the two in lockstep (`region-arrangement-record.test.ts`).
 */
export type RegionArrangementRecordRegionId =
  | 'main'
  | 'left'
  | 'right'
  | 'bottom';

/**
 * What a region holds. `kind` is the extension point: a region occupied by
 * a surface today is `{ kind: 'surface', id }`; the pane-host direction
 * (docs/design/placement.md) adds `{ kind: 'pane-host', documentId }` as a
 * second variant with no migration, because a reader that meets an unknown
 * `kind` treats the region as empty rather than failing the record.
 */
export type RegionOccupantRecord = { kind: 'surface'; id: string };

export interface RegionArrangementRecordRegion {
  visible: boolean;
  size: number;
  occupant: RegionOccupantRecord | null;
}

export interface RegionArrangementRecord {
  version: 1;
  regions: Record<
    RegionArrangementRecordRegionId,
    RegionArrangementRecordRegion
  >;
}

/**
 * Byte-for-byte the record of `DEFAULT_DEVICE_REGION_ARRANGEMENT`
 * (`src-ui/src/regions/region-model.ts`), which a UI test pins
 * (`region-arrangement-record.test.ts`): the arrangement's default lives in
 * the UI, this literal is its serialized form for a module that cannot
 * import it. A device holding exactly this value has never written the
 * record, and the region model reads it as "no record" so the legacy dock
 * keys keep governing first run.
 */
export const DEFAULT_REGION_ARRANGEMENT_RECORD: RegionArrangementRecord = {
  version: 1,
  regions: {
    main: { visible: true, size: 0, occupant: { kind: 'surface', id: 'home' } },
    left: { visible: false, size: 400, occupant: null },
    right: { visible: false, size: 400, occupant: null },
    bottom: {
      visible: false,
      size: 320,
      occupant: { kind: 'surface', id: 'chat' },
    },
  },
};

export interface DeviceSettings {
  theme: 'light' | 'dark';
  accentColor: string | null;
  featureSettings: FeatureSettings;
  sttProvider: string;
  ttsProvider: string;
  chatDockAutoHide: boolean;
  chatDockHeight: number;
  chatDockWidth: number;
  diffStyle: 'unified' | 'split';
  diffWrap: boolean;
  inboxOpen: boolean;
  inboxSections: InboxSectionsState;
  /** archive#3314: sidebar "Open chats"/"Drafts" collapse + removal state. */
  sidebarSections: SidebarSectionsState;
  projectSidebarCollapsed: boolean;
  onboardingSetupDismissed: boolean;
  shortcutOverrides: ShortcutOverrides;
  skillShortcuts: SkillShortcuts;
  modelPickerPreferences: ModelPickerPreferences;
  /** Show model reasoning steps inline in chat messages. */
  chatShowReasoning: boolean;
  /** Allow expanding tool calls to view arguments/results. */
  chatShowToolDetails: boolean;
  /**
   * Chat message font size in px. `null` means "follow the Station-configured
   * default" (`AppConfig.defaultChatFontSize`) — a number is stored only once
   * the user explicitly adjusts it in-chat.
   * Never had a prior key: font size previously lived only in a `?fontSize=`
   * URL param and was never persisted.
   */
  chatFontSize: number | null;
  /**
   * Remembered dock-slot preference. Device placement derives whether this
   * preference is available; a narrow or coarse device never applies an
   * unavailable edge preference and never clears it.
   */
  dockSlotPlacement: ChatDockMode;
  /**
   * Mobile haptic feedback for stream growth, copy, pairing success, and
   * destructive confirms (archive#1954). Desktop/web hosts ignore this;
   * default on so a fresh mobile install feels alive without a settings hunt.
   */
  hapticsEnabled: boolean;
  /**
   * archive#2652: chapter/step reached in the guided first run on this device.
   * Never had a prior key — the guided first run is new.
   */
  firstRunProgress: FirstRunProgress;
  /**
   * archive#3313: show the Developer surface (logs, system, telemetry,
   * memory, archive) in this device's sidebar and command palette. Gates
   * navigation advertisement only — /developer deep links keep working when
   * off. Never had a prior key: Developer was previously always visible.
   */
  developerToolsEnabled: boolean;
  /**
   * archive#4525: the chat dock's own remembered project binding. Owned by
   * the persistent `DockShell`/`useDockShellChrome` (archive#4484), not by
   * the Chat occupant that remounts on every occupant switch — persisting it
   * here (mirroring `chatDockHeight`/`chatDockWidth`) is what makes the
   * binding survive an occupant switch, a new unbound chat, and a reload,
   * instead of resetting to "No project" the moment the occupant that used
   * to derive it from the active session's own `projectSlug` unmounts.
   * `null` means no project is bound. Changes only via an explicit picker
   * selection, an explicit new-chat project choice, or the bound project's
   * deletion — never as a side effect of losing track of the active session.
   */
  chatDockProjectSlug: string | null;
  /**
   * #928 slice D: which surface occupies which region, with each region's
   * size and visibility, on this device. Per device on purpose — never per
   * project or layout (owner decision, docs/design/placement.md).
   * Precedence at load, highest first: a URL deep link for Chat
   * (`dockSlotPlacement` places Chat there, relocating an occupant;
   * `dock=open` shows it) > this record when it differs from the default
   * (every surface, size and visibility, Chat's included) > the legacy dock
   * seed (`chatDockHeight`/`chatDockWidth`, `dockSlotPlacement`). Sizes
   * render from the record. A mount never writes. Validated by
   * `src-ui/src/regions/region-arrangement-record.ts` on every read — a
   * malformed value falls back to the legacy dock seed, never a crash.
   * Never had a prior key: no arrangement record existed before it.
   */
  regionArrangement: RegionArrangementRecord;
}

export interface DeviceSettingDefinition<
  K extends keyof DeviceSettings = keyof DeviceSettings,
> {
  key: K;
  scope: 'device';
  descriptor: SettingValueDescriptor;
  label: string;
  description: string;
  /**
   * The pre-unification raw localStorage key this setting replaces. Used by
   * the store's one-time migration (read once, write the envelope, then
   * remove the prior key) and by earlier-format Export/Import files.
   *
   * Normally unique per setting — the migration reads this key's raw string
   * value and parses it per `descriptor` (`parsePriorValue`). Two settings
   * MAY share one `priorStorageKey` when both declare `priorRead` below
   * (archive#1359 store convergence: `shortcutOverrides`
   * and `modelPickerPreferences` both migrate from the single
   * legacy `station.device-settings` JSON root) — the shared key is
   * then read once, `JSON.parse`d, and each sharer extracts its own field
   * from the parsed root via `priorRead` instead of the generic
   * raw-string-at-its-own-key path.
   *
   * Optional: a setting that never had a
   * pre-unification localStorage key of its own (it was previously either
   * unpersisted, e.g. `chatShowReasoning`/`chatShowToolDetails`/
   * `chatFontSize`, or URL-param-only, e.g. `dockSlotPlacement`) omits this field
   * entirely rather than inventing a prior key that never existed. The
   * store's migration loops (`device-settings-store.ts`) skip any definition
   * with neither `priorStorageKey` nor `priorRead`.
   */
  priorStorageKey?: string;
  /**
   * Overrides the generic `priorStorageKey` migration path for a setting
   * whose prior source is one field inside a shared JSON root object
   * (rather than a raw string value at its own key) — see
   * `priorStorageKey`'s doc comment. Receives the root object already
   * `JSON.parse`d; returns `undefined` when the field isn't present in the
   * prior settings root (falls through to the registry default), or the correctly
   * shaped value otherwise. Absent for every setting with its own,
   * unshared prior key.
   */
  priorRead?: (root: Record<string, unknown>) => DeviceSettings[K] | undefined;
  /** The value this setting resolves to when absent from the envelope. */
  defaultValue: DeviceSettings[K];
}

function defineDeviceSetting<K extends keyof DeviceSettings>(
  definition: DeviceSettingDefinition<K>,
): DeviceSettingDefinition<K> {
  return definition;
}

export const DEFAULT_NOTIFICATION_SOUND_PREFERENCES: NotificationSoundPreferences =
  {
    'approval-request': 'bell',
    'pairing-request': 'bell',
    'job-failure': 'pulse',
    'job-missed': 'pulse',
    'scheduler-unhealthy': 'pulse',
    'turn-failed': 'pulse',
    'turn-completed': 'chime',
    'turn-stopped': 'chime',
  };

const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  ttsReadbackEnabled: false,
  pushNotificationsEnabled: false,
  voiceS2SEnabled: false,
  mobilePairingEnabled: false,
  notificationSounds: DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
};

const DEFAULT_INBOX_SECTIONS: InboxSectionsState = {
  snoozed: false,
  earlier: false,
};

const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionsState = {
  openChatsCollapsed: false,
  openChatsHidden: false,
  draftsCollapsed: false,
  draftsHidden: false,
};

const DEFAULT_SHORTCUT_OVERRIDES: ShortcutOverrides = {};
const DEFAULT_SKILL_SHORTCUTS: SkillShortcuts = {};

const DEFAULT_MODEL_PICKER_PREFERENCES: ModelPickerPreferences = {
  favorites: [],
  recents: [],
  hidden: [],
  order: [],
};

/** The shared prior settings root #1359 shipped for `shortcutOverrides`/`modelPickerPreferences`. */
const SHARED_PRIOR_DEVICE_SETTINGS_KEY = 'station.device-settings';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SHORTCUT_MODIFIERS: readonly ShortcutModifier[] = [
  'cmd',
  'ctrl',
  'shift',
  'alt',
];

/**
 * Mirrors the validation `shortcutPreferences.ts` (pre-convergence) ran on
 * every written binding. Exported
 * so `src-ui/src/lib/device-settings-store.ts`'s `importEnvelope`
 * shape validation can reuse the SAME structural check instead of a
 * parallel one — `shortcutOverrides` previously had no shape entry in that
 * module's `COMPOSITE_BOOLEAN_FIELDS`-driven validator, so an imported
 * malformed binding (e.g. `{key: 123}`) passed straight through and later
 * crashed a consumer (`shortcut.key.toUpperCase()`).
 */
export function normalizePriorShortcutBinding(
  value: unknown,
): ShortcutBinding | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  const key = value.key;
  const modifiers = value.modifiers;
  if (typeof key !== 'string' || !key.trim()) return undefined;
  if (
    !Array.isArray(modifiers) ||
    modifiers.some(
      (modifier) => !SHORTCUT_MODIFIERS.includes(modifier as ShortcutModifier),
    )
  ) {
    return undefined;
  }
  return {
    key,
    modifiers: Array.from(new Set(modifiers)) as ShortcutModifier[],
  };
}

/**
 * Extracts `shortcutOverrides` from the shared prior settings root's `shortcuts.
 * bindings` field (or its pre-versioned prototype location,
 * `shortcutBindings`) — mirrors the pre-convergence
 * `shortcutPreferences.ts#readShortcutOverrides` read-compat, with one
 * deliberate difference: the pre-convergence
 * `normalizeBinding` lowercased a single-character `key` on write;
 * `normalizePriorShortcutBinding` does not. This is safe to skip because
 * every consumer that compares/displays a binding's key already does its
 * own case-insensitive handling — `bindingSignature` (`shortcutPreferences.
 * ts`) lowercases before building its comparison signature, and
 * `KeyboardShortcutsContext.tsx#getDisplay` uppercases for rendering — so a
 * stored key of either case reads back identically either way.
 */
function priorReadShortcutOverrides(
  root: Record<string, unknown>,
): ShortcutOverrides | undefined {
  const shortcuts = isPlainObject(root.shortcuts) ? root.shortcuts : undefined;
  const source = isPlainObject(shortcuts?.bindings)
    ? shortcuts!.bindings
    : isPlainObject(root.shortcutBindings)
      ? root.shortcutBindings
      : undefined;
  if (!source) return undefined;
  const overrides: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(source)) {
    const binding = normalizePriorShortcutBinding(value);
    if (binding !== undefined) overrides[id] = binding;
  }
  return overrides;
}

/**
 * Exported for the same reason as `normalizePriorShortcutBinding` above
 * — `device-settings-store.ts`'s
 * `importEnvelope` reuses this to sanitize each `modelPickerPreferences`
 * array field instead of a parallel de-dup/filter implementation. Note this
 * function ALWAYS returns a valid (possibly empty) array — it is a
 * coercer, not a shape-rejecting validator; a caller that must REJECT a
 * wrong-TYPE field (e.g. `order` sent as a string) rather than silently
 * coercing it to `[]` must check `Array.isArray` itself first.
 */
export function priorStringList(value: unknown): string[] {
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

/**
 * Extracts `modelPickerPreferences` from the shared prior settings root's
 * `modelPicker` field — mirrors the pre-convergence
 * `modelPickerPreferences.ts#parseSettings` read-compat exactly (including
 * capping `recents` at 20).
 */
function priorReadModelPickerPreferences(
  root: Record<string, unknown>,
): ModelPickerPreferences | undefined {
  if (!isPlainObject(root.modelPicker)) return undefined;
  const picker = root.modelPicker;
  return {
    favorites: priorStringList(picker.favorites),
    recents: priorStringList(picker.recents).slice(0, 20),
    hidden: priorStringList(picker.hidden),
    order: priorStringList(picker.order),
  };
}

/**
 * One entry per `DeviceSettings` field. The module-level type assertion at
 * the bottom of this file fails to typecheck if a field is added to
 * `DeviceSettings` without being registered here.
 */
export const DEVICE_SETTINGS_REGISTRY = [
  defineDeviceSetting({
    key: 'theme',
    scope: 'device',
    descriptor: { kind: 'enum', values: ['light', 'dark'] },
    label: 'Theme',
    description: 'Light or dark interface theme.',
    priorStorageKey: 'theme',
    // Confirmed against index.css: no `data-theme` attribute resolves the
    // dark skin (ThemeToggle.tsx's own in-code default already agreed).
    defaultValue: 'dark',
  }),
  defineDeviceSetting({
    key: 'accentColor',
    scope: 'device',
    descriptor: { kind: 'string' },
    label: 'Accent color',
    description: 'Custom UI accent color (hex). Unset uses the theme default.',
    priorStorageKey: 'station-accent-color',
    defaultValue: null,
  }),
  defineDeviceSetting({
    key: 'featureSettings',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Features',
    description: 'Per-device feature toggles.',
    priorStorageKey: 'station-feature-settings',
    // Confirmed against useFeatureSettings.ts's own DEFAULTS: all off
    // (privacy-sensitive features default conservative).
    defaultValue: DEFAULT_FEATURE_SETTINGS,
  }),
  defineDeviceSetting({
    key: 'sttProvider',
    scope: 'device',
    descriptor: { kind: 'string' },
    label: 'Speech-to-text provider',
    description: 'Active speech-to-text provider id.',
    priorStorageKey: 'station-stt-provider',
    // Confirmed against VoiceProviderContext.tsx: `?? 'webspeech'`.
    defaultValue: 'webspeech',
  }),
  defineDeviceSetting({
    key: 'ttsProvider',
    scope: 'device',
    descriptor: { kind: 'string' },
    label: 'Text-to-speech provider',
    description: 'Active text-to-speech provider id.',
    priorStorageKey: 'station-tts-provider',
    // Confirmed against VoiceProviderContext.tsx: `?? 'webspeech'`.
    defaultValue: 'webspeech',
  }),
  defineDeviceSetting({
    key: 'chatDockAutoHide',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Auto-hide chat dock',
    description: 'Collapse an idle, open chat dock to its bar after 5s.',
    priorStorageKey: 'chatDockAutoHide',
    // Confirmed against useChatDockState.ts: `=== 'true'` (absent → false).
    defaultValue: false,
  }),
  defineDeviceSetting({
    key: 'chatDockHeight',
    scope: 'device',
    descriptor: { kind: 'number', integer: true },
    label: 'Chat dock height',
    description: 'Last committed bottom chat dock height in pixels.',
    defaultValue: 320,
  }),
  defineDeviceSetting({
    key: 'chatDockWidth',
    scope: 'device',
    descriptor: { kind: 'number', integer: true },
    label: 'Chat dock width',
    description: 'Last committed side chat dock width in pixels.',
    defaultValue: 400,
  }),
  defineDeviceSetting({
    key: 'diffStyle',
    scope: 'device',
    descriptor: { kind: 'enum', values: ['unified', 'split'] },
    label: 'Diff view style',
    description: 'Unified or side-by-side diff rendering.',
    priorStorageKey: 'station.diff.style',
    // Confirmed against DiffPanel.tsx: only 'split' flips it, else 'unified'.
    defaultValue: 'unified',
  }),
  defineDeviceSetting({
    key: 'diffWrap',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Diff line wrap',
    description: 'Wrap long diff lines instead of horizontal scroll.',
    priorStorageKey: 'station.diff.wrap',
    // Confirmed against DiffPanel.tsx: `=== '1'` (absent → false).
    defaultValue: false,
  }),
  defineDeviceSetting({
    key: 'inboxOpen',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Chat dock inbox open',
    description: 'Whether the chat dock inbox panel is open.',
    priorStorageKey: 'station.inbox.open',
    // Confirmed against ChatDock.tsx's readInboxOpen: `stored === null ?
    // true : stored === 'true'` — absent means open, not closed.
    defaultValue: true,
  }),
  defineDeviceSetting({
    key: 'inboxSections',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Chat dock inbox sections',
    description:
      'Collapsed/expanded state of the snoozed and earlier inbox sections.',
    priorStorageKey: 'station.inbox.sections',
    // Confirmed against ChatDockInboxPanel.tsx's DEFAULT_SECTION_STATE.
    defaultValue: DEFAULT_INBOX_SECTIONS,
  }),
  defineDeviceSetting({
    key: 'sidebarSections',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Sidebar sections',
    description:
      'Collapsed and removed state of the sidebar Open chats and Drafts sections.',
    // archive#3314 — new sections state; never had a pre-unification key.
    defaultValue: DEFAULT_SIDEBAR_SECTIONS,
  }),
  defineDeviceSetting({
    key: 'projectSidebarCollapsed',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Project sidebar collapsed',
    description: 'Whether the project sidebar renders collapsed (icon-only).',
    priorStorageKey: 'station-sidebar-collapsed',
    // Confirmed against project-sidebar/utils.ts's readInitialSidebarCollapsed:
    // defaults to expanded so labels are visible on first run.
    defaultValue: false,
  }),
  defineDeviceSetting({
    key: 'onboardingSetupDismissed',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Setup launcher dismissed',
    description:
      'Persisted "do not show me this again" for the first-run setup launcher.',
    priorStorageKey: 'station:onboarding-setup-dismissed',
    defaultValue: false,
  }),
  defineDeviceSetting({
    key: 'shortcutOverrides',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Keyboard shortcut overrides',
    // Persisted as a map keyed by command id; a `null` entry means the
    // shortcut is explicitly cleared (distinct from absent = default binding).
    description:
      'Keyboard shortcuts you have customized or cleared on this device.',
    priorStorageKey: SHARED_PRIOR_DEVICE_SETTINGS_KEY,
    priorRead: priorReadShortcutOverrides,
    defaultValue: DEFAULT_SHORTCUT_OVERRIDES,
  }),
  defineDeviceSetting({
    key: 'firstRunProgress',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'First run',
    // archive#2652. Persisted as `{ chapter, deferred?, tourStepId? }`. Records
    // only how far the guided first run got on this device and whether its
    // automatic presentation was deferred; the About-you ANSWERS are
    // server-scope (`AppConfig.userProfile`) because the model reads them.
    description: 'Guided first-run progress on this device.',
    defaultValue: DEFAULT_FIRST_RUN_PROGRESS,
  }),
  defineDeviceSetting({
    key: 'skillShortcuts',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Skill shortcuts',
    description: 'Keyboard shortcuts assigned to skills on this device.',
    defaultValue: DEFAULT_SKILL_SHORTCUTS,
  }),
  defineDeviceSetting({
    key: 'modelPickerPreferences',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Model picker preferences',
    description:
      'Favorite, recent, hidden, and manually ordered models in the model picker.',
    priorStorageKey: SHARED_PRIOR_DEVICE_SETTINGS_KEY,
    priorRead: priorReadModelPickerPreferences,
    defaultValue: DEFAULT_MODEL_PICKER_PREFERENCES,
  }),
  // ChatSettingsPanel's (docs/design/settings-architecture.md
  // §3 S4 "Chat/session") reasoning/tool-
  // detail/font/dock-mode prefs move to device scope. None of the four ever
  // had a pre-unification localStorage key (reasoning/tool-details reset on
  // every reload via plain `useState`; font size and dock mode lived only in
  // URL params) — no `priorStorageKey` for any of them.
  defineDeviceSetting({
    key: 'chatShowReasoning',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Show reasoning',
    description: 'Display model reasoning steps in chat messages.',
    // Matches the prior `useChatDockState.ts` default:
    // `useState(true)`.
    defaultValue: true,
  }),
  defineDeviceSetting({
    key: 'chatShowToolDetails',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Show tool details',
    description: 'Allow expanding tool calls to view arguments and results.',
    // Matches the prior `useChatDockState.ts` default:
    // `useState(true)`.
    defaultValue: true,
  }),
  defineDeviceSetting({
    key: 'chatFontSize',
    scope: 'device',
    descriptor: { kind: 'number', integer: true, min: 10, max: 24 },
    label: 'Chat font size',
    description:
      'Font size for chat messages (10-24px). Unset follows the Station-configured default.',
    // `null` (not a number) is the confirmed absent-value behavior: it means
    // "follow AppConfig.defaultChatFontSize" rather than pinning a pixel
    // value — see the field doc on `DeviceSettings.chatFontSize`.
    defaultValue: null,
  }),
  defineDeviceSetting({
    key: 'dockSlotPlacement',
    scope: 'device',
    descriptor: { kind: 'enum', values: ['left', 'bottom', 'right'] },
    label: 'Dock position',
    description:
      'Remembered dock-slot placement preference when this device offers a choice.',
    // Matches the prior `navigation-store.ts`'s
    // `getDefaultNavigationState`/`parseUrl` default: 'bottom'.
    defaultValue: 'bottom',
  }),
  defineDeviceSetting({
    key: 'hapticsEnabled',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Haptic feedback',
    description:
      'Light selection pulses while an assistant reply streams, plus feedback on copy, pairing success, and destructive confirms. Mobile native shells only.',
    // archive#1954: default on; desktop/web no-op via capability gate.
    defaultValue: true,
  }),
  defineDeviceSetting({
    key: 'developerToolsEnabled',
    scope: 'device',
    descriptor: { kind: 'boolean' },
    label: 'Enable developer tools',
    description:
      'Show the Developer surface (logs, system, telemetry, memory, archive) in the sidebar and command palette on this device. Deep links to /developer keep working either way.',
    // archive#3313: developer surfaces are opt-in; which navigation entries a
    // device shows is that device's preference, so this never round-trips to
    // the server.
    defaultValue: false,
  }),
  defineDeviceSetting({
    key: 'chatDockProjectSlug',
    scope: 'device',
    descriptor: { kind: 'string' },
    label: 'Chat dock project',
    description:
      'The project the chat dock header is currently bound to, independent of whichever chat is on screen.',
    // archive#4525: new device setting — the dock's project badge previously
    // derived entirely, and unpersisted, from the active chat session.
    defaultValue: null,
  }),
  defineDeviceSetting({
    key: 'regionArrangement',
    scope: 'device',
    descriptor: { kind: 'composite' },
    label: 'Region arrangement',
    description:
      "Which surfaces occupy the main, left, right, and bottom regions on this device, with each region's size and visibility.",
    // #928 slice D: new device setting; the arrangement was previously seeded
    // from the chat dock's own keys on every load and nothing else survived.
    defaultValue: DEFAULT_REGION_ARRANGEMENT_RECORD,
  }),
] as const satisfies readonly DeviceSettingDefinition[];

/**
 * Registry-driven extraction of every `priorRead`-bearing setting from one
 * parsed prior settings root object — the shared implementation behind both the
 * device-settings store's own one-time migration
 * (`src-ui/src/lib/device-settings-store.ts`) and the settings Export/Import
 * path (`src-ui/src/views/settings/utils.ts`), so an old export file
 * carrying `sharedDeviceRoot` (or `_localStorage['station.device-settings']`)
 * lands on the same envelope entries the live migration would have produced.
 */
export function extractPriorDeviceSettingsRoot(
  root: unknown,
): Partial<DeviceSettings> {
  if (!isPlainObject(root)) return {};
  const values: Partial<DeviceSettings> = {};
  for (const definition of DEVICE_SETTINGS_REGISTRY) {
    if (!definition.priorRead) continue;
    const value = definition.priorRead(root);
    if (value === undefined) continue;
    (values as Record<string, unknown>)[definition.key] = value;
  }
  return values;
}

/**
 * Registered `priorStorageKey` values — normally unique and non-empty (a
 * shared key would otherwise make migration ambiguous), EXCEPT entries that
 * declare `priorRead` (see its doc comment): those may legitimately share
 * one key, since each extracts its own field from the shared parsed root
 * instead of consuming the whole raw value. Entries with no `priorStorageKey`
 * at all (a setting that was never
 * persisted pre-unification) are excluded rather than contributing an
 * `undefined` entry.
 */
export const DEVICE_SETTINGS_PRIOR_KEYS: readonly string[] =
  DEVICE_SETTINGS_REGISTRY.filter(
    (
      definition,
    ): definition is typeof definition & { priorStorageKey: string } =>
      definition.priorStorageKey !== undefined,
  ).map((definition) => definition.priorStorageKey);

type RegisteredDeviceKey = (typeof DEVICE_SETTINGS_REGISTRY)[number]['key'];

type KeysMatch<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * Compile-time completeness check: if this line fails to typecheck, either
 * `DeviceSettings` gained a field that isn't registered here, or the
 * registry names a key that no longer exists on `DeviceSettings`. Keep this
 * assignment — it is the drift guard, not dead code.
 */
const _assertRegistryCoversDeviceSettings: KeysMatch<
  keyof DeviceSettings,
  RegisteredDeviceKey
> = true;
void _assertRegistryCoversDeviceSettings;
