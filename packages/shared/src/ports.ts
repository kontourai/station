import { STATION_CHANNEL_PORTS_DATA } from './channel-ports.generated.js';

export const STATION_CHANNEL_PORTS = STATION_CHANNEL_PORTS_DATA;
export type StationChannel = keyof typeof STATION_CHANNEL_PORTS;
export const DEFAULT_STATION_CHANNEL: StationChannel = 'development';

export function resolveStationChannel(raw?: string): StationChannel {
  const candidate = raw?.trim();
  if (!candidate) return DEFAULT_STATION_CHANNEL;
  if (candidate in STATION_CHANNEL_PORTS) return candidate as StationChannel;
  throw new Error(
    `STATION_CHANNEL must be one of ${Object.keys(STATION_CHANNEL_PORTS).join(', ')}; received ${JSON.stringify(raw)}.`,
  );
}

export function stationChannelPorts(channel: StationChannel) {
  return STATION_CHANNEL_PORTS[channel];
}

/** Ordinary source checkout lifecycle commands retain their historic defaults. */
export const DEFAULT_SERVER_PORT = 3141;
export const DEFAULT_UI_PORT = 3000;
