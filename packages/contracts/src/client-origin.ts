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

export interface ClientOrigin {
  version: typeof CLIENT_ORIGIN_VERSION;
  actor: ClientOriginActor;
  reported: ClientReportedOrigin;
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
