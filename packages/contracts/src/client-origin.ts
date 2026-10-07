/**
 * Bounded provenance for one user-issued Station request.
 *
 * `reported` is supplied by the client and is display-only. `actor` is
 * resolved after authentication by Station. Neither field grants authority.
 */
export const CLIENT_ORIGIN_VERSION = 1 as const;
export const CLIENT_ORIGIN_HEADER = 'X-Station-Client-Origin';

export const CLIENT_ORIGIN_SURFACES = [
  'web',
  'desktop',
  'mobile',
  'cli',
  'mcp',
  'unknown',
] as const;
export type ClientOriginSurface = (typeof CLIENT_ORIGIN_SURFACES)[number];

export type ClientOriginActor =
  | { kind: 'operator' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'internal' }
  | { kind: 'unknown' };

export interface ClientReportedOrigin {
  version: typeof CLIENT_ORIGIN_VERSION;
  surface: ClientOriginSurface;
  /** Bounded release/build identifier, never a user-agent. */
  build: string | null;
}

/**
 * #3419: who a non-person message is FROM, beside the `actor` that says it
 * was not a person. Stamped by the server from the verified caller, never
 * read from a request header or body, so it is provenance and never
 * authority: `actor` alone decides whether a turn was a person's.
 *
 * `agent-session` identifies an agent in another Session
 * messaging this one (`send_to_session`). `provider` identifies an engine-opened
 * turn; `delegation-result` identifies a result from a child Session. The
 * coordinator and a scheduled job are expected to join as further kinds; a
 * reader that does not know a kind drops the sender
 * ({@link clientOriginSender}) and keeps the `actor`, so a newer writer's
 * record still reads as the non-person it is.
 */
export const CLIENT_ORIGIN_SENDER_KINDS = [
  'agent-session',
  'delegation-result',
  'provider',
  'unattributed',
] as const;
export type ClientOriginSenderKind =
  (typeof CLIENT_ORIGIN_SENDER_KINDS)[number];

export interface ClientOriginSender {
  kind: ClientOriginSenderKind;
  /** The sending Session. */
  sessionId: string;
  /** The sender's Session title when it had one, as of the send. */
  title?: string;
  /** The sender's Agent (display name or slug), as of the send. */
  agent?: string;
  /** The sender's engine (`claude`, `codex`, ...). */
  engine?: string;
  /**
   * The sending tool call's idempotency key (`send_to_session`'s
   * `requestKey`). The engine's own tool-call id is not visible to Station's
   * tool server, but this key is in the call's arguments, so it identifies
   * the exact call in the sender's transcript.
   */
  requestKey?: string;
}

export interface ClientOrigin {
  version: typeof CLIENT_ORIGIN_VERSION;
  actor: ClientOriginActor;
  reported: ClientReportedOrigin;
  /** Present only on a message another agent delivered; see {@link ClientOriginSender}. */
  sender?: ClientOriginSender;
}

const MAX_SENDER_ID_LENGTH = 512;
const MAX_SENDER_TITLE_LENGTH = 120;
const MAX_SENDER_LABEL_LENGTH = 80;
const MAX_SENDER_REQUEST_KEY_LENGTH = 128;

function senderText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return undefined;
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * The sender a server-composed origin records, or undefined when it has none
 * or names a kind this build does not know. Text is bounded and flattened to
 * one line: it is display text from a Session the sender's owner controls.
 */
export function clientOriginSender(
  origin: { sender?: unknown } | undefined,
): ClientOriginSender | undefined {
  const value = origin?.sender;
  if (!isRecord(value)) return undefined;
  if (
    !CLIENT_ORIGIN_SENDER_KINDS.includes(value.kind as ClientOriginSenderKind)
  )
    return undefined;
  if (
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > MAX_SENDER_ID_LENGTH
  )
    return undefined;
  const title = senderText(value.title, MAX_SENDER_TITLE_LENGTH);
  const agent = senderText(value.agent, MAX_SENDER_LABEL_LENGTH);
  const engine = senderText(value.engine, MAX_SENDER_LABEL_LENGTH);
  const requestKey = senderText(
    value.requestKey,
    MAX_SENDER_REQUEST_KEY_LENGTH,
  );
  return {
    kind: value.kind as ClientOriginSenderKind,
    sessionId: value.sessionId,
    ...(title ? { title } : {}),
    ...(agent ? { agent } : {}),
    ...(engine ? { engine } : {}),
    ...(requestKey ? { requestKey } : {}),
  };
}

export const UNKNOWN_CLIENT_REPORTED_ORIGIN: ClientReportedOrigin =
  Object.freeze({
    version: CLIENT_ORIGIN_VERSION,
    surface: 'unknown',
    build: null,
  });

export const UNKNOWN_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: { kind: 'unknown' as const },
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

const MAX_BUILD_LENGTH = 160;

/** Serialize the closed, versioned request header. */
export function serializeClientReportedOrigin(
  origin: ClientReportedOrigin,
): string | undefined {
  if (
    origin.version !== CLIENT_ORIGIN_VERSION ||
    !CLIENT_ORIGIN_SURFACES.includes(origin.surface) ||
    (origin.build !== null && !isSafeBuild(origin.build))
  ) {
    return undefined;
  }
  return origin.build === null
    ? `${CLIENT_ORIGIN_VERSION};${origin.surface}`
    : `${CLIENT_ORIGIN_VERSION};${origin.surface};${origin.build}`;
}

/** Missing, malformed, and unsupported versions intentionally read unknown. */
export function parseClientReportedOrigin(
  value: string | undefined,
): ClientReportedOrigin {
  if (!value || value.length > MAX_BUILD_LENGTH + 16) {
    return UNKNOWN_CLIENT_REPORTED_ORIGIN;
  }
  const [version, surface, build, extra] = value.split(';');
  if (
    version !== String(CLIENT_ORIGIN_VERSION) ||
    extra !== undefined ||
    !CLIENT_ORIGIN_SURFACES.includes(surface as ClientOriginSurface) ||
    surface === 'unknown' ||
    (build !== undefined && !isSafeBuild(build))
  ) {
    return UNKNOWN_CLIENT_REPORTED_ORIGIN;
  }
  return {
    version: CLIENT_ORIGIN_VERSION,
    surface: surface as ClientOriginSurface,
    build: build || null,
  };
}

/** Validate persisted server-composed provenance without normalizing it. */
export function isClientOrigin(value: unknown): value is ClientOrigin {
  if (!isRecord(value) || value.version !== CLIENT_ORIGIN_VERSION) return false;
  if (!isRecord(value.actor) || !isRecord(value.reported)) return false;
  const actor = value.actor;
  const reported = value.reported;
  const actorKeys = Object.keys(actor);
  if (
    (actor.kind === 'device' &&
      actorKeys.length === 2 &&
      typeof actor.deviceId === 'string' &&
      actor.deviceId.trim() === actor.deviceId &&
      actor.deviceId.length > 0) ||
    ((actor.kind === 'operator' ||
      actor.kind === 'internal' ||
      actor.kind === 'unknown') &&
      actorKeys.length === 1)
  ) {
    return (
      reported.version === CLIENT_ORIGIN_VERSION &&
      typeof reported.surface === 'string' &&
      CLIENT_ORIGIN_SURFACES.includes(
        reported.surface as ClientOriginSurface,
      ) &&
      (reported.build === null ||
        (typeof reported.build === 'string' && isSafeBuild(reported.build)))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeBuild(value: string): boolean {
  return (
    value.length <= MAX_BUILD_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(value)
  );
}
