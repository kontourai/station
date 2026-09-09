import {
  type MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from '@kontourai/station-shared/mcp';
import { awaitSettlementWithin } from '../../utils/bounded-async.js';
import {
  type OptionalNetworkShutdownTask,
  shutdownOptionalNetworkWork,
} from './optional-network-shutdown.js';

const RETIRED_MCP_DISCONNECT_TIMEOUT_MS = 2_000;

export async function shutdownRuntimeServices({
  logger,
  timers,
  schedulerService,
  orchestrationService,
  attachedSessionFollowService,
  consoleBridgeService,
  voltAgent,
  mcpConfigs,
  mcpCustody,
  retiredMcpConfigs,
  activeAgents,
  acpBridge,
  connectionService,
  modelCatalog,
  feedbackService,
  notificationService,
  voiceService,
  mcpUiFrameServer,
  consentListener,
  terminalWsServer,
  terminalService,
  monitoringEmitter,
  sshEnvironmentService,
  configLoader,
  optionalNetworkShutdownTasks,
  optionalNetworkShutdownBudgetMs,
}: {
  logger: any;
  timers: NodeJS.Timeout[];
  schedulerService?: { stop(): Promise<void> };
  orchestrationService?: { shutdown(): Promise<void> };
  attachedSessionFollowService?: { stop(): void };
  consoleBridgeService?: { stop(): Promise<void> };
  voltAgent?: { shutdown(): Promise<void> };
  mcpConfigs: Map<string, { disconnect(): Promise<void> }>;
  mcpCustody?: MCPLocalConnectionCustody;
  retiredMcpConfigs?: Set<{ disconnect(): Promise<void> }>;
  activeAgents: Map<string, any>;
  acpBridge: { shutdown(): Promise<void> };
  connectionService?: { dispose(): void };
  modelCatalog?: { dispose(): void };
  feedbackService: { stop(): void };
  notificationService?: { shutdown(): Promise<void> };
  voiceService: { stop(): Promise<void> };
  mcpUiFrameServer?: { close(): Promise<void> };
  consentListener?: { close(): Promise<void> };
  terminalWsServer: { stop(): void | Promise<void> };
  terminalService: { dispose(): Promise<void> };
  monitoringEmitter?: { flush(): Promise<void> };
  sshEnvironmentService?: { shutdown(): Promise<void> };
  /**
   * Optional since station#1815. Omitting it is a HANDOVER, not a skip, and
   * the omission is logged below so it cannot become one by accident.
   *
   * `StationRuntime` disposes its own loader after the native-engine adoption
   * window has settled. The reason is narrower than an earlier version of
   * this comment claimed: it is NOT that `ConfigLoader.dispose` documents a
   * live-writer hazard — it documents the cost of its deferred watcher close
   * and an ordering rule for a caller that DELETES the watched tree — and the
   * adoption's registry half does not reach the loader at all
   * (`saveAgentRegistry` takes only `getProjectHomeDir()` and writes through
   * the module-level `saveRegistry`). What the loader IS is the write handle
   * for the other half: `materializeEngineAgent` and `materializeStationAgent`
   * go through it. Disposing the component a live caller is still writing
   * through is a lifecycle inversion whether or not this particular dispose
   * tolerates it, and putting it after the window costs nothing.
   */
  configLoader?: { dispose(): Promise<void> };
  optionalNetworkShutdownTasks?: readonly OptionalNetworkShutdownTask[];
  optionalNetworkShutdownBudgetMs?: number;
}): Promise<void> {
  logger.info('Shutting down Station Runtime...');
  // Fence admissions synchronously, before any unrelated shutdown awaits.
  const localMcpCleanup = mcpCustody?.shutdown();

  const failures: Error[] = [];
  const attempt = async (
    step: string,
    cleanup: (() => void | Promise<void>) | undefined,
  ): Promise<void> => {
    if (!cleanup) return;
    try {
      await cleanup();
    } catch (error) {
      const failure = new Error(`${step} failed`, { cause: error });
      failures.push(failure);
      logger.error('Shutdown step failed', { step, error });
    }
  };

  await shutdownOptionalNetworkWork(optionalNetworkShutdownTasks ?? [], {
    logger,
    budgetMs: optionalNetworkShutdownBudgetMs,
  });

  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;

  await attempt(
    'schedulerService.stop',
    schedulerService ? () => schedulerService.stop() : undefined,
  );
  await attempt(
    'attachedSessionFollowService.stop',
    attachedSessionFollowService
      ? () => attachedSessionFollowService.stop()
      : undefined,
  );
  // archive#1093 Part B fix round (HIGH): the coalescing worker backing
  // this service now owns a real (unref'd, but still real) batch timer —
  // `stop()` disposes it so nothing outlives shutdown.
  await attempt(
    'consoleBridgeService.stop',
    consoleBridgeService ? () => consoleBridgeService.stop() : undefined,
  );
  await attempt(
    'orchestrationService.shutdown',
    orchestrationService ? () => orchestrationService.shutdown() : undefined,
  );
  await attempt(
    'voltAgent.shutdown',
    voltAgent ? () => voltAgent.shutdown() : undefined,
  );

  if (localMcpCleanup) {
    await attempt('mcpCustody.shutdown', async () => {
      const cleanup = await localMcpCleanup;
      if (cleanup.state !== 'settled')
        throw new MCPLocalCustodyError(cleanup.state);
      mcpConfigs.clear();
      retiredMcpConfigs?.clear();
    });
  } else {
    for (const [key, mcpConfig] of mcpConfigs.entries()) {
      await attempt(`mcpConfigs.${key}.disconnect`, async () => {
        await mcpConfig.disconnect();
        if (mcpConfigs.get(key) === mcpConfig) mcpConfigs.delete(key);
        logger.info('MCP disconnected', { mcp: key });
      });
    }

    if (retiredMcpConfigs) {
      const entries = Array.from(retiredMcpConfigs);
      const retained = new Set<{ disconnect(): Promise<void> }>();
      await Promise.all(
        entries.map((config, index) =>
          attempt(`retiredMcpConfigs.${index}.disconnect`, async () => {
            const disconnect = Promise.resolve().then(() =>
              config.disconnect(),
            );
            disconnect.catch(() => undefined);
            const settled = await awaitSettlementWithin(
              disconnect,
              RETIRED_MCP_DISCONNECT_TIMEOUT_MS,
            );
            if (!settled) {
              retained.add(config);
              throw new Error('Retired MCP disconnect timed out.');
            }
            try {
              await disconnect;
            } catch (error) {
              retained.add(config);
              throw error;
            }
          }),
        ),
      );
      retiredMcpConfigs.clear();
      for (const config of retained) retiredMcpConfigs.add(config);
    }
  }
  activeAgents.clear();

  await attempt('connectionService.dispose', () =>
    connectionService?.dispose(),
  );
  await attempt('modelCatalog.dispose', () => modelCatalog?.dispose());
  await attempt('acpBridge.shutdown', () => acpBridge.shutdown());
  await attempt('feedbackService.stop', () => feedbackService.stop());
  await attempt(
    'notificationService.shutdown',
    notificationService ? () => notificationService.shutdown() : undefined,
  );
  await attempt('voiceService.stop', () => voiceService.stop());
  await attempt(
    'mcpUiFrameServer.close',
    mcpUiFrameServer ? () => mcpUiFrameServer.close() : undefined,
  );
  await attempt(
    'consentListener.close',
    consentListener ? () => consentListener.close() : undefined,
  );
  await attempt('terminalWsServer.stop', () => terminalWsServer.stop());
  await attempt('terminalService.dispose', () => terminalService.dispose());
  await attempt('sshEnvironmentService.shutdown', () =>
    sshEnvironmentService?.shutdown(),
  );
  await attempt('monitoringEmitter.flush', () => monitoringEmitter?.flush());
  if (configLoader) {
    await attempt('configLoader.dispose', () => configLoader.dispose());
  } else {
    // Named in the record rather than skipped in silence: without this a
    // caller that simply forgot the parameter would lose a teardown step with
    // no compile error and no trace of it ever having been expected.
    logger.info('Shutdown step delegated to the caller', {
      step: 'configLoader.dispose',
    });
  }

  if (failures.length > 0) {
    logger.error('Shutdown completed with errors', {
      failureCount: failures.length,
    });
    throw new AggregateError(
      failures,
      `Station Runtime shutdown failed in ${failures.length} cleanup step${failures.length === 1 ? '' : 's'}`,
    );
  }

  logger.info('Shutdown complete');
}
