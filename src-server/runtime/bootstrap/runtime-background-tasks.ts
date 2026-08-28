import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { listProviders } from '../../providers/registries/registry.js';
import {
  engineSpawnTmpDirPath,
  reapEngineSpawnTmpDir,
} from '../../services/infra/engine-spawn-tmpdir.js';

/** archive#2204: bound engine-spawn artifacts even when ACP bootstrap fails. */
const ENGINE_SPAWN_TMP_REAP_INTERVAL_MS = 5 * 60_000;
const ENGINE_SPAWN_TMP_MAX_AGE_MS = 30 * 60_000;

interface RuntimeTaskTimerContext {
  timers: NodeJS.Timeout[];
}

interface RuntimeLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

interface RuntimeEventBus {
  emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
}

interface ACPBridgeLike {
  startAll: (
    connections: any[],
    initiator?: 'request' | 'background',
  ) => Promise<void>;
  isConnected: () => boolean;
}

export function mergeRuntimeACPConnections(
  acpConnections: any[],
  providerEntries: Array<{ provider: { getConnections?: () => any[] } }>,
): any[] {
  const providerConnections = providerEntries.flatMap(
    (entry) => entry.provider.getConnections?.() || [],
  );
  const configIds = new Set(
    acpConnections.map((connection: any) => connection.id),
  );

  return [
    ...acpConnections,
    ...providerConnections.filter(
      (connection: any) => !configIds.has(connection.id),
    ),
  ];
}

export function scheduleRuntimeDailyReload(
  context: RuntimeTaskTimerContext & {
    reloadAgents: () => Promise<void>;
    setTimeoutImpl?: typeof setTimeout;
    getNow?: () => Date;
  },
): void {
  const setTimeoutImpl = context.setTimeoutImpl || setTimeout;
  const getNow = context.getNow || (() => new Date());

  const msUntilMidnight = () => {
    const now = getNow();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  };

  const scheduleNextReload = () => {
    context.timers.push(
      setTimeoutImpl(() => {
        context.reloadAgents().catch(() => {});
        scheduleNextReload();
      }, msUntilMidnight()),
    );
  };

  scheduleNextReload();
}

/**
 * Reap Station-owned engine spawn artifacts independently of every engine
 * connection's startup path. Both the initial sweep and recurring work are
 * detached best-effort: an unreadable tmp dir must never affect boot.
 */
export function scheduleRuntimeEngineSpawnTmpReaping(
  context: RuntimeTaskTimerContext & {
    logger: RuntimeLogger;
    reap?: () => void;
    setIntervalImpl?: typeof setInterval;
  },
): void {
  const setIntervalImpl = context.setIntervalImpl || setInterval;
  const reap =
    context.reap ||
    (() =>
      reapEngineSpawnTmpDir(
        engineSpawnTmpDirPath(),
        ENGINE_SPAWN_TMP_MAX_AGE_MS,
      ));
  const runReap = () => {
    void Promise.resolve()
      .then(reap)
      .catch((error: any) =>
        context.logger.warn('[Runtime] Engine spawn tmp reap failed', {
          error: error.message,
        }),
      );
  };

  runReap();
  context.timers.push(
    setIntervalImpl(runReap, ENGINE_SPAWN_TMP_REAP_INTERVAL_MS),
  );
}

export function startRuntimeACPConnections(context: {
  loadACPConfig: () => Promise<{ connections: any[] }>;
  loadRegisteredRuntimeConnectionIds?: () => Promise<ReadonlySet<string>>;
  acpBridge: ACPBridgeLike;
  logger: RuntimeLogger;
  listProvidersFn?: typeof listProviders;
}): void {
  const listProvidersFn = context.listProvidersFn || listProviders;

  context
    .loadACPConfig()
    .then(async (acpConfig) => {
      const merged = mergeRuntimeACPConnections(
        acpConfig.connections,
        listProvidersFn('acpConnections'),
      );
      const registeredIds =
        await context.loadRegisteredRuntimeConnectionIds?.();
      // archive#3404: `'background'`. This whole chain is fire-and-forget —
      // no HTTP request awaits it and it takes no configuration-mutation
      // lock — and it is where Station first meets an engine that has not
      // been started since boot, whose `initialize` was measured at 40s.
      // That is the one place the cold first-contact budget belongs.
      return context.acpBridge.startAll(
        registeredIds
          ? merged.filter((connection) => registeredIds.has(connection.id))
          : merged,
        'background',
      );
    })
    .then(() => {
      if (context.acpBridge.isConnected()) {
        context.logger.info('[Runtime] ACP connections established');
      }
    })
    .catch((error: any) => {
      context.logger.warn('[Runtime] ACP startup failed', {
        error: error.message,
      });
    });
}

export function scheduleRuntimePluginUpdateCheck(
  context: RuntimeTaskTimerContext & {
    port: number;
    eventBus: RuntimeEventBus;
    logger: RuntimeLogger;
    fetchImpl?: typeof fetch;
    setTimeoutImpl?: typeof setTimeout;
  },
): void {
  const fetchImpl = context.fetchImpl || fetch;
  const setTimeoutImpl = context.setTimeoutImpl || setTimeout;

  context.timers.push(
    setTimeoutImpl(async () => {
      try {
        const response = await fetchImpl(
          `http://localhost:${context.port}/api/plugins/check-updates`,
        );
        if (!response.ok) return;

        const { updates } = (await response.json()) as { updates: any[] };
        if (updates.length > 0) {
          context.eventBus.emit(SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE, {
            count: updates.length,
            updates,
          });
          context.logger.info('Plugin updates available', {
            count: updates.length,
          });
        }
      } catch (error: any) {
        context.logger.debug('Failed to check for plugin updates', {
          error: error.message,
        });
      }
    }, 5000),
  );
}
