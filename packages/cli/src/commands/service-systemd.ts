import { dirname, isAbsolute, join } from 'node:path';
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
}

function unitQuote(value: string): string {
  const hasUnsafeCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
  if (value.includes('%') || hasUnsafeCharacter) {
    throw new Error(
      'systemd unit values cannot contain control characters or % specifiers',
    );
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * `config_parse_working_directory()` receives the complete, unquoted value;
 * unlike command-line directives, it does not C-unescape it. Emit the raw
 * absolute path so spaces and ordinary backslashes retain their path meaning.
 */
function systemdWorkingDirectory(value: string): string {
  const hasUnsafeCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
  if (!isAbsolute(value)) {
    throw new Error('systemd WorkingDirectory must be an absolute path');
  }
  if (value.includes('%') || hasUnsafeCharacter) {
    throw new Error(
      'systemd WorkingDirectory cannot contain control characters or % specifiers',
    );
  }
  if (value.endsWith('\\')) {
    throw new Error(
      'systemd WorkingDirectory cannot end with a backslash because it continues the unit line',
    );
  }
  if (value.endsWith(' ')) {
    // systemd strips trailing whitespace from unquoted assignment values, so a
    // path ending in a space would silently resolve to a different directory.
    throw new Error(
      'systemd WorkingDirectory cannot end with a space; systemd would strip it and change the path',
    );
  }
  return value;
}

export function renderSystemdUnit(input: {
  instanceId: string;
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
  return `[Unit]
Description=Station user service (${input.instanceId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdWorkingDirectory(input.repoPath)}
Environment=${unitQuote(`PATH=${input.servicePath}`)}
Environment=${unitQuote(`STATION_ROOT=${input.lifecycle.stationRoot ?? ''}`)}
Environment=STATION_SERVICE_MANAGED=1
ExecStart=${args.map(unitQuote).join(' ')}
# Deliberately no Nice=, CPUWeight=, or IOSchedulingClass=: this user-facing
# service should retain systemd's normal scheduling defaults, not a background tier.
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
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

function lingerStatus(run: CommandRunner): {
  error?: string;
  value: boolean | null;
} {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return { error: 'loginctl status requires a user id', value: null };
  }
  const result = run('loginctl', [
    'show-user',
    String(uid),
    '-p',
    'Linger',
    '--value',
  ]);
  const error =
    result.error?.message ??
    (result.status === null
      ? 'loginctl show-user exited without a status'
      : undefined);
  return {
    error: error ? `loginctl show-user failed: ${error}` : undefined,
    value: error
      ? null
      : result.status === 0 && result.stdout?.trim() === 'yes',
  };
}

function ensureLinger(run: CommandRunner): void {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('Cannot enable systemd linger without a numeric user id');
  }
  const before = lingerStatus(run);
  if (before.error) throw new Error(before.error);
  if (before.value) return;
  requireSuccess(
    `loginctl enable-linger ${uid}`,
    run('loginctl', ['enable-linger', String(uid)]),
  );
  const after = lingerStatus(run);
  if (after.error) throw new Error(after.error);
  if (!after.value) {
    throw new Error(
      `loginctl enable-linger ${uid} completed but linger is still disabled; contact the system administrator because reboot-without-login service startup cannot be guaranteed`,
    );
  }
}

function restoreSystemdReplacement(
  registration: ServiceRegistration,
  prior: { active: boolean; enabled: boolean; unit: string | null },
  dependencies: InstallDependencies,
): void {
  if (!registration.unitName) {
    throw new Error('systemd rollback requires a service unit name');
  }
  const failures: string[] = [];
  const disabled = dependencies.run('systemctl', [
    '--user',
    'disable',
    '--now',
    registration.unitName,
  ]);
  if (disabled.status !== 0 || disabled.error) {
    failures.push(
      `disable --now failed: ${disabled.error?.message ?? disabled.stderr?.trim() ?? `exit ${disabled.status}`}`,
    );
  }
  try {
    if (prior.unit === null) {
      dependencies.fs.rmSync(registration.unitPath, { force: true });
    } else {
      dependencies.fs.writeFileSync(registration.unitPath, prior.unit, {
        mode: 0o600,
      });
      dependencies.fs.chmodSync(registration.unitPath, 0o600);
    }
  } catch (error) {
    failures.push(`restore unit failed: ${(error as Error).message}`);
  }
  const reload = dependencies.run('systemctl', ['--user', 'daemon-reload']);
  if (reload.status !== 0 || reload.error) {
    failures.push(
      `daemon-reload failed: ${reload.error?.message ?? reload.stderr?.trim() ?? `exit ${reload.status}`}`,
    );
  }
  if (prior.unit !== null && prior.enabled) {
    const enabled = dependencies.run('systemctl', [
      '--user',
      'enable',
      registration.unitName,
    ]);
    if (enabled.status !== 0 || enabled.error) {
      failures.push(
        `enable rollback failed: ${enabled.error?.message ?? enabled.stderr?.trim() ?? `exit ${enabled.status}`}`,
      );
    }
  }
  if (prior.unit !== null && prior.active) {
    const restarted = dependencies.run('systemctl', [
      '--user',
      'restart',
      registration.unitName,
    ]);
    if (restarted.status !== 0 || restarted.error) {
      failures.push(
        `restart rollback failed: ${restarted.error?.message ?? restarted.stderr?.trim() ?? `exit ${restarted.status}`}`,
      );
    }
  }
  if (prior.unit !== null) {
    const restored = systemdStatus(registration, dependencies);
    if (typeof restored.error === 'string') failures.push(restored.error);
    if (restored.active !== prior.active) {
      failures.push('restored systemd active state does not match prior state');
    }
    if (restored.enabled !== prior.enabled) {
      failures.push(
        'restored systemd enabled state does not match prior state',
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

export function systemdRegistration(
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
): ServiceRegistration {
  const unitName = `station-${instanceId}.service`;
  return {
    platform: 'linux',
    unitName,
    unitPath: join(
      process.env.HOME ?? dirname(lifecycle.baseDir),
      '.config',
      'systemd',
      'user',
      unitName,
    ),
  };
}

export function installSystemd(
  instanceId: string,
  dependencies: InstallDependencies,
): ServiceInstallResult {
  const { fs, lifecycle, nodePath, repoPath, run, servicePath } = dependencies;
  const manager = run('systemctl', ['--user', 'show-environment']);
  if (manager.status !== 0 || manager.error) {
    throw new Error(
      'The systemd user manager is unavailable. Log in with a user session and ensure `systemctl --user show-environment` succeeds.',
    );
  }
  ensureLinger(run);
  const registration = systemdRegistration(instanceId, lifecycle);
  const unitName = registration.unitName as string;
  const unitPath = registration.unitPath;
  const content = renderSystemdUnit({
    instanceId,
    lifecycle,
    nodePath,
    repoPath,
    servicePath,
  });
  const priorStatus = systemdStatus(registration, { fs, run });
  if (
    typeof priorStatus.error === 'string' ||
    priorStatus.active === null ||
    priorStatus.enabled === null
  ) {
    throw new Error(
      `Cannot snapshot Station systemd service before replacement: ${priorStatus.error ?? 'state is unknown'}`,
    );
  }
  const priorUnit = fs.existsSync(unitPath)
    ? fs.readFileSync(unitPath, 'utf8')
    : null;
  if (
    priorUnit === null &&
    (priorStatus.active === true || priorStatus.enabled === true)
  ) {
    throw new Error(
      'Cannot replace a loaded Station systemd service without a local unit to restore',
    );
  }
  const prior = {
    active: priorStatus.active === true,
    enabled: priorStatus.enabled === true,
    unit: priorUnit,
  };
  const rollback = () =>
    restoreSystemdReplacement(registration, prior, dependencies);
  const logDir = join(lifecycle.baseDir, 'logs');
  fs.mkdirSync(logDir, {
    mode: 0o700,
    recursive: true,
  });
  fs.chmodSync(logDir, 0o700);
  fs.mkdirSync(dirname(unitPath), { mode: 0o700, recursive: true });
  try {
    // A daemon-reload alone leaves an active service executing its old
    // generation. Stop and observe the exact prior unit before replacing its
    // file so the later readiness probe can only succeed for the new process.
    if (prior.active) {
      requireSuccess(
        'systemctl --user stop existing service',
        run('systemctl', ['--user', 'stop', unitName]),
      );
      const stopped = systemdStatus(registration, { fs, run });
      if (typeof stopped.error === 'string' || stopped.active !== false) {
        throw new Error(
          `Cannot confirm Station systemd service stopped before replacement: ${stopped.error ?? 'unit remains active'}`,
        );
      }
    }
    fs.writeFileSync(unitPath, content, { mode: 0o600 });
    fs.chmodSync(unitPath, 0o600);
    requireSuccess(
      'systemctl --user daemon-reload',
      run('systemctl', ['--user', 'daemon-reload']),
    );
    requireSuccess(
      'systemctl --user enable --now',
      run('systemctl', ['--user', 'enable', '--now', unitName]),
    );
  } catch (error) {
    try {
      restoreSystemdReplacement(registration, prior, dependencies);
    } catch (rollbackError) {
      throw new Error(
        `systemd replacement failed (${(error as Error).message}); rollback failed (${(rollbackError as Error).message})`,
      );
    }
    throw error;
  }
  return {
    host: lifecycle.host ?? '127.0.0.1',
    installedAt: '',
    instanceId,
    nodePath,
    platform: 'linux',
    repoPath,
    serverPort: lifecycle.serverPort,
    uiPort: lifecycle.uiPort,
    unitName,
    unitPath,
    rollback,
  };
}

export function systemdStatus(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): Record<string, boolean | string | null> {
  if (!registration.unitName) {
    const linger = lingerStatus(dependencies.run);
    return {
      active: null,
      enabled: null,
      error: linger.error ?? null,
      linger: linger.value,
      present: dependencies.fs.existsSync(registration.unitPath),
      unitName: null,
    };
  }
  const active = dependencies.run('systemctl', [
    '--user',
    'is-active',
    registration.unitName,
  ]);
  const enabled = dependencies.run('systemctl', [
    '--user',
    'is-enabled',
    registration.unitName,
  ]);
  const linger = lingerStatus(dependencies.run);
  const isCleanNotFound = (result: ReturnType<CommandRunner>): boolean =>
    result.status === 4 &&
    result.stdout?.trim() === 'not-found' &&
    !result.stderr?.trim() &&
    !result.error;
  const activeNotFound = isCleanNotFound(active);
  const enabledNotFound = isCleanNotFound(enabled);
  const activePresent = active.status === 0 || active.status === 3;
  // systemctl is-enabled represents existing units with 0 (enabled, static,
  // indirect, ...) or 1 (disabled); only its clean not-found is absence.
  const enabledPresent = enabled.status === 0 || enabled.status === 1;
  const contradictory =
    (activeNotFound && enabledPresent) || (enabledNotFound && activePresent);
  const activeUnknown =
    contradictory ||
    Boolean(active.error) ||
    active.status === null ||
    (!activePresent && !activeNotFound);
  const enabledUnknown =
    contradictory ||
    Boolean(enabled.error) ||
    enabled.status === null ||
    (!enabledPresent && !enabledNotFound);
  const errors = [
    active.error?.message ??
      (active.status === null
        ? 'systemctl is-active exited without a status'
        : active.status !== 0 && active.status !== 3 && !activeNotFound
          ? `systemctl is-active exited ${active.status}`
          : undefined),
    enabled.error?.message ??
      (enabled.status === null
        ? 'systemctl is-enabled exited without a status'
        : enabled.status !== 0 && enabled.status !== 1 && !enabledNotFound
          ? `systemctl is-enabled exited ${enabled.status}`
          : undefined),
    contradictory
      ? 'systemctl is-active and is-enabled disagree about whether the unit exists'
      : undefined,
    linger.error,
  ].filter((error): error is string => Boolean(error));
  return {
    active: activeUnknown ? null : active.status === 0,
    enabled: enabledUnknown ? null : enabled.status === 0,
    error: errors.length > 0 ? errors.join('; ') : null,
    linger: linger.value,
    present: dependencies.fs.existsSync(registration.unitPath),
    unitName: registration.unitName,
  };
}

export function uninstallSystemd(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  const before = systemdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot uninstall Station systemd service while backend status is unknown: ${before.error}`,
    );
  }
  const failures: string[] = [];
  if (
    registration.unitName &&
    (before.active === true || before.enabled === true)
  ) {
    const result = dependencies.run('systemctl', [
      '--user',
      'disable',
      '--now',
      registration.unitName,
    ]);
    if (result.status !== 0 || result.error) {
      failures.push(
        `disable --now failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
      );
    }
  }
  if (failures.length === 0) {
    try {
      dependencies.fs.rmSync(registration.unitPath, { force: true });
    } catch (error) {
      failures.push(`remove unit failed: ${(error as Error).message}`);
    }
  }
  if (failures.length === 0 && before.present === true) {
    const reload = dependencies.run('systemctl', ['--user', 'daemon-reload']);
    if (reload.status !== 0 || reload.error) {
      failures.push(
        `daemon-reload failed: ${reload.error?.message ?? reload.stderr?.trim() ?? `exit ${reload.status}`}`,
      );
    }
  }
  const after = systemdStatus(registration, dependencies);
  if (typeof after.error === 'string') failures.push(after.error);
  if (after.active === true) failures.push('systemd unit remains active');
  if (after.enabled === true) failures.push('systemd unit remains enabled');
  if (after.present === true)
    failures.push(`unit remains at ${registration.unitPath}`);
  if (failures.length > 0) {
    throw new Error(
      `Failed to uninstall Station systemd service; ${failures.join('; ')}`,
    );
  }
}

export function startSystemd(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  if (!registration.unitName) {
    throw new Error('systemd start requires a service unit name');
  }
  const before = systemdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot start Station systemd service while backend status is unknown: ${before.error}`,
    );
  }
  requireSuccess(
    'systemctl --user start',
    dependencies.run('systemctl', ['--user', 'start', registration.unitName]),
  );
}

export function stopSystemd(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  if (!registration.unitName) {
    throw new Error('systemd stop requires a service unit name');
  }
  const before = systemdStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot stop Station systemd service while backend status is unknown: ${before.error}`,
    );
  }
  if (before.active !== true) return;
  requireSuccess(
    'systemctl --user stop',
    dependencies.run('systemctl', ['--user', 'stop', registration.unitName]),
  );
}
