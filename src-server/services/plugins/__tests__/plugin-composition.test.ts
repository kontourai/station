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
    release?: () => void | Promise<void>;
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
    onRelease?: () => void | Promise<void>;
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
  test.each([
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'false', value: false },
    { name: 'zero', value: 0 },
    { name: 'text', value: 'not a handle' },
    { name: 'bigint', value: 1n },
    { name: 'symbol', value: Symbol('not a handle') },
  ])(
    'a late $name result settles the no-resource obligation and frees scope capacity',
    async ({ value }) => {
      vi.useFakeTimers();
      try {
        let finish!: () => void;
        const release = vi.fn();
        const stage = vi.fn(
          () =>
            new Promise<never>((resolve) => {
              finish = () => resolve(value as never);
            }),
        );
        const module = moduleWith([['cache', { stage }]], {
          disposerTimeoutMs: 5,
          maxRetainedScopes: 1,
          onRelease: release,
        });
        const applying = module.apply(
          profile(projectA, [contribution('cache', 'workspace.cache')]),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect((await applying).kind).toBe('failed');
        expect(release).not.toHaveBeenCalled();
        expect((await module.retire(projectA)).kind).toBe('pending');
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(release).toHaveBeenCalledOnce();
        expect((await module.retire(projectA)).kind).toBe('retired');
        expect((await module.apply(profile(projectB, []))).kind).toBe(
          'activated',
        );
        expect(stage).toHaveBeenCalledOnce();
        await module.retire(projectB);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['resolve', 'reject'] as const)(
    'late no-resource settlement still joins earlier rollback which will %s',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        let finishPrior!: () => void;
        let finishLate!: () => void;
        const release = vi.fn();
        const dispose = vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              finishPrior = () =>
                outcome === 'resolve'
                  ? resolve()
                  : reject(new Error('rollback failed'));
            }),
        );
        const module = moduleWith(
          [
            [
              'a',
              {
                async stage() {
                  return { dispose };
                },
              },
            ],
            [
              'b',
              {
                stage: () =>
                  new Promise<never>((resolve) => {
                    finishLate = () => resolve(null as never);
                  }),
              },
            ],
          ],
          { disposerTimeoutMs: 5, onRelease: release },
        );
        const applying = module.apply(
          profile(projectA, [
            contribution('a', 'workspace.a'),
            contribution('b', 'workspace.b'),
          ]),
        );
        await vi.advanceTimersByTimeAsync(20);
        await applying;
        finishLate();
        await vi.advanceTimersByTimeAsync(0);
        expect(release).not.toHaveBeenCalled();
        expect((await module.retire(projectA)).kind).toBe('pending');
        finishPrior();
        await vi.advanceTimersByTimeAsync(0);
        expect(dispose).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
        expect((await module.retire(projectA)).kind).toBe(
          outcome === 'resolve' ? 'retired' : 'pending',
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each([false, true])(
    'ambiguous raw handles retain visible custody and never invoke unknown cleanup capabilities (late=%s)',
    async (late) => {
      for (const kind of [
        'object',
        'array',
        'function',
        'accessor',
        'proxy-function',
      ] as const) {
        vi.useFakeTimers();
        try {
          const invoked = vi.fn(() => {
            throw new Error('unknown capability must not run');
          });
          const raw =
            kind === 'array'
              ? []
              : kind === 'function'
                ? invoked
                : kind === 'accessor'
                  ? Object.defineProperty({}, 'dispose', {
                      enumerable: true,
                      get: invoked,
                    })
                  : kind === 'proxy-function'
                    ? new Proxy(() => {}, { apply: invoked })
                    : {};
          const release = vi.fn();
          let finish!: () => void;
          const module = moduleWith(
            [
              [
                'cache',
                {
                  async stage() {
                    if (late)
                      await new Promise<void>((resolve) => {
                        finish = resolve;
                      });
                    return raw as never;
                  },
                },
              ],
            ],
            { disposerTimeoutMs: 5, onRelease: release },
          );
          const applying = module.apply(
            profile(projectA, [contribution('cache', 'workspace.cache')]),
          );
          await vi.advanceTimersByTimeAsync(10);
          await applying;
          if (late) {
            finish();
            await vi.advanceTimersByTimeAsync(0);
          }
          expect(invoked).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
          expect(module.inspect(projectA).pending).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                reason: 'staged-resource-ambiguous',
                generation: 1,
              }),
            ]),
          );
          expect((await module.retire(projectA)).kind).toBe('pending');
          expect((await module.apply(profile(projectA, []))).kind).toBe(
            'pending',
          );
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  test('captures the original authorizer and receiver before queued work can replace them', async () => {
    const events: string[] = [];
    let finishStage!: () => void;
    let beganStage!: () => void;
    const staging = new Promise<void>((resolve) => {
      beganStage = resolve;
    });
    const implementations = new Map<string, PluginCompositionFactory>([
      [
        'cache',
        {
          async stage() {
            beganStage();
            await new Promise<void>((resolve) => {
              finishStage = resolve;
            });
            return { dispose() {} };
          },
        },
      ],
      factory('index', events),
    ]);
    const receivers: unknown[] = [];
    const original: PluginCompositionAuthorizer = {
      authorize(input) {
        receivers.push(this);
        return grantedPlanAuthorization(input, implementations);
      },
    };
    const unrelated = vi.fn(() => {
      throw new Error('unrelated accessor');
    });
    Object.defineProperty(original, 'unrelated', { get: unrelated });
    const options = { authorizer: original };
    const module = createPluginCompositionModule(options);
    const first = module.apply(
      profile(projectA, [contribution('cache', 'workspace.cache')]),
    );
    await staging;
    const queued = module.apply(
      profile(projectA, [contribution('index', 'workspace.index')]),
    );
    const replacement = vi.fn(() => ({ kind: 'denied' as const }));
    original.authorize = replacement;
    options.authorizer = { authorize: replacement };
    finishStage();
    expect((await first).kind).toBe('activated');
    expect((await queued).kind).toBe('activated');
    expect(receivers).toEqual([original, original]);
    expect(replacement).not.toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
    await module.retire(projectA);
  });

  test('captures a receiver-bound prototype authorizer without invoking accessor capabilities', async () => {
    const seen: unknown[] = [];
    class Authority {
      authorize(): PluginCompositionAuthorization {
        seen.push(this);
        return { kind: 'denied' };
      }
    }
    const authorizer = new Authority();
    const module = createPluginCompositionModule({ authorizer });
    const old = Authority.prototype.authorize;
    try {
      Authority.prototype.authorize = () => ({ kind: 'unavailable' });
      expect((await module.apply(profile(projectA, []))).kind).toBe('failed');
      expect(seen).toEqual([authorizer]);
    } finally {
      Authority.prototype.authorize = old;
    }
    const getter = vi.fn(() => old);
    expect(() =>
      createPluginCompositionModule({
        authorizer: Object.defineProperty({}, 'authorize', {
          get: getter,
        }) as PluginCompositionAuthorizer,
      }),
    ).toThrow('authorizer');
    expect(getter).not.toHaveBeenCalled();
  });

  test.each(['scalar', 'key', 'escaped', 'aggregate'] as const)(
    'rejects oversized %s configuration before whole serialization and key sorting',
    async (shape) => {
      const large =
        shape === 'escaped' ? '\u0000'.repeat(20_000) : 'x'.repeat(70_000);
      const configuration =
        shape === 'key'
          ? { [large]: null }
          : shape === 'aggregate'
            ? { left: 'a'.repeat(40_000), right: 'b'.repeat(40_000) }
            : large;
      const originalStringify = JSON.stringify;
      const originalSort = Array.prototype.sort;
      let oversizedSerializations = 0;
      let oversizedKeySorts = 0;
      const stringify = vi
        .spyOn(JSON, 'stringify')
        .mockImplementation((value, ...rest) => {
          if (
            value === large ||
            (value &&
              typeof value === 'object' &&
              (Object.hasOwn(value, large) ||
                (value.left?.length === 40_000 &&
                  value.right?.length === 40_000)))
          )
            oversizedSerializations++;
          return Reflect.apply(originalStringify, JSON, [value, ...rest]);
        });
      const sorting = vi
        .spyOn(Array.prototype, 'sort')
        .mockImplementation(function (this: unknown[], compare) {
          if (this.some((value) => value === large)) oversizedKeySorts++;
          return Reflect.apply(originalSort, this, [compare]);
        });
      const authorize = vi.fn(() => ({ kind: 'denied' as const }));
      try {
        const module = moduleWith([], { authorizer: { authorize } });
        const result = await module.apply(
          profile(projectA, [
            contribution('bad', 'workspace.bad', { configuration }),
            contribution('good', 'workspace.good'),
          ]),
        );
        expect(result.kind).toBe('refused');
        expect(result.inspection.failed.map((row) => row.instanceId)).toContain(
          'bad',
        );
        expect(
          result.inspection.pending.map((row) => row.instanceId),
        ).toContain('good');
        expect(oversizedSerializations).toBe(0);
        expect(oversizedKeySorts).toBe(0);
        expect(authorize).not.toHaveBeenCalled();
      } finally {
        stringify.mockRestore();
        sorting.mockRestore();
      }
    },
  );

  test.each([
    ['ascii', 'x'.repeat(65_534), 'x'.repeat(65_535)],
    ['quotes', '"'.repeat(32_767), '"'.repeat(32_768)],
    ['controls', '\u0000'.repeat(10_922), '\u0000'.repeat(10_923)],
    ['surrogates', '\ud800'.repeat(10_922), '\ud800'.repeat(10_923)],
    ['utf8', '😀'.repeat(16_383), '😀'.repeat(16_384)],
  ])(
    'counts exact JSON encoded %s bytes without rejecting in-budget values',
    async (_kind, within, beyond) => {
      const module = moduleWith([factory('cache', [])]);
      expect(
        (
          await module.apply(
            profile(projectA, [
              contribution('cache', 'workspace.cache', {
                configuration: within,
              }),
            ]),
          )
        ).kind,
      ).toBe('activated');
      expect(
        (
          await module.apply(
            profile(projectB, [
              contribution('cache', 'workspace.cache', {
                configuration: beyond,
              }),
            ]),
          )
        ).kind,
      ).toBe('refused');
      await module.retire(projectA);
    },
  );

  test('byte refusal does not expose a malformed profile whose later configuration property is an accessor', async () => {
    const getter = vi.fn(() => {
      throw new Error('must not evaluate');
    });
    const configuration = { a: 'x'.repeat(70_000) };
    Object.defineProperty(configuration, 'z', {
      enumerable: true,
      get: getter,
    });
    const result = await moduleWith([]).apply(
      profile(projectA, [
        contribution('cache', 'workspace.cache', { configuration }),
      ]),
    );
    expect(result).toMatchObject({
      kind: 'refused',
      inspection: {
        scope: { kind: 'project', projectId: 'invalid' },
        failed: [],
        pending: [],
      },
    });
    expect(getter).not.toHaveBeenCalled();
  });

  test('a timed-out stage returning an exact borrowed handle releases only its own authorization after settlement', async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const shared = { dispose };
      let finishB!: () => void;
      const leases: Array<{ isCurrent(): boolean }> = [];
      const releaseA = vi.fn();
      const releaseB = vi.fn();
      const implementations = new Map<string, PluginCompositionFactory>([
        [
          'cache',
          {
            async stage(input) {
              leases.push(input.occurrence);
              if (
                input.scope.kind === 'project' &&
                input.scope.projectId === projectB.projectId
              )
                await new Promise<void>((resolve) => {
                  finishB = resolve;
                });
              return shared;
            },
          },
        ],
      ]);
      const module = moduleWith([], {
        disposerTimeoutMs: 5,
        authorizer: {
          authorize(input) {
            return grantedPlanAuthorization(input, implementations, {
              release:
                input.scope.kind === 'project' &&
                input.scope.projectId === projectA.projectId
                  ? releaseA
                  : releaseB,
            });
          },
        },
      });
      await module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      );
      const pending = module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      );
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(releaseB).not.toHaveBeenCalled();
      expect((await module.retire(projectB)).kind).toBe('pending');
      finishB();
      await vi.advanceTimersByTimeAsync(0);
      expect(releaseB).toHaveBeenCalledOnce();
      expect(releaseA).toHaveBeenCalledOnce();
      expect((await module.retire(projectB)).kind).toBe('retired');
      expect(module.inspect(projectA).active).toHaveLength(1);
      expect(leases.map((lease) => lease.isCurrent())).toEqual([true, false]);
      expect(dispose).not.toHaveBeenCalled();
      await module.retire(projectA);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([false, true])(
    'retains a distinct shared-disposer resource and its lease without destroying the active owner (late=%s)',
    async (late) => {
      vi.useFakeTimers();
      try {
        const disposed: unknown[] = [];
        let secondResourceDisposed = false;
        function dispose(this: unknown) {
          disposed.push(this);
          // A fresh adopter of this disputed cleanup function could affect B.
          // A's legitimate cleanup is deliberately independent of that effect.
          if (this === freshHandle) secondResourceDisposed = true;
        }
        const firstHandle = { dispose };
        const secondHandle = { dispose };
        const freshHandle = { dispose };
        let finishB!: () => void;
        const occurrences: Array<{ isCurrent(): boolean }> = [];
        const releaseB = vi.fn();
        const implementations = new Map<string, PluginCompositionFactory>([
          [
            'cache',
            {
              async stage(input) {
                occurrences.push(input.occurrence);
                if (
                  input.scope.kind === 'project' &&
                  input.scope.projectId === projectA.projectId
                )
                  return firstHandle;
                if (late)
                  await new Promise<void>((resolve) => {
                    finishB = resolve;
                  });
                return input.scope.kind === 'project' &&
                  input.scope.projectId === 'fresh'
                  ? freshHandle
                  : secondHandle;
              },
            },
          ],
        ]);
        const module = moduleWith([], {
          disposerTimeoutMs: 5,
          maxRetainedScopes: 2,
          authorizer: {
            authorize(input) {
              return grantedPlanAuthorization(input, implementations, {
                release:
                  input.scope.kind === 'project' &&
                  input.scope.projectId === projectB.projectId
                    ? releaseB
                    : undefined,
              });
            },
          },
        });
        await module.apply(
          profile(projectA, [contribution('cache', 'workspace.cache')]),
        );
        const applyingB = module.apply(
          profile(projectB, [contribution('cache', 'workspace.cache')]),
        );
        await vi.advanceTimersByTimeAsync(10);
        await applyingB;
        if (late) {
          finishB();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(module.inspect(projectB).pending).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              reason: 'staged-resource-conflict',
              generation: 1,
            }),
          ]),
        );
        expect(releaseB).not.toHaveBeenCalled();
        expect((await module.retire(projectB)).kind).toBe('pending');
        expect(occurrences.map((lease) => lease.isCurrent())).toEqual([
          true,
          false,
        ]);
        expect(disposed).toEqual([]);
        expect(
          (
            await module.apply(
              profile({ kind: 'project', projectId: 'third' }, []),
            )
          ).kind,
        ).toBe('refused');
        await module.retire(projectA);
        expect(disposed).toEqual([firstHandle]);
        expect((await module.retire(projectB)).kind).toBe('pending');
        expect(releaseB).not.toHaveBeenCalled();
        const third = { kind: 'project', projectId: 'third' } as const;
        const attemptedReuse = module.apply(
          profile(third, [contribution('cache', 'workspace.cache')]),
        );
        if (late) {
          await vi.advanceTimersByTimeAsync(0);
          finishB();
        }
        expect((await attemptedReuse).kind).toBe('failed');
        expect((await module.retire(third)).kind).toBe('retired');
        expect(disposed).toEqual([firstHandle]);
        expect((await module.retire(projectB)).kind).toBe('pending');
        const fresh = { kind: 'project', projectId: 'fresh' } as const;
        const attemptedFresh = module.apply(
          profile(fresh, [contribution('cache', 'workspace.cache')]),
        );
        if (late) {
          await vi.advanceTimersByTimeAsync(0);
          finishB();
        }
        const freshResult = await attemptedFresh;
        const freshRetirement = await module.retire(fresh);
        expect(secondResourceDisposed).toBe(false);
        expect(freshResult.kind).toBe('failed');
        expect(freshRetirement.kind).toBe('pending');
        expect(disposed).toEqual([firstHandle]);
        expect(releaseB).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['reject', 'hang'] as const)(
    'an empty replacement exposes scope-level %s release debt after retiring the prior generation',
    async (behavior) => {
      vi.useFakeTimers();
      try {
        const events: string[] = [];
        const implementations = new Map([factory('cache', events)]);
        let finishRelease!: () => void;
        const release = vi.fn(() =>
          behavior === 'reject'
            ? Promise.reject(new Error('release failed'))
            : new Promise<void>((resolve) => {
                finishRelease = resolve;
              }),
        );
        const authorize = vi.fn(
          (input: Parameters<PluginCompositionAuthorizer['authorize']>[0]) =>
            grantedPlanAuthorization(input, implementations, {
              release: input.contributions.length ? undefined : release,
            }),
        );
        const module = moduleWith([], {
          authorizer: { authorize },
          disposerTimeoutMs: 5,
        });
        const previous = profile(projectA, [
          contribution('cache', 'workspace.cache'),
        ]);
        await expect(module.apply(previous)).resolves.toMatchObject({
          kind: 'activated',
        });
        const replacing = module.apply(profile(projectA, []));
        await vi.advanceTimersByTimeAsync(10);
        const result = await replacing;
        const diagnostic = {
          generation: 2,
          status: behavior === 'reject' ? 'failed' : 'pending',
          reason:
            behavior === 'reject'
              ? 'authorization-release-failed'
              : 'authorization-release-pending',
        };
        expect(result.kind).toBe('activated');
        expect(result.inspection.scopeLifecycle).toEqual([diagnostic]);
        (
          result.inspection.scopeLifecycle![0] as { generation: number }
        ).generation = 99;
        expect(module.inspect(projectA).scopeLifecycle).toEqual([diagnostic]);
        expect(result.inspection.active).toEqual([]);
        expect(result.inspection.pending).toEqual([]);
        expect(result.inspection.failed).toEqual([]);
        expect(events).toEqual(['stage:cache', 'dispose:cache']);
        expect(await module.retire(projectA)).toMatchObject({
          kind: 'pending',
          inspection: { scopeLifecycle: [diagnostic] },
        });
        await expect(module.apply(previous)).resolves.toMatchObject({
          kind: 'pending',
        });
        expect(authorize).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledOnce();
        if (behavior === 'hang') {
          finishRelease();
          await vi.advanceTimersByTimeAsync(0);
          expect(module.inspect(projectA).scopeLifecycle).toBeUndefined();
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'retired',
          });
          await expect(module.apply(previous)).resolves.toMatchObject({
            kind: 'activated',
          });
          await module.retire(projectA);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('empty-plan authorization timeout transfers visible scope debt to its late lease release', async () => {
    vi.useFakeTimers();
    try {
      let finishAuthorization!: () => void;
      let finishRelease!: () => void;
      const release = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRelease = resolve;
          }),
      );
      const authorize = vi.fn(
        (input: Parameters<PluginCompositionAuthorizer['authorize']>[0]) =>
          new Promise<PluginCompositionAuthorization>((resolve) => {
            finishAuthorization = () =>
              resolve(grantedPlanAuthorization(input, new Map(), { release }));
          }),
      );
      const module = moduleWith([], {
        authorizer: { authorize },
        disposerTimeoutMs: 5,
      });
      const applying = module.apply(profile(projectA, []));
      await vi.advanceTimersByTimeAsync(6);
      await expect(applying).resolves.toMatchObject({
        kind: 'pending',
        inspection: {
          scopeLifecycle: [
            {
              generation: 1,
              status: 'pending',
              reason: 'authorization-unavailable',
            },
          ],
        },
      });
      finishAuthorization();
      await vi.advanceTimersByTimeAsync(0);
      expect(module.inspect(projectA).scopeLifecycle).toEqual([
        {
          generation: 1,
          status: 'pending',
          reason: 'authorization-release-pending',
        },
      ]);
      await expect(module.retire(projectA)).resolves.toMatchObject({
        kind: 'pending',
      });
      await expect(module.apply(profile(projectA, []))).resolves.toMatchObject({
        kind: 'pending',
      });
      expect(authorize).toHaveBeenCalledOnce();
      finishRelease();
      await vi.advanceTimersByTimeAsync(0);
      await expect(module.retire(projectA)).resolves.toMatchObject({
        kind: 'retired',
      });
      expect(module.inspect(projectA).scopeLifecycle).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an empty profile still needs authorization to replace the active generation', async () => {
    const events: string[] = [];
    let allow = true;
    const module = moduleWith([factory('cache', events)], {
      authorize: () => (allow ? 'granted' : 'denied'),
    });
    await module.apply(
      profile(projectA, [contribution('cache', 'workspace.cache')]),
    );
    allow = false;
    await expect(module.apply(profile(projectA, []))).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(module.inspect(projectA).active).toHaveLength(1);
    expect(events).toEqual(['stage:cache']);
    await module.retire(projectA);
  });

  test.each(['object', 'remaining-budget', 'array-properties'] as const)(
    'rejects oversized %s configuration before sorting or descriptor traversal',
    async (shape) => {
      const wide = Object.fromEntries(
        Array.from(
          { length: shape === 'remaining-budget' ? 3000 : 9000 },
          (_, index) => [`wide-${index}`, 0],
        ),
      );
      const array = Object.assign([], wide);
      const configuration =
        shape === 'object'
          ? wide
          : shape === 'array-properties'
            ? array
            : { a: Array(6000).fill(0), b: wide };
      const sort = Array.prototype.sort;
      const descriptors = Object.getOwnPropertyDescriptors;
      let wideSorts = 0;
      let wideDescriptorReads = 0;
      const sorting = vi
        .spyOn(Array.prototype, 'sort')
        .mockImplementation(function (this: unknown[], compare) {
          if (typeof this[0] === 'string' && this[0].startsWith('wide-'))
            wideSorts += 1;
          return Reflect.apply(sort, this, [compare]);
        });
      const reading = vi
        .spyOn(Object, 'getOwnPropertyDescriptors')
        .mockImplementation((value) => {
          if (value === array) wideDescriptorReads += 1;
          return descriptors(value);
        });
      const authorize = vi.fn(() => ({ kind: 'denied' as const }));
      try {
        const module = moduleWith([], { authorizer: { authorize } });
        await expect(
          module.apply(
            profile(projectA, [
              contribution('cache', 'workspace.cache', { configuration }),
            ]),
          ),
        ).resolves.toMatchObject({ kind: 'refused' });
        expect(wideSorts).toBe(0);
        expect(wideDescriptorReads).toBe(0);
        expect(authorize).not.toHaveBeenCalled();
      } finally {
        sorting.mockRestore();
        reading.mockRestore();
      }
    },
  );

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

  test('keeps colon-bearing Agent scope tuples structurally distinct', async () => {
    const events: string[] = [];
    const module = moduleWith([factory('cache', events)]);
    const firstScope = {
      kind: 'agent',
      projectId: 'project:a',
      agentId: 'agent-b',
    } as const;
    const secondScope = {
      kind: 'agent',
      projectId: 'project',
      agentId: 'a:agent-b',
    } as const;

    await module.apply(
      profile(firstScope, [contribution('cache', 'workspace.cache')]),
    );
    await module.apply(
      profile(secondScope, [contribution('cache', 'workspace.cache')]),
    );

    const first = module.inspect(firstScope);
    const second = module.inspect(secondScope);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(1);
    expect(first.active[0].instanceIdentity).not.toBe(
      second.active[0].instanceIdentity,
    );
    expect(events).toEqual(['stage:cache', 'stage:cache']);
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

  test('keeps every contribution inspectable across plan-level refusal branches', async () => {
    const module = moduleWith([]);
    const cases = [
      {
        label: 'invalid duplicate identity',
        kind: 'refused',
        contributions: [
          contribution('first', 'workspace.first', {
            contributionId: 'shared',
          }),
          contribution('duplicate', 'workspace.duplicate', {
            contributionId: 'shared',
          }),
          contribution('independent', 'workspace.independent'),
        ],
        expected: {
          duplicate: 'invalid-contribution',
          first: 'activation-aborted',
          independent: 'activation-aborted',
        },
      },
      {
        label: 'fixed authority',
        kind: 'refused',
        contributions: [
          contribution('fixed', 'station.authorization'),
          contribution('independent', 'workspace.independent'),
        ],
        expected: {
          fixed: 'fixed-authority',
          independent: 'activation-aborted',
        },
      },
      {
        label: 'ambiguous selection',
        kind: 'refused',
        contributions: [
          contribution('local', 'workspace.index'),
          contribution('remote', 'workspace.index'),
          contribution('independent', 'workspace.independent'),
        ],
        expected: {
          local: 'ambiguous-provider',
          remote: 'ambiguous-provider',
          independent: 'activation-aborted',
        },
      },
      {
        label: 'missing dependency',
        kind: 'pending',
        contributions: [
          contribution('consumer', 'workspace.consumer', {
            requires: [{ capability: 'workspace.missing', version: '1.0.0' }],
          }),
          contribution('independent', 'workspace.independent'),
        ],
        expected: {
          consumer: 'missing-dependency',
          independent: 'activation-aborted',
        },
      },
    ] as const;

    for (const candidate of cases) {
      const result = await module.apply(
        profile(projectA, candidate.contributions),
      );
      expect(result.kind, candidate.label).toBe(candidate.kind);
      const projected = [
        ...result.inspection.pending,
        ...result.inspection.failed,
        ...result.inspection.shadowed,
      ];
      expect(projected, candidate.label).toHaveLength(
        candidate.contributions.length,
      );
      expect(
        Object.fromEntries(
          projected.map((entry) => [entry.instanceId, entry.reason]),
        ),
        candidate.label,
      ).toEqual(candidate.expected);
    }
  });

  test('projects every safe contribution when the profile identity is invalid', async () => {
    const module = moduleWith([]);
    const contributions = [
      contribution('first', 'workspace.first'),
      contribution('second', 'workspace.second'),
    ];

    await expect(
      module.apply({
        ...profile(projectA, contributions),
        profileId: 'INVALID PROFILE',
      }),
    ).resolves.toMatchObject({
      kind: 'refused',
      inspection: {
        pending: [],
        failed: [
          expect.objectContaining({
            instanceId: 'first',
            reason: 'invalid-contribution',
          }),
          expect.objectContaining({
            instanceId: 'second',
            reason: 'invalid-contribution',
          }),
        ],
        shadowed: [],
      },
    });
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

  test('invokes host capabilities without consulting hostile callable.call properties', async () => {
    const callHijack = vi.fn(() => {
      throw new Error('call property must not be consulted');
    });
    const proxyCallRead = vi.fn();
    let stageReceiver = false;
    let currentReceiver = false;
    let releaseReceiver = false;
    let disposeReceiver = false;
    let handle!: { dispose: () => void };
    let hostLease!: Extract<
      PluginCompositionAuthorization,
      { kind: 'granted' }
    >['lease'];
    const disposeTarget = function (this: object) {
      disposeReceiver = this === handle;
    };
    const dispose = new Proxy(disposeTarget, {
      get(target, property, receiver) {
        if (property === 'call') proxyCallRead();
        return Reflect.get(target, property, receiver);
      },
    });
    handle = { dispose };
    const implementation: PluginCompositionFactory = {
      async stage() {
        stageReceiver = this === implementation;
        return handle;
      },
    };
    Object.defineProperty(implementation.stage, 'call', {
      value: callHijack,
    });
    const currentTarget = function (this: object) {
      currentReceiver = this === hostLease;
      return true;
    };
    const current = new Proxy(currentTarget, {
      get(target, property, receiver) {
        if (property === 'call') proxyCallRead();
        return Reflect.get(target, property, receiver);
      },
    });
    const release = function (this: object) {
      releaseReceiver = this === hostLease;
    };
    Object.defineProperty(release, 'call', { value: callHijack });
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
            isCurrent: current,
            release,
          };
          return { kind: 'granted', lease: hostLease };
        },
      },
    });

    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
      liveFences: [],
    });
    expect(callHijack).not.toHaveBeenCalled();
    expect(proxyCallRead).not.toHaveBeenCalled();
    expect({
      stageReceiver,
      currentReceiver,
      releaseReceiver,
      disposeReceiver,
    }).toEqual({
      stageReceiver: true,
      currentReceiver: true,
      releaseReceiver: true,
      disposeReceiver: true,
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

  test('releases a safe own lease capability without evaluating unrelated hostile fields', async () => {
    const events: string[] = [];
    const implementations = new Map([factory('cache', events)]);
    const release = vi.fn();
    const releaseCallHijack = vi.fn(() => {
      throw new Error('release.call must not be consulted');
    });
    Object.defineProperty(release, 'call', { value: releaseCallHijack });
    const hostileGetter = vi.fn(() => {
      throw new Error('unrelated accessor must not run');
    });
    const module = moduleWith([], {
      authorizer: {
        authorize(input) {
          const granted = grantedPlanAuthorization(input, implementations, {
            release,
          });
          return Object.defineProperty(granted, 'hostile', {
            enumerable: true,
            get: hostileGetter,
          }) as never;
        },
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
    expect(hostileGetter).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(releaseCallHijack).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test('waits for recognizable-invalid async lease release before returning', async () => {
    const implementations = new Map([factory('cache', [])]);
    let finishRelease!: () => void;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const module = moduleWith([], {
      authorizer: {
        authorize(input) {
          const granted = grantedPlanAuthorization(input, implementations, {
            release,
          });
          return { ...granted, unexpected: true } as never;
        },
      },
    });
    let settled = false;
    const applying = module
      .apply(profile(projectA, [contribution('cache', 'workspace.cache')]))
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishRelease();

    await expect(applying).resolves.toMatchObject({ kind: 'pending' });
  });

  test('contains a rejected async release after successful publication', async () => {
    const implementations = new Map([factory('cache', [])]);
    const release = vi.fn(async () => {
      throw new Error('release failed asynchronously');
    });
    const module = moduleWith([], {
      authorizer: {
        authorize: (input) =>
          grantedPlanAuthorization(input, implementations, { release }),
      },
    });

    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({
      kind: 'activated',
      inspection: {
        active: [expect.objectContaining({ instanceId: 'cache' })],
        failed: [
          expect.objectContaining({ reason: 'authorization-release-failed' }),
        ],
      },
    });
    expect(release).toHaveBeenCalledOnce();
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'pending',
    });
  });

  test('bounds a never-settling release and continues prior-generation retirement', async () => {
    const events: string[] = [];
    let releaseCount = 0;
    const module = moduleWith([factory('cache', events)], {
      disposerTimeoutMs: 5,
      authorizer: {
        authorize(input) {
          return grantedPlanAuthorization(
            input,
            new Map([factory('cache', events)]),
            {
              release: () => {
                releaseCount += 1;
                return releaseCount === 2
                  ? new Promise<void>(() => {})
                  : Promise.resolve();
              },
            },
          );
        },
      },
    });
    await module.apply(
      profile(projectA, [
        contribution('first', 'workspace.cache', {
          implementationId: 'cache',
        }),
      ]),
    );

    await expect(
      module.apply(
        profile(projectA, [
          contribution('second', 'workspace.cache', {
            implementationId: 'cache',
          }),
        ]),
      ),
    ).resolves.toMatchObject({ kind: 'activated', generation: 2 });
    expect(events).toContain('dispose:first');
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'pending',
      liveFences: [
        expect.objectContaining({ reason: 'authorization-release-pending' }),
      ],
    });
  });

  test.each(
    (
      [
        'published',
        'missing-binding',
        'malformed',
        'stale',
        'rollback',
      ] as const
    ).flatMap((path) =>
      (['reject', 'hang'] as const).map((behavior) => ({ path, behavior })),
    ),
  )(
    'retains actual release custody for $path / $behavior without double release',
    async ({ path, behavior }) => {
      vi.useFakeTimers();
      try {
        let finishRelease!: () => void;
        const release = vi.fn(() =>
          behavior === 'reject'
            ? Promise.reject(new Error('release rejected'))
            : new Promise<void>((resolve) => {
                finishRelease = resolve;
              }),
        );
        const implementations = new Map([
          factory('a', []),
          factory('b', [], { fail: true }),
        ]);
        let calls = 0;
        const authorize = vi.fn(
          (input: Parameters<PluginCompositionAuthorizer['authorize']>[0]) => {
            calls += 1;
            const granted = grantedPlanAuthorization(input, implementations, {
              release: calls === 1 ? release : undefined,
              isCurrent: () => path !== 'stale' || calls > 1,
            });
            if (path === 'missing-binding')
              return { ...granted, lease: { ...granted.lease, bindings: [] } };
            if (path === 'malformed')
              return { ...granted, unexpected: true } as never;
            return granted;
          },
        );
        const module = moduleWith([], {
          authorizer: { authorize },
          disposerTimeoutMs: 5,
          maxRetainedScopes: 1,
        });
        const candidate = profile(projectA, [
          contribution('a', 'workspace.a'),
          ...(path === 'rollback' ? [contribution('b', 'workspace.b')] : []),
        ]);
        const applying = module.apply(candidate);
        await vi.advanceTimersByTimeAsync(30);
        const result = await applying;
        const reason =
          behavior === 'reject'
            ? 'authorization-release-failed'
            : 'authorization-release-pending';
        expect([
          ...result.inspection.pending,
          ...result.inspection.failed,
        ]).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason })]),
        );
        if (path === 'published') {
          expect(result.kind).toBe('activated');
          expect(result.inspection.active).toHaveLength(1);
        }
        await expect(module.apply(candidate)).resolves.toMatchObject({
          kind: 'pending',
        });
        expect(authorize).toHaveBeenCalledTimes(1);
        await expect(module.retire(projectA)).resolves.toMatchObject({
          kind: 'pending',
          liveFences: expect.arrayContaining([
            expect.objectContaining({ reason }),
          ]),
        });
        expect(release).toHaveBeenCalledTimes(1);
        await expect(
          module.apply(profile(projectB, [contribution('a', 'workspace.a')])),
        ).resolves.toMatchObject({ kind: 'refused' });
        if (behavior === 'hang') {
          finishRelease();
          await vi.advanceTimersByTimeAsync(0);
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'retired',
            liveFences: [],
          });
        } else {
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'pending',
          });
        }
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('inspection and retirement preserve both lease and disposer failures for the same occurrence', async () => {
    const release = vi.fn(async () => {
      throw new Error('release failed');
    });
    const dispose = vi.fn(async () => {
      throw new Error('dispose failed');
    });
    const module = moduleWith([['a', { stage: async () => ({ dispose }) }]], {
      onRelease: release,
    });
    const result = await module.apply(
      profile(projectA, [contribution('a', 'workspace.a')]),
    );
    expect(result.kind).toBe('activated');
    if (result.kind === 'activated') {
      // Public fence projections are snapshots, not mutable custody records.
      (result.liveFences[0] as { reason: string }).reason = 'tampered';
    }
    const retired = await module.retire(projectA);
    expect(retired.kind).toBe('pending');
    expect(retired.inspection.failed.map((item) => item.reason).sort()).toEqual(
      ['authorization-release-failed', 'disposer-failed'],
    );
    expect(release).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('a denied no-lease authorization creates no release debt', async () => {
    const module = moduleWith([], { authorize: () => 'denied' });
    await expect(
      module.apply(profile(projectA, [contribution('a', 'workspace.a')])),
    ).resolves.toMatchObject({ kind: 'failed' });
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
      liveFences: [],
    });
  });

  test('published generation no longer appears as staging during prior retirement', async () => {
    const events: string[] = [];
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const implementation: PluginCompositionFactory = {
      async stage(input) {
        events.push(`stage:${input.contribution.instanceId}`);
        return {
          dispose: () => {
            events.push(`dispose:${input.contribution.instanceId}`);
            return input.contribution.instanceId === 'first'
              ? retirement
              : undefined;
          },
        };
      },
    };
    const module = moduleWith([['cache', implementation]], {
      disposerTimeoutMs: 1_000,
    });
    await module.apply(
      profile(projectA, [
        contribution('first', 'workspace.cache', {
          implementationId: 'cache',
        }),
      ]),
    );
    const replacing = module.apply(
      profile(projectA, [
        contribution('second', 'workspace.cache', {
          implementationId: 'cache',
        }),
      ]),
    );
    await vi.waitFor(() => expect(events).toContain('dispose:first'));

    expect(module.inspect(projectA)).toMatchObject({
      active: [expect.objectContaining({ instanceId: 'second' })],
      pending: [],
    });
    finishRetirement();
    await expect(replacing).resolves.toMatchObject({ kind: 'activated' });
  });

  test('bounds a stalled authorizer and releases a late lease', async () => {
    const implementation = new Map([factory('cache', [])]);
    const release = vi.fn();
    let authorizeCalls = 0;
    let finishAuthorization!: () => void;
    let authorizationInput!: Parameters<
      PluginCompositionAuthorizer['authorize']
    >[0];
    const module = moduleWith([], {
      disposerTimeoutMs: 5,
      authorizer: {
        authorize(input) {
          authorizeCalls += 1;
          authorizationInput = input;
          return new Promise<PluginCompositionAuthorization>((resolve) => {
            finishAuthorization = () =>
              resolve(
                grantedPlanAuthorization(input, implementation, { release }),
              );
          });
        },
      },
    });

    await expect(
      module.apply(
        profile(projectA, [
          contribution('cache', 'workspace.cache', {
            implementationId: 'cache',
          }),
        ]),
      ),
    ).resolves.toMatchObject({ kind: 'pending' });
    expect(authorizationInput.scope).toEqual(projectA);

    await module.retire(projectA);
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'pending' });
    expect(authorizeCalls).toBe(1);
    expect(module.inspect(projectA).pending).toHaveLength(1);

    finishAuthorization();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
    });
  });

  test.each(
    (['reject', 'hang'] as const).flatMap((behavior) =>
      [false, true].map((malformed) => ({ behavior, malformed })),
    ),
  )(
    'retains admission and actual release debt for late $behavior / malformed=$malformed',
    async ({ behavior, malformed }) => {
      vi.useFakeTimers();
      try {
        const events: string[] = [];
        const implementations = new Map([factory('cache', events)]);
        let finishAuthorization!: () => void;
        let finishRelease!: () => void;
        const release = vi.fn(() =>
          behavior === 'reject'
            ? Promise.reject(new Error('late release failed'))
            : new Promise<void>((resolve) => {
                finishRelease = resolve;
              }),
        );
        let authorizeCalls = 0;
        const authorize = vi.fn(
          (input: Parameters<PluginCompositionAuthorizer['authorize']>[0]) => {
            authorizeCalls += 1;
            if (authorizeCalls > 1)
              return grantedPlanAuthorization(input, implementations);
            return new Promise<PluginCompositionAuthorization>((resolve) => {
              finishAuthorization = () => {
                const granted = grantedPlanAuthorization(
                  input,
                  implementations,
                  { release },
                );
                resolve(
                  malformed
                    ? ({ ...granted, unexpected: true } as never)
                    : granted,
                );
              };
            });
          },
        );
        const module = moduleWith([], {
          disposerTimeoutMs: 5,
          authorizer: { authorize },
        });
        const candidate = profile(projectA, [
          contribution('cache', 'workspace.cache'),
        ]);
        const applying = module.apply(candidate);
        await vi.advanceTimersByTimeAsync(6);
        await expect(applying).resolves.toMatchObject({ kind: 'pending' });
        finishAuthorization();
        await vi.advanceTimersByTimeAsync(20);
        expect(release).toHaveBeenCalledOnce();

        await module.retire(projectA);
        await expect(module.apply(candidate)).resolves.toMatchObject({
          kind: 'pending',
        });
        expect(authorize).toHaveBeenCalledOnce();
        const debt = module.inspect(projectA);
        expect([...debt.pending, ...debt.failed]).toEqual([
          expect.objectContaining({
            reason:
              behavior === 'reject'
                ? 'authorization-release-failed'
                : 'authorization-release-pending',
          }),
        ]);
        expect(events).toEqual([]);

        if (behavior === 'hang') {
          finishRelease();
          await vi.advanceTimersByTimeAsync(0);
          await expect(module.apply(candidate)).resolves.toMatchObject({
            kind: 'activated',
          });
          expect(authorize).toHaveBeenCalledTimes(2);
          expect(events).toEqual(['stage:cache']);
          await module.retire(projectA);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('bounds stalled staging and disposes a late fenced handle', async () => {
    let finishDisposal!: () => void;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDisposal = resolve;
        }),
    );
    const release = vi.fn();
    let stageCalls = 0;
    let finishStage!: () => void;
    let occurrenceCurrent: (() => boolean) | undefined;
    const implementation: PluginCompositionFactory = {
      stage(input) {
        stageCalls += 1;
        occurrenceCurrent = input.occurrence.isCurrent;
        return new Promise((resolve) => {
          finishStage = () => resolve({ dispose });
        });
      },
    };
    const module = moduleWith([['cache', implementation]], {
      disposerTimeoutMs: 5,
      onRelease: release,
    });

    await expect(
      module.apply(
        profile(projectA, [
          contribution('cache', 'workspace.cache', {
            implementationId: 'cache',
          }),
        ]),
      ),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(occurrenceCurrent?.()).toBe(false);
    expect(release).not.toHaveBeenCalled();
    // Inspect before retire/apply can replace the failed attempt projection.
    expect(module.inspect(projectA).pending).toEqual([
      expect.objectContaining({ instanceId: 'cache', status: 'pending' }),
    ]);

    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'pending',
      liveFences: [expect.objectContaining({ instanceId: 'cache' })],
    });
    await expect(
      module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'pending' });
    expect(stageCalls).toBe(1);
    expect(module.inspect(projectA).pending).toHaveLength(1);

    finishStage();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    finishDisposal();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
    });
  });

  test.each([
    ['stage-failure', 'resolve'],
    ['stage-failure', 'reject'],
    ['stale-authorization', 'resolve'],
    ['stale-authorization', 'reject'],
  ] as const)(
    'retains ordinary %s rollback ownership until disposer will %s',
    async (failure, outcome) => {
      vi.useFakeTimers();
      let finishDisposal!: () => void;
      let current = true;
      const release = vi.fn();
      const dispose = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finishDisposal = () =>
              outcome === 'resolve'
                ? resolve()
                : reject(new Error('rollback failed'));
          }),
      );
      const firstStage = vi.fn(async () => {
        if (failure === 'stale-authorization') current = false;
        return { dispose };
      });
      const secondStage = vi.fn(async () => {
        throw new Error('stage failed');
      });
      const module = moduleWith(
        [
          ['a', { stage: firstStage }],
          ['b', { stage: secondStage }],
        ],
        { disposerTimeoutMs: 5, onRelease: release, isCurrent: () => current },
      );
      const candidate = profile(projectA, [
        contribution('a', 'workspace.a'),
        contribution('b', 'workspace.b', {
          requires: [{ capability: 'workspace.a', version: '1.0.0' }],
        }),
      ]);
      try {
        const applying = module.apply(candidate);
        await vi.advanceTimersByTimeAsync(11);
        await expect(applying).resolves.toMatchObject({
          kind: failure === 'stage-failure' ? 'failed' : 'pending',
        });
        expect(dispose).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(module.inspect(projectA).pending).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ instanceId: 'a', status: 'pending' }),
          ]),
        );
        await expect(module.apply(candidate)).resolves.toMatchObject({
          kind: 'pending',
        });
        expect(firstStage).toHaveBeenCalledOnce();
        await expect(module.retire(projectA)).resolves.toMatchObject({
          kind: 'pending',
        });
        finishDisposal();
        await vi.advanceTimersByTimeAsync(0);
        expect(dispose).toHaveBeenCalledOnce();
        if (outcome === 'resolve') {
          expect(release).toHaveBeenCalledOnce();
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'retired',
          });
        } else {
          expect(release).not.toHaveBeenCalled();
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'pending',
          });
          expect(module.inspect(projectA).pending.length).toBeGreaterThan(0);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(['resolve', 'reject'] as const)(
    'projects ordinary rollback debt while lease release will %s',
    async (outcome) => {
      vi.useFakeTimers();
      let finishRelease!: () => void;
      const release = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finishRelease = () =>
              outcome === 'resolve'
                ? resolve()
                : reject(new Error('release failed'));
          }),
      );
      const dispose = vi.fn();
      const module = moduleWith(
        [
          ['a', { stage: async () => ({ dispose }) }],
          [
            'b',
            {
              stage: async () => {
                throw new Error('stage failed');
              },
            },
          ],
        ],
        { disposerTimeoutMs: 5, onRelease: release },
      );
      const candidate = profile(projectA, [
        contribution('a', 'workspace.a'),
        contribution('b', 'workspace.b', {
          requires: [{ capability: 'workspace.a', version: '1.0.0' }],
        }),
      ]);
      try {
        const applying = module.apply(candidate);
        await vi.advanceTimersByTimeAsync(6);
        const result = await applying;
        expect(result.kind).toBe('failed');
        expect(result.inspection.pending.length).toBeGreaterThan(0);
        expect(dispose).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        await expect(module.apply(candidate)).resolves.toMatchObject({
          kind: 'pending',
        });
        finishRelease();
        await vi.advanceTimersByTimeAsync(0);
        await expect(module.retire(projectA)).resolves.toMatchObject({
          kind: outcome === 'resolve' ? 'retired' : 'pending',
        });
        expect(release).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each([
    ['resolve', 'resolve'],
    ['resolve', 'reject'],
    ['reject', 'resolve'],
    ['reject', 'reject'],
  ] as const)(
    'joins the whole rollback plan when late stage %s and prior disposer %s',
    async (lateOutcome, priorOutcome) => {
      vi.useFakeTimers();
      let finishPrior!: () => void;
      let finishLate!: () => void;
      const priorDispose = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finishPrior = () =>
              priorOutcome === 'resolve'
                ? resolve()
                : reject(new Error('prior rollback failed'));
          }),
      );
      const lateDispose = vi.fn();
      const release = vi.fn();
      const firstStage = vi.fn(async () => ({ dispose: priorDispose }));
      const lateStage = vi.fn(
        () =>
          new Promise<{ dispose: () => void }>((resolve, reject) => {
            finishLate = () =>
              lateOutcome === 'resolve'
                ? resolve({ dispose: lateDispose })
                : reject(new Error('late staging failed'));
          }),
      );
      const module = moduleWith(
        [
          ['a', { stage: firstStage }],
          ['b', { stage: lateStage }],
        ],
        { disposerTimeoutMs: 5, onRelease: release },
      );
      const candidate = profile(projectA, [
        contribution('a', 'workspace.a'),
        contribution('b', 'workspace.b', {
          requires: [{ capability: 'workspace.a', version: '1.0.0' }],
        }),
      ]);
      try {
        const applying = module.apply(candidate);
        await vi.advanceTimersByTimeAsync(11);
        await expect(applying).resolves.toMatchObject({ kind: 'failed' });
        expect(priorDispose).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();

        finishLate();
        await vi.advanceTimersByTimeAsync(0);
        expect(lateDispose).toHaveBeenCalledTimes(
          lateOutcome === 'resolve' ? 1 : 0,
        );
        expect(release).not.toHaveBeenCalled();
        await expect(module.retire(projectA)).resolves.toMatchObject({
          kind: 'pending',
        });
        await expect(module.apply(candidate)).resolves.toMatchObject({
          kind: 'pending',
        });
        expect(firstStage).toHaveBeenCalledOnce();
        expect(lateStage).toHaveBeenCalledOnce();

        finishPrior();
        await vi.advanceTimersByTimeAsync(0);
        expect(priorDispose).toHaveBeenCalledOnce();
        if (priorOutcome === 'resolve') {
          expect(release).toHaveBeenCalledOnce();
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'retired',
            liveFences: [],
          });
        } else {
          expect(release).not.toHaveBeenCalled();
          await expect(module.retire(projectA)).resolves.toMatchObject({
            kind: 'pending',
          });
          expect(module.inspect(projectA).failed).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                instanceId: 'a',
                reason: 'rollback-failed',
              }),
            ]),
          );
        }
      } finally {
        finishLate?.();
        finishPrior?.();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    },
  );

  test.each(['constructor'])(
    'empty selections cannot invent a provider selection for %s',
    async (capability) => {
      const module = moduleWith([factory('cache', [])]);
      await expect(
        module.apply(
          profile(projectA, [contribution('cache', capability)], {}),
        ),
      ).resolves.toMatchObject({ kind: 'activated' });
    },
  );

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

  test('disposes a safe own staged capability without evaluating unrelated hostile fields', async () => {
    const observations: string[] = [];
    const hostileGetter = vi.fn(() => {
      throw new Error('unrelated accessor must not run');
    });
    let handle!: { dispose(): void; hostile?: unknown };
    const dispose = vi.fn(function (this: object) {
      observations.push(`dispose:${this === handle}`);
    });
    handle = { dispose };
    Object.defineProperty(handle, 'hostile', {
      enumerable: true,
      get: hostileGetter,
    });
    const implementation: PluginCompositionFactory = {
      async stage() {
        return handle;
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
    expect(hostileGetter).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(observations).toEqual(['dispose:true']);
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

  test('capacity refusal transiently projects every selected and shadowed contribution', async () => {
    const authorize = vi.fn(async () => 'granted' as const);
    const module = moduleWith(
      [factory('chosen', []), factory('other', []), factory('independent', [])],
      { maxRetainedScopes: 1, authorize },
    );
    await module.apply(
      profile(projectA, [contribution('chosen', 'workspace.cache')]),
    );
    const requested = profile(
      projectB,
      [
        contribution('chosen', 'workspace.cache'),
        contribution('other', 'workspace.cache'),
        contribution('independent', 'workspace.index'),
      ],
      { 'workspace.cache': 'chosen' },
    );

    const refused = await module.apply(requested);

    expect(refused.kind).toBe('refused');
    expect(
      refused.inspection.pending.map((item) => [item.instanceId, item.reason]),
    ).toEqual([
      ['chosen', 'scope-capacity'],
      ['independent', 'scope-capacity'],
    ]);
    expect(refused.inspection.shadowed.map((item) => item.instanceId)).toEqual([
      'other',
    ]);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(module.inspect(projectB)).toMatchObject({
      active: [],
      pending: [],
      failed: [],
      shadowed: [],
    });
    await module.retire(projectA);
    await expect(module.apply(requested)).resolves.toMatchObject({
      kind: 'activated',
    });
  });

  test.each(['rejecting', 'never-settling'] as const)(
    'retirement stays pending while a %s disposer retains its fence',
    async (behavior) => {
      const dispose = vi.fn(() =>
        behavior === 'rejecting'
          ? Promise.reject(new Error('disposal failed'))
          : new Promise<void>(() => {}),
      );
      const module = moduleWith(
        [['cache', { stage: async () => ({ dispose }) }]],
        {
          disposerTimeoutMs: 5,
          maxRetainedScopes: 1,
        },
      );
      await module.apply(
        profile(projectA, [contribution('cache', 'workspace.cache')]),
      );
      const reason =
        behavior === 'rejecting' ? 'disposer-failed' : 'disposer-timeout';
      await expect(module.retire(projectA)).resolves.toMatchObject({
        kind: 'pending',
        liveFences: [expect.objectContaining({ reason })],
        inspection: {
          active: [],
          failed: [expect.objectContaining({ reason })],
        },
      });
      await expect(module.retire(projectA)).resolves.toMatchObject({
        kind: 'pending',
      });
      expect(dispose).toHaveBeenCalledTimes(1);
      await expect(
        module.apply(
          profile(projectB, [contribution('cache', 'workspace.cache')]),
        ),
      ).resolves.toMatchObject({ kind: 'refused' });
    },
  );

  test('retirement reports completion only after its late disposer settles', async () => {
    let finish!: () => void;
    const module = moduleWith(
      [
        [
          'cache',
          {
            stage: async () => ({
              dispose: () =>
                new Promise<void>((resolve) => {
                  finish = resolve;
                }),
            }),
          },
        ],
      ],
      { disposerTimeoutMs: 5, maxRetainedScopes: 1 },
    );
    await module.apply(
      profile(projectA, [contribution('cache', 'workspace.cache')]),
    );
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'pending',
    });
    finish();
    await vi.waitFor(() => expect(module.inspect(projectA).failed).toEqual([]));
    await expect(module.retire(projectA)).resolves.toMatchObject({
      kind: 'retired',
      liveFences: [],
    });
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
  });

  test('unknown retirement does not consume retained-scope capacity', async () => {
    const module = moduleWith([factory('cache', [])], {
      maxRetainedScopes: 1,
    });

    const unknownRetirement = module.retire(projectA);
    await expect(
      module.apply(
        profile(projectB, [contribution('cache', 'workspace.cache')]),
      ),
    ).resolves.toMatchObject({ kind: 'activated' });
    await expect(unknownRetirement).resolves.toMatchObject({ kind: 'retired' });
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
