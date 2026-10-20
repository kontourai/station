import { assertSupportedNodeVersion } from '@kontourai/station-shared/node-runtime';
import { sweepStationTempRoot } from '@kontourai/station-shared/temp-dir';
import 'dotenv/config';
import './telemetry.js';

/**
 * Station — local-first AI agent system
 * Main entry point
 */

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LifecycleShutdownReason } from '@kontourai/station-shared/lifecycle-events';
import { installNodeHttpCompatibility } from '@kontourai/station-shared/node-http-compat';
import { HANDOFF_DEFAULTS } from '@kontourai/station-supervisor/protocol';
import { ensureStationHomeSchemaSync } from './domain/home-schema-gate.js';
import { writeBootRecord } from './routes/system/boot-history.js';
import { captureBuildProvenance } from './routes/system/build-provenance.js';
import { reportSelfUpdateRestartAtBoot } from './routes/system/self-update-boot-report.js';
import { allocateFreePortBlock } from './runtime/bootstrap/allocate-port-block.js';
import {
  installCrashHandlers,
  logFatalAndFlush,
} from './runtime/bootstrap/crash-handlers.js';
import {
  installStdoutEpipeGuard,
  writeReadinessHandshake,
} from './runtime/bootstrap/readiness-handshake.js';
import {
  AUTO_ALLOCATE_PORT,
  resolveRuntimePort,
} from './runtime/bootstrap/runtime-port.js';
import { createRuntimeProcessLifecycle } from './runtime/bootstrap/runtime-process-lifecycle.js';
import type { SelfHostedBrokerStatus } from './runtime/bootstrap/self-hosted-broker-runtime.js';
import { loadSelfHostedBrokerConnectorConfig } from './runtime/bootstrap/self-hosted-connector-config.js';
import { StationRuntime } from './runtime/bootstrap/station-runtime.js';
import { armSupervisedParentWatchdog } from './runtime/bootstrap/supervised-parent-watchdog.js';
import {
  createSigtermHandler,
  runSupervisorDrain,
} from './runtime/bootstrap/supervisor-drain.js';
import {
  allowHomeAccess,
  installListenerLink,
  parkUnderSupervisor,
  type SupervisorLink,
} from './runtime/bootstrap/supervisor-link.js';
import { sweepOrphanedOwnedProcesses } from './services/infra/process-utils.js';
import {
  getInstalledServerLogSink,
  installServerLogSink,
} from './services/infra/server-log-store.js';
import { lifecycleService } from './telemetry/metrics.js';
import { createLogger, resolveLogLevel } from './utils/logger.js';
import { resolveHomeDir } from './utils/paths.js';

assertSupportedNodeVersion();
installNodeHttpCompatibility();

// Capture process identity before normal boot can mutate its environment or
// baked banner state. Crash records and diagnostics bundles share this value.
const buildProvenanceSnapshot = captureBuildProvenance();
process.env.STATION_PROCESS_STARTED_AT ??= String(Date.now());

/** Best-effort synchronous drain of the durable log sink — installed once
 * per process, so this reads whatever `installServerLogSink` most recently
 * installed rather than closing over a fixed reference. */
function flushLogSink(): void {
  try {
    getInstalledServerLogSink()?.flushSync();
  } catch {
    // best-effort; the crash path must never throw
  }
}

async function parkOrExit(): Promise<SupervisorLink | null> {
  try {
    return await parkUnderSupervisor();
  } catch (error) {
    console.error('Station could not start under its supervisor:', error);
    process.exit(1);
  }
}

async function main() {
  // Under the process supervisor this generation is loaded while the previous
  // one still serves and owns the home, so it parks before anything below:
  // the temp and orphan sweeps (which could kill the live generation's
  // engines), the schema gate, the log sink, and the lifecycle journal.
  const supervisorLink = await parkOrExit();
  if (supervisorLink) installListenerLink(supervisorLink);
  allowHomeAccess();
  // Set as boot reaches them; a drain before then exits without them.
  let runtimeForDrain: StationRuntime | undefined;
  let gracefulShutdown:
    | ((
        signal: LifecycleShutdownReason,
        forcedExitCode?: number,
      ) => Promise<void>)
    | undefined;
  supervisorLink?.onDrain((request) => {
    void runSupervisorDrain(request, {
      link: supervisorLink,
      runtime: () => runtimeForDrain,
      shutdown: () => gracefulShutdown,
      exit: (code) => process.exit(code),
    });
  });

  if (process.env.STATION_SERVICE_MANAGED === '1') {
    lifecycleService.add(1, { action: 'boot', platform: process.platform });
  }
  const processLifecycle = createRuntimeProcessLifecycle();
  processLifecycle.installExitObserver();
  // A killed or crashed process never runs its own temp cleanup, so reclaim
  // anything older than a day before doing anything else. Best-effort: a
  // failure here must never block boot.
  void sweepStationTempRoot().catch(() => {});
  // archive#1863: an engine child spawned with `detached: true` outlives a
  // SIGKILLed/crashed Station, and none of that Station's in-process cleanup
  // ever runs. Reap orphaned engine processes a PREVIOUS Station on this host
  // recorded but never cleaned up. The sweep is provably scoped — it only
  // reaps children whose recorded owner pid is demonstrably gone — so it
  // cannot touch a live sibling Station's engines. Best-effort, like the temp
  // sweep: a failure here must never block boot.
  void sweepOrphanedOwnedProcesses({
    log: (message, data) => console.log(`[station] ${message}`, data ?? ''),
  }).catch(() => {});
  let port = resolveRuntimePort(
    process.env.PORT,
    process.env.STATION_PORT_MODE,
  );
  // A later generation serves on the sockets its supervisor holds, so their
  // base port wins over PORT (and over allocating a fresh block for PORT=0).
  const adoptedApiPort = supervisorLink?.adoptedPort('api') ?? null;
  if (adoptedApiPort !== null) {
    if (port !== AUTO_ALLOCATE_PORT && port !== adoptedApiPort) {
      console.warn(
        `[station] PORT ${port} differs from the supervisor-held API port ${adoptedApiPort}; serving on ${adoptedApiPort}`,
      );
    }
    port = adoptedApiPort;
  }
  const projectHomeDir = resolveHomeDir();

  // The schema gate must own the first write to a Station home. In
  // particular, installing the durable log sink first creates logs/server in
  // an otherwise fresh home and makes that home look like incompatible
  // marker-less application data.
  ensureStationHomeSchemaSync(projectHomeDir);

  // Root logger + durable NDJSON sink, wired as early as possible — before
  // the runtime (and every module-scope logger it transitively imports)
  // does any real work, so boot itself is captured in the store.
  const serverLogSink = installServerLogSink({
    directory: join(projectHomeDir, 'logs', 'server'),
  });
  writeBootRecord(
    serverLogSink.writeLine.bind(serverLogSink),
    buildProvenanceSnapshot,
  );
  const logger = createLogger({
    name: 'station',
    level: resolveLogLevel(),
  });

  const configuredHost = process.env.STATION_HOST || undefined;
  const host = configuredHost || '0.0.0.0';
  const displayHost = host.includes(':') ? `[${host}]` : host;

  // PORT=0 / STATION_PORT_MODE=auto: reserve a contiguous free block for the
  // HTTP, terminal (port+1), voice (port+2), and consent (port+3) listeners
  // before the runtime binds them, then report the resolved base back to a
  // supervising parent.
  if (port === AUTO_ALLOCATE_PORT) {
    port = await allocateFreePortBlock(host);
  }

  const connector = loadSelfHostedBrokerConnectorConfig({
    homeDir: projectHomeDir,
    observeStatus: (status: SelfHostedBrokerStatus) => {
      const message = 'Self-hosted relay lifecycle status';
      const detail = { ...status };
      if (status.state === 'failed') logger.warn(message, detail);
      else logger.info(message, detail);
    },
  });

  const runtime = new StationRuntime({
    projectHomeDir,
    port,
    host: configuredHost,
    logger,
    buildProvenanceSnapshot,
    ...(connector
      ? {
          relayInvitationOwner: connector.invitationOwner,
          virtualApplication: connector.virtualApplication,
          selfHostedBrokerConnector: connector.selfHostedBrokerConnector,
        }
      : {}),
  });
  runtimeForDrain = runtime;

  let stdoutBrokenPipe = false;
  // Install before runtime initialization: boot logs are still stdout writes,
  // and Desktop can disappear while initialization is in flight.
  installStdoutEpipeGuard(process.stdout, () => {
    stdoutBrokenPipe = true;
    // No logging in this callback: EPIPE means stdout is gone, and a log
    // write here would recurse through the same error handler.
    void gracefulShutdown?.('stdout_epipe', 1);
  });
  try {
    await runtime.initialize();
    let shuttingDown = false;

    // The read side of archive#1903: a self-update that never confirmed the
    // new server was healthy used to leave no trace at all past a log line
    // from a process that had already exited. A no-op for anything other
    // than a source-checkout install with a failed or stale-pending record.
    reportSelfUpdateRestartAtBoot(dirname(fileURLToPath(import.meta.url)));

    console.log('\\n═══════════════════════════════════════════════════');
    console.log('  STATION STARTED');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  ✓ HTTP Server:  http://${displayHost}:${port}`);
    console.log(`  ✓ Swagger UI:   http://${displayHost}:${port}/ui`);
    console.log('');
    const loadedAgents = runtime.listAgents();
    console.log('  Loaded agents:', loadedAgents.join(', '));
    console.log('═══════════════════════════════════════════════════\\n');
    logger.info('Station started', { port, host, agents: loadedAgents });

    gracefulShutdown = async (
      signal: LifecycleShutdownReason,
      forcedExitCode?: number,
    ) => {
      if (shuttingDown) return;
      shuttingDown = true;
      processLifecycle.observeShutdown(signal);
      console.log(`\n\nShutting down gracefully (${signal})...`);
      logger.info('Station shutting down', { signal });
      let exitCode = forcedExitCode ?? (signal === 'uncaughtException' ? 1 : 0);
      try {
        await runtime.shutdown();
        logger.info('Station shutdown complete', { signal, exitCode });
      } catch (error) {
        exitCode = 1;
        console.error('Shutdown completed with cleanup errors:', error);
        logger.error('Shutdown completed with cleanup errors', {
          signal,
          err: error,
        });
      }
      processLifecycle.observeExit(exitCode);
      if (supervisorLink?.draining) await supervisorLink.reportDrained();
      process.exit(exitCode);
    };

    process.on('SIGINT', () => void gracefulShutdown?.('SIGINT'));
    process.on(
      'SIGTERM',
      createSigtermHandler({
        link: supervisorLink,
        shutdown: () => gracefulShutdown,
        killGraceMs: HANDOFF_DEFAULTS.killGraceMs,
      }),
    );
    // The supervisor's IPC channel closing means it is gone (protocol).
    supervisorLink?.setShutdownHandler(() =>
      gracefulShutdown?.('supervisor_disconnect', 1),
    );
    armSupervisedParentWatchdog({
      logger,
      onSupervisorGone: () => gracefulShutdown?.('SIGTERM', 1),
    });
    installCrashHandlers(logger, {
      flushSync: flushLogSink,
      buildProvenanceSnapshot,
      onUncaughtException: () => {
        void gracefulShutdown?.('uncaughtException');
      },
    });

    // A supervisor may stop us immediately after readiness. Install all
    // shutdown handlers before publishing that ownership handoff.
    // Emit a single structured readiness line for a supervising parent process
    // (the desktop spawner) once every listener is bound. No-op unless the
    // supervisor opted in with STATION_STDOUT_HANDSHAKE=1.
    if (
      !writeReadinessHandshake(
        process.stdout,
        port,
        host,
        process.env.STATION_STDOUT_HANDSHAKE === '1',
      )
    ) {
      stdoutBrokenPipe = true;
    }
    // Cover both an earlier async EPIPE and a synchronous handshake refusal.
    if (stdoutBrokenPipe) void gracefulShutdown('stdout_epipe', 1);
    // The supervisor's readiness, sent once every listener has settled. The
    // boot id is per generation: STATION_BOOT_ID is inherited unchanged by
    // every generation a supervisor forks.
    await supervisorLink?.ready(randomUUID(), port);
  } catch (error) {
    processLifecycle.observeShutdown('startup_failure');
    processLifecycle.observeExit(1);
    console.error('Failed to start Station:', error);
    logFatalAndFlush(
      logger,
      'Failed to start Station',
      { err: error },
      flushLogSink,
      buildProvenanceSnapshot,
    );
    process.exit(1);
  }
}

main();
