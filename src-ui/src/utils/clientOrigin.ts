import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';

export function clientOriginDetail(origin: ClientOrigin | undefined): string {
  if (!origin) return 'unknown';
  const actor =
    origin.actor.kind === 'device'
      ? `device ${origin.actor.deviceId}`
      : origin.actor.kind;
  return `${actor} · ${origin.reported.surface}${origin.reported.build ? ` · ${origin.reported.build}` : ''}`;
}
