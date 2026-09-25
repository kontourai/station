/**
 * Strict reader and small builders for the unified notification envelope
 * (#2582 / #2583). The shapes live in
 * `@kontourai/station-contracts/notification`; the contracts package carries
 * no parsers, so the reader lives here, importable from server and UI.
 *
 * `readNotificationEnvelope` never throws: a missing or malformed envelope is
 * `undefined`, and callers treat that record as legacy (owner audience,
 * urgency derived from its category). A partly valid envelope is rejected
 * whole — a reader that kept the valid fields would present a label (an
 * urgency, a source) next to data it could not vouch for.
 */
import {
  AGENT_NOTIFICATION_CATEGORIES,
  type AgentNotificationCategory,
  NOTIFICATION_DEDUPE_KEY_PATTERN,
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_URGENCIES,
  type Notification,
  type NotificationAudience,
  type NotificationEnvelopeV1,
  type NotificationPriority,
  type NotificationSource,
  type NotificationTarget,
  type NotificationUrgency,
} from '@kontourai/station-contracts/notification';

type Fields = Record<string, unknown>;

/** Reads `n.metadata.envelope`; `undefined` when absent or malformed. */
export function readNotificationEnvelope(
  notification: Pick<Notification, 'metadata'> | null | undefined,
): NotificationEnvelopeV1 | undefined {
  try {
    const metadata = notification?.metadata;
    if (!isPlainRecord(metadata)) return undefined;
    return parseNotificationEnvelope(metadata.envelope);
  } catch {
    return undefined;
  }
}

/**
 * Strictly parses an envelope value. Returns a fresh object (never the input)
 * with absent optional fields omitted. An optional key present with the value
 * `undefined` counts as absent — such a key cannot survive JSON persistence,
 * and in-memory callers assemble envelopes from optional values.
 */
export function parseNotificationEnvelope(
  value: unknown,
): NotificationEnvelopeV1 | undefined {
  try {
    return parseEnvelope(value);
  } catch {
    return undefined;
  }
}

function parseEnvelope(value: unknown): NotificationEnvelopeV1 | undefined {
  const fields = exactFields(
    value,
    ['v', 'source', 'audience', 'urgency', 'interrupt'],
    ['target', 'readAt', 'readBy', 'dismissedAt', 'dismissedBy'],
  );
  if (fields?.v !== 1) return undefined;
  const source = parseSource(fields.source);
  const audience = parseAudience(fields.audience);
  if (!source || !audience) return undefined;
  if (!isUrgency(fields.urgency)) return undefined;
  if (fields.interrupt !== 'default' && fields.interrupt !== 'silent')
    return undefined;
  let target: NotificationTarget | undefined;
  if (fields.target !== undefined) {
    target = parseTarget(fields.target);
    if (!target) return undefined;
  }
  const read = parseMark(fields.readAt, fields.readBy);
  const dismissed = parseMark(fields.dismissedAt, fields.dismissedBy);
  if (!read || !dismissed) return undefined;
  return {
    v: 1,
    source,
    audience,
    urgency: fields.urgency,
    ...(target ? { target } : {}),
    interrupt: fields.interrupt,
    ...(read.at ? { readAt: read.at, readBy: read.by } : {}),
    ...(dismissed.at
      ? { dismissedAt: dismissed.at, dismissedBy: dismissed.by }
      : {}),
  };
}

function parseSource(value: unknown): NotificationSource | undefined {
  const kind = isPlainRecord(value) ? value.kind : undefined;
  if (kind === 'agent') {
    const fields = exactFields(
      value,
      ['kind', 'sessionId', 'assurance'],
      ['projectId', 'agent', 'conversationId'],
    );
    if (
      !fields ||
      !isCanonicalText(fields.sessionId) ||
      (fields.assurance !== 'bound' &&
        fields.assurance !== 'delegated-custody' &&
        fields.assurance !== 'bearer-exposed')
    ) {
      return undefined;
    }
    for (const key of ['projectId', 'agent', 'conversationId'] as const) {
      if (fields[key] !== undefined && !isCanonicalText(fields[key]))
        return undefined;
    }
    return {
      kind: 'agent',
      sessionId: fields.sessionId,
      ...optionalText(fields, 'projectId'),
      ...optionalText(fields, 'agent'),
      ...optionalText(fields, 'conversationId'),
      assurance: fields.assurance,
    };
  }
  if (kind === 'system') {
    const fields = exactFields(value, ['kind', 'subsystem'], []);
    if (!fields || !isCanonicalText(fields.subsystem)) return undefined;
    return { kind: 'system', subsystem: fields.subsystem };
  }
  if (kind === 'provider') {
    const fields = exactFields(value, ['kind', 'providerId'], []);
    if (!fields || !isCanonicalText(fields.providerId)) return undefined;
    return { kind: 'provider', providerId: fields.providerId };
  }
  return undefined;
}

function parseAudience(value: unknown): NotificationAudience | undefined {
  const kind = isPlainRecord(value) ? value.kind : undefined;
  if (kind === 'owner') {
    return exactFields(value, ['kind'], []) ? { kind: 'owner' } : undefined;
  }
  if (kind === 'session-readers') {
    const fields = exactFields(value, ['kind', 'sessionId'], []);
    if (!fields || !isCanonicalText(fields.sessionId)) return undefined;
    return { kind: 'session-readers', sessionId: fields.sessionId };
  }
  if (kind === 'principal') {
    const fields = exactFields(value, ['kind', 'principalId'], []);
    if (!fields || !isCanonicalText(fields.principalId)) return undefined;
    return { kind: 'principal', principalId: fields.principalId };
  }
  return undefined;
}

function parseTarget(value: unknown): NotificationTarget | undefined {
  const kind = isPlainRecord(value) ? value.kind : undefined;
  if (kind === 'session') {
    const fields = exactFields(value, ['kind', 'sessionId'], []);
    if (!fields || !isCanonicalText(fields.sessionId)) return undefined;
    return { kind: 'session', sessionId: fields.sessionId };
  }
  if (kind === 'path') {
    const fields = exactFields(value, ['kind', 'path'], []);
    if (!fields || !isRelativeStationPath(fields.path)) return undefined;
    return { kind: 'path', path: fields.path };
  }
  return undefined;
}

/** `at`/`by` travel together: a timestamp without its reader is rejected. */
function parseMark(
  at: unknown,
  by: unknown,
): { at?: string; by?: string } | undefined {
  if (at === undefined && by === undefined) return {};
  if (!isCanonicalTimestamp(at) || !isCanonicalText(by)) return undefined;
  return { at, by };
}

/**
 * Same-origin relative path only: leading `/`, never protocol-relative
 * (`//host`), no backslash (some browsers coerce `/\host` to `//host`), no
 * whitespace or control characters, bounded length.
 */
export function isRelativeStationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= NOTIFICATION_LINK_MAX &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Global store dedupe tag for an agent notification. Tags are global and a
 * dismissed tag is final, so an agent's key is namespaced by its ROOT session:
 * two sessions choosing the same key never collide, and a delegated child
 * shares its root's namespace.
 */
export function agentNotificationDedupeTag(
  rootSessionId: string,
  dedupeKey: string,
): string {
  if (!isCanonicalText(rootSessionId) || rootSessionId.includes(':')) {
    throw new RangeError('agent notification root session id is invalid');
  }
  if (!NOTIFICATION_DEDUPE_KEY_PATTERN.test(dedupeKey)) {
    throw new RangeError('agent notification dedupe key is invalid');
  }
  return `agent:${rootSessionId}:${dedupeKey}`;
}

export function agentNotificationCategory(
  urgency: NotificationUrgency,
): AgentNotificationCategory {
  return AGENT_NOTIFICATION_CATEGORIES[urgency];
}

/** attention/failed are high priority; info/done normal. */
export function notificationPriorityForUrgency(
  urgency: NotificationUrgency,
): NotificationPriority {
  return urgency === 'attention' || urgency === 'failed' ? 'high' : 'normal';
}

function exactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Fields | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return undefined;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key) || value[key] === undefined)
      return undefined;
  }
  return value;
}

function optionalText(
  fields: Fields,
  key: string,
): Record<string, string> | Record<string, never> {
  const value = fields[key];
  return typeof value === 'string' ? { [key]: value } : {};
}

function isPlainRecord(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUrgency(value: unknown): value is NotificationUrgency {
  return (NOTIFICATION_URGENCIES as readonly unknown[]).includes(value);
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
