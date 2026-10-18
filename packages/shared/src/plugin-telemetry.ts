import { createHash } from 'node:crypto';
import {
  PLUGIN_TELEMETRY_LIMITS as LIMITS,
  type PluginDailyPing,
  type PublisherTelemetryDeclaration,
} from '@kontourai/station-contracts/plugin-telemetry';

const TOKEN = /^[a-z][a-z0-9_]{0,47}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function token(value: string) {
  return TOKEN.test(value) && !RESERVED.has(value);
}
function fail(): never {
  throw new Error(
    'Invalid telemetry declaration: use bounded enums/countBuckets, declared names and an HTTPS endpoint without credentials, query or fragment.',
  );
}
export function isTelemetryPublisherId(
  value: unknown,
): value is import('@kontourai/station-contracts/product-telemetry').TelemetryPublisherId {
  return (
    value === 'kontour' ||
    value === 'operator' ||
    (typeof value === 'string' &&
      value.startsWith('publisher:') &&
      ID.test(value.slice(10)) &&
      !RESERVED.has(value.slice(10)))
  );
}
export function parsePublisherTelemetryDeclaration(
  value: unknown,
): PublisherTelemetryDeclaration {
  if (
    !object(value) ||
    !exact(value, ['publisher', 'endpoint', 'events']) ||
    typeof value.publisher !== 'string' ||
    !ID.test(value.publisher) ||
    RESERVED.has(value.publisher) ||
    typeof value.endpoint !== 'string' ||
    value.endpoint.length > 2048
  )
    fail();
  let url: URL;
  try {
    url = new URL(value.endpoint);
  } catch {
    return fail();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.endpoint.includes('?') ||
    value.endpoint.includes('#')
  )
    fail();
  if (
    !object(value.events) ||
    !Object.keys(value.events).length ||
    Object.keys(value.events).length > LIMITS.events
  )
    fail();
  const events: PublisherTelemetryDeclaration['events'] = {};
  for (const [name, event] of Object.entries(value.events)) {
    if (
      !token(name) ||
      !object(event) ||
      !exact(event, ['properties']) ||
      !object(event.properties) ||
      Object.keys(event.properties).length > LIMITS.properties
    )
      fail();
    const properties: PublisherTelemetryDeclaration['events'][string]['properties'] =
      {};
    for (const [key, domain] of Object.entries(event.properties)) {
      if (!token(key)) fail();
      if (Array.isArray(domain)) {
        if (
          !domain.length ||
          domain.length > LIMITS.values ||
          domain.some((v) => typeof v !== 'string' || !token(v)) ||
          new Set(domain).size !== domain.length
        )
          fail();
        properties[key] = [...domain].sort();
      } else {
        if (
          !object(domain) ||
          !exact(domain, ['countBuckets']) ||
          !Array.isArray(domain.countBuckets) ||
          !domain.countBuckets.length ||
          domain.countBuckets.length > LIMITS.values ||
          domain.countBuckets[0] !== 0 ||
          domain.countBuckets.some(
            (v, i, all) =>
              !Number.isSafeInteger(v) ||
              v < 0 ||
              v > LIMITS.countMaximum ||
              (i > 0 && v <= all[i - 1]),
          )
        )
          fail();
        properties[key] = { countBuckets: [...domain.countBuckets] };
      }
    }
    events[name] = {
      properties: Object.fromEntries(Object.entries(properties).sort()),
    };
  }
  if (
    Object.values(events).reduce(
      (sum, event) =>
        sum +
        Object.values(event.properties).reduce(
          (n, domain) => n + pluginTelemetryPropertyValues(domain).length,
          0,
        ),
      0,
    ) > LIMITS.cells
  )
    fail();
  return {
    publisher: value.publisher,
    endpoint: url.href,
    events: Object.fromEntries(Object.entries(events).sort()),
  };
}
export function pluginTelemetryPropertyValues(
  domain: readonly string[] | { countBuckets: readonly number[] },
): string[] {
  if (Array.isArray(domain)) return [...domain];
  const bounds = (domain as { countBuckets: readonly number[] }).countBuckets;
  return [
    ...bounds.map((upper, i) =>
      i === 0 || upper === bounds[i - 1] + 1
        ? String(upper)
        : `${bounds[i - 1] + 1}-${upper}`,
    ),
    `${bounds[bounds.length - 1] + 1}+`,
  ];
}
export function parsePluginTelemetryCount(
  declaration: PublisherTelemetryDeclaration,
  name: unknown,
  props: unknown,
): { name: string; properties: Record<string, string> } {
  if (
    typeof name !== 'string' ||
    !Object.hasOwn(declaration.events, name) ||
    !object(props)
  )
    throw new Error('Undeclared telemetry event or properties');
  const allowed = declaration.events[name].properties;
  if (
    Object.keys(props).length !== Object.keys(allowed).length ||
    Object.keys(props).some((key) => !Object.hasOwn(allowed, key))
  )
    throw new Error('Undeclared or missing telemetry property');
  const properties: Record<string, string> = {};
  for (const [key, domain] of Object.entries(allowed)) {
    const value = props[key];
    if (Array.isArray(domain)) {
      if (typeof value !== 'string' || !domain.includes(value))
        throw new Error('Undeclared telemetry value');
      properties[key] = value;
    } else {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > LIMITS.countMaximum
      )
        throw new Error('Telemetry count must be a bounded integer');
      const bounds = (domain as { countBuckets: readonly number[] })
        .countBuckets;
      const index = bounds.findIndex((upper) => value <= upper);
      const values = pluginTelemetryPropertyValues(domain);
      properties[key] = values[index < 0 ? values.length - 1 : index];
    }
  }
  return { name, properties };
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Wire shape only; declaration/destination changes independently invalidate receipts. */
export const PLUGIN_TELEMETRY_DATA_REVISION = digest({
  version: 1,
  events: ['plugin_daily', 'plugin_event'],
  count: ['0', '1', '2-3', '4+'],
  limits: LIMITS,
  daily:
    'marginal event/property histograms; random event_id; no time or installation key',
  full: 'name,properties,distinct_id,timestamp',
});
export function pluginTelemetryInventoryRevision(
  declaration: PublisherTelemetryDeclaration,
  tier: 'lite' | 'full',
): string {
  return digest({
    declaration,
    tier,
    data: PLUGIN_TELEMETRY_DATA_REVISION,
    wording: 1,
  });
}
export function parsePluginDailyPing(
  value: unknown,
  input: PublisherTelemetryDeclaration,
): PluginDailyPing {
  const declaration = parsePublisherTelemetryDeclaration(input);
  if (
    !object(value) ||
    !exact(value, [
      'event',
      'schema_version',
      'data_revision',
      'inventory_revision',
      'event_id',
      'publisher',
      'events',
    ]) ||
    value.event !== 'plugin_daily' ||
    value.schema_version !== 1 ||
    value.data_revision !== PLUGIN_TELEMETRY_DATA_REVISION ||
    value.inventory_revision !==
      pluginTelemetryInventoryRevision(declaration, 'lite') ||
    value.publisher !== `publisher:${declaration.publisher}` ||
    typeof value.event_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.event_id,
    ) ||
    !object(value.events) ||
    !exact(value.events, Object.keys(declaration.events))
  )
    throw new Error('Invalid plugin_daily envelope');
  const bucket = (v: unknown) => ['0', '1', '2-3', '4+'].includes(v as string);
  for (const [name, declared] of Object.entries(declaration.events)) {
    const event = value.events[name];
    if (
      !object(event) ||
      !exact(event, ['count', 'properties']) ||
      !bucket(event.count) ||
      !object(event.properties) ||
      !exact(event.properties, Object.keys(declared.properties))
    )
      throw new Error('Invalid plugin_daily event');
    for (const [key, domain] of Object.entries(declared.properties)) {
      const histogram = event.properties[key];
      if (
        !object(histogram) ||
        !exact(histogram, pluginTelemetryPropertyValues(domain)) ||
        Object.values(histogram).some((v) => !bucket(v))
      )
        throw new Error('Invalid plugin_daily histogram');
    }
  }
  return value as unknown as PluginDailyPing;
}
