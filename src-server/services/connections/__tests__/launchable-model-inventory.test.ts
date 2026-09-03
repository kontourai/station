import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test, vi } from 'vitest';
import {
  buildLaunchableModelInventory,
  type LaunchableModelInventoryInput,
} from '../launchable-model-inventory.js';

const OBSERVED_AT = '2026-07-19T13:00:00.000Z';

function input(
  overrides: Partial<LaunchableModelInventoryInput> = {},
): LaunchableModelInventoryInput {
  return {
    observedAt: OBSERVED_AT,
    modelConnections: [],
    agentConnections: [],
    ...overrides,
  };
}

describe('buildLaunchableModelInventory', () => {
  // #1208 delta: the inspector decides engine identity (and refuses it for
  // plugins). The inventory carries that decision; a second derivation here
  // disagreed with it for resolved aliases and could not see provenance.
  test('carries the runtime catalog identity for engines and never re-derives one', () => {
    const agent = (id: string, models: Array<Record<string, unknown>>) =>
      ({
        id,
        kind: 'agent' as const,
        type: 'claude',
        name: id,
        enabled: true,
        capabilities: ['agent-runtime' as const],
        config: { engineId: 'claude' },
        status: 'ready' as const,
        prerequisites: [],
        setup: { state: 'ready', detected: true, configured: true },
        runtimeCatalog: {
          source: 'live' as const,
          fetchedAt: OBSERVED_AT,
          reason: null,
          models,
          builtInModels: [],
        },
      }) as never;
    const decorated = {
      canonicalId: 'anthropic:claude-sonnet-4-5',
      verifiedAgainst: 'reviewed',
    };
    const inventory = buildLaunchableModelInventory(
      input({
        agentConnections: [
          agent('claude-decorated', [
            {
              id: 'sonnet',
              name: 'Sonnet',
              originalId: 'sonnet',
              canonicalModelIdentity: decorated,
            },
          ]),
          // Same engine, same id, but the inspector declined (e.g. a plugin
          // asserting this engine id). The inventory must not fill it in.
          agent('claude-bare', [
            { id: 'sonnet', name: 'Sonnet', originalId: 'sonnet' },
          ]),
        ],
      }),
    );
    const byConnection = (connectionId: string) =>
      inventory.models.find((model) => model.connectionId === connectionId);
    expect(byConnection('claude-decorated')?.canonicalModelIdentity).toEqual(
      decorated,
    );
    expect(byConnection('claude-bare')?.canonicalModelIdentity).toBeUndefined();
  });

  // #1208 review: identity is a fact about (route family, id), never id alone.
  // The same string from a family the reviewed data never named must carry
  // nothing, or an unrelated model renders as Claude Sonnet 4.5.
  test('qualifies identity by the route family the connection issues ids for', () => {
    const modelConnection = (
      id: string,
      type: string,
      config: Record<string, unknown>,
      providerModel: string,
    ) => ({
      connection: {
        id,
        kind: 'model' as const,
        type,
        name: id,
        enabled: true,
        capabilities: ['llm' as const],
        config,
        status: 'ready' as const,
        prerequisites: [],
      },
      execution: null,
      catalog: {
        source: 'live' as const,
        observedAt: OBSERVED_AT,
        models: [{ id: providerModel, name: providerModel }],
      },
    });
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          modelConnection(
            'bedrock-1',
            'bedrock',
            {},
            'anthropic.claude-sonnet-4-5-v1:0',
          ),
          modelConnection(
            'openrouter-1',
            'openai-compat',
            { baseUrl: 'https://openrouter.ai/api/v1' },
            'anthropic/claude-sonnet-4.5',
          ),
          modelConnection(
            'other-compat',
            'openai-compat',
            { baseUrl: 'https://api.openai.com/v1' },
            'sonnet',
          ),
          modelConnection('ollama-1', 'ollama', {}, 'claude-sonnet-4-5'),
          // A DEFINED family that the reviewed data never paired with this id:
          // direct Anthropic does not issue the Claude Code alias.
          modelConnection('anthropic-alias', 'anthropic', {}, 'sonnet'),
        ],
      }),
    );
    const byConnection = (connectionId: string) =>
      inventory.models.find((model) => model.connectionId === connectionId);
    expect(byConnection('bedrock-1')?.canonicalModelIdentity?.canonicalId).toBe(
      'anthropic:claude-sonnet-4-5',
    );
    expect(
      byConnection('openrouter-1')?.canonicalModelIdentity?.canonicalId,
    ).toBe('anthropic:claude-sonnet-4-5');
    expect(
      byConnection('other-compat')?.canonicalModelIdentity,
    ).toBeUndefined();
    expect(byConnection('ollama-1')?.canonicalModelIdentity).toBeUndefined();
    expect(
      byConnection('anthropic-alias')?.canonicalModelIdentity,
    ).toBeUndefined();
  });

  test('marks curated routes and leaves an unknown provider-native id ungrouped', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          ...['claude-sonnet-4-5', 'claude-sonnet-4-5-v2'].map((id) => ({
            connection: {
              id: `anthropic-${id}`,
              kind: 'model' as const,
              type: 'anthropic',
              name: id,
              enabled: true,
              capabilities: ['llm' as const],
              config: {},
              status: 'ready' as const,
              prerequisites: [],
            },
            execution: null,
            catalog: {
              source: 'live' as const,
              observedAt: OBSERVED_AT,
              models: [{ id, name: id }],
            },
          })),
        ],
      }),
    );
    const known = inventory.models.find(
      (model) => model.providerModel === 'claude-sonnet-4-5',
    );
    const unknown = inventory.models.find(
      (model) => model.providerModel === 'claude-sonnet-4-5-v2',
    );
    expect(known?.canonicalModelIdentity?.canonicalId).toBe(
      'anthropic:claude-sonnet-4-5',
    );
    expect(unknown?.canonicalModelIdentity).toBeUndefined();
    expect(unknown?.providerModel).toBe('claude-sonnet-4-5-v2');
  });

  test('projects live Ollama models with adapter-declared locality and metadata', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection: {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Local Ollama',
              enabled: true,
              capabilities: ['llm' as const],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
            execution: {
              runtime: { id: 'ollama', version: null },
              adapter: { id: 'station-ollama', version: null },
              locality: 'local',
            },
            catalog: {
              source: 'live',
              observedAt: OBSERVED_AT,
              models: [
                {
                  id: 'qwen3:30b',
                  name: 'Qwen 3 30B',
                  contextWindow: 32_768,
                  supportsTools: true,
                  supportsVision: false,
                },
              ],
            },
          },
        ],
      }),
    );

    expect(inventory.models).toEqual([
      {
        id: 'model:ollama-local:qwen3%3A30b',
        connectionId: 'ollama-local',
        connectionKind: 'model',
        providerId: 'ollama-local',
        runtime: { id: 'ollama', version: null },
        adapter: { id: 'station-ollama', version: null },
        model: {
          id: 'qwen3:30b',
          revision: null,
          quantization: null,
        },
        providerModel: 'qwen3:30b',
        aliases: ['qwen3:30b'],
        displayName: 'Qwen 3 30B',
        locality: 'local',
        availability: 'available',
        freshness: 'live',
        observedAt: OBSERVED_AT,
        effectiveContextTokens: 32_768,
        toolSurface: ['tool-calls'],
        supportsVision: false,
      },
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });

  test('truncates aggregate records and serialized output deterministically', () => {
    const models = Array.from({ length: 5 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index} ${'x'.repeat(200)}`,
    }));
    const inventory = buildLaunchableModelInventory(
      input({
        maxRecords: 2,
        maxResponseBytes: 4096,
        modelConnections: [
          {
            connection: {
              id: 'bounded',
              kind: 'model',
              type: 'openai-compat',
              name: 'Bounded',
              enabled: true,
              capabilities: ['llm' as const],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
            execution: null,
            catalog: { source: 'live', observedAt: OBSERVED_AT, models },
          },
        ],
      }),
    );

    expect(inventory.models.map((model) => model.providerModel)).toEqual([
      'model-0',
      'model-1',
    ]);
    expect(Buffer.byteLength(JSON.stringify(inventory))).toBeLessThanOrEqual(
      4096,
    );
    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'station:model-inventory',
      code: 'discovery-limited',
      message:
        '3 launchable models were omitted by aggregate inventory limits.',
    });
  });

  test('does not allow callers to raise production inventory ceilings', () => {
    const models = Array.from({ length: 4100 }, (_, index) => ({
      id: `model-${String(index).padStart(4, '0')}`,
      name: `Model ${index}`,
    }));
    const recordBounded = buildLaunchableModelInventory(
      input({
        maxRecords: 5000,
        modelConnections: [
          {
            connection: {
              id: 'bounded-records',
              kind: 'model',
              type: 'openai-compat',
              name: 'Bounded records',
              enabled: true,
              capabilities: ['llm' as const],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
            execution: null,
            catalog: { source: 'live', observedAt: OBSERVED_AT, models },
          },
        ],
      }),
    );
    expect(recordBounded.models).toHaveLength(4096);

    const byteBounded = buildLaunchableModelInventory(
      input({
        maxResponseBytes: 4 * 1024 * 1024,
        modelConnections: [
          {
            connection: {
              id: 'bounded-bytes',
              kind: 'model',
              type: 'openai-compat',
              name: 'Bounded bytes',
              enabled: true,
              capabilities: ['llm' as const],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
            execution: null,
            catalog: {
              source: 'live',
              observedAt: OBSERVED_AT,
              models: [{ id: 'huge', name: 'x'.repeat(3 * 1024 * 1024) }],
            },
          },
        ],
      }),
    );
    expect(
      Buffer.byteLength(JSON.stringify({ success: true, data: byteBounded })),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);

    const diagnosticBounded = buildLaunchableModelInventory(
      input({
        maxResponseBytes: 4 * 1024 * 1024,
        diagnostics: [
          {
            connectionId: 'x'.repeat(3 * 1024 * 1024),
            code: 'refresh-unavailable',
            message: 'oversized diagnostic',
          },
        ],
      }),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ success: true, data: diagnosticBounded }),
      ),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(diagnosticBounded.diagnostics).toContainEqual({
      connectionId: 'station:model-inventory',
      code: 'discovery-limited',
      message: '1 diagnostic was omitted by aggregate inventory limits.',
    });
  });

  test('selects a deterministic bounded prefix across maximum provider fanout', () => {
    const modelConnections = Array.from({ length: 64 }, (_, sourceIndex) => ({
      connection: {
        id: `source-${String(sourceIndex).padStart(3, '0')}`,
        kind: 'model' as const,
        type: 'test',
        name: `Source ${sourceIndex}`,
        enabled: true,
        capabilities: ['llm' as const],
        config: {},
        status: 'ready' as const,
        prerequisites: [],
      },
      execution: null,
      catalog: {
        source: 'live' as const,
        observedAt: OBSERVED_AT,
        models: Array.from({ length: 1000 }, (_, modelIndex) => ({
          id: `model-${String(modelIndex).padStart(4, '0')}`,
          name: `Model ${modelIndex}`,
        })),
      },
    }));

    const originalStringify = JSON.stringify;
    let fullCandidateSerializations = 0;
    const stringify = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          Array.isArray((value as { models?: unknown }).models) &&
          (value as { models: unknown[] }).models.length > 0
        ) {
          fullCandidateSerializations += 1;
        }
        return originalStringify(value);
      });
    let inventory: ReturnType<typeof buildLaunchableModelInventory>;
    try {
      inventory = buildLaunchableModelInventory(
        input({ modelConnections, maxRecords: 128 }),
      );
    } finally {
      stringify.mockRestore();
    }

    expect(fullCandidateSerializations).toBe(0);
    expect(inventory.models).toHaveLength(128);
    expect(inventory.models[0]?.id).toBe('model:source-000:model-0000');
    expect(inventory.models.at(-1)?.id).toBe('model:source-000:model-0127');
    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'station:model-inventory',
      code: 'discovery-limited',
      message:
        '63872 launchable models were omitted by aggregate inventory limits.',
    });
  });

  test('keeps execution identity and capability unknown for a generic remote endpoint', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection: {
              id: 'remote-compatible',
              kind: 'model',
              type: 'openai-compat',
              name: 'Remote API',
              enabled: true,
              capabilities: ['llm' as const],
              config: { apiKey: 'must-not-escape' },
              status: 'ready',
              prerequisites: [],
            },
            execution: null,
            catalog: {
              source: 'live',
              observedAt: OBSERVED_AT,
              models: [{ id: 'vendor/model', name: 'Vendor Model' }],
            },
          },
        ],
      }),
    );

    expect(inventory.models[0]).toMatchObject({
      providerId: 'remote-compatible',
      runtime: null,
      adapter: null,
      locality: 'unknown',
      effectiveContextTokens: null,
      toolSurface: null,
      supportsVision: null,
    });
    expect(JSON.stringify(inventory)).not.toContain('must-not-escape');
  });

  test('uses an agent adapter execution declaration instead of its connection id', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        agentConnections: [
          {
            id: engineConnectionId('ollama'),
            kind: 'agent',
            type: 'ollama-runtime',
            name: 'Ollama',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: { provider: 'ollama' },
            status: 'ready',
            prerequisites: [],
            setup: { state: 'ready', detected: true, configured: false },
            modelExecution: {
              runtime: { id: 'ollama', version: null },
              adapter: { id: 'station-ollama', version: null },
              locality: 'local',
            },
            runtimeCatalog: {
              source: 'live',
              fetchedAt: OBSERVED_AT,
              reason: null,
              models: [
                { id: 'qwen3:30b', name: 'Qwen', originalId: 'qwen3:30b' },
              ],
              builtInModels: [],
            },
          },
        ],
      }),
    );

    expect(inventory.models[0]).toMatchObject({
      runtime: { id: 'ollama', version: null },
      adapter: { id: 'station-ollama', version: null },
      locality: 'local',
    });
  });

  test('marks cached runtime catalogs stale and converges explicit aliases deterministically', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        agentConnections: [
          {
            id: engineConnectionId('codex'),
            kind: 'agent',
            type: 'codex',
            name: 'Codex',
            enabled: true,
            capabilities: ['agent-runtime', 'tool-calls'],
            config: { provider: 'codex' },
            status: 'ready',
            prerequisites: [],
            setup: { state: 'ready', detected: true, configured: false },
            runtimeCatalog: {
              source: 'cached',
              fetchedAt: '2026-07-18T13:00:00.000Z',
              reason: 'api key must-not-escape',
              models: [
                { id: 'z-alias', name: 'Z', originalId: 'gpt-5.6' },
                { id: 'a-alias', name: 'A', originalId: 'gpt-5.6' },
                { id: 'a-alias', name: 'A', originalId: 'gpt-5.6' },
              ],
              builtInModels: [],
            },
          },
        ],
      }),
    );

    expect(inventory.models).toHaveLength(1);
    expect(inventory.models[0]).toMatchObject({
      providerId: 'codex',
      runtime: null,
      providerModel: 'gpt-5.6',
      aliases: ['a-alias', 'z-alias'],
      availability: 'stale',
      freshness: 'cached',
      toolSurface: ['tool-calls'],
    });
    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'codex',
      code: 'stale-catalog',
      message: 'Connection is using a cached model catalog.',
    });
    expect(JSON.stringify(inventory)).not.toContain('must-not-escape');
  });

  test('does not publish configured models with unknown observation age', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection: {
              id: 'configured-remote',
              kind: 'model',
              type: 'openai-compat',
              name: 'Configured remote',
              enabled: true,
              capabilities: ['llm' as const],
              config: { defaultModel: 'provider/model-v1' },
              status: 'ready',
              prerequisites: [],
            },
            execution: null,
            catalog: {
              source: 'configured',
              observedAt: null,
              models: [{ id: 'provider/model-v1', name: 'provider/model-v1' }],
            },
          },
        ],
      }),
    );

    expect(inventory.models).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      {
        connectionId: 'configured-remote',
        code: 'catalog-unavailable',
        message: 'The model catalog has no valid observation timestamp.',
      },
    ]);
  });

  test('removes a model deterministically on the next live refresh', () => {
    const connection: LaunchableModelInventoryInput['modelConnections'][number]['connection'] =
      {
        id: 'remote-models',
        kind: 'model',
        type: 'openai-compat',
        name: 'Remote models',
        enabled: true,
        capabilities: ['llm' as const],
        config: {},
        status: 'ready',
        prerequisites: [],
      };
    const initial = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection,
            execution: null,
            catalog: {
              source: 'live',
              observedAt: OBSERVED_AT,
              models: [
                { id: 'kept', name: 'Kept' },
                { id: 'removed', name: 'Removed' },
              ],
            },
          },
        ],
      }),
    );
    const refreshed = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection,
            execution: null,
            catalog: {
              source: 'live',
              observedAt: '2026-07-19T13:01:00.000Z',
              models: [{ id: 'kept', name: 'Kept' }],
            },
          },
        ],
      }),
    );

    expect(initial.models.map((model) => model.providerModel)).toEqual([
      'kept',
      'removed',
    ]);
    expect(refreshed.models.map((model) => model.providerModel)).toEqual([
      'kept',
    ]);
    expect(refreshed.models[0]?.id).toBe(initial.models[0]?.id);
  });

  test('omits disabled, disconnected, and removed models with stable diagnostics and ordering', () => {
    const inventory = buildLaunchableModelInventory(
      input({
        modelConnections: [
          {
            connection: {
              id: 'disabled',
              kind: 'model',
              type: 'ollama',
              name: 'Disabled',
              enabled: false,
              capabilities: ['llm' as const],
              config: {},
              status: 'disabled',
              prerequisites: [],
            },
            execution: null,
            catalog: {
              source: 'live',
              observedAt: OBSERVED_AT,
              models: [{ id: 'removed', name: 'Removed' }],
            },
          },
        ],
        agentConnections: [
          {
            id: engineConnectionId('disconnected'),
            kind: 'agent',
            type: 'acp',
            name: 'Disconnected',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'degraded',
            prerequisites: [],
            setup: {
              state: 'configured',
              detected: false,
              configured: true,
            },
          },
          {
            id: engineConnectionId('empty'),
            kind: 'agent',
            type: 'empty',
            name: 'Empty',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: {},
            status: 'ready',
            prerequisites: [],
            setup: { state: 'ready', detected: true, configured: false },
            runtimeCatalog: {
              source: 'none',
              fetchedAt: null,
              reason: 'No catalog.',
              models: [],
              builtInModels: [],
            },
          },
        ],
      }),
    );

    expect(inventory.models).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      {
        connectionId: 'disabled',
        code: 'disabled',
        message: 'Connection is disabled.',
      },
      {
        connectionId: 'disconnected',
        code: 'not-ready',
        message: 'Connection status is degraded.',
      },
      {
        connectionId: 'empty',
        code: 'catalog-unavailable',
        message: 'No runtime model catalog is available.',
      },
    ]);
  });
});
