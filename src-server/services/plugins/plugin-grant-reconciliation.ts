import { randomUUID } from 'node:crypto';
import { awaitSettlementWithin } from '../../utils/bounded-async.js';

export interface PluginGrantRuntimeSnapshot {
  readonly installed: boolean;
  /** Exact installed-tree generation; null means it cannot be established. */
  readonly installationGeneration: string | null;
  /** Generation of this source's currently published provider registration. */
  readonly providerGeneration: number;
  readonly grants: readonly string[];
}

export type PluginGrantRuntimeGenerationFence = Pick<
  PluginGrantRuntimeSnapshot,
  'installed' | 'installationGeneration' | 'providerGeneration'
>;

export interface PluginGrantQuiescence {
  release(): void;
}

export interface PluginGrantReconciliationAdapters {
  snapshot(pluginName: string): Promise<PluginGrantRuntimeSnapshot>;
  quiesceModule(pluginName: string): Promise<PluginGrantQuiescence>;
  quiesceSubscriptions(pluginName: string): Promise<PluginGrantQuiescence>;
  retireProviders(
    pluginName: string,
    expectedGeneration: number,
  ): Promise<'retired' | 'superseded'>;
  activateProviders(
    pluginName: string,
    expected: PluginGrantRuntimeGenerationFence,
    isCurrent: () => boolean,
  ): Promise<'activated' | 'superseded'>;
  settleProviderAdapters(pluginName: string): Promise<void>;
  removeEngineConnections(
    pluginName: string,
    expected: PluginGrantRuntimeGenerationFence,
  ): Promise<'removed' | 'superseded'>;
  reconcileEngineConnections(pluginName: string): Promise<void>;
  reconcileSubscriptions(): Promise<{ kind: 'applied' | 'unavailable' }>;
}

export type PluginGrantReconciliationStage =
  | 'module-quiescence'
  | 'subscription-quiescence'
  | 'provider-retirement'
  | 'provider-activation'
  | 'adapter-retirement'
  | 'engine-connections'
  | 'event-subscriptions'
  | 'snapshot'
  | 'capacity';

export type PluginGrantReconciliationResult =
  | {
      readonly status: 'completed';
      readonly operationId: string;
      readonly generation: number;
      readonly installationGeneration: string | null;
      readonly effects: readonly PluginGrantReconciliationStage[];
    }
  | {
      readonly status: 'superseded';
      readonly operationId: string;
      readonly generation: number;
    }
  | {
      readonly status: 'incomplete';
      readonly operationId: string;
      readonly generation: number;
      readonly failures: readonly PluginGrantReconciliationStage[];
    }
  | {
      readonly status: 'winding-down';
      readonly operationId: string;
      readonly generation: number;
    };

const LIFECYCLE_PERMISSIONS = new Set([
  'providers.register',
  'plugin.server',
  'events.subscribe',
  'events.read-payload',
]);

export function pluginPermissionsNeedRuntimeReconciliation(
  permissions: readonly string[],
): boolean {
  return permissions.some((permission) =>
    LIFECYCLE_PERMISSIONS.has(permission),
  );
}

export function createPluginGrantReconciliationService(
  adapters: PluginGrantReconciliationAdapters,
  options: { responseDeadlineMs?: number } = {},
) {
  const deadlineMs = options.responseDeadlineMs ?? 2_000;
  const generations = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const pendingPermissions = new Map<string, Set<string>>();
  const retained = new Map<
    string,
    { generation: number; result?: PluginGrantReconciliationResult }
  >();

  const currentGeneration = (pluginName: string) =>
    generations.get(pluginName) ?? 0;

  const perform = async (input: {
    pluginName: string;
    permissions: readonly string[];
    generation: number;
    operationId: string;
  }): Promise<PluginGrantReconciliationResult> => {
    const effects: PluginGrantReconciliationStage[] = [];
    const failures: PluginGrantReconciliationStage[] = [];
    const guards: Array<{
      guard: PluginGrantQuiescence;
      stage: 'module-quiescence' | 'subscription-quiescence';
    }> = [];
    let expectedProviderGeneration: number | undefined;
    const current = () =>
      currentGeneration(input.pluginName) === input.generation;
    const relevantGrantFingerprint = (snapshot: PluginGrantRuntimeSnapshot) =>
      input.permissions
        .filter((permission) => LIFECYCLE_PERMISSIONS.has(permission))
        .map((permission) =>
          snapshot.grants.includes(permission)
            ? `${permission}:1`
            : `${permission}:0`,
        )
        .join('|');
    let initial: PluginGrantRuntimeSnapshot;
    try {
      initial = await adapters.snapshot(input.pluginName);
    } catch {
      return {
        status: 'incomplete',
        operationId: input.operationId,
        generation: input.generation,
        failures: ['snapshot'],
      };
    }
    if (!current()) {
      return {
        status: 'superseded',
        operationId: input.operationId,
        generation: input.generation,
      };
    }
    expectedProviderGeneration = initial.providerGeneration;
    const matchesCurrentGeneration = (
      snapshot: PluginGrantRuntimeSnapshot,
      providerGeneration: number,
    ) =>
      current() &&
      snapshot.installed === initial.installed &&
      snapshot.installationGeneration === initial.installationGeneration &&
      snapshot.providerGeneration === providerGeneration &&
      relevantGrantFingerprint(snapshot) === relevantGrantFingerprint(initial);
    const changed = new Set(input.permissions);
    const reconcileEvents =
      changed.has('plugin.server') ||
      changed.has('events.subscribe') ||
      changed.has('events.read-payload');

    try {
      if (reconcileEvents) {
        try {
          guards.push({
            guard: await adapters.quiesceSubscriptions(input.pluginName),
            stage: 'subscription-quiescence',
          });
          effects.push('subscription-quiescence');
        } catch {
          failures.push('subscription-quiescence');
        }
      }
      if (!current()) {
        return {
          status: 'superseded',
          operationId: input.operationId,
          generation: input.generation,
        };
      }
      if (
        changed.has('plugin.server') &&
        !initial.grants.includes('plugin.server')
      ) {
        try {
          guards.push({
            guard: await adapters.quiesceModule(input.pluginName),
            stage: 'module-quiescence',
          });
          effects.push('module-quiescence');
        } catch {
          failures.push('module-quiescence');
        }
      }
      if (!current()) {
        return {
          status: 'superseded',
          operationId: input.operationId,
          generation: input.generation,
        };
      }
      let beforeEffect: PluginGrantRuntimeSnapshot;
      try {
        beforeEffect = await adapters.snapshot(input.pluginName);
      } catch {
        failures.push('snapshot');
        return {
          status: 'incomplete',
          operationId: input.operationId,
          generation: input.generation,
          failures,
        };
      }
      if (
        !current() ||
        beforeEffect.installed !== initial.installed ||
        beforeEffect.installationGeneration !== initial.installationGeneration
      ) {
        return {
          status: 'superseded',
          operationId: input.operationId,
          generation: input.generation,
        };
      }

      if (changed.has('providers.register')) {
        if (beforeEffect.grants.includes('providers.register')) {
          try {
            const activated = await adapters.activateProviders(
              input.pluginName,
              {
                installed: beforeEffect.installed,
                installationGeneration: beforeEffect.installationGeneration,
                providerGeneration: beforeEffect.providerGeneration,
              },
              current,
            );
            if (activated === 'superseded') {
              return {
                status: 'superseded',
                operationId: input.operationId,
                generation: input.generation,
              };
            }
            effects.push('provider-activation');
            expectedProviderGeneration = beforeEffect.providerGeneration + 1;
          } catch {
            failures.push('provider-activation');
          }
          if (current()) {
            try {
              await adapters.settleProviderAdapters(input.pluginName);
              effects.push('adapter-retirement');
            } catch {
              failures.push('adapter-retirement');
            }
          }
          let activatedSnapshot: PluginGrantRuntimeSnapshot | undefined;
          try {
            activatedSnapshot = await adapters.snapshot(input.pluginName);
          } catch {
            failures.push('snapshot');
          }
          if (
            activatedSnapshot &&
            !matchesCurrentGeneration(
              activatedSnapshot,
              expectedProviderGeneration,
            )
          ) {
            return {
              status: 'superseded',
              operationId: input.operationId,
              generation: input.generation,
            };
          }
          try {
            if (activatedSnapshot) {
              await adapters.reconcileEngineConnections(input.pluginName);
              effects.push('engine-connections');
            }
          } catch {
            failures.push('engine-connections');
          }
        } else {
          try {
            const retired = await adapters.retireProviders(
              input.pluginName,
              beforeEffect.providerGeneration,
            );
            if (retired === 'superseded') {
              return {
                status: 'superseded',
                operationId: input.operationId,
                generation: input.generation,
              };
            }
            effects.push('provider-retirement');
            expectedProviderGeneration = beforeEffect.providerGeneration + 1;
          } catch {
            failures.push('provider-retirement');
          }
          try {
            await adapters.settleProviderAdapters(input.pluginName);
            effects.push('adapter-retirement');
          } catch {
            failures.push('adapter-retirement');
          }
          let retiredSnapshot: PluginGrantRuntimeSnapshot | undefined;
          try {
            retiredSnapshot = await adapters.snapshot(input.pluginName);
          } catch {
            failures.push('snapshot');
          }
          if (
            retiredSnapshot &&
            !matchesCurrentGeneration(
              retiredSnapshot,
              expectedProviderGeneration,
            )
          ) {
            return {
              status: 'superseded',
              operationId: input.operationId,
              generation: input.generation,
            };
          }
          try {
            if (retiredSnapshot) {
              const removed = await adapters.removeEngineConnections(
                input.pluginName,
                {
                  installed: retiredSnapshot.installed,
                  installationGeneration:
                    retiredSnapshot.installationGeneration,
                  providerGeneration: retiredSnapshot.providerGeneration,
                },
              );
              if (removed === 'superseded') {
                return {
                  status: 'superseded',
                  operationId: input.operationId,
                  generation: input.generation,
                };
              }
              effects.push('engine-connections');
            }
          } catch {
            failures.push('engine-connections');
          }
        }
      }
    } finally {
      for (const entry of guards.reverse()) {
        try {
          entry.guard.release();
        } catch {
          failures.push(entry.stage);
        }
      }
    }

    if (reconcileEvents) {
      try {
        const subscriptions = await adapters.reconcileSubscriptions();
        if (subscriptions.kind === 'applied')
          effects.push('event-subscriptions');
        else failures.push('event-subscriptions');
      } catch {
        failures.push('event-subscriptions');
      }
    }
    let finalSnapshot: PluginGrantRuntimeSnapshot;
    try {
      finalSnapshot = await adapters.snapshot(input.pluginName);
    } catch {
      failures.push('snapshot');
      return {
        status: 'incomplete',
        operationId: input.operationId,
        generation: input.generation,
        failures: [...new Set(failures)],
      };
    }
    if (
      !current() ||
      finalSnapshot.installed !== initial.installed ||
      finalSnapshot.installationGeneration !== initial.installationGeneration ||
      finalSnapshot.providerGeneration !== expectedProviderGeneration ||
      relevantGrantFingerprint(finalSnapshot) !==
        relevantGrantFingerprint(initial)
    ) {
      return {
        status: 'superseded',
        operationId: input.operationId,
        generation: input.generation,
      };
    }
    return failures.length > 0
      ? {
          status: 'incomplete',
          operationId: input.operationId,
          generation: input.generation,
          failures: [...new Set(failures)],
        }
      : {
          status: 'completed',
          operationId: input.operationId,
          generation: input.generation,
          installationGeneration: initial.installationGeneration,
          effects,
        };
  };

  return Object.freeze({
    async reconcile(input: {
      pluginName: string;
      permissions: readonly string[];
    }): Promise<PluginGrantReconciliationResult> {
      const operationId = randomUUID();
      if (!retained.has(input.pluginName) && retained.size >= 256) {
        const evictable = [...retained].find(
          ([pluginName, record]) =>
            !tails.has(pluginName) && record.result?.status === 'completed',
        );
        if (evictable) {
          const [evictablePluginName] = evictable;
          retained.delete(evictablePluginName);
          generations.delete(evictablePluginName);
          pendingPermissions.delete(evictablePluginName);
        }
      }
      if (!retained.has(input.pluginName) && retained.size >= 256) {
        return {
          status: 'incomplete',
          operationId,
          generation: 0,
          failures: ['capacity'],
        };
      }
      const generation = currentGeneration(input.pluginName) + 1;
      generations.set(input.pluginName, generation);
      const completePermissionVector =
        pendingPermissions.get(input.pluginName) ?? new Set<string>();
      for (const permission of input.permissions) {
        if (LIFECYCLE_PERMISSIONS.has(permission)) {
          completePermissionVector.add(permission);
        }
      }
      pendingPermissions.set(input.pluginName, completePermissionVector);
      const prior = tails.get(input.pluginName) ?? Promise.resolve();
      const work = prior
        .catch(() => undefined)
        .then(() =>
          perform({
            ...input,
            permissions: [...completePermissionVector],
            generation,
            operationId,
          }),
        );
      retained.set(input.pluginName, { generation });
      const tail = work.then(
        (result) => {
          const record = retained.get(input.pluginName);
          if (record?.generation === generation) {
            record.result = result;
            if (result.status === 'completed') {
              pendingPermissions.delete(input.pluginName);
            }
          }
        },
        () => undefined,
      );
      tails.set(input.pluginName, tail);
      void tail.finally(() => {
        if (tails.get(input.pluginName) === tail)
          tails.delete(input.pluginName);
      });
      if (await awaitSettlementWithin(work, deadlineMs)) return work;
      return { status: 'winding-down', operationId, generation };
    },
    inspect(pluginName: string) {
      return retained.get(pluginName)?.result;
    },
  });
}

export type PluginGrantReconciliationService = ReturnType<
  typeof createPluginGrantReconciliationService
>;
