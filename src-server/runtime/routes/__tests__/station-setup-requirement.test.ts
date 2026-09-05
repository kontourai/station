/**
 * #1536 D8. The attention projection is handed this function's answer; if it
 * asks the wrong question, the inbox goes back to reading "Nothing needs you
 * right now" while Station's own Agent cannot run. So this drives the real
 * derivation — `resolveManagedAvailabilityReason` over real connection
 * records — rather than a stub of it.
 */

import { describe, expect, test } from 'vitest';
import { createStationEngineAvailabilityReader } from '../../plugins/runtime-provider-resolution.js';
import {
  memoizeStationSetupRequirement,
  readStationSetupRequirement,
} from '../runtime-route-support.js';
import type { ConfigureRuntimeRoutesContext } from '../runtime-routes.js';

const warnings: unknown[] = [];

function contextWith(input: {
  agents: Array<{ slug: string; name?: string }>;
  specs: Record<string, unknown>;
  connections?: unknown[];
  defaultLLMProvider?: string;
  listAgents?: () => Promise<never>;
  /** Read on every call, so a test can change it mid-run. */
  liveDefaultLLMProvider?: () => string | undefined;
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
      defaultLLMProvider: input.liveDefaultLLMProvider
        ? input.liveDefaultLLMProvider()
        : input.defaultLLMProvider,
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

  /**
   * Review L4: the subject was `agents.find(slug === 'station') ?? agents[0]`,
   * so it varied with store order — and the item's id and its first-observed
   * timestamp are both keyed by that slug — and an external-engine agent
   * sorting first silenced the notice for a blocked Station-engine agent
   * behind it.
   */
  describe('choosing whose requirement to report', () => {
    const managed = { name: 'Managed', model: 'anthropic/opus' };
    const external = { execution: { agentConnectionId: 'claude-code' } };

    test('prefers Station, whatever order the store listed', async () => {
      for (const agents of [
        [
          { slug: 'zeta', name: 'Zeta' },
          { slug: 'station', name: 'Station' },
        ],
        [
          { slug: 'station', name: 'Station' },
          { slug: 'alpha', name: 'Alpha' },
        ],
      ]) {
        expect(
          await readStationSetupRequirement(
            contextWith({
              agents,
              specs: {
                station: managed,
                zeta: managed,
                alpha: managed,
              },
              connections: [],
            }),
          ),
        ).toMatchObject({ agentSlug: 'station' });
      }
    });

    test('without Station, the same candidate every time', async () => {
      const shuffles = [
        [
          { slug: 'zeta', name: 'Zeta' },
          { slug: 'alpha', name: 'Alpha' },
        ],
        [
          { slug: 'alpha', name: 'Alpha' },
          { slug: 'zeta', name: 'Zeta' },
        ],
      ];
      for (const agents of shuffles) {
        expect(
          await readStationSetupRequirement(
            contextWith({
              agents,
              specs: { alpha: managed, zeta: managed },
              connections: [],
            }),
          ),
        ).toMatchObject({ agentSlug: 'alpha' });
      }
    });

    test('an external-engine Agent sorting first does not silence a blocked one behind it', async () => {
      expect(
        await readStationSetupRequirement(
          contextWith({
            agents: [
              { slug: 'aaa-external', name: 'Claude Code' },
              { slug: 'zeta', name: 'Zeta' },
            ],
            specs: { 'aaa-external': external, zeta: managed },
            connections: [],
          }),
        ),
      ).toMatchObject({ agentSlug: 'zeta' });
    });

    test('every Agent external-engine bound is no managed-model claim at all', async () => {
      expect(
        await readStationSetupRequirement(
          contextWith({
            agents: [{ slug: 'aaa-external', name: 'Claude Code' }],
            specs: { 'aaa-external': external },
            connections: [],
          }),
        ),
      ).toBeNull();
    });
  });

  test('no Agents at all is not a setup claim about one', async () => {
    const requirement = await readStationSetupRequirement(
      contextWith({ agents: [], specs: {} }),
    );

    expect(requirement).toBeNull();
  });
});

/**
 * `/api/attention` polls every 10s and each read of this fact costs an
 * agent-directory listing, a spec read and the provider-connection list. The
 * projection bounds `readSessionFlowRun` the same way for the same reason.
 */
describe('memoizeStationSetupRequirement', () => {
  test('reuses one observation within the window and re-reads after it', async () => {
    let calls = 0;
    let clock = 1_000;
    const read = memoizeStationSetupRequirement(
      async () => ++calls,
      5_000,
      () => clock,
    );

    expect(await read()).toBe(1);
    clock += 4_999;
    expect(await read()).toBe(1);
    expect(calls).toBe(1);

    clock += 1;
    expect(await read()).toBe(2);
    expect(calls).toBe(2);
  });

  test('shares one in-flight read rather than starting two', async () => {
    let calls = 0;
    const read = memoizeStationSetupRequirement(async () => {
      calls += 1;
      await Promise.resolve();
      return calls;
    });

    const [a, b] = await Promise.all([read(), read()]);
    expect([a, b]).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  test('does not cache a rejection as an answer', async () => {
    let calls = 0;
    const read = memoizeStationSetupRequirement(async () => {
      calls += 1;
      if (calls === 1) throw new Error('store unavailable');
      return calls;
    });

    await expect(read()).rejects.toThrow('store unavailable');
    // Same window, but there is no observation to reuse.
    await expect(read()).resolves.toBe(2);
  });
});

/**
 * #1536 D8 review H2. Four surfaces asked `resolveManagedAvailabilityReason`
 * separately and had already drifted: three passed the BOOT snapshot
 * (`context.appConfig`) and one of those also omitted `gatedConnectionIds`.
 * With two enabled LLM connections, setting a default at runtime cleared the
 * attention item while the New Chat picker went on refusing until restart —
 * the disagreement D8 exists to close, inverted.
 */
describe('createStationEngineAvailabilityReader (#1536 D8 review H2)', () => {
  const twoConnections = [
    {
      id: 'anthropic-main',
      type: 'anthropic',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    },
    {
      id: 'openai-main',
      type: 'openai',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    },
  ];

  test('the picker reason and the attention requirement follow a runtime default change together', async () => {
    let liveDefault: string | undefined;
    const context = contextWith({
      agents: [{ slug: 'station', name: 'Station' }],
      specs: { station: { name: 'Station', model: 'anthropic/opus' } },
      connections: twoConnections,
      liveDefaultLLMProvider: () => liveDefault,
    });
    // Both read the same reader, so `spec` is the picker's question and
    // `readStationSetupRequirement` is the inbox's.
    const pickerReason = createStationEngineAvailabilityReader(context);
    const spec = { name: 'Station', model: 'anthropic/opus' } as never;

    // Ambiguous: two candidates, no default. Both refuse.
    expect(pickerReason(spec)).toBe(
      'Multiple enabled LLM provider connections require an explicit default.',
    );
    expect(await readStationSetupRequirement(context)).toMatchObject({
      reason:
        'Multiple enabled LLM provider connections require an explicit default.',
    });

    // The operator sets a default while Station runs.
    liveDefault = 'anthropic-main';

    // Both clear. Reading the boot snapshot here left the picker refusing.
    expect(pickerReason(spec)).toBeNull();
    expect(await readStationSetupRequirement(context)).toBeNull();
  });

  test('carries the check-gated connection receipts, so a faulted binding is not reported runnable', () => {
    const gated = new Map([['anthropic-main', 'failed' as const]]);
    const context = contextWith({
      agents: [],
      specs: {},
      connections: [twoConnections[0]],
    }) as ConfigureRuntimeRoutesContext & {
      connectionService: { checkGatedModelConnectionIds: () => unknown };
    };
    context.connectionService.checkGatedModelConnectionIds = () => gated;

    // `/api/boot`'s catalog omitted this argument entirely, so it reported an
    // agent bound to a faulted connection as runnable.
    expect(
      createStationEngineAvailabilityReader(context)({
        name: 'Station',
        model: 'anthropic/opus',
      } as never),
    ).not.toBeNull();
  });
});
