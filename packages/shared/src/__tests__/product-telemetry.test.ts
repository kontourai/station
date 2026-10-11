import { describe, expect, test } from 'vitest';
import {
  parseProductTelemetryBatch,
  USAGE_TELEMETRY_INVENTORY_REVISION,
} from '../product-telemetry.js';

const batch = () => ({
  schema_version: 1,
  inventory_revision: USAGE_TELEMETRY_INVENTORY_REVISION,
  distinct_id: 'a'.repeat(64),
  events: [
    {
      event_id: '11111111-2222-4333-8444-555555555555',
      event: 'engine_turn',
      occurred_at: '2026-10-10T12:00:00.000Z',
      observed_at: '2026-10-10T12:00:01.000Z',
      build: { version: '1.2.3', platform: 'linux', arch: 'x64' },
      properties: { engine: 'codex', outcome: 'completed' },
    },
  ],
});

describe('versioned content-free product ingestion contract', () => {
  test('retains missing build provenance rather than assigning a current release hash', () => {
    expect(
      parseProductTelemetryBatch(batch()).events[0].build.sha,
    ).toBeUndefined();
  });
  test('validated properties do not alias mutable input', () => {
    const input = batch();
    const parsed = parseProductTelemetryBatch(input);
    input.events[0].properties.engine = 'private-engine-name';
    expect(parsed.events[0].properties.engine).toBe('codex');
  });
  test.each([
    [
      'legacy',
      () => ({
        distinct_id: 'a'.repeat(64),
        events: [{ event: 'engine_turn', properties: {} }],
      }),
    ],
    [
      'prototype property',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              properties: {
                ...value.events[0].properties,
                constructor: '1.2.3',
              },
            },
          ],
        };
      },
    ],
    ['unsupported version', () => ({ ...batch(), schema_version: 2 })],
    [
      'stale disclosure',
      () => ({ ...batch(), inventory_revision: 'b'.repeat(64) }),
    ],
    [
      'excessive batch',
      () => ({ ...batch(), events: Array(21).fill(batch().events[0]) }),
    ],
    ['unexpected top-level content', () => ({ ...batch(), prompt: 'secret' })],
    [
      'non-event timestamp',
      () => {
        const value = batch();
        value.events[0].occurred_at = 'yesterday';
        return value;
      },
    ],
    [
      'rolled-over timestamp',
      () => {
        const value = batch();
        value.events[0].occurred_at = '2026-02-30T12:00:00.000Z';
        return value;
      },
    ],
    [
      'unexpected event property',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              properties: { ...value.events[0].properties, prompt: 'secret' },
            },
          ],
        };
      },
    ],
    [
      'unclassified event',
      () => {
        const value = batch();
        value.events[0].event = 'new_private_event';
        return value;
      },
    ],
    [
      'unexpected build content',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, branch: 'secret' },
            },
          ],
        };
      },
    ],
    [
      'coerced provenance enum',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: {
                ...value.events[0].build,
                sha: 'a'.repeat(40),
                sha_source: ['checkout'],
              },
            },
          ],
        };
      },
    ],
    [
      'coerced channel enum',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, channel: ['nightly'] },
            },
          ],
        };
      },
    ],
    [
      'not a full Git hash',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: {
                ...value.events[0].build,
                sha: 'a'.repeat(50),
                sha_source: 'checkout',
              },
            },
          ],
        };
      },
    ],
    [
      'unproven build hash',
      () => {
        const value = batch();
        return {
          ...value,
          events: [
            {
              ...value.events[0],
              build: { ...value.events[0].build, sha: 'a'.repeat(40) },
            },
          ],
        };
      },
    ],
    [
      'invalid classification',
      () => {
        const value = batch();
        value.events[0].properties.engine = 'private-model-name';
        return value;
      },
    ],
  ])('refuses %s at the receiver boundary', (_name, invalid) => {
    expect(() => parseProductTelemetryBatch(invalid())).toThrow();
  });
});
