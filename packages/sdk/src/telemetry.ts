import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { _getApiBase, _getPluginName } from './api-core';

interface TelemetryEvent {
  event: string;
  plugin: string;
  attributes: Record<string, string | number>;
  timestamp: number;
}

const buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 10_000;
const MAX_BUFFERED_EVENTS = 1000;
let flushInFlight: Promise<void> | null = null;

function flush(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  if (buffer.length === 0) return Promise.resolve();
  const events = buffer.splice(0);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  flushInFlight = (async () => {
    try {
      const apiBase = await _getApiBase();
      await fetch(`${apiBase}/api/telemetry/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [STATION_PLUGIN_HEADER]: _getPluginName(),
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
    } catch {
      /* best-effort diagnostics */
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    flushInFlight = null;
    if (buffer.length) scheduleFlush();
  });
  return flushInFlight;
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
    if (buffer.length === MAX_BUFFERED_EVENTS) return;
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
