/**
 * archive#1398 — the contributed-subset projection
 * (`docs/design/inference-fleet.md` §4.2/§4.5).
 *
 * The load-bearing assertions here are the negative ones: nothing is
 * contributed by default, nothing is contributed that the operator did not
 * name, and a contributed connection that yields no model produces a named
 * diagnostic rather than a shorter list.
 */

import type {
  LaunchableModelInventory,
  LaunchableModelRecord,
  ModelInventoryDiagnostic,
} from '@kontourai/station-contracts/model-inventory';
import { describe, expect, test } from 'vitest';
import { projectFleetContributionManifest } from '../fleet-contribution-manifest.js';

const PROJECTED_AT = '2026-08-01T12:00:00.000Z';
const OBSERVED_AT = '2026-08-01T11:59:00.000Z';

function modelRecord(
  overrides: Partial<LaunchableModelRecord> & { connectionId: string },
): LaunchableModelRecord {
  const providerModel = overrides.providerModel ?? 'qwen3:30b';
  return {
    id: `model:${overrides.connectionId}:${providerModel}`,
    connectionKind: 'model',
    providerId: overrides.connectionId,
    runtime: { id: 'ollama', version: null },
    adapter: null,
    model: { id: providerModel, revision: null, quantization: null },
    providerModel,
    aliases: [providerModel],
    displayName: providerModel,
    locality: 'local',
    availability: 'available',
    freshness: 'live',
    observedAt: OBSERVED_AT,
    effectiveContextTokens: 32_768,
    toolSurface: null,
    supportsVision: null,
    ...overrides,
  };
}

function inventory(
  models: LaunchableModelRecord[],
  diagnostics: ModelInventoryDiagnostic[] = [],
): LaunchableModelInventory {
  return {
    schemaVersion: 'station.model-inventory/v2',
    observedAt: OBSERVED_AT,
    models,
    diagnostics,
  };
}

describe('projectFleetContributionManifest — default off', () => {
  test('a Station that never configured contribution offers nothing, even with launchable models', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: undefined,
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.schemaVersion).toBe('station.fleet-contribution/v1');
    expect(manifest.participation).toBe('disabled');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'station:fleet-contribution',
        code: 'contribution-disabled',
        message:
          'Fleet contribution is turned off for this Station. No local models are offered to the fleet.',
      },
    ]);
  });

  test('marked connections with the opt-in off are reported as withheld, not silently ignored', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: {
        enabled: false,
        connectionIds: ['ollama-local', 'workstation'],
      },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.participation).toBe('disabled');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics[0]?.message).toBe(
      'Fleet contribution is turned off for this Station. 2 marked connections are not being offered.',
    );
  });

  test('a single withheld connection reads in the singular', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: false, connectionIds: ['ollama-local'] },
      inventory: inventory([]),
    });

    expect(manifest.diagnostics[0]?.message).toBe(
      'Fleet contribution is turned off for this Station. 1 marked connection is not being offered.',
    );
  });

  test('the opt-in on with nothing marked is its own named state, not "contributing zero"', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.participation).toBe('nothing-contributed');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'station:fleet-contribution',
        code: 'contribution-empty',
        message:
          'Fleet contribution is turned on, but no model connection is marked as contributed.',
      },
    ]);
  });
});

describe('projectFleetContributionManifest — the contributed subset', () => {
  test('projects only the marked connection, never the rest of the inventory', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory([
        modelRecord({ connectionId: 'ollama-local' }),
        modelRecord({
          connectionId: 'private-bedrock',
          providerModel: 'anthropic.claude',
        }),
      ]),
    });

    expect(manifest.participation).toBe('contributing');
    expect(manifest.models.map((model) => model.connectionId)).toEqual([
      'ollama-local',
    ]);
    expect(JSON.stringify(manifest)).not.toContain('anthropic.claude');
  });

  test('carries the source observation through verbatim and stamps its own projection time', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.projectedAt).toBe(PROJECTED_AT);
    expect(manifest.sourceObservedAt).toBe(OBSERVED_AT);
    expect(manifest.models[0]?.observedAt).toBe(OBSERVED_AT);
  });

  // The envelope's time-of-projection field must not be called `observedAt`:
  // every sibling `observedAt` in this stack means observation AGE, so a
  // consumer computing staleness from the learned name would always read
  // ~now and call a stale manifest fresh.
  test('the envelope has no observedAt field — age lives on sourceObservedAt and per model', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    const envelope = manifest as unknown as Record<string, unknown>;
    expect('observedAt' in envelope).toBe(false);
    expect('projectedAt' in envelope).toBe(true);
    expect(manifest.projectedAt).not.toBe(manifest.sourceObservedAt);
  });

  // archive#1430 (deliberately re-pinned, not deleted): the producer gap
  // this test used to pin as permanent is closed, so it now proves the
  // opposite invariant — the column is carried, and it carries the SAME
  // honest values `launchable-model-inventory.ts` computes (`null` unknown,
  // `[]` known-empty, a real array when a provider genuinely reported it),
  // never invented at the projection layer.
  test('carries toolSurface including its honest unknown and known-empty states (station#1430)', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['a', 'b', 'c'] },
      inventory: inventory([
        modelRecord({ connectionId: 'a', toolSurface: null }),
        modelRecord({ connectionId: 'b', toolSurface: [] }),
        modelRecord({ connectionId: 'c', toolSurface: ['tool-calls'] }),
      ]),
    });

    expect(
      manifest.models.map((model) => [model.connectionId, model.toolSurface]),
    ).toEqual([
      ['a', null],
      ['b', []],
      ['c', ['tool-calls']],
    ]);
  });

  test('carries supportsVision including its honest unknown', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['a', 'b'] },
      inventory: inventory([
        modelRecord({ connectionId: 'a', supportsVision: true }),
        modelRecord({ connectionId: 'b', supportsVision: null }),
      ]),
    });

    expect(
      manifest.models.map((model) => [
        model.connectionId,
        model.supportsVision,
      ]),
    ).toEqual([
      ['a', true],
      ['b', null],
    ]);
  });

  test('models are ordered by id so two projections of one inventory are byte-identical', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory([
        modelRecord({ connectionId: 'ollama-local', providerModel: 'zephyr' }),
        modelRecord({ connectionId: 'ollama-local', providerModel: 'alpha' }),
      ]),
    });

    expect(manifest.models.map((model) => model.providerModel)).toEqual([
      'alpha',
      'zephyr',
    ]);
  });
});

describe('projectFleetContributionManifest — honest degraded states', () => {
  test('a stale contributed model is offered WITH its staleness, never dropped', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory(
        [
          modelRecord({
            connectionId: 'ollama-local',
            availability: 'stale',
            freshness: 'cached',
          }),
        ],
        [
          {
            connectionId: 'ollama-local',
            code: 'stale-catalog',
            message: 'Connection is using a cached model catalog.',
          },
        ],
      ),
    });

    expect(manifest.participation).toBe('contributing');
    expect(manifest.models[0]).toMatchObject({
      availability: 'stale',
      freshness: 'cached',
    });
    expect(manifest.diagnostics).toContainEqual({
      connectionId: 'ollama-local',
      code: 'stale-catalog',
      message: 'Connection is using a cached model catalog.',
    });
  });

  test('a contributed connection that yields nothing carries the local reason through', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory(
        [],
        [
          {
            connectionId: 'ollama-local',
            code: 'not-ready',
            message: 'Connection status is error.',
          },
        ],
      ),
    });

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'ollama-local',
        code: 'not-ready',
        message: 'Connection status is error.',
      },
    ]);
  });

  test('a marked connection that does not exist is named, not quietly skipped', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['deleted-connection'] },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'deleted-connection',
        code: 'contribution-unknown-connection',
        message:
          'This connection is marked as contributed but no such connection exists on this Station.',
      },
    ]);
  });

  test('a truncated source inventory is disclosed, and a missing connection is not blamed on the operator', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['maybe-omitted'] },
      inventory: inventory(
        [modelRecord({ connectionId: 'ollama-local' })],
        [
          {
            connectionId: 'station:model-inventory',
            code: 'discovery-limited',
            message:
              '12 launchable models were omitted by aggregate inventory limits.',
          },
        ],
      ),
    });

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(
      manifest.diagnostics.map((item) => [item.connectionId, item.code]),
    ).toEqual([
      ['maybe-omitted', 'inventory-truncated'],
      ['station:fleet-contribution', 'inventory-truncated'],
    ]);
    expect(
      manifest.diagnostics.some(
        (item) => item.code === 'contribution-unknown-connection',
      ),
    ).toBe(false);
  });

  test('an unreadable inventory is UNKNOWN, not an empty contribution', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: null,
    });

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(manifest.participation).not.toBe('nothing-contributed');
    expect(manifest.sourceObservedAt).toBeNull();
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'station:fleet-contribution',
        code: 'inventory-unavailable',
        message:
          'This Station could not read its own launchable-model inventory, so what it currently contributes is unknown rather than empty.',
      },
    ]);
  });

  test('a non-local contributed model is offered but flagged as a reference, not a local capability', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['hosted'] },
      inventory: inventory([
        modelRecord({ connectionId: 'hosted', locality: 'remote' }),
      ]),
    });

    expect(manifest.participation).toBe('contributing');
    expect(manifest.models[0]?.locality).toBe('remote');
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'hosted',
        code: 'contribution-not-local',
        message:
          "Contributed models on this connection report locality 'remote'. This Station holds a reference to a model it does not execute itself, so a local-capability check cannot verify it.",
      },
    ]);
  });

  test('a local contributed model raises no locality diagnostic', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory([modelRecord({ connectionId: 'ollama-local' })]),
    });

    expect(manifest.diagnostics).toEqual([]);
  });

  test('an engine connection cannot be contributed in v1, and says so', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['claude-code'] },
      inventory: inventory([
        modelRecord({ connectionId: 'claude-code', connectionKind: 'agent' }),
      ]),
    });

    expect(manifest.participation).toBe('contributed-unavailable');
    expect(manifest.models).toEqual([]);
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'claude-code',
        code: 'contribution-unsupported-connection',
        message:
          'This connection is marked as contributed but is not a model connection. Fleet contribution covers model connections only.',
      },
    ]);
  });

  // The whole-Station stale snapshot: `listLaunchableModelInventory()`
  // serves the last successful snapshot and stamps `refresh-unavailable` at
  // `station:model-inventory` scope. If only truncation were mapped through,
  // this renders as a healthy `contributing` with zero diagnostics — an
  // enabled-but-broken Station reported as fine.
  test('a stale-fallback inventory surfaces refresh-unavailable even while models still project', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory(
        [modelRecord({ connectionId: 'ollama-local' })],
        [
          {
            connectionId: 'station:model-inventory',
            code: 'refresh-unavailable',
            message:
              'Station is serving the last successful inventory because refresh is unavailable.',
          },
        ],
      ),
    });

    expect(manifest.participation).toBe('contributing');
    expect(manifest.models).toHaveLength(1);
    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'station:fleet-contribution',
        code: 'refresh-unavailable',
        message:
          'Station is serving the last successful inventory because refresh is unavailable.',
      },
    ]);
  });

  test('every whole-Station diagnostic is carried, not only the truncation one', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory(
        [modelRecord({ connectionId: 'ollama-local' })],
        [
          {
            connectionId: 'station:model-inventory',
            code: 'refresh-unavailable',
            message: 'Serving the last successful inventory.',
          },
          {
            connectionId: 'station:model-inventory',
            code: 'discovery-limited',
            message: '3 connection inventories were omitted.',
          },
        ],
      ),
    });

    expect(manifest.diagnostics.map((item) => item.code).sort()).toEqual([
      'inventory-truncated',
      'refresh-unavailable',
    ]);
  });

  // `station.model-inventory/v2` is internal and may grow a code;
  // `station.fleet-contribution/v1` is peer-facing and may not grow
  // silently. In-repo the compile-time assertion in fleet-contribution.ts
  // fires first — this pins the runtime behavior for a mixed-version read.
  test('a source code outside the frozen vocabulary is renamed, not passed through or dropped', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local'] },
      inventory: inventory(
        [],
        [
          {
            connectionId: 'ollama-local',
            code: 'quota-exhausted' as unknown as ModelInventoryDiagnostic['code'],
            message: 'The provider rejected discovery for billing reasons.',
          },
        ],
      ),
    });

    expect(manifest.diagnostics).toEqual([
      {
        connectionId: 'ollama-local',
        code: 'inventory-diagnostic-unrecognized',
        message:
          "This Station reported 'quota-exhausted', which this manifest version cannot name: The provider rejected discovery for billing reasons.",
      },
    ]);
  });

  test('a connection reporting two non-local localities names both, not just the first', () => {
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['mixed'] },
      inventory: inventory([
        modelRecord({
          connectionId: 'mixed',
          providerModel: 'a',
          locality: 'remote',
        }),
        modelRecord({
          connectionId: 'mixed',
          providerModel: 'b',
          locality: 'unknown',
        }),
      ]),
    });

    expect(
      manifest.diagnostics.map((item) => item.message.match(/'(\w+)'/)?.[1]),
    ).toEqual(['remote', 'unknown']);
  });

  test('diagnostics are deduplicated and ordered so the manifest is stable across projections', () => {
    const duplicate: ModelInventoryDiagnostic = {
      connectionId: 'ollama-local',
      code: 'stale-catalog',
      message: 'Connection is using a cached model catalog.',
    };
    const manifest = projectFleetContributionManifest({
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['ollama-local', 'missing'] },
      inventory: inventory(
        [modelRecord({ connectionId: 'ollama-local' })],
        [duplicate, { ...duplicate }],
      ),
    });

    expect(
      manifest.diagnostics.map((item) => [item.connectionId, item.code]),
    ).toEqual([
      ['missing', 'contribution-unknown-connection'],
      ['ollama-local', 'stale-catalog'],
    ]);
  });
});

/**
 * M3 (slice-1 half): the fleet-AUTHORED diagnostic text is a closed set —
 * every message this module writes is a static literal or a template whose
 * only interpolations come from a closed enum (`ModelInventoryLocality`, a
 * count, a source code). The one channel that carries text this module did
 * not write is the local inventory's own message, and that partition is the
 * thing slice 2 has to decide about at the peer boundary: a manifest read
 * across a machine boundary is rendering another Station's strings.
 */
describe('projectFleetContributionManifest — closed message vocabulary', () => {
  const FLEET_AUTHORED_MESSAGES: readonly string[] = [
    'Fleet contribution is turned off for this Station. No local models are offered to the fleet.',
    'Fleet contribution is turned off for this Station. 1 marked connection is not being offered.',
    'Fleet contribution is turned off for this Station. 2 marked connections are not being offered.',
    'Fleet contribution is turned on, but no model connection is marked as contributed.',
    'This Station could not read its own launchable-model inventory, so what it currently contributes is unknown rather than empty.',
    'The source model inventory hit its bounded limits, so this contributed subset may be incomplete for reasons unrelated to any connection’s own health.',
    'This connection is marked as contributed but did not appear in the source inventory, which was truncated by its bounded limits.',
    'This connection is marked as contributed but no such connection exists on this Station.',
    'This connection is marked as contributed but is not a model connection. Fleet contribution covers model connections only.',
    "Contributed models on this connection report locality 'remote'. This Station holds a reference to a model it does not execute itself, so a local-capability check cannot verify it.",
    "Contributed models on this connection report locality 'unknown'. This Station holds a reference to a model it does not execute itself, so a local-capability check cannot verify it.",
  ];

  const SOURCE_MESSAGE = 'Connection status is error.';

  const scenarios: Array<
    Parameters<typeof projectFleetContributionManifest>[0]
  > = [
    { projectedAt: PROJECTED_AT, config: undefined, inventory: null },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: false, connectionIds: ['a'] },
      inventory: null,
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: false, connectionIds: ['a', 'b'] },
      inventory: null,
    },
    { projectedAt: PROJECTED_AT, config: { enabled: true }, inventory: null },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['a'] },
      inventory: null,
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['gone'] },
      inventory: inventory([modelRecord({ connectionId: 'here' })]),
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['agentish'] },
      inventory: inventory([
        modelRecord({ connectionId: 'agentish', connectionKind: 'agent' }),
      ]),
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['hosted'] },
      inventory: inventory([
        modelRecord({ connectionId: 'hosted', locality: 'remote' }),
        modelRecord({
          connectionId: 'hosted',
          providerModel: 'z',
          locality: 'unknown',
        }),
      ]),
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['omitted'] },
      inventory: inventory(
        [],
        [
          {
            connectionId: 'station:model-inventory',
            code: 'discovery-limited',
            message: 'omitted by limits',
          },
        ],
      ),
    },
    {
      projectedAt: PROJECTED_AT,
      config: { enabled: true, connectionIds: ['broken'] },
      inventory: inventory(
        [],
        [
          {
            connectionId: 'broken',
            code: 'not-ready',
            message: SOURCE_MESSAGE,
          },
        ],
      ),
    },
  ];

  test('every emitted message is either fleet-authored from the closed set or carried verbatim from the local inventory', () => {
    const unaccounted: string[] = [];
    for (const scenario of scenarios) {
      for (const item of projectFleetContributionManifest(scenario)
        .diagnostics) {
        const fleetAuthored = FLEET_AUTHORED_MESSAGES.includes(item.message);
        const carried = item.message === SOURCE_MESSAGE;
        if (!fleetAuthored && !carried) unaccounted.push(item.message);
      }
    }
    expect(unaccounted).toEqual([]);
  });

  test('only the carried-through code can emit text this module did not author', () => {
    const carriedCodes = new Set<string>();
    for (const scenario of scenarios) {
      for (const item of projectFleetContributionManifest(scenario)
        .diagnostics) {
        if (item.message === SOURCE_MESSAGE) carriedCodes.add(item.code);
      }
    }
    expect([...carriedCodes]).toEqual(['not-ready']);
  });
});
