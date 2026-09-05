/**
 * #1536 D8. The attention projection is handed this function's answer; if it
 * asks the wrong question, the inbox goes back to reading "Nothing needs you
 * right now" while Station's own Agent cannot run. So this drives the real
 * derivation — `resolveManagedAvailabilityReason` over real connection
 * records — rather than a stub of it.
 */

import { describe, expect, test } from 'vitest';
import { readStationSetupRequirement } from '../runtime-route-support.js';
import type { ConfigureRuntimeRoutesContext } from '../runtime-routes.js';

const warnings: unknown[] = [];

function contextWith(input: {
  agents: Array<{ slug: string; name?: string }>;
  specs: Record<string, unknown>;
  connections?: unknown[];
  defaultLLMProvider?: string;
  listAgents?: () => Promise<never>;
}): ConfigureRuntimeRoutesContext {
  return {
    agentService: {
      listAgents:
        input.listAgents ?? (async () => input.agents as unknown as never),
      getAgent: async (slug: string) => {
        const spec = input.specs[slug];
        if (!spec) throw new Error(`no spec for ${slug}`);
        return spec;
      },
    },
    getLiveAppConfig: () => ({
      defaultLLMProvider: input.defaultLLMProvider,
    }),
    providerService: {
      listProviderConnections: () => input.connections ?? [],
    },
    connectionService: {
      checkGatedModelConnectionIds: () => new Map(),
    },
    logger: {
      warn: (...args: unknown[]) => warnings.push(args),
    },
  } as unknown as ConfigureRuntimeRoutesContext;
}

describe('readStationSetupRequirement (#1536 D8)', () => {
  test('reports the real resolver sentence when no model connection is configured', async () => {
    const requirement = await readStationSetupRequirement(
      contextWith({
        agents: [{ slug: 'station', name: 'Station' }],
        specs: { station: { name: 'Station', model: 'anthropic/opus' } },
        connections: [],
      }),
    );

    // The sentence is the resolver's, which is what makes it the same one the
    // New Chat picker's Station row renders.
    expect(requirement).toEqual({
      agentSlug: 'station',
      agentName: 'Station',
      reason: 'No enabled LLM provider connection is configured.',
    });
  });

  test('reports nothing once an enabled LLM connection resolves', async () => {
    const requirement = await readStationSetupRequirement(
      contextWith({
        agents: [{ slug: 'station', name: 'Station' }],
        specs: { station: { name: 'Station', model: 'anthropic/opus' } },
        connections: [
          {
            id: 'anthropic-main',
            type: 'anthropic',
            enabled: true,
            capabilities: ['llm'],
            config: {},
          },
        ],
      }),
    );

    expect(requirement).toBeNull();
  });

  test('an external-engine Agent is not asked a managed-model question', async () => {
    // The `deriveAgentCatalog` lesson: a model-resolution probe run against a
    // Claude Code binding reports a working Agent as broken.
    const requirement = await readStationSetupRequirement(
      contextWith({
        agents: [{ slug: 'station', name: 'Station' }],
        specs: {
          station: {
            name: 'Station',
            // The classifier reads the engine CONNECTION binding, which is
            // what makes a record external.
            execution: { agentConnectionId: 'claude-code' },
          },
        },
        connections: [],
      }),
    );

    expect(requirement).toBeNull();
  });

  test('a read that could not answer claims nothing', async () => {
    warnings.length = 0;
    const requirement = await readStationSetupRequirement(
      contextWith({
        agents: [],
        specs: {},
        listAgents: async () => {
          throw new Error('agent store unavailable');
        },
      }),
    );

    expect(requirement).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test('no Agents at all is not a setup claim about one', async () => {
    const requirement = await readStationSetupRequirement(
      contextWith({ agents: [], specs: {} }),
    );

    expect(requirement).toBeNull();
  });
});
