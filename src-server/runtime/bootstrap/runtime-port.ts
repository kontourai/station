import { resolveStationRuntimeContext } from '@kontourai/station-shared/runtime-path-resolver';

const MAX_STATION_BASE_PORT = 65_532;

/**
 * Sentinel returned when Station should self-allocate a free port block instead
 * of binding a fixed base. `index.ts` maps this to `allocateFreePortBlock()`.
 */
export const AUTO_ALLOCATE_PORT = 0;

function assertBasePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > MAX_STATION_BASE_PORT) {
    throw new Error(
      `PORT must be an integer between 1 and ${MAX_STATION_BASE_PORT} so Station can reserve its HTTP, terminal, voice, and consent listeners`,
    );
  }
  return port;
}

export function resolveRuntimePort(
  rawPort: string | undefined,
  portMode?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // Explicit opt-in to self-allocation, independent of the PORT value.
  if (portMode?.trim() === 'auto') return AUTO_ALLOCATE_PORT;

  if (rawPort === undefined || rawPort.trim() === '')
    return assertBasePort(resolveStationRuntimeContext(env).serverPort);

  const port = Number(rawPort);
  // PORT=0 is the conventional "pick a free port" request; Station honors it by
  // self-allocating a contiguous block rather than passing 0 to the kernel.
  if (port === 0) return AUTO_ALLOCATE_PORT;

  return assertBasePort(port);
}
