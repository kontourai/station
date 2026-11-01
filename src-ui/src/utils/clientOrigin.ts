import type {
  ClientOrigin,
  ClientOriginSurface,
} from '@kontourai/station-contracts/client-origin';

export function clientOriginDetail(origin: ClientOrigin | undefined): string {
  if (!origin) return 'unknown';
  const actor =
    origin.actor.kind === 'device'
      ? `device ${origin.actor.deviceId}`
      : origin.actor.kind;
  return `${actor} · ${origin.reported.surface}${origin.reported.build ? ` · ${origin.reported.build}` : ''}`;
}

const SURFACE_LABELS: Record<ClientOriginSurface, string> = {
  web: 'Web browser',
  desktop: 'Desktop app',
  mobile: 'Mobile app',
  cli: 'CLI',
  mcp: 'MCP client',
  unknown: 'Unknown app',
};

/**
 * Just the client surface ("CLI", "Web browser"), for a meta line that names
 * where work came from without the actor kind. `null` when no origin was
 * recorded, or the client reported an unknown surface: callers omit the
 * clause rather than print "from Unknown surface".
 */
export function clientOriginSurfaceLabel(
  origin: ClientOrigin | undefined,
): string | null {
  if (!origin || origin.reported.surface === 'unknown') return null;
  return SURFACE_LABELS[origin.reported.surface] ?? origin.reported.surface;
}

/**
 * #765 D6: the human-readable one-liner for a summary tile. The raw
 * `clientOriginDetail` string leads with a device UUID, which answers
 * nothing at a glance; this names what Station actually derived — the
 * resolved actor kind and the client surface — and nothing more. No paired
 * device NAME is claimed because none reaches this seam (the origin carries
 * only the resolved device id); the exact detail string stays available for
 * tooltips/detail rows via `clientOriginDetail`.
 */
export function clientOriginSummary(origin: ClientOrigin | undefined): string {
  if (!origin) return 'unknown';
  const actor =
    origin.actor.kind === 'device'
      ? 'Paired device'
      : origin.actor.kind === 'operator'
        ? 'Operator'
        : origin.actor.kind === 'internal'
          ? 'Station'
          : 'Unknown sender';
  // #4402: Station's own turns ("Station (internal) · Unknown surface") have
  // no client app; an unreported surface is omitted rather than named.
  if (origin.reported.surface === 'unknown') return actor;
  const surface =
    SURFACE_LABELS[origin.reported.surface] ?? origin.reported.surface;
  return `${actor} · ${surface}`;
}
