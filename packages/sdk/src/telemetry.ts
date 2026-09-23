import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import { _getApiBaseSnapshot, _getPluginName } from './api-core';
import { getClientRawEgressPolicy } from './client/http';

interface TelemetryEvent {
  event: string;
  plugin: string;
  attributes: Record<string, string | number>;
  timestamp: number;
}

type BufferedTelemetryEvent = {
  value: TelemetryEvent;
  apiBase: string;
  owner: {
    connectionId: string;
    activationEpoch: number;
    authorityKey?: string;
  } | null;
  isCurrent?: () => boolean;
};

const buffer: BufferedTelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 10_000;
const MAX_BUFFERED_EVENTS = 1000;
let flushInFlight: Promise<void> | null = null;

function flush(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  if (buffer.length === 0) return Promise.resolve();
  const pending = buffer.splice(0);
  const apiBase = _getApiBaseSnapshot();
  const policy = getClientRawEgressPolicy();
  // Telemetry is optional. A broker route has no independently reviewed
  // account-bound telemetry contract yet, so never send its events directly.
  if (policy?.kind === 'broker' || !apiBase || (policy && !policy.isCurrent()))
    return Promise.resolve();
  const events = pending.flatMap((item) => {
    if (item.apiBase !== apiBase || item.isCurrent?.() === false) return [];
    if (item.owner === null) return policy ? [] : [item.value];
    if (
      policy?.kind !== 'direct' ||
      policy.connectionId !== item.owner.connectionId ||
      policy.activationEpoch !== item.owner.activationEpoch ||
      policy.authorityKey !== item.owner.authorityKey
    )
      return [];
    return [item.value];
  });
  if (events.length === 0) return Promise.resolve();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  flushInFlight = (async () => {
    try {
      const currentPolicy = getClientRawEgressPolicy();
      if (
        _getApiBaseSnapshot() !== apiBase ||
        currentPolicy?.kind === 'broker' ||
        (currentPolicy && !currentPolicy.isCurrent()) ||
        (policy &&
          (!currentPolicy ||
            currentPolicy.connectionId !== policy.connectionId ||
            currentPolicy.activationEpoch !== policy.activationEpoch ||
            currentPolicy.authorityKey !== policy.authorityKey))
      )
        return;
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
    const apiBase = _getApiBaseSnapshot();
    const policy = getClientRawEgressPolicy();
    if (!apiBase || policy?.kind === 'broker' || policy?.isCurrent() === false)
      return;
    buffer.push({
      value: {
        event,
        plugin: _getPluginName(),
        attributes,
        timestamp: Date.now(),
      },
      apiBase,
      owner: policy
        ? {
            connectionId: policy.connectionId,
            activationEpoch: policy.activationEpoch,
            ...(policy.authorityKey
              ? { authorityKey: policy.authorityKey }
              : {}),
          }
        : null,
      ...(policy ? { isCurrent: policy.isCurrent } : {}),
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
