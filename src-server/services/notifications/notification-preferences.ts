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
import { join } from 'node:path';
import {
  AGENT_NOTIFICATION_LEVELS,
  type AgentNotificationLevel,
  defaultNotificationPreferences,
  NOTIFICATION_ESCALATE_AFTER_MS_MAX,
  NOTIFICATION_URGENCIES,
  type NotificationPreferencesV1,
  type NotificationQuietHours,
  type NotificationSource,
  type NotificationSurfacePreference,
  type NotificationUrgency,
} from '@kontourai/station-contracts/notification';
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
}

export type NotificationPreferencesReadResult =
  | { ok: true; preferences: NotificationPreferencesV1; stored: boolean }
  | { ok: false; error: 'unreadable' };

/** The effective level for an agent source: agent over project over global. */
export function agentNotificationLevel(
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
  if (level === 'attention-only')
    return urgency !== undefined && urgency !== 'attention';
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

  isMuted(source: NotificationSource, urgency?: NotificationUrgency): boolean {
    return isNotificationSourceMuted(this.current(), source, urgency);
  }

  /** Validates, persists (0600, atomic) and only then serves the value. */
  write(value: unknown): NotificationPreferencesV1 {
    const preferences = parseNotificationPreferences(value);
    if (!preferences) throw new NotificationPreferencesInvalidError();
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
  if (
    keys.length !== 3 ||
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
  };
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
