/**
 * station#1398 slice 1 — the two fail-closed readers of the contribution
 * opt-in (`docs/design/inference-fleet.md` §11 slice 1). These are the only
 * supported way to ask "is contribution on" and "what is marked", so their
 * coercion behavior is the whole default-off guarantee.
 */

import { describe, expect, test } from 'vitest';
import type { FleetContributionConfig } from '../fleet-contribution.js';
import {
  declaredContributionConnectionIds,
  FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES,
  FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
  FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION,
  isFleetContributionEnabled,
} from '../fleet-contribution.js';

describe('isFleetContributionEnabled', () => {
  test('an absent config is off', () => {
    expect(isFleetContributionEnabled(undefined)).toBe(false);
  });

  test('an empty config is off', () => {
    expect(isFleetContributionEnabled({})).toBe(false);
  });

  test('an explicit false is off', () => {
    expect(isFleetContributionEnabled({ enabled: false })).toBe(false);
  });

  test('marking connections without turning the opt-in on is still off', () => {
    expect(
      isFleetContributionEnabled({ connectionIds: ['ollama-local'] }),
    ).toBe(false);
  });

  test.each([
    ['a truthy string', 'true'],
    ['a truthy number', 1],
    ['an object', {}],
    ['a non-empty array', ['yes']],
  ])('%s is NOT enabled — no coercion into the on state', (_label, value) => {
    expect(
      isFleetContributionEnabled({
        enabled: value,
      } as unknown as FleetContributionConfig),
    ).toBe(false);
  });

  test('only an exact true turns it on', () => {
    expect(isFleetContributionEnabled({ enabled: true })).toBe(true);
  });
});

describe('declaredContributionConnectionIds', () => {
  test('an absent config declares nothing', () => {
    expect(declaredContributionConnectionIds(undefined)).toEqual([]);
    expect(declaredContributionConnectionIds({})).toEqual([]);
  });

  test('a non-array value declares nothing rather than throwing', () => {
    expect(
      declaredContributionConnectionIds({
        connectionIds: 'ollama-local',
      } as unknown as FleetContributionConfig),
    ).toEqual([]);
  });

  test('deduplicates and sorts so a manifest is order-stable', () => {
    expect(
      declaredContributionConnectionIds({
        connectionIds: ['workstation', 'ollama-local', 'workstation'],
      }),
    ).toEqual(['ollama-local', 'workstation']);
  });

  test('drops empty and non-string entries', () => {
    expect(
      declaredContributionConnectionIds({
        connectionIds: ['ollama-local', '', null, 42] as unknown as string[],
      }),
    ).toEqual(['ollama-local']);
  });

  test('reports what is marked even while the opt-in is off, so a disabled Station can say so', () => {
    expect(
      declaredContributionConnectionIds({
        enabled: false,
        connectionIds: ['ollama-local'],
      }),
    ).toEqual(['ollama-local']);
  });
});

describe('the carried-through diagnostic vocabulary is closed', () => {
  // `station.model-inventory/v2` is internal and may grow a code at any
  // time; `station.fleet-contribution/v1` is peer-facing and may not grow
  // silently. The compile-time assertion in fleet-contribution.ts is the
  // real gate — this is its runtime mirror, and it fails if the frozen list
  // is edited without a version decision.
  test('names exactly the six model-inventory codes this version decided to carry', () => {
    expect([...FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES]).toEqual([
      'catalog-unavailable',
      'disabled',
      'discovery-limited',
      'not-ready',
      'refresh-unavailable',
      'stale-catalog',
    ]);
  });

  test('the runtime mirror is sorted and duplicate-free so membership checks are stable', () => {
    const codes = [...FLEET_CARRIED_INVENTORY_DIAGNOSTIC_CODES];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort());
  });
});

describe('contract constants', () => {
  test('the manifest schema version is the versioned Station contract id', () => {
    expect(FLEET_CONTRIBUTION_MANIFEST_SCHEMA_VERSION).toBe(
      'station.fleet-contribution/v1',
    );
  });

  test('manifest-scoped diagnostics use a reserved id that cannot collide with a connection id', () => {
    expect(FLEET_CONTRIBUTION_DIAGNOSTIC_ID).toBe('station:fleet-contribution');
  });
});
