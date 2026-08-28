import { describe, expect, test, vi } from 'vitest';
import {
  initializeRuntimeAgents,
  replaceRuntimeAgentMetadataMap,
} from '../runtime-agent-registry.js';

describe('runtime-agent-registry', () => {
  test('replaceRuntimeAgentMetadataMap preserves default metadata on the same map instance', () => {
    const agentMetadataMap = new Map<string, unknown>([
      ['default', { slug: 'default', label: 'Default' }],
      ['old', { slug: 'old', label: 'Old' }],
    ]);
    const logger = { info: vi.fn() };

    replaceRuntimeAgentMetadataMap(
      agentMetadataMap,
      [{ slug: 'writer' }, { slug: 'reviewer' }],
      logger,
    );

    expect(agentMetadataMap).toEqual(
      new Map<string, unknown>([
        ['writer', { slug: 'writer' }],
        ['reviewer', { slug: 'reviewer' }],
        ['default', { slug: 'default', label: 'Default' }],
      ]),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Agent metadata map created',
      expect.objectContaining({
        count: 3,
        sample: { slug: 'writer' },
      }),
    );
  });

  test('initializeRuntimeAgents loads dynamic agents and keeps going after failures', async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const activeAgents = new Map<string, any>();
    const agentMetadataMap = new Map<string, unknown>([
      ['default', { slug: 'default', label: 'Default' }],
    ]);
    const bootstrapDefaultAgent = vi
      .fn()
      .mockResolvedValue({ default: { id: 'default-agent' } });
    const createVoltAgentInstance = vi
      .fn()
      .mockResolvedValueOnce({ id: 'writer-agent' })
      .mockRejectedValueOnce(new Error('broken'));

    const agents = await initializeRuntimeAgents({
      configLoader: {
        listAgents: async () => [{ slug: 'writer' }, { slug: 'broken' }],
      },
      logger,
      bootstrapDefaultAgent,
      createVoltAgentInstance,
      activeAgents,
      agentMetadataMap,
    });

    expect(agents).toEqual({
      default: { id: 'default-agent' },
      writer: { id: 'writer-agent' },
    });
    expect(activeAgents).toEqual(
      new Map<string, any>([['writer', { id: 'writer-agent' }]]),
    );
    expect(agentMetadataMap).toEqual(
      new Map<string, unknown>([
        ['writer', { slug: 'writer' }],
        ['broken', { slug: 'broken' }],
        ['default', { slug: 'default', label: 'Default' }],
      ]),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load agent',
      expect.objectContaining({
        agent: 'broken',
      }),
    );
  });
});

describe('the reserved Station record (station#3662)', () => {
  test('never builds a SECOND instance for the public station slug', async () => {
    // `bootstrapDefaultAgent` builds Station's one instance under the
    // internal key `default`. `agents/station/agent.json` is a user-editable
    // overlay, not a second agent — building an instance from it would give
    // the public slug a different object than every Station-engine seam
    // resolves, and without the runtime spec's built-in tool servers.
    //
    // Until archive#3662 this was skipped for a reason that was not true: the record
    // named a `station` engine CONNECTION that cannot exist, so the capability
    // matrix classified Station's own Agent as an unknown external engine. The
    // record no longer carries that binding, so the skip has to hold on the
    // identity.
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const activeAgents = new Map<string, any>();
    const createVoltAgentInstance = vi.fn();

    const agents = await initializeRuntimeAgents({
      configLoader: {
        // No `execution` at all — exactly what the seed writes now.
        listAgents: async () => [{ slug: 'station' }, { slug: 'writer' }],
      },
      logger,
      bootstrapDefaultAgent: vi
        .fn()
        .mockResolvedValue({ default: { id: 'default-agent' } }),
      createVoltAgentInstance: createVoltAgentInstance.mockResolvedValue({
        id: 'writer-agent',
      }),
      activeAgents,
      agentMetadataMap: new Map<string, unknown>(),
    });

    expect(createVoltAgentInstance).toHaveBeenCalledTimes(1);
    expect(createVoltAgentInstance).toHaveBeenCalledWith('writer');
    expect(activeAgents.has('station')).toBe(false);
    expect(Object.keys(agents).sort()).toEqual(['default', 'writer']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
