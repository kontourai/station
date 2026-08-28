/**
 * device-settings-store — the unified, versioned, device-scope client-
 * settings store (docs/design/settings-architecture.md §3 "S3. Device",
 * §6). Module-singleton pattern modeled on
 * `src-ui/src/contexts/onboarding-setup-store.ts` (subscribe/getSnapshot/
 * notify for `useSyncExternalStore`).
 *
 * Everything lives in ONE localStorage key (`ENVELOPE_STORAGE_KEY`):
 * `{ version, values }`, where `values` is a PARTIAL `DeviceSettings` — only
 * keys that have ever been explicitly set are present; every other key
 * resolves through `DEVICE_SETTINGS_REGISTRY`'s `defaultValue`.
 *
 * On first construction (no envelope present yet), the store runs a
 * one-time migration: for every registered setting with a present prior
 * localStorage key, it parses that raw value per the setting's descriptor,
 * folds the result into the new envelope, writes the envelope, and removes
 * the prior key — but ONLY once the envelope write is confirmed to have
 * landed (archive#settings-revamp; see
 * `migrateFromPriorStorage` below). This is a single-writer-per-tab app, but two
 * tabs of the same origin ARE two independent writers of this one
 * localStorage key — every mutator does a read-merge-write against the
 * freshly-read persisted envelope, and a `storage` event
 * listener live-syncs an out-of-band change from another tab (or a second
 * concurrent migration) into this tab's snapshot.
 */

import {
  DEVICE_SETTINGS_REGISTRY,
  type DeviceSettingDefinition,
  type DeviceSettings,
  NOTIFICATION_SOUND_CATEGORIES,
  NOTIFICATION_SOUND_VALUES,
  type NotificationSound,
  normalizePriorShortcutBinding,
  priorStringList,
} from '@kontourai/station-contracts/device-settings';
import type { SettingValueDescriptor } from '@kontourai/station-contracts/settings-registry';

const ENVELOPE_STORAGE_KEY = 'station-device-settings-v1';

/** See the doc comment on `notify` below. */
const PRIOR_DEVICE_SETTINGS_EVENT = 'station-device-settings-changed';

/**
 * The envelope's own schema version — bumped whenever the *shape* of
 * `values` changes in a way that needs an explicit migration step (a field
 * renamed, restructured, or split). `runMigrationLadder` below is the
 * scaffold that future slices extend.
 *
 * v1 -> v2 (archive#settings-revamp): backfills
 * any `priorRead`-bearing key (`shortcutOverrides`, `modelPickerPreferences`)
 * missing from an ALREADY-EXISTING v1 envelope from the shared archive#1359 root —
 * see `migrateEnvelopeV1ToV2` below. This closes a real reachability gap:
 * `migrateFromPriorStorage` (the store's other prior-setting import path) only runs when
 * the envelope key is entirely ABSENT, but slice 2 (already live on main
 * before this slice) writes an empty v1 envelope on every device's first
 * boot — so the exact devices with real archive#1359 customizations never hit that
 * path at all, and without this ladder step their `station.device-settings`
 * root would silently orphan and their customizations would read back as
 * registry defaults.
 */
const CURRENT_ENVELOPE_VERSION = 2;

export interface DeviceSettingsEnvelope {
  version: number;
  values: Partial<DeviceSettings>;
}

export interface DeviceSettingsImportResult {
  /**
   * Registered keys present in the imported file whose value failed
   * descriptor validation (archive#settings-revamp) — dropped rather than merged. Every other present, valid key was
   * merged into the store.
   */
  droppedKeys: (keyof DeviceSettings)[];
}

/**
 * Thrown by `importEnvelope` when the file's envelope version is newer than
 * this app understands — surfaced by the import flow
 * (`views/settings/utils.ts` → `SettingsView.tsx`) as a specific message
 * instead of a generic "Invalid settings file".
 */
export class DeviceSettingsImportVersionError extends Error {
  readonly importedVersion: number;

  constructor(importedVersion: number) {
    super(
      `This settings file was exported by a newer version of Station (device settings v${importedVersion}; this app supports up to v${CURRENT_ENVELOPE_VERSION}) and can't be imported here.`,
    );
    this.name = 'DeviceSettingsImportVersionError';
    this.importedVersion = importedVersion;
  }
}

type Listener = () => void;

function hasLocalStorage(): boolean {
  // Defensive `typeof window` guard matching existing patterns
  // (onboarding-setup-store.ts, useFeatureSettings.ts) — this module runs in
  // test environments (Node, no DOM) as well as the browser, never SSR.
  //
  // Reading `window.localStorage` is itself a throwing operation in a document
  // whose storage access is denied — an opaque origin (a sandboxed iframe
  // without `allow-same-origin`, an `about:blank` document) or a browser
  // configured to block site data raises `SecurityError` on the PROPERTY, not
  // on the later `getItem`. A probe whose whole job is to answer "can I use
  // storage?" must answer it rather than propagate; the throw used to escape
  // the two call sites that are not already inside a try (the constructor's
  // `storage` listener, and the prior-settings event dispatch), which takes
  // down the module-scope `deviceSettingsStore` singleton — and with it every
  // bundle that imports it — at import time.
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function readRaw(key: string): string | null {
  try {
    return hasLocalStorage() ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Returns whether the write actually landed — callers that must not act on an unconfirmed write (`migrateFromPriorStorage`) check this instead of assuming success. */
function writeRaw(key: string, value: string): boolean {
  try {
    if (!hasLocalStorage()) return false;
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage can be unavailable (privacy modes) or full (quota) — the
    // caller decides what "best-effort" means for it.
    return false;
  }
}

function removeRaw(key: string): void {
  try {
    if (!hasLocalStorage()) return;
    window.localStorage.removeItem(key);
  } catch {
    // Best-effort — see writeRaw.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses a raw prior shared-root string (archive#settings-revamp slice 3
 * archive#1359 convergence) into a plain object, or `null` when the raw value is
 * absent, malformed JSON, or not an object — the caller then just skips a
 * `null` root rather than crashing app boot on a corrupt prior value.
 */
function parsePriorSettingsRoot(
  raw: string | null,
): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parses one prior raw localStorage string per its setting's descriptor.
 * Malformed values fall back to the setting's own default rather than
 * throwing — a corrupt prior value must never break app boot.
 */
export function parsePriorValue<K extends keyof DeviceSettings>(
  descriptor: SettingValueDescriptor,
  raw: string,
  defaultValue: DeviceSettings[K],
): DeviceSettings[K] {
  switch (descriptor.kind) {
    case 'boolean':
      // Earlier writers use two different truthy encodings across keys
      // ('true'/'false' for chatDockAutoHide/inboxOpen, '1'/'0' for
      // diffWrap) — both are accepted here since each field's real writer
      // only ever used one of them; this generic OR covers both losslessly.
      return (raw === 'true' || raw === '1') as DeviceSettings[K];
    case 'enum':
      return (
        (descriptor.values as readonly string[]).includes(raw)
          ? raw
          : defaultValue
      ) as DeviceSettings[K];
    case 'string':
      return raw as DeviceSettings[K];
    case 'number': {
      // archive#settings-revamp note: `Number('')` and
      // `Number('   ')` both coerce to `0`, not NaN — an empty/whitespace
      // raw value must fall back to `defaultValue` explicitly rather than
      // silently landing on 0 for a setting whose real default is
      // something else. (Currently dead code: no number-kind device
      // setting has a `priorStorageKey` yet — guarded now rather than
      // left as a footgun for the first one that does.)
      const trimmed = raw.trim();
      if (trimmed === '') return defaultValue;
      const parsed = Number(trimmed);
      return (
        Number.isFinite(parsed) ? parsed : defaultValue
      ) as DeviceSettings[K];
    }
    case 'composite': {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPlainObject(parsed)) {
          return {
            ...(defaultValue as object),
            ...parsed,
          } as unknown as DeviceSettings[K];
        }
        return defaultValue;
      } catch {
        return defaultValue;
      }
    }
    default:
      return defaultValue;
  }
}

/**
 * The known boolean-field shape of each composite device setting — used
 * only to validate an IMPORTED composite value's structure (a
 * `{version:1, values:{inboxSections:null}}` file, or one with a non-
 * boolean field, must be dropped rather than accepted and later crash a
 * consumer that dereferences it). A field missing from the imported object
 * is tolerated (filled in from the registry default below); a field
 * present with the wrong type fails the whole value.
 *
 * `shortcutOverrides`/`modelPickerPreferences` are validated by their own
 * dedicated checks below (`validateShortcutOverrides`/
 * `validateModelPickerPreferences`) instead of this table — archive#settings-revamp: neither had a shape entry here
 * at all, so `structurallyValid` silently defaulted to `true` for ANY
 * plain object, letting a malformed import (e.g. `modelPickerPreferences.
 * order` as a string, or a `shortcutOverrides` binding with a non-string
 * `key`) persist and later crash a real consumer
 * (`SessionModelPicker.tsx`'s `preferences.order.map`,
 * `KeyboardShortcutsSection.tsx`'s `shortcut.key.toUpperCase`).
 */
const COMPOSITE_BOOLEAN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  featureSettings: [
    'ttsReadbackEnabled',
    'pushNotificationsEnabled',
    'voiceS2SEnabled',
    'mobilePairingEnabled',
  ],
  inboxSections: ['snoozed', 'earlier'],
  sidebarSections: [
    'openChatsCollapsed',
    'openChatsHidden',
    'draftsCollapsed',
    'draftsHidden',
  ],
};

function validateFeatureSettings(
  candidate: Record<string, unknown>,
): { valid: true; value: Record<string, unknown> } | { valid: false } {
  const booleanFields = COMPOSITE_BOOLEAN_FIELDS.featureSettings;
  if (
    booleanFields.some(
      (field) =>
        Object.hasOwn(candidate, field) &&
        typeof candidate[field] !== 'boolean',
    )
  ) {
    return { valid: false };
  }

  const sounds = candidate.notificationSounds;
  if (sounds !== undefined) {
    if (!isPlainObject(sounds)) return { valid: false };
    for (const category of NOTIFICATION_SOUND_CATEGORIES) {
      if (
        Object.hasOwn(sounds, category) &&
        !NOTIFICATION_SOUND_VALUES.includes(
          sounds[category] as NotificationSound,
        )
      ) {
        return { valid: false };
      }
    }
  }

  return { valid: true, value: candidate };
}

/**
 * Validates an imported `shortcutOverrides` composite: EVERY entry must be
 * a valid binding or `null` (`normalizePriorShortcutBinding` — shared with
 * the prior-root migration reader, archive#settings-revamp) or the whole
 * value is rejected, matching the field-level
 * (not per-entry) drop granularity every other composite in this module
 * uses. Valid imports are re-normalized (modifier de-dup) rather than
 * passed through raw.
 */
function validateShortcutOverrides(
  candidate: Record<string, unknown>,
): { valid: true; value: Record<string, unknown> } | { valid: false } {
  const normalized: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(candidate)) {
    const binding = normalizePriorShortcutBinding(raw);
    if (binding === undefined) return { valid: false };
    normalized[id] = binding;
  }
  return { valid: true, value: normalized };
}

const MODEL_PICKER_LIST_FIELDS = [
  'favorites',
  'recents',
  'hidden',
  'order',
] as const;

/**
 * Validates an imported `modelPickerPreferences` composite. Each of the
 * four list fields must be ABSENT or a genuine array — a present
 * wrong-TYPE field (e.g. `order: "not-an-array"`) fails the whole value
 * rather than being silently coerced to `[]` by `priorStringList` (which
 * is a lenient coercer for a value already known to be an array — see its
 * own doc comment, archive#settings-revamp).
 * A structurally-valid array is then sanitized through `priorStringList`
 * (shared with the prior-root migration reader), matching
 * `updateModelPickerPreferences`'s own 20-item `recents` cap.
 */
function validateModelPickerPreferences(
  candidate: Record<string, unknown>,
): { valid: true; value: Record<string, unknown> } | { valid: false } {
  const structurallyValid = MODEL_PICKER_LIST_FIELDS.every(
    (field) =>
      !Object.hasOwn(candidate, field) || Array.isArray(candidate[field]),
  );
  if (!structurallyValid) return { valid: false };
  return {
    valid: true,
    value: {
      favorites: priorStringList(candidate.favorites),
      recents: priorStringList(candidate.recents).slice(0, 20),
      hidden: priorStringList(candidate.hidden),
      order: priorStringList(candidate.order),
    },
  };
}

type ImportValidationOutcome<K extends keyof DeviceSettings> =
  | { valid: true; value: DeviceSettings[K] }
  | { valid: false };

/** Validates (and, for composites, default-fills) one imported value against its registry descriptor. */
function validateImportedValue<K extends keyof DeviceSettings>(
  definition: DeviceSettingDefinition<K>,
  candidate: unknown,
): ImportValidationOutcome<K> {
  const descriptor = definition.descriptor;
  switch (descriptor.kind) {
    case 'boolean':
      return typeof candidate === 'boolean'
        ? { valid: true, value: candidate as DeviceSettings[K] }
        : { valid: false };
    case 'enum':
      return typeof candidate === 'string' &&
        (descriptor.values as readonly string[]).includes(candidate)
        ? { valid: true, value: candidate as DeviceSettings[K] }
        : { valid: false };
    case 'string':
      if (candidate === null) {
        // `accentColor` and `chatDockProjectSlug` are the nullable
        // string-kind device settings — `null` is each one's legitimate
        // "no override"/"no project bound" value (archive#4525).
        return definition.key === 'accentColor' ||
          definition.key === 'chatDockProjectSlug'
          ? { valid: true, value: null as DeviceSettings[K] }
          : { valid: false };
      }
      return typeof candidate === 'string'
        ? { valid: true, value: candidate as DeviceSettings[K] }
        : { valid: false };
    case 'number': {
      if (candidate === null) {
        // `chatFontSize` is the one nullable number-kind device setting —
        // `null` is its legitimate "follow the Station default" value (see
        // the field doc on `DeviceSettings.chatFontSize`).
        return definition.key === 'chatFontSize'
          ? { valid: true, value: null as DeviceSettings[K] }
          : { valid: false };
      }
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        return { valid: false };
      }
      // archive#settings-revamp: an in-bounds
      // check was missing entirely — an imported `chatFontSize: 5000` (or
      // `-12`, or `3.7` against an `integer: true` descriptor) landed
      // unclamped into an inline `fontSize` style (ChatSettingsPanel's A−/A+
      // clamp is client-side only, not re-applied to an imported value).
      // Out-of-bounds/non-integer is dropped into `droppedKeys` — the
      // established import contract (every other kind fails the whole value
      // rather than silently coercing it into range).
      if (descriptor.integer && !Number.isInteger(candidate)) {
        return { valid: false };
      }
      if (descriptor.min !== undefined && candidate < descriptor.min) {
        return { valid: false };
      }
      if (descriptor.max !== undefined && candidate > descriptor.max) {
        return { valid: false };
      }
      return { valid: true, value: candidate as DeviceSettings[K] };
    }
    case 'composite': {
      if (!isPlainObject(candidate)) return { valid: false };

      if (definition.key === 'featureSettings') {
        const outcome = validateFeatureSettings(candidate);
        return outcome.valid
          ? {
              valid: true,
              value: {
                ...(definition.defaultValue as object),
                ...outcome.value,
                notificationSounds: {
                  ...(
                    definition.defaultValue as DeviceSettings['featureSettings']
                  ).notificationSounds,
                  ...(outcome.value.notificationSounds as object | undefined),
                },
              } as unknown as DeviceSettings[K],
            }
          : { valid: false };
      }

      if (
        definition.key === 'shortcutOverrides' ||
        definition.key === 'skillShortcuts'
      ) {
        const outcome = validateShortcutOverrides(candidate);
        return outcome.valid
          ? {
              valid: true,
              value: outcome.value as unknown as DeviceSettings[K],
            }
          : { valid: false };
      }
      if (definition.key === 'modelPickerPreferences') {
        const outcome = validateModelPickerPreferences(candidate);
        return outcome.valid
          ? {
              valid: true,
              value: outcome.value as unknown as DeviceSettings[K],
            }
          : { valid: false };
      }

      const fields = COMPOSITE_BOOLEAN_FIELDS[definition.key as string];
      const structurallyValid =
        !fields ||
        fields.every(
          (field) =>
            !Object.hasOwn(candidate, field) ||
            typeof candidate[field] === 'boolean',
        );
      if (!structurallyValid) return { valid: false };
      return {
        valid: true,
        value: {
          ...(definition.defaultValue as object),
          ...candidate,
        } as unknown as DeviceSettings[K],
      };
    }
    default:
      return { valid: false };
  }
}

/** Registry-driven filter for an imported `values` object: valid entries pass through (composites default-filled), invalid ones are dropped and reported. */
function sanitizeImportedValues(values: unknown): {
  values: Partial<DeviceSettings>;
  droppedKeys: (keyof DeviceSettings)[];
} {
  const result: Partial<DeviceSettings> = {};
  const droppedKeys: (keyof DeviceSettings)[] = [];
  if (!isPlainObject(values)) return { values: result, droppedKeys };

  for (const definition of DEVICE_SETTINGS_REGISTRY) {
    if (!Object.hasOwn(values, definition.key)) continue;
    const candidate = values[definition.key as string];
    const outcome = validateImportedValue(definition, candidate);
    if (outcome.valid) {
      (result as Record<string, unknown>)[definition.key] = outcome.value;
    } else {
      droppedKeys.push(definition.key);
    }
  }
  return { values: result, droppedKeys };
}

function isPlainEnvelopeShape(value: unknown): value is DeviceSettingsEnvelope {
  return (
    isPlainObject(value) &&
    typeof value.version === 'number' &&
    isPlainObject(value.values)
  );
}

/** Compares two resolved device-setting values (primitives or the small composite objects) for the same-value no-op check in `set`. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object'
  ) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * v1 -> v2 (archive#settings-revamp): for every
 * `priorRead`-bearing registry entry MISSING from an existing v1 envelope,
 * read its shared prior settings root, extract the value, and fold it in — the
 * targeted backfill for devices that already have a (slice-2, pre-slice-3)
 * envelope and therefore never run `migrateFromPriorStorage` at all.
 *
 * Mirrors `migrateFromPriorStorage`'s own quota-lossless contract: the migrated
 * envelope (with backfilled values, in memory) is always returned so this
 * session serves correct values either way; the shared prior settings root is
 * removed ONLY once the write of the migrated envelope is CONFIRMED to have
 * landed. A write failure leaves the prior settings root in place so the next call
 * retries from scratch (same "degraded but lossless" shape as
 * `migrateFromPriorStorage`). When there is nothing to backfill (no missing key,
 * or a missing key with no prior settings root data to recover), this is a clean,
 * write-free version bump.
 */
function migrateEnvelopeV1ToV2(
  envelope: DeviceSettingsEnvelope,
): DeviceSettingsEnvelope {
  const missingPriorReadDefinitions = DEVICE_SETTINGS_REGISTRY.filter(
    (definition) =>
      definition.priorRead && !Object.hasOwn(envelope.values, definition.key),
  );
  if (missingPriorReadDefinitions.length === 0) {
    return { ...envelope, version: 2 };
  }

  const sharedRootCache = new Map<string, Record<string, unknown> | null>();
  const backfilled: Partial<DeviceSettings> = {};
  const consumedPriorKeys = new Set<string>();
  for (const definition of missingPriorReadDefinitions) {
    // Every `priorRead`-bearing entry declares its shared `priorStorageKey`
    // (see that field's doc comment) — this guard is only for the type
    // (archive#settings-revamp made the field optional for the
    // no-prior-key entries added that slice, none of which declare
    // `priorRead`).
    const priorStorageKey = definition.priorStorageKey;
    if (!priorStorageKey) continue;
    if (!sharedRootCache.has(priorStorageKey)) {
      sharedRootCache.set(
        priorStorageKey,
        parsePriorSettingsRoot(readRaw(priorStorageKey)),
      );
    }
    const root = sharedRootCache.get(priorStorageKey);
    if (!root) continue;
    const extracted = definition.priorRead!(root);
    if (extracted === undefined) continue;
    (backfilled as Record<string, unknown>)[definition.key] = extracted;
    consumedPriorKeys.add(priorStorageKey);
  }

  const migrated: DeviceSettingsEnvelope = {
    version: 2,
    values: { ...envelope.values, ...backfilled },
  };

  // Nothing recovered from a prior settings root — a clean version bump, no I/O.
  if (consumedPriorKeys.size === 0) {
    return migrated;
  }

  const persisted = writeRaw(ENVELOPE_STORAGE_KEY, JSON.stringify(migrated));
  if (persisted) {
    for (const priorKey of consumedPriorKeys) removeRaw(priorKey);
  }
  return migrated;
}

/**
 * Version-migration ladder. Any envelope at or above the current version,
 * or with an unrecognized/malformed shape, is treated conservatively rather
 * than thrown away wholesale: unrecognized shapes fall back to an empty,
 * current-version envelope. (`importEnvelope` rejects a genuinely-future
 * version with a thrown error BEFORE calling this — so by
 * the time a future version reaches this loop it is only ever from the
 * general boot-time load path, which must never throw.)
 */
function runMigrationLadder(raw: unknown): DeviceSettingsEnvelope {
  if (!isPlainEnvelopeShape(raw)) {
    return { version: CURRENT_ENVELOPE_VERSION, values: {} };
  }
  let envelope: DeviceSettingsEnvelope = raw;
  while (envelope.version < CURRENT_ENVELOPE_VERSION) {
    switch (envelope.version) {
      case 1:
        envelope = migrateEnvelopeV1ToV2(envelope);
        break;
      default:
        envelope = { ...envelope, version: envelope.version + 1 };
    }
  }
  return envelope;
}

const DEFINITIONS_BY_KEY = new Map(
  DEVICE_SETTINGS_REGISTRY.map((definition) => [definition.key, definition]),
);

class DeviceSettingsStore {
  private envelope: DeviceSettingsEnvelope;
  private snapshot: DeviceSettings;
  private listeners = new Set<Listener>();
  private hydratedState: boolean;

  constructor() {
    // Hydration is synchronous in this environment (localStorage reads are
    // sync, there is no SSR boundary) — the flag still exists as its own
    // piece of state so consumers have an explicit "have we resolved
    // storage yet" signal rather than assuming it, and so a future
    // genuinely-async source (e.g. a native bridge) has somewhere to report
    // through without changing the public shape.
    this.hydratedState = false;
    this.envelope = this.loadOrMigrate();
    this.snapshot = this.resolve();
    this.hydratedState = true;

    // Cross-tab live sync + migration self-heal. Per spec (and
    // MDN), the `storage` event never fires in the document that made the
    // write — only in OTHER same-origin tabs/windows/iframes — so this
    // cannot loop on our own writes; no self-write guard is needed.
    if (hasLocalStorage() && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', this.handleStorageEvent);
    }
  }

  private loadOrMigrate(): DeviceSettingsEnvelope {
    const raw = readRaw(ENVELOPE_STORAGE_KEY);
    if (raw !== null) {
      try {
        return runMigrationLadder(JSON.parse(raw));
      } catch {
        return { version: CURRENT_ENVELOPE_VERSION, values: {} };
      }
    }
    return this.migrateFromPriorStorage();
  }

  /**
   * One-time: fold every present prior key into a new envelope. Prior
   * keys are removed ONLY once the envelope write is confirmed to have
   * landed (archive#settings-revamp) — `writeRaw`
   * used to be called and its result ignored, so a quota-full browser lost
   * every migrated setting permanently the moment this ran: the envelope
   * silently failed to persist, then the prior keys were deleted anyway.
   * On a failed write the prior keys stay in place (so the next boot's
   * migration retries from scratch) and this session still serves the
   * parsed values from memory via the returned envelope — degraded (every
   * write this session likely keeps failing for the same reason) but
   * lossless.
   */
  private migrateFromPriorStorage(): DeviceSettingsEnvelope {
    const values: Partial<DeviceSettings> = {};
    // A Set: entries sharing one priorStorageKey (archive#settings-revamp
    // slice 3 archive#1359 convergence — `shortcutOverrides`/`modelPickerPreferences`
    // both read `station.device-settings`) must only queue that key once.
    const migratedPriorKeys = new Set<string>();
    // Parsed-once cache for shared-root (`priorRead`) keys, keyed by
    // `priorStorageKey` — avoids re-reading/re-parsing the same raw value
    // once per sharer.
    const sharedRootCache = new Map<string, Record<string, unknown> | null>();

    for (const definition of DEVICE_SETTINGS_REGISTRY) {
      // archive#settings-revamp: a setting with neither `priorRead`
      // nor `priorStorageKey` was never persisted pre-unification (e.g.
      // `chatShowReasoning`, `chatFontSize`) — nothing to migrate for it.
      if (!definition.priorRead && !definition.priorStorageKey) continue;

      if (definition.priorRead) {
        const priorStorageKey = definition.priorStorageKey;
        if (!priorStorageKey) continue;
        if (!sharedRootCache.has(priorStorageKey)) {
          sharedRootCache.set(
            priorStorageKey,
            parsePriorSettingsRoot(readRaw(priorStorageKey)),
          );
        }
        const root = sharedRootCache.get(priorStorageKey);
        if (!root) continue;
        const extracted = definition.priorRead(root);
        if (extracted === undefined) continue;
        (values as Record<string, unknown>)[definition.key] = extracted;
        migratedPriorKeys.add(priorStorageKey);
        continue;
      }

      const priorStorageKey = definition.priorStorageKey as string;
      const priorRaw = readRaw(priorStorageKey);
      if (priorRaw === null) continue;
      (values as Record<string, unknown>)[definition.key] = parsePriorValue(
        definition.descriptor,
        priorRaw,
        definition.defaultValue,
      );
      migratedPriorKeys.add(priorStorageKey);
    }

    const envelope: DeviceSettingsEnvelope = {
      version: CURRENT_ENVELOPE_VERSION,
      values,
    };
    const persisted = writeRaw(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope));
    if (persisted) {
      for (const priorKey of migratedPriorKeys) removeRaw(priorKey);
    }
    return envelope;
  }

  /** Re-reads the persisted envelope fresh (this store's read-merge-write basis); falls back to the in-memory envelope when storage has nothing (or nothing readable) yet — e.g. a still-failing quota-full write from `migrateFromPriorStorage`. */
  private readPersistedEnvelope(): DeviceSettingsEnvelope {
    const raw = readRaw(ENVELOPE_STORAGE_KEY);
    if (raw === null) return this.envelope;
    try {
      return runMigrationLadder(JSON.parse(raw));
    } catch {
      return this.envelope;
    }
  }

  private resolveValue<K extends keyof DeviceSettings>(
    envelope: DeviceSettingsEnvelope,
    key: K,
  ): DeviceSettings[K] {
    return Object.hasOwn(envelope.values, key)
      ? ((envelope.values as Record<string, unknown>)[key] as DeviceSettings[K])
      : (DEFINITIONS_BY_KEY.get(key)!.defaultValue as DeviceSettings[K]);
  }

  private resolve(): DeviceSettings {
    const result = {} as Record<string, unknown>;
    for (const definition of DEVICE_SETTINGS_REGISTRY) {
      result[definition.key] = this.resolveValue(this.envelope, definition.key);
    }
    return result as unknown as DeviceSettings;
  }

  private persist(): void {
    writeRaw(ENVELOPE_STORAGE_KEY, JSON.stringify(this.envelope));
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
    // archive#settings-revamp (archive#1359 convergence): archive#1359's own
    // window-event name, kept as a generic "envelope changed" broadcast so
    // pre-convergence consumers that still listen for it directly
    // (`KeyboardShortcutsContext.tsx`, `modelPickerPreferences.ts`'s
    // `subscribe`) via
    // `shortcutPreferences.ts`/`modelPickerPreferences.ts` re-exports need
    // no changes.
    if (hasLocalStorage() && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(PRIOR_DEVICE_SETTINGS_EVENT));
    }
  }

  /** Adopts a freshly-computed envelope: sets it as current, re-resolves the snapshot, persists, and notifies. The one mutation path every public writer funnels through. */
  private applyEnvelope(envelope: DeviceSettingsEnvelope): void {
    this.envelope = envelope;
    this.snapshot = this.resolve();
    this.persist();
    this.notify();
  }

  private handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== ENVELOPE_STORAGE_KEY) return;
    const raw = event.newValue;
    if (raw === null) {
      this.envelope = { version: CURRENT_ENVELOPE_VERSION, values: {} };
    } else {
      try {
        this.envelope = runMigrationLadder(JSON.parse(raw));
      } catch {
        return; // Malformed external write — ignore, keep current state.
      }
    }
    this.snapshot = this.resolve();
    this.notify();
  };

  /**
   * Re-read the envelope from localStorage (running migration if the
   * envelope is absent), replace the in-memory state, and notify. This is
   * the same refresh the cross-tab `storage` listener performs, exposed for
   * callers that mutate localStorage outside the store's own API — chiefly
   * consumer TESTS that isolate with `localStorage.clear` in beforeEach:
   * the old per-key readers re-read localStorage on every mount, so
   * `clear` alone reset them, but this module-singleton's in-memory state
   * survives across tests unless explicitly reloaded (found via
   * ChatDockInboxPanel.test.tsx after the archive#1311 snooze tests landed).
   */
  reloadFromStorage = (): void => {
    this.envelope = this.loadOrMigrate();
    this.snapshot = this.resolve();
    this.notify();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DeviceSettings => this.snapshot;

  isHydrated = (): boolean => this.hydratedState;

  getEnvelope = (): DeviceSettingsEnvelope => this.envelope;

  /**
   * Adopts an imported envelope wholesale: throws
   * `DeviceSettingsImportVersionError` for a version newer than this app
   * understands rather than importing it unchanged; every present,
   * registry-known value is validated against its descriptor — invalid
   * ones (wrong type, `null` for a non-nullable field, a malformed
   * composite) are dropped rather than merged, and returned in the result
   * so the caller can report them.
   */
  importEnvelope = (input: unknown): DeviceSettingsImportResult => {
    const candidateVersion = isPlainObject(input) ? input.version : undefined;
    if (
      typeof candidateVersion === 'number' &&
      candidateVersion > CURRENT_ENVELOPE_VERSION
    ) {
      throw new DeviceSettingsImportVersionError(candidateVersion);
    }
    const laddered = runMigrationLadder(input);
    const { values, droppedKeys } = sanitizeImportedValues(laddered.values);
    this.applyEnvelope({ version: CURRENT_ENVELOPE_VERSION, values });
    return { droppedKeys };
  };

  /** Shallow-merges a partial value set into the FRESHLY-read persisted envelope (read-merge-write, not a blind overwrite from this tab's stale snapshot). */
  merge = (partial: Partial<DeviceSettings>): void => {
    const fresh = this.readPersistedEnvelope();
    this.applyEnvelope({
      ...fresh,
      values: { ...fresh.values, ...partial },
    });
  };

  get = <K extends keyof DeviceSettings>(key: K): DeviceSettings[K] =>
    this.snapshot[key];

  /** Read-merge-write; a value equal to the current FRESH value is a true no-op — no snapshot replacement, no persist, no notify. */
  set = <K extends keyof DeviceSettings>(
    key: K,
    value: DeviceSettings[K],
  ): void => {
    const fresh = this.readPersistedEnvelope();
    const currentValue = this.resolveValue(fresh, key);
    if (valuesEqual(currentValue, value)) return;

    this.applyEnvelope({
      ...fresh,
      values: { ...fresh.values, [key]: value },
    });
  };

  /** Clears an explicit override, falling back to the registry default. Read-merge-write. */
  reset = <K extends keyof DeviceSettings>(key: K): void => {
    const fresh = this.readPersistedEnvelope();
    if (!Object.hasOwn(fresh.values, key)) return;
    const nextValues = { ...fresh.values };
    delete nextValues[key];
    this.applyEnvelope({ ...fresh, values: nextValues });
  };
}

export const deviceSettingsStore = new DeviceSettingsStore();

/**
 * Pure, unit-testable boot-time theme resolution used by `main.tsx`'s
 * pre-render fast path (extracted so the fast path itself stays a couple of
 * lines). Reads the new envelope first (post-migration browsers); falls
 * back to the prior raw `theme` key for the one load where a pre-migration
 * browser hits this before the store singleton above has had a chance to
 * migrate it. Never throws on malformed input.
 */
export function resolveBootTheme(
  envelopeRaw: string | null,
  priorRaw: string | null,
): 'light' | 'dark' {
  if (envelopeRaw !== null) {
    try {
      const parsed = JSON.parse(envelopeRaw);
      const theme = parsed?.values?.theme;
      if (theme === 'light' || theme === 'dark') return theme;
    } catch {
      // Fall through to the prior/default path below.
    }
  }
  if (priorRaw === 'light' || priorRaw === 'dark') return priorRaw;
  return 'dark';
}

/**
 * Same envelope-then-prior-setting read order as `resolveBootTheme`, for the
 * accent-color pre-render fast path in `main.tsx`. Returns `null` (no
 * accent override) rather than throwing on malformed input.
 */
export function resolveBootAccentColor(
  envelopeRaw: string | null,
  priorRaw: string | null,
): string | null {
  if (envelopeRaw !== null) {
    try {
      const parsed = JSON.parse(envelopeRaw);
      const accentColor = parsed?.values?.accentColor;
      if (typeof accentColor === 'string' && accentColor) return accentColor;
      if (Object.hasOwn(parsed?.values ?? {}, 'accentColor')) return null;
    } catch {
      // Fall through to the prior/default path below.
    }
  }
  return priorRaw || null;
}
