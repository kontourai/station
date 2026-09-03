import { describe, expect, test, vi } from 'vitest';
import {
  createPluginCompositionModule,
  type PluginCompositionAuthorization,
  type PluginCompositionAuthorizer,
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

function grantedPlanAuthorization(
  input: Parameters<PluginCompositionAuthorizer['authorize']>[0],
  factories: ReadonlyMap<string, PluginCompositionFactory>,
  options: {
    isCurrent?: () => boolean;
    release?: () => void;
    mutateBinding?: (
      binding: Record<string, unknown>,
      index: number,
    ) => Record<string, unknown>;
  } = {},
): Extract<PluginCompositionAuthorization, { kind: 'granted' }> {
  return {
    kind: 'granted',
    lease: {
      bindings: input.contributions.flatMap((candidate, index) => {
        const implementationId = candidate.contribution.implementationId;
        const implementation = factories.get(implementationId);
        if (!implementation) return [];
        const binding = {
          instanceIdentity: candidate.instanceIdentity,
          pluginId: candidate.contribution.pluginId,
          contributionId: candidate.contribution.contributionId,
          implementationId,
          installationGeneration: `installed:${candidate.contribution.pluginId}:1`,
          factory: implementation,
        };
        return [options.mutateBinding?.(binding, index) ?? binding];
      }) as never,
      isCurrent: () => options.isCurrent?.() ?? true,
      release: () => options.release?.(),
    },
  };
}

function moduleWith(
  factories: Iterable<[string, PluginCompositionFactory]>,
  options: {
    authorize?: () =>
      | 'granted'
      | 'denied'
      | 'unavailable'
      | Promise<'granted' | 'denied' | 'unavailable'>;
    isCurrent?: () => boolean;
    onRelease?: () => void;
    authorizer?: PluginCompositionAuthorizer;
    disposerTimeoutMs?: number;
    maxRetainedScopes?: number;
  } = {},
) {
  const byImplementation = new Map(factories);
  return createPluginCompositionModule({
    authorizer:
      options.authorizer ??
      ({
        authorize: async (input) => {
          const kind = (await options.authorize?.()) ?? 'granted';
          if (kind !== 'granted') return { kind };
          return grantedPlanAuthorization(input, byImplementation, {
            isCurrent: options.isCurrent,
            release: options.onRelease,
          });
        },
      } satisfies PluginCompositionAuthorizer),
    ...(options.disposerTimeoutMs
      ? { disposerTimeoutMs: options.disposerTimeoutMs }
      : {}),
    ...(options.maxRetainedScopes
      ? { maxRetainedScopes: options.maxRetainedScopes }
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

  test('refuses duplicate plugin contribution identities before staging', async () => {
    const events: string[] = [];
    const module = moduleWith([
      factory('first', events),
      factory('second', events),
    ]);
    await expect(
      module.apply(
        profile(projectA, [
          contribution('first', 'workspace.first', {
            contributionId: 'shared-contribution',
          }),
          contribution('second', 'workspace.second', {
            contributionId: 'shared-contribution',
          }),
        ]),
      ),
    ).resolves.toMatchObject({
      kind: 'refused',
      inspection: {
        failed: [expect.objectContaining({ reason: 'invalid-contribution' })],
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
        pending: [
          expect.objectContaining({
            instanceId: 'store',
            reason: 'activation-aborted',
          }),
        ],
        failed: [
          expect.objectContaining({
            instanceId: 'search',
            reason: 'activation-failed',
          }),
        ],
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

  test('authorizes the whole dependency plan once and carries exact installed bindings through staging and inspection', async () => {
    const events: string[] = [];
    const implementations = new Map([
      factory('store', events),
      factory('search', events),
    ]);
    const release = vi.fn();
    const authorize = vi.fn((input) =>
      grantedPlanAuthorization(input, implementations, { release }),
    );
    const module = moduleWith([], { authorizer: { authorize } });

    const result = await module.apply(
      profile(projectA, [
        contribution('search', 'workspace.search', {
          requires: [{ capability: 'workspace.store', version: '1.0.0' }],
        }),
        contribution('store', 'workspace.store'),
      ]),
    );

    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize.mock.calls[0][0].contributions).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'activated',
      inspection: {
        active: expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'workspace-tools',
            implementationId: 'store',
            installationGeneration: 'installed:workspace-tools:1',
            occurrenceIdentity: expect.stringMatching(/^plugin-occurrence:/),
          }),
        ]),
      },
    });
    expect(events).toEqual(['stage:store', 'stage:search']);
  });

  test('preserves receiver-bound host lease and factory capabilities', async () => {
    const factoryState = new WeakMap<object, { staged: number }>();
    const leaseState = new WeakMap<
      object,
      { current: boolean; released: number }
    >();
    const implementation: PluginCompositionFactory = {
      async stage() {
        const state = factoryState.get(this);
        if (!state) throw new Error('factory receiver changed');
        state.staged += 1;
        return { dispose() {} };
      },
    };
    factoryState.set(implementation, { staged: 0 });
    let hostLease: Extract<
      PluginCompositionAuthorization,
      { kind: 'granted' }
    >['lease'];
    const module = moduleWith([], {
      authorizer: {
        authorize(input) {
          const candidate = input.contributions[0];
          hostLease = {
            bindings: [
              {
                instanceIdentity: candidate.instanceIdentity,
                pluginId: candidate.contribution.pluginId,
                contributionId: candidate.contribution.contributionId,
                implementationId: candidate.contribution.implementationId,
                installationGeneration: 'installed:workspace-tools:1',
                factory: implementation,
              },
            ],
            isCurrent() {
              return leaseState.get(this)?.current === true;
            },
            release() {
              const state = leaseState.get(this);
              if (!state) throw new Error('lease receiver changed');
              state.released += 1;
            },
          };
          leaseState.set(hostLease, { current: true, released: 0 });
          return { kind: 'granted', lease: hostLease };
        },
      },
    });

    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    expect(factoryState.get(implementation)).toEqual({ staged: 1 });
    expect(leaseState.get(hostLease!)).toEqual({
      current: true,
      released: 1,
    });
  });

  test('rejects an owner-mismatched installed binding before staging and releases its recognizable lease', async () => {
    const events: string[] = [];
    const implementations = new Map([factory('cache', events)]);
    const release = vi.fn();
    const authorizer: PluginCompositionAuthorizer = {
      authorize: (input) =>
        grantedPlanAuthorization(input, implementations, {
          release,
          mutateBinding: (binding) => ({
            ...binding,
            pluginId: 'different-owner',
          }),
        }),
    };
    const module = moduleWith([], { authorizer });

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
    expect(events).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  test('keeps every selected contribution visible when a whole-plan binding is missing', async () => {
    const events: string[] = [];
    const implementations = new Map([
      factory('first', events),
      factory('second', events),
    ]);
    const release = vi.fn();
    const module = moduleWith([], {
      authorizer: {
        authorize(input) {
          const granted = grantedPlanAuthorization(input, implementations, {
            release,
          });
          return {
            ...granted,
            lease: {
              ...granted.lease,
              bindings: granted.lease.bindings.slice(0, 1),
            },
          };
        },
      },
    });

    await expect(
      module.apply(
        profile(projectA, [
          contribution('first', 'workspace.first'),
          contribution('second', 'workspace.second'),
        ]),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        pending: [
          expect.objectContaining({
            instanceId: 'first',
            reason: 'activation-aborted',
          }),
        ],
        failed: [
          expect.objectContaining({
            instanceId: 'second',
            reason: 'implementation-unavailable',
          }),
        ],
      },
    });
    expect(events).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  test('rejects non-exact authorization outcomes without invoking accessors or staging', async () => {
    const stage = vi.fn(async () => ({ dispose: vi.fn() }));
    const implementations = new Map([['cache', { stage }]]);
    const release = vi.fn();
    const leaseGetter = vi.fn();
    const module = moduleWith([], {
      authorizer: {
        authorize: (input) =>
          Object.defineProperty({ kind: 'granted' }, 'lease', {
            enumerable: true,
            get: () => {
              leaseGetter();
              return grantedPlanAuthorization(input, implementations, {
                release,
              }).lease;
            },
          }) as never,
      },
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
    expect(leaseGetter).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('holds one whole-plan authorization lease and rolls back when it becomes stale before publication', async () => {
    const events: string[] = [];
    let current = true;
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const delayedStage = vi.fn(async () => {
      events.push('stage:replacement');
      await stageGate;
      return {
        dispose: () => {
          events.push('dispose:replacement');
        },
      };
    });
    const module = moduleWith(
      [factory('current', events), ['replacement', { stage: delayedStage }]],
      { isCurrent: () => current },
    );
    await module.apply(
      profile(projectA, [contribution('current', 'workspace.index')]),
    );
    const replacing = module.apply(
      profile(projectA, [contribution('replacement', 'workspace.index')]),
    );
    await vi.waitFor(() => expect(delayedStage).toHaveBeenCalledOnce());
    current = false;
    releaseStage();

    await expect(replacing).resolves.toMatchObject({
      kind: 'pending',
      inspection: {
        generation: 1,
        active: [expect.objectContaining({ instanceId: 'current' })],
        pending: [
          expect.objectContaining({ reason: 'authorization-unavailable' }),
        ],
      },
    });
    expect(events).toContain('dispose:replacement');
    expect(events).not.toContain('dispose:current');
  });

  test('treats a non-boolean currentness outcome as unavailable and fences every staged occurrence before rollback', async () => {
    const observations: string[] = [];
    let currentChecks = 0;
    const implementation: PluginCompositionFactory = {
      async stage(input) {
        observations.push(`stage:${input.occurrence.isCurrent()}`);
        return {
          dispose: () => {
            observations.push(`dispose:${input.occurrence.isCurrent()}`);
          },
        };
      },
    };
    const implementations = new Map([['cache', implementation]]);
    const release = vi.fn();
    const module = moduleWith([], {
      authorizer: {
        authorize: (input) =>
          grantedPlanAuthorization(input, implementations, {
            release,
            isCurrent: () => {
              currentChecks += 1;
              return (currentChecks === 1 ? true : 'invalid') as boolean;
            },
          }),
      },
    });

    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'pending',
      inspection: {
        generation: 0,
        pending: [
          expect.objectContaining({ reason: 'authorization-unavailable' }),
        ],
      },
    });
    expect(observations).toEqual(['stage:true', 'dispose:false']);
    expect(release).toHaveBeenCalledOnce();
  });

  test('fences and disposes a recognizable resource returned in a malformed staged outcome', async () => {
    const observations: string[] = [];
    let occurrence: { isCurrent(): boolean } | undefined;
    const dispose = vi.fn(() => {
      observations.push(`dispose:${occurrence?.isCurrent()}`);
    });
    const implementation: PluginCompositionFactory = {
      async stage(input) {
        occurrence = input.occurrence;
        return { dispose, unexpected: true } as never;
      },
    };
    const module = moduleWith([['cache', implementation]]);

    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        active: [],
        failed: [
          expect.objectContaining({
            instanceId: 'cache',
            reason: 'activation-failed',
          }),
        ],
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(observations).toEqual(['dispose:false']);
  });

  test('fences an occurrence synchronously before replacement and explicit-retirement disposal', async () => {
    const observations: string[] = [];
    const implementation: PluginCompositionFactory = {
      async stage(input) {
        const instanceId = input.contribution.instanceId;
        return {
          dispose: () => {
            observations.push(
              `dispose:${instanceId}:${input.occurrence.isCurrent()}`,
            );
          },
        };
      },
    };
    const module = moduleWith([
      ['old', implementation],
      ['new', implementation],
    ]);
    await module.apply(
      profile(projectA, [contribution('old', 'workspace.index')]),
    );
    await module.apply(
      profile(projectA, [contribution('new', 'workspace.index')]),
    );
    await module.retire(projectA);

    expect(observations).toEqual(['dispose:old:false', 'dispose:new:false']);
  });

  test('refuses a shared staged handle without cross-disposing another Project occurrence', async () => {
    const dispose = vi.fn();
    const shared = { dispose };
    const leases: Array<{
      occurrenceIdentity: string;
      isCurrent(): boolean;
    }> = [];
    const implementation: PluginCompositionFactory = {
      async stage(input) {
        leases.push(input.occurrence);
        return shared;
      },
    };
    const module = moduleWith([['cache', implementation]]);
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        active: [],
        failed: [expect.objectContaining({ reason: 'activation-failed' })],
      },
    });

    expect(leases).toHaveLength(2);
    expect(leases[0].occurrenceIdentity).not.toBe(leases[1].occurrenceIdentity);
    expect(leases[0].isCurrent()).toBe(true);
    expect(leases[1].isCurrent()).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    await module.retire(projectB);
    expect(dispose).not.toHaveBeenCalled();
    await module.retire(projectA);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    await module.retire(projectB);
    expect(dispose).toHaveBeenCalledTimes(2);
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

  test('retains timed-out disposer fences and blocks exact identity reuse until settlement', async () => {
    const events: string[] = [];
    let settleOldDisposer!: () => void;
    let oldStages = 0;
    const oldFactory: PluginCompositionFactory = {
      async stage() {
        oldStages += 1;
        events.push(`stage:old:${oldStages}`);
        return {
          dispose:
            oldStages === 1
              ? () =>
                  new Promise<void>((resolve) => {
                    settleOldDisposer = resolve;
                  })
              : () => {
                  events.push('dispose:old:replacement');
                },
        };
      },
    };
    const module = moduleWith([['old', oldFactory], factory('new', events)], {
      disposerTimeoutMs: 5,
    });
    await module.apply(
      profile(projectA, [contribution('old', 'workspace.index')]),
    );
    await expect(
      module.apply(profile(projectA, [contribution('new', 'workspace.index')])),
    ).resolves.toMatchObject({
      kind: 'activated',
      liveFences: [
        expect.objectContaining({
          instanceId: 'old',
          generation: 1,
          reason: 'disposer-timeout',
        }),
      ],
    });

    await expect(
      module.apply(profile(projectA, [contribution('old', 'workspace.index')])),
    ).resolves.toMatchObject({
      kind: 'failed',
      inspection: {
        active: [expect.objectContaining({ instanceId: 'new' })],
        failed: [
          expect.objectContaining({
            instanceId: 'old',
            generation: 1,
            reason: 'disposer-timeout',
          }),
        ],
      },
    });
    expect(oldStages).toBe(1);

    settleOldDisposer();
    await vi.waitFor(() => expect(module.inspect(projectA).failed).toEqual([]));
    await expect(
      module.apply(profile(projectA, [contribution('old', 'workspace.index')])),
    ).resolves.toMatchObject({ kind: 'activated', generation: 3 });
    expect(oldStages).toBe(2);
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

  test('bounds retained scopes and explicit retirement releases scope state', async () => {
    const events: string[] = [];
    const module = moduleWith([factory('cache', events)], {
      maxRetainedScopes: 1,
    });
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'refused' });

    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
      inspection: { generation: 0, active: [] },
    });
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
  });

  test('refuses malformed profiles without invoking accessors or leaking identity', async () => {
    const module = moduleWith([]);
    const scopeGetter = vi.fn(() => projectA);
    const accessorProfile = Object.defineProperty({}, 'scope', {
      enumerable: true,
      get: scopeGetter,
    });
    const configurationGetter = vi.fn(() => 'secret');
    const configuration: unknown[] = [];
    Object.defineProperty(configuration, '0', {
      enumerable: true,
      get: configurationGetter,
    });
    configuration.length = 1;
    const malformedContribution = contribution('cache', 'workspace.cache', {
      configuration: configuration as never,
    });
    const scalarToString = vi.fn(() => {
      throw new Error('hostile scalar coercion');
    });
    const hostileScalar = { toString: scalarToString };
    const hostileContribution = {
      ...contribution('cache', 'workspace.cache'),
      instanceId: hostileScalar,
    };
    const hostileRequirement = contribution('cache', 'workspace.cache', {
      requires: [
        {
          capability: hostileScalar as never,
          version: '1.0.0',
        },
      ],
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('profile trap');
        },
      },
    );

    for (const candidate of [
      null,
      accessorProfile,
      throwingProxy,
      profile(projectA, [malformedContribution]),
      profile(projectA, [hostileContribution as never]),
      profile(projectA, [hostileRequirement]),
      { ...profile(projectA, []), contributions: Array(1) },
    ]) {
      await expect(module.apply(candidate as never)).resolves.toEqual({
        kind: 'refused',
        inspection: {
          scope: { kind: 'project', projectId: 'invalid' },
          generation: 0,
          active: [],
          pending: [],
          failed: [],
          shadowed: [],
        },
      });
    }
    expect(scopeGetter).not.toHaveBeenCalled();
    expect(configurationGetter).not.toHaveBeenCalled();
    expect(scalarToString).not.toHaveBeenCalled();
  });
});
