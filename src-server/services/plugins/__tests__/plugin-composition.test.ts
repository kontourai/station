import { describe, expect, test, vi } from 'vitest';
import {
  createPluginCompositionModule,
  type PluginCompositionContribution,
  type PluginCompositionFactory,
  type PluginCompositionProfile,
  type PluginCompositionScope,
} from '../plugin-composition.js';

const projectA = { kind: 'project', projectId: 'project-a' } as const;
const projectB = { kind: 'project', projectId: 'project-b' } as const;

function contribution(
  instanceId: string,
  capability: string,
  options: Partial<PluginCompositionContribution> = {},
): PluginCompositionContribution {
  return {
    instanceId,
    pluginId: options.pluginId ?? 'workspace-tools',
    contributionId: options.contributionId ?? instanceId,
    implementationId: options.implementationId ?? instanceId,
    capability,
    version: options.version ?? '1.0.0',
    configuration: options.configuration ?? {},
    isolation: 'profile',
    requires: options.requires ?? [],
  };
}

function profile(
  scope: PluginCompositionScope,
  contributions: readonly PluginCompositionContribution[],
  selections?: Record<string, string>,
): PluginCompositionProfile {
  return {
    profileId: 'workspace-profile',
    scope,
    contributions,
    ...(selections ? { selections } : {}),
  };
}

function factory(
  implementationId: string,
  events: string[],
  options: { fail?: boolean; neverDispose?: boolean } = {},
): [string, PluginCompositionFactory] {
  return [
    implementationId,
    {
      async stage(input) {
        events.push(`stage:${input.contribution.instanceId}`);
        if (options.fail) throw new Error('injected stage failure');
        return {
          dispose: options.neverDispose
            ? () => new Promise(() => {})
            : () => {
                events.push(`dispose:${input.contribution.instanceId}`);
              },
        };
      },
    },
  ];
}

function moduleWith(
  factories: Iterable<[string, PluginCompositionFactory]>,
  options: {
    authorize?: () => 'granted' | 'denied' | 'unavailable';
    disposerTimeoutMs?: number;
  } = {},
) {
  return createPluginCompositionModule({
    factories: new Map(factories),
    authorizer: {
      authorize: () => ({ kind: options.authorize?.() ?? 'granted' }),
    },
    ...(options.disposerTimeoutMs
      ? { disposerTimeoutMs: options.disposerTimeoutMs }
      : {}),
  });
}

describe('plugin composition profiles', () => {
  test('isolates stable contribution instances by Project and configuration generation', async () => {
    const events: string[] = [];
    const module = moduleWith([factory('cache', events)]);
    const first = await module.apply(
      profile(projectA, [
        contribution('cache', 'workspace.cache', {
          configuration: { directory: 'a' },
        }),
      ]),
    );
    const second = await module.apply(
      profile(projectB, [
        contribution('cache', 'workspace.cache', {
          configuration: { directory: 'b' },
        }),
      ]),
    );
    expect(first.kind).toBe('activated');
    expect(second.kind).toBe('activated');

    const a = module.inspect(projectA).active[0];
    const b = module.inspect(projectB).active[0];
    expect(a.instanceIdentity).not.toBe(b.instanceIdentity);
    expect(a.configurationDigest).not.toBe(b.configurationDigest);
    expect(events).toEqual(['stage:cache', 'stage:cache']);

    const reconfigured = await module.apply(
      profile(projectA, [
        contribution('cache', 'workspace.cache', {
          configuration: { directory: 'new-a' },
        }),
      ]),
    );
    expect(reconfigured).toMatchObject({ kind: 'activated', generation: 2 });
    expect(module.inspect(projectA).active[0].instanceIdentity).toBe(
      a.instanceIdentity,
    );
    expect(module.inspect(projectA).active[0].configurationDigest).not.toBe(
      a.configurationDigest,
    );
  });

  test('keeps Agent and Project compositions independently scoped', async () => {
    const events: string[] = [];
    const module = moduleWith([factory('cache', events)]);
    const agentScope = {
      kind: 'agent',
      agentId: 'agent-a',
      projectId: 'project-a',
    } as const;
    await module.apply(
      profile(projectA, [contribution('cache', 'workspace.cache')]),
    );
    await module.apply(
      profile(agentScope, [contribution('cache', 'workspace.cache')]),
    );

    expect(module.inspect(agentScope).active[0].instanceIdentity).not.toBe(
      module.inspect(projectA).active[0].instanceIdentity,
    );
    expect(module.inspect(projectB).active).toEqual([]);
  });

  test('stages dependencies first and disposes a retired generation in reverse order', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('store', events),
      factory('search', events),
    ]);
    await expect(
      module.apply(
        profile(projectA, [
          contribution('search', 'workspace.search', {
            requires: [{ capability: 'workspace.store', version: '1.0.0' }],
          }),
          contribution('store', 'workspace.store'),
        ]),
      ),
    ).resolves.toMatchObject({ kind: 'activated', generation: 1 });
    await expect(module.apply(profile(projectA, []))).resolves.toMatchObject({
      kind: 'activated',
      generation: 2,
    });
    expect(events).toEqual([
      'stage:store',
      'stage:search',
      'dispose:search',
      'dispose:store',
    ]);
  });

  test('keeps missing dependencies visible and restores them when supplied', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('store', events),
      factory('search', events),
    ]);
    const search = contribution('search', 'workspace.search', {
      requires: [{ capability: 'workspace.store', version: '1.0.0' }],
    });
    await expect(
      module.apply(profile(projectA, [search])),
    ).resolves.toMatchObject({
      kind: 'pending',
      inspection: {
        generation: 0,
        pending: [expect.objectContaining({ reason: 'missing-dependency' })],
      },
    });
    expect(events).toEqual([]);

    await expect(
      module.apply(
        profile(projectA, [search, contribution('store', 'workspace.store')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated', generation: 1 });
    expect(module.inspect(projectA).pending).toEqual([]);
  });

  test('refuses cycles, incompatible and cross-scope dependencies before staging', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('a', events),
      factory('b', events),
      factory('consumer', events),
      factory('provider', events),
    ]);
    const cycle = await module.apply(
      profile(projectA, [
        contribution('a', 'capability.a', {
          requires: [{ capability: 'capability.b', version: '1.0.0' }],
        }),
        contribution('b', 'capability.b', {
          requires: [{ capability: 'capability.a', version: '1.0.0' }],
        }),
      ]),
    );
    expect(cycle).toMatchObject({
      kind: 'refused',
      inspection: {
        failed: expect.arrayContaining([
          expect.objectContaining({ reason: 'dependency-cycle' }),
        ]),
      },
    });

    const incompatible = await module.apply(
      profile(projectA, [
        contribution('consumer', 'capability.consumer', {
          requires: [{ capability: 'capability.provider', version: '2.0.0' }],
        }),
        contribution('provider', 'capability.provider'),
      ]),
    );
    expect(incompatible).toMatchObject({
      kind: 'refused',
      inspection: {
        failed: [expect.objectContaining({ reason: 'incompatible-version' })],
      },
    });

    const crossScope = await module.apply(
      profile(projectA, [
        contribution('consumer', 'capability.consumer', {
          requires: [
            {
              capability: 'capability.provider',
              version: '1.0.0',
              scope: projectB,
            },
          ],
        }),
        contribution('provider', 'capability.provider'),
      ]),
    );
    expect(crossScope).toMatchObject({
      kind: 'refused',
      inspection: {
        failed: [expect.objectContaining({ reason: 'cross-scope-dependency' })],
      },
    });
    expect(events).toEqual([]);
  });

  test('requires explicit provider selection and exposes shadowed implementations', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('local', events),
      factory('remote', events),
    ]);
    const candidates = [
      contribution('local', 'workspace.index'),
      contribution('remote', 'workspace.index'),
    ];
    await expect(
      module.apply(profile(projectA, candidates)),
    ).resolves.toMatchObject({
      kind: 'refused',
      inspection: {
        failed: expect.arrayContaining([
          expect.objectContaining({ reason: 'ambiguous-provider' }),
        ]),
      },
    });

    await expect(
      module.apply(
        profile(projectA, candidates, { 'workspace.index': 'local' }),
      ),
    ).resolves.toMatchObject({
      kind: 'activated',
      inspection: {
        active: [expect.objectContaining({ instanceId: 'local' })],
        shadowed: [
          expect.objectContaining({ instanceId: 'remote', status: 'shadowed' }),
        ],
      },
    });
    expect(events).toEqual(['stage:local']);
  });

  test('refuses replacement of fixed Station authorities', async () => {
    const events: string[] = [];
    const module = moduleWith([factory('replacement', events)]);
    await expect(
      module.apply(
        profile(projectA, [
          contribution('replacement', 'station.authorization'),
        ]),
      ),
    ).resolves.toMatchObject({
      kind: 'refused',
      inspection: {
        failed: [expect.objectContaining({ reason: 'fixed-authority' })],
      },
    });
    expect(events).toEqual([]);
  });

  test('keeps the prior generation active when staging fails', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('working', events),
      factory('broken', events, { fail: true }),
    ]);
    await module.apply(
      profile(projectA, [contribution('working', 'workspace.index')]),
    );
    const before = module.inspect(projectA);
    await expect(
      module.apply(
        profile(projectA, [
          contribution('broken', 'workspace.index', {
            implementationId: 'broken',
          }),
        ]),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        generation: 1,
        active: [
          expect.objectContaining({
            instanceIdentity: before.active[0].instanceIdentity,
          }),
        ],
        failed: [expect.objectContaining({ reason: 'activation-failed' })],
      },
    });
    expect(events).not.toContain('dispose:working');
  });

  test('rolls back staged dependencies when a later contribution fails', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('store', events),
      factory('search', events, { fail: true }),
    ]);
    const result = await module.apply(
      profile(projectA, [
        contribution('store', 'workspace.store'),
        contribution('search', 'workspace.search', {
          requires: [{ capability: 'workspace.store', version: '1.0.0' }],
        }),
      ]),
    );
    expect(result).toMatchObject({
      kind: 'failed',
      inspection: {
        generation: 0,
        failed: [expect.objectContaining({ reason: 'activation-failed' })],
      },
    });
    expect(events).toEqual(['stage:store', 'stage:search', 'dispose:store']);
  });

  test('shows unavailable authorization as pending and denial as failed', async () => {
    const events: string[] = [];
    let authorization: 'granted' | 'denied' | 'unavailable' = 'unavailable';
    const module = moduleWith([factory('cache', events)], {
      authorize: () => authorization,
    });
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'pending',
      inspection: {
        pending: [
          expect.objectContaining({ reason: 'authorization-unavailable' }),
        ],
      },
    });

    authorization = 'denied';
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        failed: [expect.objectContaining({ reason: 'authorization-denied' })],
      },
    });
    expect(events).toEqual([]);
  });

  test('publishes a generation atomically while reporting bounded disposer fences', async () => {
    const events: string[] = [];
    const module = moduleWith(
      [factory('old', events, { neverDispose: true }), factory('new', events)],
      { disposerTimeoutMs: 5 },
    );
    await module.apply(
      profile(projectA, [contribution('old', 'workspace.index')]),
    );
    const result = await module.apply(
      profile(projectA, [contribution('new', 'workspace.index')]),
    );
    expect(result).toMatchObject({
      kind: 'activated',
      generation: 2,
      liveFences: [expect.objectContaining({ reason: 'disposer-timeout' })],
      inspection: {
        active: [expect.objectContaining({ instanceId: 'new' })],
        failed: [expect.objectContaining({ reason: 'disposer-timeout' })],
      },
    });
  });

  test('serializes activation attempts for the same scope', async () => {
    let releaseFirst: (() => void) | undefined;
    const events: string[] = [];
    const firstStage = vi.fn(
      async (input: Parameters<PluginCompositionFactory['stage']>[0]) => {
        events.push(`stage:${input.contribution.instanceId}`);
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return {
          dispose: () => {
            events.push('dispose:first');
          },
        };
      },
    );
    const module = moduleWith([
      ['first', { stage: firstStage }],
      factory('second', events),
    ]);
    const first = module.apply(
      profile(projectA, [contribution('first', 'workspace.index')]),
    );
    await vi.waitFor(() => expect(firstStage).toHaveBeenCalledOnce());
    const second = module.apply(
      profile(projectA, [contribution('second', 'workspace.index')]),
    );
    await Promise.resolve();
    expect(events).toEqual(['stage:first']);
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({
      kind: 'activated',
      generation: 1,
    });
    await expect(second).resolves.toMatchObject({
      kind: 'activated',
      generation: 2,
    });
    expect(events).toEqual(['stage:first', 'stage:second', 'dispose:first']);
  });
});
