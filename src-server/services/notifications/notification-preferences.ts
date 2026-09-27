/**
 * Notification delivery preferences (#2586): `notification-preferences.json`
 * in the Station home, 0600, `schemaVersion: 1`, strictly parsed.
 *
 * Read by the delivery router (every delivery), by the agent notification
 * gate (`isMuted`, #2584) and by `GET/PUT /api/notifications/preferences`.
 * The file has one writer — this process — so the parsed value is cached
 * and replaced on every successful write; an edit made to the file by hand
 * is read at the next start.
 *
 * A missing file means the defaults. A present file that fails custody or
 * the strict parse is NOT silently replaced by the defaults for the routes:
 * `read()` reports it, so the settings screen can say so instead of showing
 * a form that claims "all" while the person had chosen "off". Delivery,
 * which cannot stop to ask, uses the defaults and warns once.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  NOTIFICATION_URGENCIES,
  type NotificationSource,
  type NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import {
  AGENT_NOTIFICATION_LEVELS,
  type AgentNotificationLevel,
  defaultNotificationPreferences,
  NOTIFICATION_ESCALATE_AFTER_MS_MAX,
  type NotificationPreferencesPatch,
  type NotificationPreferencesV1,
  type NotificationQuietHours,
  type NotificationSurfacePreference,
} from '@kontourai/station-contracts/notification-preferences';
import { errorMessage } from '../../utils/error-message.js';
import {
  readPrivateJsonFile,
  writePrivateJsonFileSync,
} from './private-json-file.js';

export const NOTIFICATION_PREFERENCES_FILE = 'notification-preferences.json';
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 256;
const MAX_KEY_LENGTH = 200;
const SURFACE_ID_PATTERN = /^(device|local):[^\s:][^\s]{0,199}$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What the agent notification gate (#2584) reads before it stores anything.
 * `urgency` omitted asks only whether the source is switched off entirely.
 */
export interface NotificationMuteReader {
  isMuted(source: NotificationSource, urgency?: NotificationUrgency): boolean;
}

export interface NotificationPreferencesReader extends NotificationMuteReader {
  /** The preferences delivery applies now (defaults when unreadable). */
  current(): NotificationPreferencesV1;
  /**
   * The saved document exists but cannot be read. Delivery then cannot
   * honour the person's mutes or hidden-content choices, so it fails
   * closed: content hidden on every surface, agent notifications in-app
   * only (the defaults `current()` returns are NOT what the person chose).
   */
  unreadable(): boolean;
}

export type NotificationPreferencesReadResult =
  | { ok: true; preferences: NotificationPreferencesV1; stored: boolean }
  | { ok: false; error: 'unreadable' };

/** The effective level for an agent source: agent over project over global. */
function agentNotificationLevel(
  preferences: NotificationPreferencesV1,
  source: Extract<NotificationSource, { kind: 'agent' }>,
): AgentNotificationLevel {
  if (
    source.agent !== undefined &&
    Object.hasOwn(preferences.perAgent, source.agent)
  )
    return preferences.perAgent[source.agent]!;
  if (
    source.projectId !== undefined &&
    Object.hasOwn(preferences.perProject, source.projectId)
  )
    return preferences.perProject[source.projectId]!;
  return preferences.agentNotifications;
}

/**
 * Only agent sources can be muted: system and provider notifications
 * (approvals, pairing requests, job failures) are not the person's to mute
 * here, and muting them would hide a decision Station is waiting on.
 */
export function isNotificationSourceMuted(
  preferences: NotificationPreferencesV1,
  source: NotificationSource,
  urgency?: NotificationUrgency,
): boolean {
  if (source.kind !== 'agent') return false;
  const level = agentNotificationLevel(preferences, source);
  if (level === 'off') return true;
  // Failures pass too: like a request for input, a failure is something
  // the person acts on. `info` and `done` wait in the inbox.
  if (level === 'attention-only')
    return urgency === 'info' || urgency === 'done';
  return false;
}

/** Strict: unknown keys, wrong types and out-of-range values all refuse. */
export function parseNotificationPreferences(
  value: unknown,
): NotificationPreferencesV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowed = new Set([
    'schemaVersion',
    'agentNotifications',
    'perProject',
    'perAgent',
    'quietHours',
    'perSurface',
    'escalateAfterMs',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (!isLevel(value.agentNotifications)) return undefined;
  const perProject = parseLevelMap(value.perProject);
  const perAgent = parseLevelMap(value.perAgent);
  const perSurface = parseSurfaceMap(value.perSurface);
  if (!perProject || !perAgent || !perSurface) return undefined;
  const escalateAfterMs = value.escalateAfterMs;
  if (
    typeof escalateAfterMs !== 'number' ||
    !Number.isInteger(escalateAfterMs) ||
    escalateAfterMs < 0 ||
    escalateAfterMs > NOTIFICATION_ESCALATE_AFTER_MS_MAX
  )
    return undefined;
  let quietHours: NotificationQuietHours | undefined;
  if (value.quietHours !== undefined) {
    quietHours = parseQuietHours(value.quietHours);
    if (!quietHours) return undefined;
  }
  return {
    schemaVersion: 1,
    agentNotifications: value.agentNotifications,
    perProject,
    perAgent,
    ...(quietHours ? { quietHours } : {}),
    perSurface,
    escalateAfterMs,
  };
}

interface NotificationPreferencesLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export class NotificationPreferencesStore
  implements NotificationPreferencesReader
{
  readonly #path: string;
  readonly #logger: NotificationPreferencesLogger | undefined;
  #cached: NotificationPreferencesReadResult | undefined;
  #warnedUnreadable = false;

  constructor(homeDir: string, logger?: NotificationPreferencesLogger) {
    this.#path = join(homeDir, NOTIFICATION_PREFERENCES_FILE);
    this.#logger = logger;
  }

  read(): NotificationPreferencesReadResult {
    if (this.#cached) return this.#cached;
    let raw: unknown;
    try {
      raw = readPrivateJsonFile(
        this.#path,
        MAX_BYTES,
        'notification preferences',
      );
    } catch {
      // Not cached: a repaired file is picked up on the next read.
      return { ok: false, error: 'unreadable' };
    }
    if (raw === null) {
      this.#cached = {
        ok: true,
        preferences: defaultNotificationPreferences(),
        stored: false,
      };
      return this.#cached;
    }
    const preferences = parseNotificationPreferences(raw);
    if (!preferences) return { ok: false, error: 'unreadable' };
    this.#cached = { ok: true, preferences, stored: true };
    return this.#cached;
  }

  current(): NotificationPreferencesV1 {
    const result = this.read();
    if (result.ok) return result.preferences;
    if (!this.#warnedUnreadable) {
      this.#warnedUnreadable = true;
      this.#logger?.warn(
        'notification preferences are unreadable; delivering with the defaults until they are saved again',
      );
    }
    return defaultNotificationPreferences();
  }

  /**
   * The stored document's revision (the ETag): a content hash, or
   * {@link UNREADABLE_PREFERENCES_REVISION} while the file cannot be read —
   * so a reset of an unreadable file is itself a compare-and-swap (it fails
   * if someone repaired the file in between).
   */
  revision(): string {
    const current = this.read();
    return current.ok
      ? preferencesRevision(current.preferences)
      : UNREADABLE_PREFERENCES_REVISION;
  }

  unreadable(): boolean {
    return !this.read().ok;
  }

  isMuted(source: NotificationSource, urgency?: NotificationUrgency): boolean {
    return isNotificationSourceMuted(this.current(), source, urgency);
  }

  /**
   * Validates, persists (0600, atomic) and only then serves the value. With
   * `ifMatch`, refuses unless the stored document is still that revision
   * (compare-and-swap for read-modify-write clients).
   */
  write(
    value: unknown,
    options: { ifMatch?: string } = {},
  ): NotificationPreferencesV1 {
    const preferences = parseNotificationPreferences(value);
    if (!preferences) throw new NotificationPreferencesInvalidError();
    if (options.ifMatch !== undefined && this.revision() !== options.ifMatch)
      throw new NotificationPreferencesConflictError();
    return this.#persist(preferences);
  }

  /**
   * Applies a partial update to the stored document in one synchronous
   * step (this process is the only writer), so concurrent patches — a mute
   * from the inbox and a settings edit — never lose each other. Refused
   * while the stored document is unreadable: patching the defaults would
   * silently discard what the person had saved.
   */
  patch(
    value: unknown,
    options: { ifMatch?: string } = {},
  ): NotificationPreferencesV1 {
    const current = this.read();
    if (!current.ok) throw new NotificationPreferencesConflictError();
    if (options.ifMatch !== undefined && this.revision() !== options.ifMatch)
      throw new NotificationPreferencesConflictError();
    const next = applyNotificationPreferencesPatch(current.preferences, value);
    if (!next) throw new NotificationPreferencesInvalidError();
    return this.#persist(next);
  }

  #persist(preferences: NotificationPreferencesV1): NotificationPreferencesV1 {
    try {
      writePrivateJsonFileSync(
        this.#path,
        preferences,
        MAX_BYTES,
        'notification preferences',
      );
    } catch (error) {
      this.#logger?.warn('notification preferences could not be saved', {
        error: errorMessage(error),
      });
      throw error;
    }
    this.#cached = { ok: true, preferences, stored: true };
    this.#warnedUnreadable = false;
    return preferences;
  }
}

export class NotificationPreferencesInvalidError extends Error {
  constructor() {
    super('Notification preferences are invalid');
  }
}

/** The stored document changed (or is unreadable) since the caller read it. */
export class NotificationPreferencesConflictError extends Error {
  constructor() {
    super('Notification preferences changed');
  }
}

const UNREADABLE_PREFERENCES_REVISION = '"unreadable"';

/** Content revision, served as the ETag and checked by `If-Match`. */
export function preferencesRevision(
  preferences: NotificationPreferencesV1,
): string {
  return `"${createHash('sha256').update(JSON.stringify(preferences)).digest('hex').slice(0, 32)}"`;
}

const PATCH_KEYS = new Set([
  'agentNotifications',
  'perProject',
  'perAgent',
  'perSurface',
  'quietHours',
  'escalateAfterMs',
]);

/**
 * The patched document, or undefined when the patch (or its result) is
 * invalid. The result goes through the same strict parse as a full write.
 */
export function applyNotificationPreferencesPatch(
  current: NotificationPreferencesV1,
  patch: unknown,
): NotificationPreferencesV1 | undefined {
  if (!isPlainRecord(patch)) return undefined;
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !PATCH_KEYS.has(key)))
    return undefined;
  const next: Record<string, unknown> = { ...current };
  for (const key of keys) {
    const value = (
      patch as NotificationPreferencesPatch & Record<string, unknown>
    )[key];
    if (key === 'perProject' || key === 'perAgent' || key === 'perSurface') {
      if (!isPlainRecord(value)) return undefined;
      const merged: Array<[string, unknown]> = Object.entries(
        current[key] as Record<string, unknown>,
      ).filter(([name]) => !Object.hasOwn(value, name));
      for (const [name, entry] of Object.entries(value))
        if (entry !== null) merged.push([name, entry]);
      next[key] = Object.fromEntries(merged);
    } else if (key === 'quietHours') {
      if (value === null) delete next.quietHours;
      else next.quietHours = value;
    } else {
      next[key] = value;
    }
  }
  return parseNotificationPreferences(next);
}

function parseLevelMap(
  value: unknown,
): Record<string, AgentNotificationLevel> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) return undefined;
  for (const [key, level] of entries)
    if (!isKey(key) || !isLevel(level)) return undefined;
  // fromEntries defines own properties, so a `__proto__` key stays data.
  return Object.fromEntries(entries) as Record<string, AgentNotificationLevel>;
}

function parseSurfaceMap(
  value: unknown,
): Record<string, NotificationSurfacePreference> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) return undefined;
  const parsed: Array<[string, NotificationSurfacePreference]> = [];
  for (const [key, entry] of entries) {
    if (!SURFACE_ID_PATTERN.test(key) || !isPlainRecord(entry))
      return undefined;
    const keys = Object.keys(entry);
    if (
      keys.length !== 2 ||
      !isUrgency(entry.minUrgency) ||
      typeof entry.hideContent !== 'boolean'
    )
      return undefined;
    parsed.push([
      key,
      { minUrgency: entry.minUrgency, hideContent: entry.hideContent },
    ]);
  }
  return Object.fromEntries(parsed);
}

function parseQuietHours(value: unknown): NotificationQuietHours | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = Object.keys(value);
  const hasZone = Object.hasOwn(value, 'timeZone');
  if (
    keys.length !== (hasZone ? 4 : 3) ||
    (hasZone && !isTimeZone(value.timeZone)) ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    !CLOCK_PATTERN.test(value.start) ||
    !CLOCK_PATTERN.test(value.end) ||
    // An empty window is not a quiet-hours setting; absent says "none".
    value.start === value.end ||
    typeof value.allowAttention !== 'boolean'
  )
    return undefined;
  return {
    start: value.start,
    end: value.end,
    allowAttention: value.allowAttention,
    ...(hasZone ? { timeZone: value.timeZone as string } : {}),
  };
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && key.trim() === key;
}

function isLevel(value: unknown): value is AgentNotificationLevel {
  return (AGENT_NOTIFICATION_LEVELS as readonly unknown[]).includes(value);
}

function isUrgency(value: unknown): value is NotificationUrgency {
  return (NOTIFICATION_URGENCIES as readonly unknown[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
