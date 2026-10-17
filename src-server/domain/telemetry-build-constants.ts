import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';

/** Only the server build banner supplies this value; runtime environment cannot enable it. */
export const STATION_AUTHOR_TELEMETRY_ENDPOINT =
  (
    globalThis as typeof globalThis & {
      __STATION_AUTHOR_TELEMETRY_ENDPOINT__?: string;
    }
  ).__STATION_AUTHOR_TELEMETRY_ENDPOINT__ ?? '';

const buildChannel =
  (
    globalThis as typeof globalThis & {
      __STATION_SERVER_BUILD__?: { channel?: string };
    }
  ).__STATION_SERVER_BUILD__?.channel ?? 'source-checkout';

/** Release protocol name, derived from the existing server stamp and channel table. */
export const STATION_TELEMETRY_BUILD_CHANNEL =
  Object.entries(STATION_RELEASE_RINGS).find(
    ([ring, { runtimeChannel }]) =>
      ring === buildChannel || runtimeChannel === buildChannel,
  )?.[0] ?? buildChannel;
