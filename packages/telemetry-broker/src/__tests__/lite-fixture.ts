import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { StationDailyPing } from '@kontourai/station-contracts/product-telemetry';

export function socketBindings(address: string) {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: address });
  const incoming = new IncomingMessage(socket);
  return { incoming, outgoing: new ServerResponse(incoming) };
}
export function dailyPing(): StationDailyPing {
  return {
    event: 'station_daily',
    event_id: randomUUID(),
    version: '1.2.3',
    channel: 'stable',
    platform: 'linux',
    arch: 'x64',
    surfaces_today: ['web'],
    first_active_this_week: true,
    first_active_this_month: true,
    install_age_bucket: '8-30d',
    paired_devices_bucket: '2-3',
    engines_used_today: ['codex'],
    distribution: 'none',
    public_plugins_enabled: ['public.plugin'],
    private_plugins_bucket: '0',
    branding_overridden: false,
    home_replaced: false,
    layouts_customized: false,
    setup_abandoned_step: 'engine',
    engine_connect_failures: [{ engine: 'codex', bucket: '2-3' }],
    safe_mode_entered: 1,
    plugin_disabled_after_crash: 0,
  };
}
