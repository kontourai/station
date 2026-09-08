import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCanonicalPluginId,
  type PluginManifest,
  type PluginOperationalEventSubscriptionEntry,
} from '@kontourai/station-contracts/plugin';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  type AcquiredPluginPublicServerModule,
  acquirePluginPublicServerModule,
} from '../../routes/plugins/plugin-public-server.js';
import type {
  OperationalEventSubscription,
  OperationalEventSubscriptionAuthorization,
  OperationalEventSubscriptionCloseOutcome,
  OperationalEventSubscriptionDeclaration,
  OperationalEventSubscriptionDispatchOutcome,
  OperationalEventSubscriptionRegistry,
} from '../../services/operational-events/operational-event-subscriptions.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import {
  getPluginGrants,
  PluginGrantsUnavailableError,
  readPluginGrantState,
} from '../../services/plugins/plugin-permissions.js';
import {
  capturePluginRuntimeArtifact,
  type PluginRuntimeArtifact,
} from '../../services/plugins/plugin-runtime-artifact.js';
import { pluginEventSubscriptionOperations } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';

const EMPTY_POLL_MS = 5_000;
const RETRY_POLL_MS = 1_000;
const GAP_POLL_MS = 30_000;

interface DesiredSubscription {
  declaration: OperationalEventSubscriptionDeclaration;
  entry: PluginOperationalEventSubscriptionEntry;
  fingerprint: string;
  artifact: PluginRuntimeArtifact;
  pluginName: string;
}

interface ActiveSubscription {
  acquired: AcquiredPluginPublicServerModule;
  desired: DesiredSubscription;
  running?: Promise<void>;
  stopping: boolean;
  subscription: OperationalEventSubscription;
  timer?: ReturnType<typeof setTimeout>;
}

export type PluginOperationalEventSubscriptionReconcileOutcome =
  | { kind: 'applied'; active: number }
  | { kind: 'unavailable' };

export interface PluginOperationalEventSubscriptionService {
  start(): Promise<PluginOperationalEventSubscriptionReconcileOutcome>;
  reconcile(): Promise<PluginOperationalEventSubscriptionReconcileOutcome>;
  quiesce(
    pluginName?: string,
  ): Promise<PluginOperationalEventSubscriptionQuiescence>;
  close(): Promise<OperationalEventSubscriptionCloseOutcome>;
}

export interface PluginOperationalEventSubscriptionQuiescence {
  release(): void;
}

interface PluginOperationalEventSubscriptionServiceOptions {
  eventBus: Pick<EventBus, 'subscribe'>;
  eventStore: Pick<EventStore, 'createOperationalEventSubscriptionRegistry'>;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  projectHomeDir: string;
  acquireModule?: typeof acquirePluginPublicServerModule;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  readGrants?: typeof getPluginGrants;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sameDeclaration(
  left: OperationalEventSubscriptionDeclaration,
  right: OperationalEventSubscriptionDeclaration,
): boolean {
  return stableJson(left) === stableJson(right);
}

function sameEntry(
  left: PluginOperationalEventSubscriptionEntry,
  right: PluginOperationalEventSubscriptionEntry,
): boolean {
  return stableJson(left) === stableJson(right);
}

function consumerId(subscriberId: string): string {
  return `plugin.${createHash('sha256').update(subscriberId).digest('hex')}`;
}

function desiredFingerprint(
  manifest: PluginManifest,
  entry: PluginOperationalEventSubscriptionEntry,
): string {
  return createHash('sha256')
    .update(
      stableJson({
        manifestVersion: manifest.version,
        serverModule: manifest.serverModule,
        entry,
      }),
    )
    .digest('hex');
}

function dispatchDelay(
  outcome: OperationalEventSubscriptionDispatchOutcome,
): number | undefined {
  switch (outcome.kind) {
    case 'delivered':
    case 'dead-lettered':
    case 'retrying':
      return 0;
    case 'busy':
    case 'waiting':
    case 'unavailable':
      return RETRY_POLL_MS;
    case 'gap':
      return GAP_POLL_MS;
    case 'empty':
      return EMPTY_POLL_MS;
    case 'revoked':
      return undefined;
  }
}

/**
 * Runtime composition for trusted plugin observers. The service owns only
 * manifest discovery, grant-derived authorization, module acquisition, and
 * bounded dispatch scheduling; EventStore retains all delivery truth.
 */
export function createPluginOperationalEventSubscriptionService(
  options: PluginOperationalEventSubscriptionServiceOptions,
): PluginOperationalEventSubscriptionService {
  const pluginsDir = join(options.projectHomeDir, 'plugins');
  const acquireModule =
    options.acquireModule ?? acquirePluginPublicServerModule;
  const readGrants = (plugin: string, artifact: PluginRuntimeArtifact) =>
    options.readGrants
      ? options.readGrants(options.projectHomeDir, plugin)
      : readPluginGrantState(options.projectHomeDir, plugin, artifact).granted;
  const desired = new Map<string, DesiredSubscription>();
  const active = new Map<string, ActiveSubscription>();
  let closing = false;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  let globalQuiescence = 0;
  const pluginQuiescence = new Map<string, number>();
  let reconcileTail: Promise<PluginOperationalEventSubscriptionReconcileOutcome> =
    Promise.resolve({ kind: 'applied', active: 0 });

  const observe = (
    operation: string,
    outcome: string,
    plugin?: string,
  ): void => {
    try {
      pluginEventSubscriptionOperations.add(1, {
        operation,
        outcome,
        ...(plugin ? { plugin } : {}),
      });
    } catch {
      // Metrics are observers, never execution authority.
    }
  };

  const log = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    try {
      options.logger[level](message, context);
    } catch {
      // Logging cannot decide subscription or settlement truth.
    }
  };

  const authorization = (
    declaration: OperationalEventSubscriptionDeclaration,
  ): OperationalEventSubscriptionAuthorization => {
    const current = desired.get(declaration.subscriber.id);
    if (!current || !sameDeclaration(current.declaration, declaration))
      return { kind: 'denied' };
    if (!current.artifact.isCurrent()) return { kind: 'denied' };
    const manifest = current.artifact.manifest;
    if (
      manifest.name !== current.pluginName ||
      typeof manifest.serverModule !== 'string'
    )
      return { kind: 'denied' };
    const currentEntry = manifest.operationalEventSubscriptions?.find(
      (entry) => entry.id === current.entry.id,
    );
    if (!currentEntry || !sameEntry(current.entry, currentEntry))
      return { kind: 'denied' };
    const grants = new Set(readGrants(current.pluginName, current.artifact));
    if (!grants.has('plugin.server') || !grants.has('events.subscribe'))
      return { kind: 'denied' };
    const projection = current.entry.projection ?? 'metadata';
    if (projection === 'envelope' && !grants.has('events.read-payload'))
      return { kind: 'denied' };
    return {
      kind: 'granted',
      consumerId: consumerId(declaration.subscriber.id),
      projection,
    };
  };

  const registry: OperationalEventSubscriptionRegistry =
    options.eventStore.createOperationalEventSubscriptionRegistry({
      authorize: authorization,
    });

  const discover = (): Map<string, DesiredSubscription> => {
    const found = new Map<string, DesiredSubscription>();
    if (!existsSync(pluginsDir)) return found;
    const names = new Set(
      readdirSync(pluginsDir, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && isCanonicalPluginId(entry.name),
        )
        .map((entry) => entry.name),
    );
    const selected = options.packageMcpJournal?.selectedInstallations();
    if (selected?.state === 'unavailable')
      throw new Error('Plugin installation inventory unavailable.');
    for (const installed of selected?.installations ?? [])
      names.add(installed.pluginId);
    for (const name of [...names].sort()) {
      try {
        const artifact = capturePluginRuntimeArtifact(
          pluginsDir,
          name,
          options.packageMcpJournal,
        );
        if (!artifact) continue;
        const manifest = artifact.manifest;
        for (const entry of manifest.operationalEventSubscriptions ?? []) {
          const subscriberId = `${manifest.name}.${entry.id}`;
          if (found.has(subscriberId))
            throw new Error(
              'Plugin event subscription identity is duplicated.',
            );
          found.set(subscriberId, {
            declaration: {
              subscriber: {
                id: subscriberId,
                version: entry.version,
                class: 'trusted-plugin',
              },
              purpose: 'plugin-observation',
              eventTypes: [...entry.eventTypes],
              requiredScopes: structuredClone(entry.requiredScopes ?? []),
            },
            entry: structuredClone(entry),
            fingerprint: `${artifact.generation ?? 'legacy'}:${artifact.digest}:${desiredFingerprint(manifest, entry)}`,
            artifact,
            pluginName: manifest.name,
          });
        }
      } catch (error) {
        log('warn', 'Skipped invalid plugin event subscription manifest', {
          error: error instanceof Error ? error.message : 'unknown',
          plugin: name,
        });
        observe('discover', 'invalid', name);
      }
    }
    return found;
  };

  const releaseActive = (key: string, item: ActiveSubscription): void => {
    if (active.get(key) !== item) return;
    if (item.timer) clearTimeout(item.timer);
    item.timer = undefined;
    item.acquired.release();
    active.delete(key);
    observe('close', 'closed', item.desired.pluginName);
  };

  const stopActive = async (
    key: string,
    item: ActiveSubscription,
  ): Promise<OperationalEventSubscriptionCloseOutcome> => {
    item.stopping = true;
    if (item.timer) clearTimeout(item.timer);
    item.timer = undefined;
    let outcome = item.subscription.close();
    if (outcome.kind === 'pending' && item.running) {
      await item.running.catch(() => undefined);
      outcome = item.subscription.close();
    }
    if (outcome.kind === 'closed') releaseActive(key, item);
    else observe('close', outcome.kind, item.desired.pluginName);
    return outcome;
  };

  const schedule = (
    key: string,
    item: ActiveSubscription,
    delayMs = 0,
  ): void => {
    if (closing || item.stopping || item.running || active.get(key) !== item)
      return;
    if (item.timer) clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.timer = undefined;
      if (closing || item.stopping || active.get(key) !== item) return;
      let nextDelay: number | undefined;
      const running = (async () => {
        let outcome: OperationalEventSubscriptionDispatchOutcome;
        try {
          outcome = await item.subscription.dispatchOne();
        } catch {
          outcome = { kind: 'unavailable' };
        }
        observe('dispatch', outcome.kind, item.desired.pluginName);
        if (outcome.kind === 'gap') {
          log(
            'warn',
            'Plugin operational event subscription has a replay gap',
            {
              plugin: item.desired.pluginName,
              subscription: item.desired.entry.id,
            },
          );
        }
        if (outcome.kind === 'revoked') {
          item.stopping = true;
          const closed = item.subscription.close();
          if (closed.kind === 'closed') releaseActive(key, item);
          return;
        }
        nextDelay = dispatchDelay(outcome);
      })();
      const tracked = running.finally(() => {
        if (item.running === tracked) item.running = undefined;
        if (nextDelay !== undefined) schedule(key, item, nextDelay);
      });
      item.running = tracked;
    }, delayMs);
    item.timer.unref?.();
  };

  const reconcileNow = async (
    forcePlugin?: string,
  ): Promise<PluginOperationalEventSubscriptionReconcileOutcome> => {
    if (closing) return { kind: 'unavailable' };
    let discovered: Map<string, DesiredSubscription>;
    try {
      discovered = discover();
    } catch (error) {
      log('error', 'Plugin operational event subscription discovery failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      observe('reconcile', 'unavailable');
      return { kind: 'unavailable' };
    }
    desired.clear();
    for (const [key, value] of discovered) desired.set(key, value);

    for (const [key, item] of [...active]) {
      const next = desired.get(key);
      if (
        next?.fingerprint === item.desired.fingerprint &&
        forcePlugin !== item.desired.pluginName
      )
        continue;
      await stopActive(key, item);
    }

    for (const [key, next] of desired) {
      if (active.has(key)) continue;
      if (
        globalQuiescence > 0 ||
        (pluginQuiescence.get(next.pluginName) ?? 0) > 0
      )
        continue;
      let authorized: OperationalEventSubscriptionAuthorization;
      try {
        authorized = authorization(next.declaration);
      } catch (error) {
        if (error instanceof PluginGrantsUnavailableError) {
          log('error', 'Plugin grants unavailable for event subscription', {
            plugin: next.pluginName,
          });
        }
        observe('open', 'unavailable', next.pluginName);
        continue;
      }
      if (authorized.kind !== 'granted') {
        observe('open', 'denied', next.pluginName);
        continue;
      }
      let acquired: AcquiredPluginPublicServerModule | null = null;
      try {
        const manifest = next.artifact.manifest;
        acquired = await acquireModule(
          pluginsDir,
          next.pluginName,
          manifest,
          options.logger as Logger,
          {
            journal: options.packageMcpJournal,
            artifact: next.artifact,
            authorize: () => authorization(next.declaration).kind === 'granted',
          },
        );
        if (
          !acquired?.loaded.operationalEvents ||
          typeof acquired.loaded.operationalEvents.observe !== 'function'
        ) {
          acquired?.release();
          log('warn', 'Plugin event subscription observer is unavailable', {
            plugin: next.pluginName,
            subscription: next.entry.id,
          });
          observe('open', 'observer-unavailable', next.pluginName);
          continue;
        }
        const observer = acquired.loaded.operationalEvents;
        const opened = registry.open({
          declaration: next.declaration,
          adapter: {
            observe: (input) => {
              if (
                !acquired?.isCurrent() ||
                !next.artifact.isCurrent() ||
                authorization(next.declaration).kind !== 'granted'
              )
                return Promise.resolve({
                  kind: 'rejected' as const,
                  failureCode: 'plugin-unavailable',
                });
              return observer.observe({
                subscriptionId: next.entry.id,
                projection: input.projection,
                idempotencyKey: input.idempotencyKey,
                attempt: input.attempt,
                signal: input.signal,
              });
            },
          },
        });
        if (opened.kind !== 'opened') {
          acquired.release();
          observe('open', opened.kind, next.pluginName);
          continue;
        }
        const item: ActiveSubscription = {
          acquired,
          desired: next,
          stopping: false,
          subscription: opened.subscription,
        };
        active.set(key, item);
        schedule(key, item);
        observe('open', 'opened', next.pluginName);
      } catch (error) {
        acquired?.release();
        log('error', 'Plugin event subscription could not be opened', {
          error: error instanceof Error ? error.message : 'unknown',
          plugin: next.pluginName,
          subscription: next.entry.id,
        });
        observe('open', 'unavailable', next.pluginName);
      }
    }
    observe('reconcile', 'applied');
    return { kind: 'applied', active: active.size };
  };

  const enqueueReconcile = (
    forcePlugin?: string,
  ): Promise<PluginOperationalEventSubscriptionReconcileOutcome> => {
    reconcileTail = reconcileTail
      .catch(() => ({ kind: 'unavailable' as const }))
      .then(() => reconcileNow(forcePlugin));
    return reconcileTail;
  };

  const wakeAll = (): void => {
    for (const [key, item] of active) schedule(key, item);
  };

  return Object.freeze<PluginOperationalEventSubscriptionService>({
    async start() {
      if (started) return enqueueReconcile();
      started = true;
      unsubscribe = options.eventBus.subscribe((event) => {
        if (event.event === SERVER_EVENTS.OPERATIONAL_EVENT) {
          wakeAll();
          return;
        }
        if (event.event === SERVER_EVENTS.PLUGINS_UPDATED) {
          const plugin =
            typeof event.data?.name === 'string' ? event.data.name : undefined;
          void enqueueReconcile(plugin).then(wakeAll);
          return;
        }
        if (
          event.event === SERVER_EVENTS.PLUGINS_INSTALLED ||
          event.event === SERVER_EVENTS.PLUGINS_REMOVED ||
          event.event === SERVER_EVENTS.PLUGINS_GRANTS_CHANGED
        ) {
          void enqueueReconcile().then(wakeAll);
        }
      });
      return enqueueReconcile();
    },
    reconcile: () => enqueueReconcile(),
    async quiesce(pluginName) {
      if (pluginName !== undefined && !isCanonicalPluginId(pluginName))
        throw new Error('Plugin event subscription quiescence id is invalid.');
      if (pluginName === undefined) globalQuiescence += 1;
      else
        pluginQuiescence.set(
          pluginName,
          (pluginQuiescence.get(pluginName) ?? 0) + 1,
        );
      try {
        await reconcileTail.catch(() => undefined);
        for (const [key, item] of [...active]) {
          if (
            pluginName !== undefined &&
            item.desired.pluginName !== pluginName
          )
            continue;
          const outcome = await stopActive(key, item);
          if (outcome.kind !== 'closed')
            throw new Error(
              `Plugin event subscription quiescence is ${outcome.kind}.`,
            );
        }
      } catch (error) {
        if (pluginName === undefined) globalQuiescence -= 1;
        else {
          const remaining = (pluginQuiescence.get(pluginName) ?? 1) - 1;
          if (remaining === 0) pluginQuiescence.delete(pluginName);
          else pluginQuiescence.set(pluginName, remaining);
        }
        throw error;
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          if (pluginName === undefined) globalQuiescence -= 1;
          else {
            const remaining = (pluginQuiescence.get(pluginName) ?? 1) - 1;
            if (remaining === 0) pluginQuiescence.delete(pluginName);
            else pluginQuiescence.set(pluginName, remaining);
          }
          if (!closing) void enqueueReconcile(pluginName);
        },
      };
    },
    async close() {
      if (closing && active.size === 0) return registry.close();
      closing = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await reconcileTail.catch(() => undefined);
      let result: OperationalEventSubscriptionCloseOutcome = {
        kind: 'closed',
      };
      for (const [key, item] of [...active]) {
        const outcome = await stopActive(key, item);
        if (outcome.kind === 'unavailable') result = outcome;
        else if (outcome.kind === 'pending' && result.kind === 'closed')
          result = outcome;
      }
      const registryOutcome = registry.close();
      if (registryOutcome.kind === 'unavailable') result = registryOutcome;
      else if (registryOutcome.kind === 'pending' && result.kind === 'closed')
        result = registryOutcome;
      return result;
    },
  });
}
