import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { _getApiBase, _getPluginName } from './api';

interface TelemetryEvent {
  event: string;
  plugin: string;
  attributes: Record<string, string | number>;
  timestamp: number;
}

const buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 10_000;

async function flush() {
  if (buffer.length === 0) return;
  const events = buffer.splice(0);
  try {
    const apiBase = await _getApiBase();
    await fetch(`${apiBase}/api/telemetry/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [STATION_PLUGIN_HEADER]: _getPluginName(),
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    /* best-effort */
  }
}

function scheduleFlush() {
  if (!flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_INTERVAL);
}

export const telemetry = {
  track(event: string, attributes: Record<string, string | number> = {}) {
    buffer.push({
      event,
      plugin: _getPluginName(),
      attributes,
      timestamp: Date.now(),
    });
    scheduleFlush();
  },
  flush,
};

export function instrument<T extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: T,
): T {
  return (async (...args: any[]) => {
    const start = performance.now();
    try {
      const result = await fn(...args);
      telemetry.track(`sdk.${name}`, {
        duration_ms: Math.round(performance.now() - start),
        status: 'ok',
      });
      return result;
    } catch (err) {
      telemetry.track(`sdk.${name}`, {
        duration_ms: Math.round(performance.now() - start),
        status: 'error',
      });
      throw err;
    }
  }) as unknown as T;
}
