import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  PLUGIN_TELEMETRY_DATA_REVISION,
  parsePluginDailyPing,
  parsePublisherTelemetryDeclaration,
  pluginTelemetryInventoryRevision,
} from '../plugin-telemetry.js';

const declaration = {
  publisher: 'writer',
  endpoint: 'https://writer.example.test/counts',
  events: { opened: { properties: { surface: ['main', 'dock'] } } },
};
test.each([
  { ...declaration, extra: true },
  { ...declaration, endpoint: 'http://writer.example.test/counts' },
  {
    ...declaration,
    endpoint: 'https://secret:password@writer.example.test/counts',
  },
  { ...declaration, endpoint: 'https://writer.example.test/counts?key=secret' },
  { ...declaration, endpoint: 'https://writer.example.test/counts#fragment' },
  { ...declaration, events: { opened: { properties: { prompt: 'string' } } } },
  {
    ...declaration,
    events: { opened: { properties: { surface: ['private text'] } } },
  },
  {
    ...declaration,
    events: { opened: { properties: { items: { countBuckets: [0, 10, 1] } } } },
  },
  {
    ...declaration,
    events: { opened: { properties: { items: { countBuckets: [0, 65536] } } } },
  },
  {
    ...declaration,
    events: Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`event_${i}`, { properties: {} }]),
    ),
  },
  {
    ...declaration,
    events: {
      opened: {
        properties: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`prop_${i}`, ['ok']]),
        ),
      },
    },
  },
  {
    ...declaration,
    events: {
      opened: {
        properties: {
          value: Array.from({ length: 17 }, (_, i) => `value_${i}`),
        },
      },
    },
  },
])('rejects declarations outside the bounded public contract %j', (value) => {
  expect(() => parsePublisherTelemetryDeclaration(value)).toThrow(
    /Invalid telemetry declaration/,
  );
});

test('broker-reusable plugin_daily parser rejects identifying fields and any undeclared histogram dimension', () => {
  const parsed = parsePublisherTelemetryDeclaration(declaration);
  const ping = {
    event: 'plugin_daily',
    schema_version: 1,
    data_revision: PLUGIN_TELEMETRY_DATA_REVISION,
    inventory_revision: pluginTelemetryInventoryRevision(parsed, 'lite'),
    event_id: randomUUID(),
    publisher: 'publisher:writer',
    events: {
      opened: {
        count: '2-3',
        properties: { surface: { main: '2-3', dock: '0' } },
      },
    },
  };
  expect(parsePluginDailyPing(ping, parsed, 'publisher:writer')).toEqual(ping);
  for (const bad of [
    { ...ping, distinct_id: 'private-id' },
    { ...ping, timestamp: '2026-10-01' },
    { ...ping, schema_version: 2 },
    { ...ping, data_revision: 'old' },
    { ...ping, publisher: 'publisher:other' },
    {
      ...ping,
      events: {
        opened: {
          count: 2,
          properties: { surface: { main: '2-3', dock: '0' } },
        },
      },
    },
    {
      ...ping,
      events: {
        opened: {
          count: '2-3',
          properties: { surface: { private: '2-3', dock: '0' } },
        },
      },
    },
  ])
    expect(() => parsePluginDailyPing(bad, parsed, 'publisher:writer')).toThrow(
      /Invalid plugin_daily/,
    );
  expect(
    pluginTelemetryInventoryRevision(
      { ...parsed, endpoint: 'https://changed.example.test/' },
      'lite',
    ),
  ).not.toBe(ping.inventory_revision);
});

test.each([
  '127.0.0.1',
  '169.254.169.254',
  '[::1]',
  '10.1.2.3',
  'localhost',
  '0x7f000001',
])('declarations reject non-public destination %s', (host) => {
  expect(() =>
    parsePublisherTelemetryDeclaration({
      publisher: 'writer',
      endpoint: `https://${host}/counts`,
      events: { opened: { properties: {} } },
    }),
  ).toThrow();
});
