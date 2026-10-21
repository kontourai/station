// @vitest-environment jsdom

import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  acpCatalogModelOptions,
  resolveProviderManagedAgentConnectionId,
  stationEligibleModels,
} from '../hooks/useNewChatSelectionModel';

function modelConnection({
  id,
  ...overrides
}: Partial<Omit<ConnectionConfig, 'id'>> &
  Pick<ConnectionConfig, 'id'>): ConnectionConfig {
  return {
    id,
    kind: 'model',
    type: 'bedrock',
    name: 'Model connection',
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    prerequisites: [],
    config: {},
    ...overrides,
  };
}

describe('resolveProviderManagedAgentConnectionId', () => {
  test('binds NOTHING when provider-managed chat has no loaded runtime row (#3662)', () => {
    // This used to answer `engineConnectionId('station')`. The registry can
    // never hold an engine connection with that id, so the picker was minting
    // a binding its own dispatch check would then fail to resolve — the
    // client-side twin of the seeded record archive#3662 removed. Absent means
    // Station's own engine, which is what every other seam already reads.
    expect(
      resolveProviderManagedAgentConnectionId(undefined, undefined),
    ).toBeUndefined();
  });

  test('uses the loaded managed-runtime connection when there is one', () => {
    expect(
      resolveProviderManagedAgentConnectionId(undefined, 'bedrock-runtime'),
    ).toBe(engineConnectionId('bedrock-runtime'));
  });

  test('preserves an explicit clean engine identity', () => {
    expect(
      resolveProviderManagedAgentConnectionId(
        engineConnectionId('codex'),
        undefined,
      ),
    ).toBe(engineConnectionId('codex'));
  });
});

describe('acpCatalogModelOptions (#3028)', () => {
  // The server picks the catalog (model config option, else the #352
  // `models` list; acp-handshake-facts.test.ts pins that rule) and serves it
  // as `advertisedModels`. The picker offers exactly that list.
  const connections = [
    {
      id: 'opencode',
      currentModel: 'opencode/big-pickle',
      configOptions: [
        {
          category: 'model',
          currentValue: 'opencode/big-pickle',
          options: [{ value: 'not-served', name: 'Not served' }],
        },
      ],
      advertisedModels: [
        { id: 'zai-coding-plan/glm-4.7', name: 'Z.AI Coding Plan/GLM-4.7' },
        { id: 'zai-coding-plan/glm-5.2', name: 'Z.AI Coding Plan/GLM-5.2' },
      ],
    },
    { id: 'kiro', currentModel: null, advertisedModels: [] },
  ];

  test('the served catalog is the selectable list, not a re-read of config options', () => {
    expect(acpCatalogModelOptions(connections, 'opencode')).toEqual([
      { id: 'zai-coding-plan/glm-4.7', name: 'Z.AI Coding Plan/GLM-4.7' },
      { id: 'zai-coding-plan/glm-5.2', name: 'Z.AI Coding Plan/GLM-5.2' },
    ]);
  });

  test('no catalog, no connection id, or an empty id yield nothing', () => {
    expect(acpCatalogModelOptions(connections, 'kiro')).toEqual([]);
    expect(acpCatalogModelOptions(connections, undefined)).toEqual([]);
    expect(acpCatalogModelOptions([], 'opencode')).toEqual([]);
    expect(
      acpCatalogModelOptions(
        [
          {
            id: 'x',
            currentModel: null,
            advertisedModels: [{ id: '', name: '' }],
          },
        ],
        'x',
      ),
    ).toEqual([]);
  });
});

describe('stationEligibleModels', () => {
  test('does not expose cached models from disabled or unhealthy providers', () => {
    const models = stationEligibleModels([
      modelConnection({
        id: 'ready-provider',
        name: 'Ready provider',
        config: {
          modelOptions: [{ id: 'ready-model', name: 'Ready model' }],
        },
      }),
      modelConnection({
        id: 'disabled-provider',
        name: 'Disabled provider',
        enabled: false,
        config: {
          modelOptions: [{ id: 'cached-disabled', name: 'Cached disabled' }],
        },
      }),
      modelConnection({
        id: 'error-provider',
        name: 'Error provider',
        status: 'error',
        config: {
          modelOptions: [{ id: 'cached-error', name: 'Cached error' }],
        },
      }),
    ]);

    expect(models).toEqual([
      expect.objectContaining({
        id: 'ready-model',
        providerId: 'ready-provider',
      }),
    ]);
  });
});
