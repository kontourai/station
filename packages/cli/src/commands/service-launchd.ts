import { dirname, join } from 'node:path';
import type {
  CommandRunner,
  ServiceFs,
  ServiceInstallResult,
  ServiceLifecycleArgs,
  ServiceRegistration,
} from './service.js';

interface InstallDependencies {
  fs: ServiceFs;
  lifecycle: ServiceLifecycleArgs;
  nodePath: string;
  repoPath: string;
  run: CommandRunner;
  servicePath: string;
  monotonicNow?: () => number;
  reportProgress?: (message: string) => void;
  sleep?: (milliseconds: number) => void;
  stopOwnedInstance?: () => void;
}

const LAUNCHD_EXIT_TIMEOUT_SECONDS = 600;
export const LAUNCHD_INTERACTIVE_PROCESS_TYPE = 'Interactive';
const BOOTOUT_DRAIN_MARGIN_MS = 5_000;
const BOOTOUT_MINIMUM_DRAIN_TIMEOUT_MS = 30_000;
const BOOTOUT_POLL_INTERVAL_MS = 100;
const BOOTOUT_PROGRESS_INTERVAL_MS = 1_000;

function launchdDrainTimeoutMs(): number {
  return Math.max(
    BOOTOUT_MINIMUM_DRAIN_TIMEOUT_MS,
    LAUNCHD_EXIT_TIMEOUT_SECONDS * 1_000 + BOOTOUT_DRAIN_MARGIN_MS,
  );
}

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderLaunchdPlist(input: {
  instanceId: string;
  label: string;
  lifecycle: ServiceLifecycleArgs;
  nodePath: string;
  repoPath: string;
  servicePath: string;
}): string {
  const args = [
    input.nodePath,
    join(input.repoPath, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(input.repoPath, 'scripts', 'station-cli.ts'),
    'service',
    'run',
    `--instance=${input.instanceId}`,
    `--base=${input.lifecycle.baseDir}`,
    `--port=${input.lifecycle.serverPort}`,
    `--ui-port=${input.lifecycle.uiPort}`,
    `--host=${input.lifecycle.host ?? '127.0.0.1'}`,
    ...(input.lifecycle.features
      ? [`--features=${input.lifecycle.features}`]
      : []),
    ...(input.lifecycle.allowedOrigins ?? []).map(
      (origin) => `--allowed-origin=${origin}`,
    ),
  ];
  const logDir = join(input.lifecycle.baseDir, 'logs');
  // launchd.plist(5): Standard/unset remains throttled; only Interactive
  // lifts resource limits. This user-facing service must remain responsive.
  const processType = LAUNCHD_INTERACTIVE_PROCESS_TYPE;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `\n    <string>${xml(arg)}</string>`).join('')}
  </array>
  <key>WorkingDirectory</key><string>${xml(input.repoPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(input.servicePath)}</string>
    <key>STATION_ROOT</key><string>${xml(input.lifecycle.stationRoot ?? '')}</string>
    <key>STATION_SERVICE_MANAGED</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>${processType}</string>
  <key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, `${input.instanceId}-service.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, `${input.instanceId}-service.err.log`))}</string>
</dict>
</plist>
`;
}

function requireSuccess(
  label: string,
  result: ReturnType<CommandRunner>,
): void {
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${label} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
}

/**
 * `launchctl bootout` returns before launchd has necessarily removed the
 * label. Reusing that label immediately is the bootstrap race seen in live
 * reinstall flows, so require an observed absence before continuing.
 */
function waitForLaunchdBootout(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    monotonicNow?: () => number;
    reportProgress?: (message: string) => void;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  const label = registration.label ?? 'the Station label';
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const timeoutMs = launchdDrainTimeoutMs();
  let lastProgressAt = startedAt;
  while (true) {
    const status = launchdStatus(registration, dependencies);
    if (typeof status.error === 'string') {
      throw new Error(`Cannot confirm launchd bootout: ${status.error}`);
    }
    if (status.active === false) return;
    const now = monotonicNow();
    const elapsedMs = now - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `launchd job ${label} is still draining after ${elapsedMs}ms; run \`launchctl bootout gui/${process.getuid?.()}/${label}\` again after it exits`,
      );
    }
    if (now - lastProgressAt >= BOOTOUT_PROGRESS_INTERVAL_MS) {
      (dependencies.reportProgress ?? console.log)(
        `waiting for ${label} to drain (${Math.floor(elapsedMs / 1_000)}s)...`,
      );
      lastProgressAt = now;
    }
    (dependencies.sleep ?? sleepSynchronously)(
      Math.min(BOOTOUT_POLL_INTERVAL_MS, timeoutMs - elapsedMs),
    );
  }
}

function restoreLaunchdReplacement(
  registration: ServiceRegistration,
  prior: { active: boolean; plist: string | null },
  dependencies: InstallDependencies,
): void {
  const uid = process.getuid?.();
  if (uid === undefined || !registration.label) {
    throw new Error('launchd rollback requires a user id and a service label');
  }
  const current = launchdStatus(registration, dependencies);
  if (typeof current.error === 'string') throw new Error(current.error);
  if (current.active === true) {
    requireSuccess(
      'launchctl bootout rollback service',
      dependencies.run('launchctl', [
        'bootout',
        `gui/${uid}/${registration.label}`,
      ]),
    );
    try {
      waitForLaunchdBootout(registration, dependencies);
    } catch (error) {
      // A drain can complete between its last unsuccessful observation and the
      // rollback failure path. Do not claim rollback failed without one final
      // state check; an absent label is safe to restore over.
      const afterBootout = launchdStatus(registration, dependencies);
      if (afterBootout.active !== false) throw error;
    }
  }
  dependencies.stopOwnedInstance?.();
  if (prior.plist === null) {
    dependencies.fs.rmSync(registration.unitPath, { force: true });
    return;
  }
  dependencies.fs.writeFileSync(registration.unitPath, prior.plist, {
    mode: 0o600,
  });
  dependencies.fs.chmodSync(registration.unitPath, 0o600);
  if (!prior.active) return;
  requireSuccess(
    'launchctl bootstrap rollback service',
    dependencies.run('launchctl', [
      'bootstrap',
      `gui/${uid}`,
      registration.unitPath,
    ]),
  );
  requireSuccess(
    'launchctl kickstart rollback service',
    dependencies.run('launchctl', [
      'kickstart',
      '-k',
      `gui/${uid}/${registration.label}`,
    ]),
  );
}

export function launchdRegistration(
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
): ServiceRegistration {
  return launchdRegistrationForLabel(
    `io.kontourai.station.${instanceId}`,
    lifecycle,
  );
}

/**
 * Every LaunchAgent identity Station has shipped before the current one,
 * newest first. A user upgrading from an installed older service still has one
 * of these labels loaded and its manifest on disk; migration must recognize
 * and replace whichever is present rather than refuse it (station#1983).
 *
 * Ordered newest-first so a machine carrying more than one stale generation
 * (an interrupted earlier migration) is reported against the most recent one.
 * Every entry must be booted out and removed during install, or the renamed
 * job would run alongside its own predecessor.
 */
export function legacyLaunchdRegistrations(
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
): ServiceRegistration[] {
  return [
    `ai.kontour.command-station.${instanceId}`,
    `ai.kontour.station.${instanceId}`,
  ].map((label) => launchdRegistrationForLabel(label, lifecycle));
}

function launchdRegistrationForLabel(
  label: string,
  lifecycle: ServiceLifecycleArgs,
): ServiceRegistration {
  return {
    label,
    platform: 'darwin',
    unitPath: join(
      process.env.HOME ?? dirname(lifecycle.baseDir),
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    ),
  };
}

export function installLaunchd(
  instanceId: string,
  dependencies: InstallDependencies,
): ServiceInstallResult {
  const { fs, lifecycle, nodePath, repoPath, run, servicePath } = dependencies;
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error('launchd installation requires a user id');
  const registration = launchdRegistration(instanceId, lifecycle);
  const label = registration.label as string;
  const unitPath = registration.unitPath;
  const tempPath = join(lifecycle.baseDir, 'service', `${label}.plist.tmp`);
  const content = renderLaunchdPlist({
    instanceId,
    label,
    lifecycle,
    nodePath,
    repoPath,
    servicePath,
  });
  const logDir = join(lifecycle.baseDir, 'logs');
  fs.mkdirSync(logDir, {
    mode: 0o700,
    recursive: true,
  });
  fs.chmodSync(logDir, 0o700);
  const serviceDir = dirname(tempPath);
  fs.mkdirSync(serviceDir, { mode: 0o700, recursive: true });
  fs.chmodSync(serviceDir, 0o700);
  fs.mkdirSync(dirname(unitPath), { mode: 0o700, recursive: true });
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  let rollback: (() => void) | undefined;
  try {
    requireSuccess('plutil -lint', run('plutil', ['-lint', tempPath]));
    // Capture every legacy plist's bytes and loaded state BEFORE booting any
    // of them out or deleting them, so a later replacement failure can restore
    // the previously working legacy service instead of leaving it removed
    // (station#1983).
    const legacyGenerations = legacyLaunchdRegistrations(
      instanceId,
      lifecycle,
    ).map((legacyRegistration) => {
      const legacy = launchdStatus(legacyRegistration, { fs, run });
      if (typeof legacy.error === 'string') throw new Error(legacy.error);
      return {
        registration: legacyRegistration,
        active: legacy.active === true,
        prior: {
          active: legacy.active === true,
          plist: fs.existsSync(legacyRegistration.unitPath)
            ? fs.readFileSync(legacyRegistration.unitPath, 'utf8')
            : null,
        },
      };
    });
    const current = launchdStatus(registration, { fs, run });
    if (typeof current.error === 'string') throw new Error(current.error);
    const prior = {
      active: current.active === true,
      plist: fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf8') : null,
    };
    // Rollback restores BOTH the new-label replacement and every legacy
    // service that was booted out and deleted above.
    const restoreAll = (): void => {
      restoreLaunchdReplacement(registration, prior, dependencies);
      for (const generation of legacyGenerations) {
        restoreLaunchdReplacement(
          generation.registration,
          generation.prior,
          dependencies,
        );
      }
    };
    // Arm rollback before the first legacy mutation. In particular,
    // waitForLaunchdBootout and removal can fail after bootout succeeds.
    rollback = restoreAll;
    try {
      for (const generation of legacyGenerations) {
        if (generation.active) {
          requireSuccess(
            'launchctl bootout legacy service',
            run('launchctl', [
              'bootout',
              `gui/${uid}/${generation.registration.label as string}`,
            ]),
          );
          waitForLaunchdBootout(generation.registration, dependencies);
        }
        if (fs.existsSync(generation.registration.unitPath)) {
          fs.rmSync(generation.registration.unitPath, { force: true });
        }
      }
      if (prior.active) {
        requireSuccess(
          'launchctl bootout existing service',
          run('launchctl', ['bootout', `gui/${uid}/${label}`]),
        );
        waitForLaunchdBootout(registration, dependencies);
      }
      // The lifecycle children are deliberately detached from the supervisor
      // so they can drain gracefully. launchd bootout therefore cannot be the
      // whole replacement boundary: converge the exact recorded children
      // before the new job is allowed to reuse their ports.
      dependencies.stopOwnedInstance?.();
      fs.writeFileSync(unitPath, content, { mode: 0o600 });
      fs.chmodSync(unitPath, 0o600);
      requireSuccess(
        'launchctl bootstrap',
        run('launchctl', ['bootstrap', `gui/${uid}`, unitPath]),
      );
      requireSuccess(
        'launchctl kickstart',
        run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]),
      );
    } catch (error) {
      try {
        restoreAll();
      } catch (rollbackError) {
        throw new Error(
          `launchd replacement failed (${(error as Error).message}); rollback failed (${(rollbackError as Error).message})`,
        );
      }
      throw error;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return {
    host: lifecycle.host ?? '127.0.0.1',
    installedAt: '',
    instanceId,
    label,
    nodePath,
    platform: 'darwin',
    repoPath,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
    unitPath,
    rollback,
  };
}

export function launchdStatus(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): Record<string, boolean | string | null> {
  if (!registration.label) {
    return {
      active: null,
      label: null,
      present: dependencies.fs.existsSync(registration.unitPath),
    };
  }
  const uid = process.getuid?.();
  const result =
    uid === undefined
      ? {
          error: new Error('launchd status requires a user id'),
          status: null,
        }
      : dependencies.run('launchctl', [
          'print',
          `gui/${uid}/${registration.label}`,
        ]);
  const error =
    result.error?.message ??
    (result.status === null
      ? 'launchctl print exited without a status'
      : result.status !== 0 && result.status !== 1 && result.status !== 113
        ? `launchctl print exited ${result.status}`
        : undefined);
  return {
    active: error ? null : result.status === 0,
    error: error ? `launchctl print failed: ${error}` : null,
    label: registration.label,
    present: dependencies.fs.existsSync(registration.unitPath),
  };
}

export function startLaunchd(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  const uid = process.getuid?.();
  if (uid === undefined || !registration.label)
    throw new Error('launchd start requires a user id and a service label');
  const before = launchdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot start Station LaunchAgent while backend status is unknown: ${before.error}`,
    );
  }
  if (before.active !== true) {
    requireSuccess(
      'launchctl bootstrap',
      dependencies.run('launchctl', [
        'bootstrap',
        `gui/${uid}`,
        registration.unitPath,
      ]),
    );
  }
  // kickstart -k restarts an already-running job and starts a freshly
  // bootstrapped one — correct in both branches.
  requireSuccess(
    'launchctl kickstart',
    dependencies.run('launchctl', [
      'kickstart',
      '-k',
      `gui/${uid}/${registration.label}`,
    ]),
  );
}

export function stopLaunchd(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    monotonicNow?: () => number;
    reportProgress?: (message: string) => void;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  const uid = process.getuid?.();
  if (uid === undefined || !registration.label)
    throw new Error('launchd stop requires a user id and a service label');
  const before = launchdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot stop Station LaunchAgent while backend status is unknown: ${before.error}`,
    );
  }
  if (before.active !== true) return;
  // KeepAlive silently defeats a plain `launchctl stop`; bootout is the only
  // stop that sticks until the next explicit start/login.
  requireSuccess(
    'launchctl bootout',
    dependencies.run('launchctl', [
      'bootout',
      `gui/${uid}/${registration.label}`,
    ]),
  );
  waitForLaunchdBootout(registration, dependencies);
}

export function uninstallLaunchd(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    monotonicNow?: () => number;
    reportProgress?: (message: string) => void;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  const uid = process.getuid?.();
  const before = launchdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot uninstall Station LaunchAgent while backend status is unknown: ${before.error}`,
    );
  }
  const failures: string[] = [];
  if (uid !== undefined && registration.label && before.active === true) {
    const result = dependencies.run('launchctl', [
      'bootout',
      `gui/${uid}/${registration.label}`,
    ]);
    if (result.status !== 0 || result.error) {
      failures.push(
        `bootout failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
      );
    } else {
      try {
        waitForLaunchdBootout(registration, dependencies);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
  }
  if (failures.length === 0) {
    try {
      dependencies.fs.rmSync(registration.unitPath, { force: true });
    } catch (error) {
      failures.push(`remove plist failed: ${(error as Error).message}`);
    }
  }
  const after = launchdStatus(registration, dependencies);
  if (typeof after.error === 'string') failures.push(after.error);
  if (after.active === true) failures.push('launchd job remains loaded');
  if (after.present === true)
    failures.push(`plist remains at ${registration.unitPath}`);
  if (failures.length > 0) {
    throw new Error(
      `Failed to uninstall Station LaunchAgent; ${failures.join('; ')}`,
    );
  }
}
