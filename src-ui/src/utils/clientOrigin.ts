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
  unknown: 'Unknown surface',
};

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
          ? 'Station (internal)'
          : 'Unknown actor';
  const surface =
    SURFACE_LABELS[origin.reported.surface] ?? origin.reported.surface;
  return `${actor} · ${surface}`;
}
