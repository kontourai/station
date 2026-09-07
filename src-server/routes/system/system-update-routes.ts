import { execFile as execFileCb, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_UI_PORT,
} from '@kontourai/station-shared/ports';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { type Context, Hono } from 'hono';
import { systemOps } from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { resolveHomeDir } from '../../utils/paths.js';
import { errorMessage } from '../schemas/schemas.js';
import {
  fetchChannelLatestSha,
  resolveInstallProvenance,
  resolveSelfUpdateEligibility,
  type SelfUpdateEligibility,
} from './install-provenance.js';
import {
  emitRestartDiagnostic,
  readSelfUpdateRestartRecord,
  restartStateFilePath,
  writeSelfUpdateRestartRecord,
} from './self-update-restart-state.js';
import {
  SELF_UPDATE_WATCHDOG_DEADLINE_MS,
  SELF_UPDATE_WATCHDOG_LAUNCH_GRACE_MS,
} from './self-update-watchdog.js';
import type { SystemStatusDeps } from './system-route-types.js';

const execFileAsync = promisify(execFileCb);
const DEFAULT_INSTANCE_ID = 'default';

function restartVerificationDeadlineAt(startedAt: string): string | null {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  return new Date(
    startedAtMs +
      SELF_UPDATE_WATCHDOG_DEADLINE_MS +
      SELF_UPDATE_WATCHDOG_LAUNCH_GRACE_MS,
  ).toISOString();
}

interface InstanceStateRecord {
  baseDir: string;
  instanceId: string;
  serverPid: number | null;
  serverPort: number;
  startedAt: string;
  statePath: string;
  uiPid: number | null;
  uiPort: number;
}

function isRecord(
  value: unknown,
): value is Record<string, string | number | boolean | null | unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePidList(raw: string): Array<number | null> {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    });
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isInstanceRunning(record: InstanceStateRecord): boolean {
  return isProcessAlive(record.serverPid) || isProcessAlive(record.uiPid);
}

function readInstanceStateFile(path: string): InstanceStateRecord | null {
  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf-8'),
    ) as Partial<InstanceStateRecord>;
    if (typeof parsed.instanceId !== 'string' || !parsed.instanceId) {
      return null;
    }

    return {
      instanceId: parsed.instanceId,
      serverPid: parsed.serverPid ?? null,
      uiPid: parsed.uiPid ?? null,
      serverPort: parsed.serverPort ?? DEFAULT_SERVER_PORT,
      uiPort: parsed.uiPort ?? DEFAULT_UI_PORT,
      baseDir:
        typeof parsed.baseDir === 'string' && parsed.baseDir
          ? parsed.baseDir
          : '',
      startedAt:
        typeof parsed.startedAt === 'string' && parsed.startedAt
          ? parsed.startedAt
          : new Date(0).toISOString(),
      statePath: path,
    };
  } catch {
    return null;
  }
}

function readPriorPidInstanceState(
  gitRoot: string,
): InstanceStateRecord | null {
  const pidFile = join(gitRoot, '.station.pids');
  if (!existsSync(pidFile)) return null;

  const [serverPid, uiPid] = parsePidList(readFileSync(pidFile, 'utf-8'));
  const record: InstanceStateRecord = {
    instanceId: DEFAULT_INSTANCE_ID,
    serverPid,
    uiPid,
    serverPort: DEFAULT_SERVER_PORT,
    uiPort: DEFAULT_UI_PORT,
    baseDir: '',
    startedAt: new Date(0).toISOString(),
    statePath: pidFile,
  };

  if (!isInstanceRunning(record)) {
    rmSync(pidFile, { force: true });
    return null;
  }

  return record;
}

function listRunningInstances(gitRoot: string): InstanceStateRecord[] {
  const records: InstanceStateRecord[] = [];
  const instanceStateDir = join(gitRoot, '.station', 'instances');

  if (existsSync(instanceStateDir)) {
    for (const entry of readdirSync(instanceStateDir)) {
      if (!entry.endsWith('.json')) continue;
      const statePath = join(instanceStateDir, entry);
      const record = readInstanceStateFile(statePath);
      if (!record || !isInstanceRunning(record)) {
        rmSync(statePath, { force: true });
        continue;
      }
      records.push(record);
    }
  }

  const hasDefaultRecord = records.some(
    (record) => record.instanceId === DEFAULT_INSTANCE_ID,
  );
  const priorPidRecord = readPriorPidInstanceState(gitRoot);
  if (priorPidRecord && !hasDefaultRecord) {
    records.push(priorPidRecord);
  } else if (priorPidRecord && hasDefaultRecord) {
    rmSync(priorPidRecord.statePath, { force: true });
  }

  return records.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

function describeInstance(record: InstanceStateRecord): string {
  const home = record.baseDir || '(unknown home)';
  return `${record.instanceId} — server ${record.serverPort}, ui ${record.uiPort}, home ${home}`;
}

function getSelfUpdateConflictError(
  gitRoot: string,
  currentInstanceId: string,
): string | null {
  const siblings = listRunningInstances(gitRoot).filter(
    (record) => record.instanceId !== currentInstanceId,
  );
  if (siblings.length === 0) return null;

  return [
    'Core update is blocked because this checkout shares build artifacts with other live Station instances.',
    'Stop the sibling instance(s) first or rerun the update from a different checkout.',
    ...siblings.map((record) => `  - ${describeInstance(record)}`),
  ].join('\n');
}

function updateInstanceRecord(
  record: Record<string, string | number | boolean | null | unknown>,
  serverPid: number,
) {
  const nextRecord = { ...record };

  nextRecord.serverPid = serverPid;
  if ('pid' in nextRecord) {
    nextRecord.pid = serverPid;
  }
  if (Array.isArray(nextRecord.pids)) {
    const nextPids = [...nextRecord.pids];
    nextPids[0] = serverPid;
    nextRecord.pids = nextPids;
  }
  if (isRecord(nextRecord.server)) {
    nextRecord.server = {
      ...nextRecord.server,
      pid: serverPid,
    };
  }
  nextRecord.updatedAt = new Date().toISOString();

  return nextRecord;
}

function updateInstanceStatePayload(
  payload: unknown,
  instanceId: string | undefined,
  serverPid: number,
): unknown {
  if (Array.isArray(payload)) {
    if (!instanceId) return payload;
    return payload.map((entry) => {
      if (
        isRecord(entry) &&
        typeof entry.instanceId === 'string' &&
        entry.instanceId === instanceId
      ) {
        return updateInstanceRecord(entry, serverPid);
      }
      return entry;
    });
  }

  if (!isRecord(payload)) {
    return payload;
  }

  if (instanceId && Array.isArray(payload.instances)) {
    return {
      ...payload,
      instances: payload.instances.map((entry) => {
        if (
          isRecord(entry) &&
          typeof entry.instanceId === 'string' &&
          entry.instanceId === instanceId
        ) {
          return updateInstanceRecord(entry, serverPid);
        }
        return entry;
      }),
    };
  }

  if (
    instanceId &&
    isRecord(payload.instances) &&
    isRecord(payload.instances[instanceId])
  ) {
    return {
      ...payload,
      instances: {
        ...payload.instances,
        [instanceId]: updateInstanceRecord(
          payload.instances[instanceId] as Record<
            string,
            string | number | boolean | null | unknown
          >,
          serverPid,
        ),
      },
    };
  }

  if (
    instanceId &&
    typeof payload.instanceId === 'string' &&
    payload.instanceId !== instanceId
  ) {
    return payload;
  }

  return updateInstanceRecord(payload, serverPid);
}

function updateRestartState(logger: any, gitRoot: string, serverPid: number) {
  const instanceStatePath = process.env.STATION_INSTANCE_STATE_PATH;
  const instanceId = process.env.STATION_INSTANCE_ID;

  if (instanceStatePath && existsSync(instanceStatePath)) {
    try {
      const rawState = readFileSync(instanceStatePath, 'utf-8').trim();
      if (rawState) {
        const nextState = updateInstanceStatePayload(
          JSON.parse(rawState) as unknown,
          instanceId,
          serverPid,
        );
        writeFileSync(
          instanceStatePath,
          `${JSON.stringify(nextState, null, 2)}\n`,
        );
        return;
      }
    } catch (error) {
      logger.warn(
        'Core restart: failed to rewrite instance state; using the prior pidfile path',
        {
          error: errorMessage(error),
          instanceId,
          instanceStatePath,
        },
      );
    }
  }

  const pidFile = join(gitRoot, '.station.pids');
  if (existsSync(pidFile)) {
    const pids = readFileSync(pidFile, 'utf-8').trim().split(' ');
    const uiPid = pids[1] || '';
    writeFileSync(pidFile, `${serverPid} ${uiPid}`);
  }
}

export interface GitPullRestartInput {
  gitRoot: string;
  port: string;
  newHash: string;
  /**
   * Full 40-char sha — must reach the child's STATION_BUILD_SHA env so the
   * watchdog can verify BUILD IDENTITY, not just liveness (archive#1903
   * review finding 1): a 200 from a stale respawned old build, or from any
   * other process that happens to answer on this port, must not read as a
   * healthy new server.
   */
  newHashFull: string;
  instanceId: string;
  restartStatePath: string;
  startedAt: string;
  moduleDir: string;
  logger: any;
  spawnFn: typeof spawn;
  exitFn: (code: number) => void;
}

/**
 * Spawns the new server, then spawns a DETACHED watchdog (archive#1903) that
 * does not need the port and can therefore keep running after this process
 * exits — the exit itself is what frees the port for the new server to
 * bind, so this process cannot stay alive to verify anything on its own.
 * The watchdog polls the new server's own health endpoint and is the only
 * thing that ever marks a restart `verified`; if it never sees a 200 within
 * budget it kills the new server (tonight's actual failure mode was a
 * process that bound the port, held the socket, and answered nothing) and
 * records `failed` durably at `restartStatePath` — see
 * self-update-boot-report.ts for the read side.
 *
 * Extracted from the route handler and injected with `spawnFn`/`exitFn` so
 * it is directly unit-testable without a real 500ms timer or a real
 * `process.exit` call (archive#1903 tests).
 */
export function performGitPullRestart(input: GitPullRestartInput): void {
  const serverEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: input.port,
    // The child inherits the PARENT's env otherwise — including whatever
    // STATION_BUILD_SHA/STATION_INSTANCE_ID the OLD build was started with.
    // Left alone, `/api/system/status` on the NEW process would keep
    // reporting the OLD identity, and the watchdog's identity check below
    // would never verify a genuinely successful restart.
    STATION_BUILD_SHA: input.newHashFull,
    STATION_INSTANCE_ID: input.instanceId,
  };
  // The replacement intentionally runs unwatched: the old supervisor PID is
  // not its parent, and correctness during an in-place update wins over this
  // watchdog backstop.
  delete serverEnv.STATION_SUPERVISOR_PID;
  const child = input.spawnFn('node', ['dist-server/command-station.js'], {
    cwd: input.gitRoot,
    stdio: 'ignore',
    detached: true,
    env: serverEnv,
    windowsHide: true,
  });
  child.unref();

  if (
    typeof child.pid === 'number' &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    updateRestartState(input.logger, input.gitRoot, child.pid);

    const watchdogEntry = join(input.moduleDir, 'self-update-watchdog.js');
    const watchdogInput = JSON.stringify({
      pid: child.pid,
      port: Number(input.port),
      hash: input.newHash,
      instanceId: input.instanceId,
      startedAt: input.startedAt,
      gitRoot: input.gitRoot,
    });
    try {
      const watchdog = input.spawnFn(
        process.execPath,
        [watchdogEntry, watchdogInput],
        {
          cwd: input.gitRoot,
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        },
      );
      watchdog.unref();
      input.logger.info('Core restart: health-verification watchdog spawned', {
        watchdogPid: watchdog.pid,
        targetPid: child.pid,
        hash: input.newHash,
      });
    } catch (error) {
      // The restart-state record stays `pending` forever in this case —
      // classifyRestartRecordAtBoot ages it into `stale-pending` rather than
      // silently reading as fine.
      input.logger.error(
        'Core restart: failed to spawn health-verification watchdog; restart outcome will remain unverified',
        { error: errorMessage(error) },
      );
    }
  } else {
    input.logger.error(
      'Core restart: spawn returned no pid; cannot verify or record restart health',
    );
  }

  input.logger.info('Core restart: new server spawned', {
    pid: child.pid,
    hash: input.newHash,
  });
  input.exitFn(0);
}

export function createSystemUpdateRoutes(
  deps: SystemStatusDeps,
  logger: any,
  restartStateWriter: typeof writeSelfUpdateRestartRecord = writeSelfUpdateRestartRecord,
) {
  const app = new Hono();

  const verifyManagedRuntime = async (c: any) => {
    try {
      systemOps.add(1, { op: 'verify_bedrock' });
      const { BedrockClient, ListFoundationModelsCommand } = await import(
        '@aws-sdk/client-bedrock'
      );
      const body = (await c.req.json().catch(() => ({}))) as {
        region?: string;
      };
      const region = body.region || deps.getAppConfig().region || 'us-east-1';
      const client = new BedrockClient({ region });
      await client.send(new ListFoundationModelsCommand({}));
      return c.json({ verified: true, region });
    } catch (error: unknown) {
      logger.warn('Bedrock verification failed', {
        error: errorMessage(error),
      });
      return c.json({ verified: false, error: errorMessage(error) });
    }
  };

  app.post('/verify-managed-runtime', verifyManagedRuntime);
  app.post('/verify-bedrock', async (c) => {
    return verifyManagedRuntime(c);
  });

  // A stamped desktop bundle has no repository to pull, so the check compares
  // the stamp's sha against the head of its channel ref. The remote being
  // unreachable is a disclosed warning (`remoteUnreachable` + `message`),
  // never an `error` — the SDK throws on `error`, which is exactly how "Not a
  // git repository" used to eat the whole surface (archive#1624).
  const desktopBundleUpdateStatus = async (
    provenance: Extract<
      ReturnType<typeof resolveInstallProvenance>,
      { installKind: 'desktop-bundle' }
    >,
  ) => {
    // Git-based self-update (archive#1624): when this bundle's recorded
    // source checkout is present and proves the same repository identity,
    // "apply" means running that checkout's own installer instead of asking
    // the user to reinstall by hand.
    const eligibility = await resolveSelfUpdateEligibility(provenance);
    const base = {
      installKind: 'desktop-bundle' as const,
      applyMethod: eligibility.eligible
        ? ('self-update' as const)
        : ('reinstall' as const),
      channel: provenance.channel,
      branch: provenance.ref.startsWith('origin/')
        ? provenance.ref.slice('origin/'.length)
        : provenance.ref,
      currentHash: provenance.sha.substring(0, 7),
    };
    try {
      const latestSha = await fetchChannelLatestSha(
        provenance.repository,
        provenance.ref,
      );
      return {
        ...base,
        remoteHash: latestSha.substring(0, 7),
        updateAvailable: latestSha !== provenance.sha,
      };
    } catch (error) {
      logger.warn('Core update check: channel remote unreachable', {
        error: errorMessage(error),
        repository: provenance.repository,
      });
      return {
        ...base,
        updateAvailable: false,
        remoteUnreachable: true,
        message: `Could not reach ${provenance.repository} to check the ${provenance.channel} channel.`,
      };
    }
  };

  // Runs the verified checkout's own installer, detached: the installer (not
  // this process) owns the build gates, the atomic app swap, and --relaunch;
  // its lock dir is the natural in-progress signal. Output goes to a log under
  // the Station home so a failed background update is diagnosable.
  const applyDesktopSelfUpdate = (
    c: Context,
    eligibility: Extract<SelfUpdateEligibility, { eligible: true }>,
  ) => {
    // Canonical derivation, not a second hand-rolled copy: the spawner leaves
    // STATION_ROOT unset for a self-rooted home (`--home`, `--base`,
    // `--temp-home`), where re-deriving the `~/.station` default would point
    // this lock -- and the installer this hands it to -- at the shared root
    // that home deliberately does not use.
    const stationRoot = resolveStationRoot();
    const lockDir = join(stationRoot, 'cache', 'nightly', 'install.lock');
    if (existsSync(lockDir)) {
      return c.json(
        { success: false, error: 'An update is already in progress.' },
        409,
      );
    }
    systemOps.add(1, { op: 'apply_self_update' });
    const logDir = join(resolveHomeDir(), 'updates');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(
      logDir,
      `self-update-${new Date().toISOString().replaceAll(':', '-')}.log`,
    );
    const logFd = openSync(logPath, 'a', 0o600);
    try {
      const child = spawn(
        '/bin/zsh',
        [eligibility.installerPath, '--relaunch'],
        {
          cwd: eligibility.checkoutPath,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
          env: { ...process.env, STATION_ROOT: stationRoot },
        },
      );
      child.unref();
      logger.info('Self-update started', {
        checkout: eligibility.checkoutPath,
        logPath,
        pid: child.pid,
      });
    } finally {
      closeSync(logFd);
    }
    return c.json(
      {
        success: true,
        updating: true,
        logPath,
        message:
          'Update started — Station rebuilds from source and restarts when complete.',
      },
      202,
    );
  };

  app.get('/core-update', async (c) => {
    const provenance = resolveInstallProvenance(
      dirname(fileURLToPath(import.meta.url)),
    );

    if (provenance.installKind === 'desktop-bundle') {
      return c.json(await desktopBundleUpdateStatus(provenance));
    }

    if (provenance.installKind === 'unknown') {
      return c.json({
        installKind: 'unknown',
        updateAvailable: false,
        message: `This install carries no update provenance (${provenance.detail}), so updates cannot be checked from here.`,
      });
    }

    try {
      const { gitRoot, branch, sha: currentHash } = provenance;

      let hasUpstream = false;
      try {
        await execGit(['rev-parse', '--abbrev-ref', `${branch}@{u}`], {
          cwd: gitRoot,
          encoding: 'utf-8',
        });
        hasUpstream = true;
      } catch (e) {
        console.debug('Failed to check upstream branch:', e);
        try {
          await execGit(['remote', 'get-url', 'origin'], {
            cwd: gitRoot,
            encoding: 'utf-8',
          });
          await execGit(['fetch', 'origin', branch, '--quiet'], {
            cwd: gitRoot,
            timeout: 15000,
          });
          await execGit(
            ['branch', `--set-upstream-to=origin/${branch}`, branch],
            {
              cwd: gitRoot,
              encoding: 'utf-8',
            },
          );
          hasUpstream = true;
        } catch (autoConfigureError) {
          console.debug(
            'Failed to auto-configure upstream:',
            autoConfigureError,
          );
        }
      }

      if (!hasUpstream) {
        return c.json({
          installKind: 'source-checkout',
          applyMethod: 'git-pull',
          currentHash,
          branch,
          behind: 0,
          ahead: 0,
          updateAvailable: false,
          noUpstream: true,
        });
      }

      await execGit(['fetch', '--quiet'], {
        cwd: gitRoot,
        timeout: 15000,
      });

      const remoteHash = (
        await execGit(['rev-parse', '@{u}'], {
          cwd: gitRoot,
          encoding: 'utf-8',
        })
      ).stdout
        .trim()
        .substring(0, 7);

      const behind = parseInt(
        (
          await execGit(['rev-list', 'HEAD..@{u}', '--count'], {
            cwd: gitRoot,
            encoding: 'utf-8',
          })
        ).stdout.trim(),
        10,
      );
      const ahead = parseInt(
        (
          await execGit(['rev-list', '@{u}..HEAD', '--count'], {
            cwd: gitRoot,
            encoding: 'utf-8',
          })
        ).stdout.trim(),
        10,
      );

      return c.json({
        installKind: 'source-checkout',
        applyMethod: 'git-pull',
        currentHash,
        remoteHash,
        branch,
        behind,
        ahead,
        updateAvailable: behind > 0,
      });
    } catch (error: unknown) {
      return c.json({ updateAvailable: false, error: errorMessage(error) });
    }
  });

  /**
   * The detached watchdog, not an arbitrary status 200, is authoritative for
   * a git-pull restart. This record lets the browser correlate its update
   * request to that durable verification outcome after the old server exits.
   */
  app.get('/core-update/restart-status', (c) => {
    const provenance = resolveInstallProvenance(
      dirname(fileURLToPath(import.meta.url)),
    );
    if (provenance.installKind !== 'source-checkout') {
      return c.json({ status: 'unavailable' });
    }

    const record = readSelfUpdateRestartRecord(
      restartStateFilePath(provenance.gitRoot),
    );
    const deadlineAt = record
      ? restartVerificationDeadlineAt(record.startedAt)
      : null;
    if (!record || !deadlineAt) {
      // Missing or malformed durable state must never read as a verified
      // restart. Deliberately avoid exposing local checkout paths or details.
      return c.json({ status: 'unavailable' });
    }

    return c.json({
      status: record.status,
      expectedHash: record.hash,
      expectedInstanceId: record.instanceId,
      deadlineAt,
      ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    });
  });

  app.post('/core-update', async (c) => {
    // Applying an update is git-pull + rebuild, which only a source checkout
    // can do — except a desktop bundle whose verified source checkout is on
    // this machine, which self-updates by running that checkout's installer
    // (archive#1624). Everything else refuses cleanly instead of letting
    // resolveGitInfo throw "Not a git repository" into a 500.
    const provenance = resolveInstallProvenance(
      dirname(fileURLToPath(import.meta.url)),
    );
    if (provenance.installKind === 'desktop-bundle') {
      const eligibility = await resolveSelfUpdateEligibility(provenance);
      if (!eligibility.eligible) {
        return c.json(
          {
            success: false,
            error: `This Station is a ${provenance.channel} desktop bundle; update it by reinstalling from the ${provenance.channel} channel (self-update unavailable: ${eligibility.reason}).`,
          },
          409,
        );
      }
      return applyDesktopSelfUpdate(c, eligibility);
    }
    if (provenance.installKind !== 'source-checkout') {
      return c.json(
        {
          success: false,
          error:
            'This install carries no update provenance, so it cannot update itself.',
        },
        409,
      );
    }

    try {
      systemOps.add(1, { op: 'apply_update' });
      const { gitRoot } = provenance;
      const currentInstanceId =
        process.env.STATION_INSTANCE_ID || DEFAULT_INSTANCE_ID;
      const conflictError = getSelfUpdateConflictError(
        gitRoot,
        currentInstanceId,
      );

      if (conflictError) {
        return c.json({ success: false, error: conflictError }, 409);
      }

      await execGit(['pull', '--ff-only'], {
        cwd: gitRoot,
        timeout: 30000,
      });
      await execFileAsync('npm', ['run', 'build:server'], {
        cwd: gitRoot,
        timeout: 120000,
      });
      await execFileAsync('npm', ['run', 'build:ui'], {
        cwd: gitRoot,
        timeout: 120000,
      });

      const newHashFull = (
        await execGit(['rev-parse', 'HEAD'], {
          cwd: gitRoot,
          encoding: 'utf-8',
        })
      ).stdout.trim();
      const newHash = newHashFull.substring(0, 7);

      deps.eventBus?.emit(SERVER_EVENTS.CORE_UPDATED, { hash: newHash });

      const port = process.env.PORT || String(DEFAULT_SERVER_PORT);
      const startedAt = new Date().toISOString();
      const deadlineAt = restartVerificationDeadlineAt(startedAt);
      if (!deadlineAt) {
        throw new Error('Core restart verification deadline is unavailable');
      }
      const restartStatePath = restartStateFilePath(gitRoot);

      // Written BEFORE anything is scheduled, so a crash before the watchdog
      // even spawns still leaves a durable, non-silent `pending` trail
      // (self-update-boot-report.ts ages an unresolved `pending` into a
      // boot-time warning rather than reading it as fine). The watchdog is
      // the only thing that ever moves this to `verified`/`failed`.
      const restartStateWrite = restartStateWriter(restartStatePath, {
        instanceId: currentInstanceId,
        hash: newHash,
        pid: 0,
        port: Number(port),
        startedAt,
        status: 'pending',
      });
      if (restartStateWrite.durability === 'uncertain') {
        emitRestartDiagnostic(
          logger,
          'warn',
          'Core restart: pending restart state committed with uncertain directory durability',
          {
            hash: newHash,
          },
        );
      }

      setTimeout(() => {
        performGitPullRestart({
          gitRoot,
          port,
          newHash,
          newHashFull,
          instanceId: currentInstanceId,
          restartStatePath,
          startedAt,
          moduleDir: dirname(fileURLToPath(import.meta.url)),
          logger,
          spawnFn: spawn,
          exitFn: (code) => process.exit(code),
        });
      }, 500);

      // `success: true` here means the build succeeded and the restart was
      // genuinely initiated — both already true at this point. It does NOT
      // mean the update succeeded: whether the new server ever answers a
      // request is unknown until the detached watchdog above verifies it,
      // well after this response has been sent (archive#1903). The message
      // says what happened, not what will happen.
      return c.json({
        success: true,
        hash: newHash,
        message: `Build succeeded (${newHash}). Restarting the server and verifying it comes up healthy…`,
        restarting: true,
        restart: {
          expectedHash: newHash,
          expectedInstanceId: currentInstanceId,
          deadlineAt,
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/build-updated', (c) => {
    deps.eventBus?.emit(SERVER_EVENTS.BUILD_UPDATED, {
      timestamp: new Date().toISOString(),
    });
    return c.json({ notified: true });
  });

  return app;
}
