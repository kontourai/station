/**
 * Readers, the write validator, and small builders for the unified
 * notification envelope (#2582 / #2583). The shapes live in
 * `@kontourai/station-contracts/notification`; the contracts package carries
 * no parsers, so they live here, importable from server and UI.
 *
 * Reads are lenient, writes are strict:
 * - `readNotificationEnvelope` / `parseNotificationEnvelope` accept any v1
 *   envelope a newer build could have written: unknown keys are ignored at
 *   every level, and an unknown source/audience/target KIND fails closed
 *   (source → `{kind:'unknown'}`, audience → owner, target → omitted; an
 *   unknown source or audience also forces `interrupt: 'silent'`, i.e.
 *   in-app only). A known field with an invalid value rejects the whole
 *   envelope — a reader that kept the valid fields would present a label next
 *   to data it could not vouch for. Neither ever throws.
 *   Consumers (the delivery router) must treat an unknown audience as the
 *   owner's in-app view only — never push — since nothing resolved who it
 *   was meant for; the forced `silent` carries that.
 * - `parseNotificationEnvelopeForWrite` is what a producer's envelope must
 *   pass: exact keys, known kinds only, no `principal` audience (no resolver
 *   exists yet), and no read/dismiss markers (only the service sets those).
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
  type SurfaceId,
} from '@kontourai/station-contracts/notification';

type Fields = Record<string, unknown>;
type Mode = 'read' | 'write';

/** Dedupe tags with this prefix belong to the trusted (enveloped) write path. */
export const AGENT_NOTIFICATION_DEDUPE_PREFIX = 'agent:';
/** Categories with this prefix belong to the trusted (enveloped) write path. */
export const AGENT_NOTIFICATION_CATEGORY_PREFIX = 'agent-';

/** Reads `n.metadata.envelope`; `undefined` when absent, not v1, or malformed. */
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
 * Lenient v1 read of an envelope value. Returns a fresh normalized object
 * (never the input). An optional key holding `undefined` counts as absent.
 */
export function parseNotificationEnvelope(
  value: unknown,
): NotificationEnvelopeV1 | undefined {
  try {
    return parseEnvelope(value, 'read');
  } catch {
    return undefined;
  }
}

/** Strict validation of a producer-supplied envelope; `undefined` if refused. */
export function parseNotificationEnvelopeForWrite(
  value: unknown,
): NotificationEnvelopeV1 | undefined {
  try {
    return parseEnvelope(value, 'write');
  } catch {
    return undefined;
  }
}

function parseEnvelope(
  value: unknown,
  mode: Mode,
): NotificationEnvelopeV1 | undefined {
  const fields = knownFields(
    value,
    mode,
    ['v', 'source', 'audience', 'urgency', 'interrupt'],
    ['target', 'readAt', 'readBy', 'dismissedAt', 'dismissedBy'],
  );
  if (fields?.v !== 1) return undefined;
  const source = parseSource(fields.source, mode);
  const audience = parseAudience(fields.audience, mode);
  if (!source || !audience) return undefined;
  if (!isUrgency(fields.urgency)) return undefined;
  if (fields.interrupt !== 'default' && fields.interrupt !== 'silent')
    return undefined;
  let target: NotificationTarget | undefined;
  if (fields.target !== undefined) {
    const parsed = parseTarget(fields.target, mode);
    if (!parsed) return undefined;
    target = parsed === UNKNOWN_KIND ? undefined : parsed;
  }
  const read = parseMark(fields.readAt, fields.readBy);
  const dismissed = parseMark(fields.dismissedAt, fields.dismissedBy);
  if (!read || !dismissed) return undefined;
  if (mode === 'write' && (read.at || dismissed.at)) return undefined;
  const failClosed = source.kind === 'unknown' || audience === UNKNOWN_KIND;
  return {
    v: 1,
    source,
    audience: audience === UNKNOWN_KIND ? { kind: 'owner' } : audience,
    urgency: fields.urgency,
    ...(target ? { target } : {}),
    interrupt: failClosed ? 'silent' : fields.interrupt,
    ...(read.at ? { readAt: read.at, readBy: read.by } : {}),
    ...(dismissed.at
      ? { dismissedAt: dismissed.at, dismissedBy: dismissed.by }
      : {}),
  };
}

const UNKNOWN_KIND = Symbol('unknown-kind');

/** The record's `kind`, or UNKNOWN_KIND for a string this build doesn't know. */
function kindOf(
  value: unknown,
  known: readonly string[],
  mode: Mode,
): string | typeof UNKNOWN_KIND | undefined {
  if (!isPlainRecord(value) || !isCanonicalText(value.kind)) return undefined;
  if (known.includes(value.kind)) return value.kind;
  return mode === 'read' ? UNKNOWN_KIND : undefined;
}

function parseSource(
  value: unknown,
  mode: Mode,
): NotificationSource | undefined {
  const kind = kindOf(value, ['agent', 'system', 'provider'], mode);
  if (kind === UNKNOWN_KIND) {
    return { kind: 'unknown', observedKind: (value as Fields).kind as string };
  }
  if (kind === 'agent') {
    const fields = knownFields(
      value,
      mode,
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
    const fields = knownFields(value, mode, ['kind', 'subsystem'], []);
    if (!fields || !isCanonicalText(fields.subsystem)) return undefined;
    return { kind: 'system', subsystem: fields.subsystem };
  }
  if (kind === 'provider') {
    const fields = knownFields(value, mode, ['kind', 'providerId'], []);
    if (!fields || !isCanonicalText(fields.providerId)) return undefined;
    return { kind: 'provider', providerId: fields.providerId };
  }
  return undefined;
}

function parseAudience(
  value: unknown,
  mode: Mode,
): NotificationAudience | typeof UNKNOWN_KIND | undefined {
  // No resolver turns a principal audience into surfaces yet, so a producer
  // may not write one; a newer build's record still reads.
  const known =
    mode === 'write'
      ? ['owner', 'session-readers']
      : ['owner', 'session-readers', 'principal'];
  const kind = kindOf(value, known, mode);
  if (kind === UNKNOWN_KIND) return UNKNOWN_KIND;
  if (kind === 'owner') {
    return knownFields(value, mode, ['kind'], [])
      ? { kind: 'owner' }
      : undefined;
  }
  if (kind === 'session-readers') {
    const fields = knownFields(value, mode, ['kind', 'sessionId'], []);
    if (!fields || !isCanonicalText(fields.sessionId)) return undefined;
    return { kind: 'session-readers', sessionId: fields.sessionId };
  }
  if (kind === 'principal') {
    const fields = knownFields(value, mode, ['kind', 'principalId'], []);
    if (!fields || !isCanonicalText(fields.principalId)) return undefined;
    return { kind: 'principal', principalId: fields.principalId };
  }
  return undefined;
}

function parseTarget(
  value: unknown,
  mode: Mode,
): NotificationTarget | typeof UNKNOWN_KIND | undefined {
  const kind = kindOf(value, ['session', 'path'], mode);
  if (kind === UNKNOWN_KIND) return UNKNOWN_KIND;
  if (kind === 'session') {
    const fields = knownFields(value, mode, ['kind', 'sessionId'], []);
    if (!fields || !isCanonicalText(fields.sessionId)) return undefined;
    return { kind: 'session', sessionId: fields.sessionId };
  }
  if (kind === 'path') {
    const fields = knownFields(value, mode, ['kind', 'path'], []);
    if (!fields || !isRelativeStationPath(fields.path)) return undefined;
    return { kind: 'path', path: fields.path };
  }
  return undefined;
}

/** `at`/`by` travel together: a timestamp without its surface is rejected. */
function parseMark(
  at: unknown,
  by: unknown,
): { at?: string; by?: SurfaceId } | undefined {
  if (at === undefined && by === undefined) return {};
  if (!isCanonicalTimestamp(at) || !isSurfaceId(by)) return undefined;
  return { at, by };
}

/** `device:<id>` or `local:<clientSessionId>`, no surrounding whitespace. */
export function isSurfaceId(value: unknown): value is SurfaceId {
  return (
    isCanonicalText(value) &&
    /^(device|local):\S+$/.test(value) &&
    value.length <= 256
  );
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
 * shares its root's namespace. The `agent:` prefix is reserved to the
 * service's trusted enveloped write path.
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
  return `${AGENT_NOTIFICATION_DEDUPE_PREFIX}${rootSessionId}:${dedupeKey}`;
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

/**
 * The record's known fields, or `undefined` when a required one is missing.
 * In write mode an unknown key rejects; in read mode it is ignored.
 */
function knownFields(
  value: unknown,
  mode: Mode,
  required: readonly string[],
  optional: readonly string[],
): Fields | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (mode === 'write') {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return undefined;
    }
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
