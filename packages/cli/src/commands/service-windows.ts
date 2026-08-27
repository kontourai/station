import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import type {
  CommandRunner,
  ServiceFs,
  ServiceInstallResult,
  ServiceLifecycleArgs,
  ServiceRegistration,
} from './service.js';
import {
  assertWindowsPathsTrusted,
  encodePowerShellCommand,
  ensureWindowsDirectoriesTrusted,
  hardenWindowsPathsTrusted,
  windowsSystemUtilityPath,
} from './windows-path-trust.js';

interface InstallDependencies {
  fs: ServiceFs;
  lifecycle: ServiceLifecycleArgs;
  nodePath: string;
  repoPath: string;
  run: CommandRunner;
  sleep?: (milliseconds: number) => void;
  hardenWindowsPaths?: typeof hardenWindowsPathsTrusted;
}

const START_POLL_INTERVAL_MS = 100;
const START_POLL_ATTEMPTS = 20;
// Task Scheduler defaults to 7, a background-tier priority. 5 is in its
// interactive band and is appropriate for Station's user-facing service.
export const WINDOWS_INTERACTIVE_TASK_PRIORITY = 5;

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

/** Quote one argument for Windows command-line parsing, not shell interpolation. */
export function quoteWindowsArgument(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('Windows service values cannot contain control characters');
  }
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1')}"`;
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

interface WindowsIdentity {
  account: string;
  sid: string;
}

function currentWindowsIdentity(run: CommandRunner): WindowsIdentity {
  const result = run(windowsSystemUtilityPath('whoami'), [
    '/user',
    '/fo',
    'csv',
    '/nh',
  ]);
  requireSuccess('whoami', result);
  const match = result.stdout
    ?.trim()
    .match(/^"((?:[^"]|"")*)","(S-[0-9-]+)"$/iu);
  if (!match) throw new Error('whoami returned no current Windows SID');
  return { account: match[1].replaceAll('""', '"'), sid: match[2] };
}

function commandPath(
  lifecycle: ServiceLifecycleArgs,
  instanceId: string,
): string {
  return win32.join(lifecycle.baseDir, 'service', `station-${instanceId}.cmd`);
}

function logPath(lifecycle: ServiceLifecycleArgs, instanceId: string): string {
  return win32.join(lifecycle.baseDir, 'logs', `${instanceId}-service.log`);
}

function manifestCommandTargets(manifest: {
  nodePath: string;
  repoPath: string;
}) {
  const files = [
    {
      kind: 'file' as const,
      path: manifest.nodePath,
      policy: 'execution-safe' as const,
    },
    {
      kind: 'file' as const,
      path: win32.join(
        manifest.repoPath,
        'node_modules',
        'tsx',
        'dist',
        'cli.mjs',
      ),
      policy: 'execution-safe' as const,
    },
    {
      kind: 'file' as const,
      path: win32.join(manifest.repoPath, 'scripts', 'station-cli.ts'),
      policy: 'execution-safe' as const,
    },
  ];
  return files.flatMap((file) => [
    {
      kind: 'directory' as const,
      path: win32.dirname(file.path),
      policy: 'execution-safe' as const,
    },
    file,
  ]);
}

/** Recheck control and command paths at the actual Task Scheduler boundary. */
export function assertWindowsServiceExecutionTrusted(
  manifest: { nodePath: string; repoPath: string; unitPath: string },
  lifecycle: ServiceLifecycleArgs,
  run: CommandRunner,
): void {
  assertWindowsPathsTrusted(run, [
    { kind: 'directory', path: lifecycle.baseDir },
    { kind: 'directory', path: win32.join(lifecycle.baseDir, 'service') },
    { kind: 'directory', path: win32.join(lifecycle.baseDir, 'logs') },
    { kind: 'file', path: manifest.unitPath },
    ...manifestCommandTargets(manifest),
  ]);
}

function commandInterpreter(): string {
  return windowsSystemUtilityPath('cmd');
}

export function renderWindowsServiceCommand(input: {
  instanceId: string;
  lifecycle: ServiceLifecycleArgs;
  nodePath: string;
  repoPath: string;
}): string {
  const stationRoot = input.lifecycle.stationRoot ?? '';
  if (/["%\r\n]/.test(stationRoot)) {
    throw new Error('STATION_ROOT contains an unsafe Windows command value');
  }
  const args = [
    input.nodePath,
    win32.join(input.repoPath, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    win32.join(input.repoPath, 'scripts', 'station-cli.ts'),
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
  const log = logPath(input.lifecycle, input.instanceId);
  return [
    '@echo off',
    `set "STATION_ROOT=${stationRoot}"`,
    `cd /d ${quoteWindowsArgument(input.repoPath)} || exit /b 1`,
    `${args.map(quoteWindowsArgument).join(' ')} >> ${quoteWindowsArgument(log)} 2>&1`,
    '',
  ].join('\r\n');
}

export function renderWindowsTaskInvocation(wrapperPath: string): string {
  return `${quoteWindowsArgument(commandInterpreter())} /d /c ${quoteWindowsArgument(wrapperPath)}`;
}

export function windowsRegistration(
  instanceId: string,
  lifecycle: ServiceLifecycleArgs,
): ServiceRegistration {
  const taskName = `\\KontourStation-${instanceId}`;
  return {
    platform: 'win32',
    taskName,
    unitPath: commandPath(lifecycle, instanceId),
  };
}

function taskIdentityMismatches(
  xmlOutput: string,
  registration: ServiceRegistration,
  sid: string,
): string[] {
  if (!registration.taskName) return ['task name'];
  const expectedCommand = xml(commandInterpreter());
  const expectedWrapper = xml(registration.unitPath);
  const expectedUser = xml(sid);
  const command = xmlOutput.match(/<Command>([\s\S]*?)<\/Command>/iu)?.[1];
  const normalizedCommand =
    command?.startsWith('"') && command.endsWith('"')
      ? command.slice(1, -1)
      : command;
  const argumentsText = xmlOutput.match(
    /<Arguments>([\s\S]*?)<\/Arguments>/iu,
  )?.[1];
  const user = xmlOutput.match(/<UserId>([\s\S]*?)<\/UserId>/iu)?.[1];
  const runLevelIsLimited =
    !/<RunLevel>/iu.test(xmlOutput) ||
    xmlOutput.includes('<RunLevel>LeastPrivilege</RunLevel>');
  const mismatches: string[] = [];
  if (normalizedCommand?.toLowerCase() !== expectedCommand.toLowerCase())
    mismatches.push(`command ${JSON.stringify(command ?? 'missing')}`);
  if (
    argumentsText?.toLowerCase().includes(expectedWrapper.toLowerCase()) !==
    true
  )
    mismatches.push('wrapper');
  if (user?.toLowerCase() !== expectedUser.toLowerCase())
    mismatches.push('user');
  if (!runLevelIsLimited) mismatches.push('run level');
  return mismatches;
}

function taskState(
  run: CommandRunner,
  taskName: string,
): {
  active: boolean | null;
  error?: string;
} {
  // schtasks emits both its field names and state values in the user's UI
  // language. Task Scheduler's PowerShell enum is stable instead: Unknown=0,
  // Disabled=1, Queued=2, Ready=3, Running=4. The task name is Base64 JSON in
  // an encoded program, never an ambiguous post--Command argument.
  const payload = Buffer.from(JSON.stringify({ taskName }), 'utf8').toString(
    'base64',
  );
  const program = `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $task = Get-ScheduledTask -TaskName $request.taskName.TrimStart('\\') -TaskPath '\\'; [int]$task.State`;
  const result = run(windowsSystemUtilityPath('powershell'), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShellCommand(program),
  ]);
  if (result.error || result.status !== 0) {
    return {
      active: null,
      error:
        result.error?.message ??
        result.stderr?.trim() ??
        `exit ${result.status}`,
    };
  }
  const match = result.stdout?.match(/^\s*([0-4])\s*$/u);
  if (!match)
    return { active: null, error: 'Task Scheduler status could not be parsed' };
  return { active: match[1] === '4' };
}

/**
 * `schtasks /Create` has no priority switch. The ScheduledTasks module is
 * already required for our locale-independent state query, so update the
 * registered task through that supported API before Station starts it.
 */
function setWindowsTaskPriority(
  registration: ServiceRegistration,
  run: CommandRunner,
): void {
  if (!registration.taskName) {
    throw new Error('Windows task registration is missing a task name');
  }
  const payload = Buffer.from(
    JSON.stringify({ taskName: registration.taskName }),
    'utf8',
  ).toString('base64');
  const program = `$ErrorActionPreference = 'Stop'; $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $task = Get-ScheduledTask -TaskName $request.taskName.TrimStart('\\') -TaskPath '\\'; $task.Settings.Priority = ${WINDOWS_INTERACTIVE_TASK_PRIORITY}; Set-ScheduledTask -InputObject $task | Out-Null; $updated = Get-ScheduledTask -TaskName $request.taskName.TrimStart('\\') -TaskPath '\\'; if ([int]$updated.Settings.Priority -ne ${WINDOWS_INTERACTIVE_TASK_PRIORITY}) { throw 'Station Task Scheduler priority did not persist' }`;
  requireSuccess(
    'Task Scheduler priority update',
    run(windowsSystemUtilityPath('powershell'), [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(program),
    ]),
  );
}

function verifiedTaskXml(
  registration: ServiceRegistration,
  run: CommandRunner,
): string {
  if (!registration.taskName) {
    throw new Error('Windows task registration is missing a task name');
  }
  const queried = run(windowsSystemUtilityPath('schtasks'), [
    '/Query',
    '/TN',
    registration.taskName,
    '/XML',
  ]);
  requireSuccess('schtasks query', queried);
  const identity = currentWindowsIdentity(run);
  const mismatches = taskIdentityMismatches(
    queried.stdout ?? '',
    registration,
    identity.sid,
  );
  if (mismatches.length > 0) {
    throw new Error(
      `Station task identity does not match the current user and expected command (${mismatches.join(', ')})`,
    );
  }
  return queried.stdout ?? '';
}

function waitForWindowsRunning(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
    const status = windowsServiceStatus(registration, dependencies);
    if (typeof status.error === 'string') {
      throw new Error(
        `Cannot confirm Station Task Scheduler start: ${status.error}`,
      );
    }
    if (status.active === true) return;
    if (status.present !== true) {
      throw new Error('Station Task Scheduler task disappeared after start');
    }
    if (attempt < START_POLL_ATTEMPTS - 1) {
      (dependencies.sleep ?? sleepSynchronously)(START_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Station Task Scheduler task did not enter Running state within ${START_POLL_ATTEMPTS * START_POLL_INTERVAL_MS}ms`,
  );
}

function waitForWindowsStopped(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
    const status = windowsServiceStatus(registration, dependencies);
    if (typeof status.error === 'string') {
      throw new Error(
        `Cannot confirm Station Task Scheduler stop: ${status.error}`,
      );
    }
    if (status.present !== true) {
      throw new Error(
        'Station Task Scheduler task disappeared before replacement',
      );
    }
    if (status.active === false) return;
    if (attempt < START_POLL_ATTEMPTS - 1) {
      (dependencies.sleep ?? sleepSynchronously)(START_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Station Task Scheduler task did not stop within ${START_POLL_ATTEMPTS * START_POLL_INTERVAL_MS}ms before replacement`,
  );
}

function deleteFreshWindowsTask(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  if (!registration.taskName) {
    throw new Error('Windows task rollback requires a task name');
  }
  // A successful /Run does not mean the cmd wrapper has exited. Do not delete
  // a fresh registration beneath a live replacement: end it and observe the
  // scheduler state first, so no later task action can run its wrapper.
  stopWindowsTaskForRollback(registration, dependencies);
  const deleted = dependencies.run(windowsSystemUtilityPath('schtasks'), [
    '/Delete',
    '/TN',
    registration.taskName,
    '/F',
  ]);
  const after = dependencies.run(windowsSystemUtilityPath('schtasks'), [
    '/Query',
    '/TN',
    registration.taskName,
    '/XML',
  ]);
  if (after.error || after.status === null || after.status === 0) {
    throw new Error(
      `Cannot verify rollback task removal after ${deleted.error?.message ?? deleted.stderr?.trim() ?? `delete exit ${deleted.status}`}: ${after.error?.message ?? (after.status === 0 ? 'task remains registered' : 'query exited without a status')}`,
    );
  }
}

function stopWindowsTaskForRollback(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  const status = windowsServiceStatus(registration, dependencies);
  if (typeof status.error !== 'string') {
    if (status.present !== true) return;
    stopWindowsService(registration, dependencies);
    waitForWindowsStopped(registration, dependencies);
    return;
  }
  // A malformed/localized state probe must not turn into a delete beneath a
  // potentially live task. /End is a best-effort containment action only;
  // without a reliable bounded state proof, fail closed before touching the
  // wrapper or registration.
  requireSuccess(
    'schtasks end',
    dependencies.run(windowsSystemUtilityPath('schtasks'), [
      '/End',
      '/TN',
      registration.taskName as string,
    ]),
  );
  throw new Error(
    `Cannot confirm Station Task Scheduler stop before rollback: ${status.error}`,
  );
}

export function windowsServiceStatus(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): Record<string, boolean | string | null> {
  if (!registration.taskName) {
    return {
      active: null,
      enabled: null,
      error: 'Windows task registration is missing a task name',
      present: dependencies.fs.existsSync(registration.unitPath),
      taskName: null,
    };
  }
  const queried = dependencies.run(windowsSystemUtilityPath('schtasks'), [
    '/Query',
    '/TN',
    registration.taskName,
    '/XML',
  ]);
  if (queried.error || queried.status === null) {
    return {
      active: null,
      enabled: null,
      error: `schtasks query failed: ${queried.error?.message ?? 'exited without a status'}`,
      present: dependencies.fs.existsSync(registration.unitPath),
      taskName: registration.taskName,
    };
  }
  if (queried.status === 1) {
    return {
      active: false,
      enabled: false,
      error: null,
      present: false,
      taskName: registration.taskName,
    };
  }
  if (queried.status !== 0) {
    return {
      active: null,
      enabled: null,
      error: `schtasks query failed: exit ${queried.status}`,
      present: dependencies.fs.existsSync(registration.unitPath),
      taskName: registration.taskName,
    };
  }
  let identity: WindowsIdentity;
  try {
    identity = currentWindowsIdentity(dependencies.run);
  } catch (error) {
    return {
      active: null,
      enabled: null,
      error: `Cannot verify Station task owner: ${(error as Error).message}`,
      present: true,
      taskName: registration.taskName,
    };
  }
  const mismatches = taskIdentityMismatches(
    queried.stdout ?? '',
    registration,
    identity.sid,
  );
  if (mismatches.length > 0) {
    return {
      active: null,
      enabled: null,
      error: `Station task identity does not match the current user and expected command (${mismatches.join(', ')})`,
      present: true,
      taskName: registration.taskName,
    };
  }
  const state = taskState(dependencies.run, registration.taskName);
  const enabledMatch = queried.stdout?.match(
    /<Enabled>\s*(true|false)\s*<\/Enabled>/iu,
  );
  return {
    active: state.active,
    // Task Scheduler defaults Enabled to true when the element is omitted.
    // A registered but disabled task is present but cannot be considered a
    // durable service installation.
    enabled: enabledMatch?.[1]?.toLowerCase() !== 'false',
    error: state.error ?? null,
    present: true,
    taskName: registration.taskName,
  };
}

function restoreWindowsReplacement(
  registration: ServiceRegistration,
  prior: { taskXml: string | null; wasActive: boolean; wrapper: string | null },
  dependencies: {
    fs: ServiceFs;
    hardenWindowsPaths?: typeof hardenWindowsPathsTrusted;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  if (!registration.taskName) {
    throw new Error('Windows task rollback requires a task name');
  }
  if (prior.taskXml === null) {
    deleteFreshWindowsTask(registration, dependencies);
    dependencies.fs.rmSync(registration.unitPath, { force: true });
    return;
  }
  if (prior.wrapper === null) {
    throw new Error('rollback cannot restore a task without its wrapper');
  }
  // /Create /F can replace a registration while the replacement cmd wrapper
  // is still executing. Stop that exact task before restoring the prior
  // wrapper and XML, otherwise a live replacement can observe rewritten files.
  stopWindowsTaskForRollback(registration, dependencies);
  const rollbackXmlPath = win32.join(
    win32.dirname(registration.unitPath),
    `.${registration.taskName.replaceAll('\\', '')}.${process.pid}.${randomUUID()}.rollback.xml`,
  );
  dependencies.fs.writeFileSync(registration.unitPath, prior.wrapper, {
    mode: 0o600,
  });
  dependencies.fs.chmodSync(registration.unitPath, 0o600);
  (dependencies.hardenWindowsPaths ?? hardenWindowsPathsTrusted)(
    dependencies.run,
    [{ kind: 'file', path: registration.unitPath }],
  );
  dependencies.fs.writeFileSync(rollbackXmlPath, prior.taskXml, {
    mode: 0o600,
  });
  dependencies.fs.chmodSync(rollbackXmlPath, 0o600);
  try {
    requireSuccess(
      'schtasks restore',
      dependencies.run(windowsSystemUtilityPath('schtasks'), [
        '/Create',
        '/TN',
        registration.taskName,
        '/XML',
        rollbackXmlPath,
        '/F',
      ]),
    );
    let restored = windowsServiceStatus(registration, dependencies);
    if (typeof restored.error === 'string') throw new Error(restored.error);
    if (prior.wasActive) {
      startWindowsService(registration, dependencies);
      restored = windowsServiceStatus(registration, dependencies);
      if (restored.active !== true) {
        throw new Error('restored task did not return to Running state');
      }
    } else if (restored.active === true) {
      stopWindowsService(registration, dependencies);
      waitForWindowsStopped(registration, dependencies);
      restored = windowsServiceStatus(registration, dependencies);
    }
    if (restored.active !== prior.wasActive) {
      throw new Error(
        `restored task state ${String(restored.active)} did not match prior state ${String(prior.wasActive)}`,
      );
    }
  } finally {
    dependencies.fs.rmSync(rollbackXmlPath, { force: true });
  }
}

export function installWindowsService(
  instanceId: string,
  dependencies: InstallDependencies,
): ServiceInstallResult {
  const { fs, lifecycle, nodePath, repoPath, run } = dependencies;
  const hardenPaths =
    dependencies.hardenWindowsPaths ?? hardenWindowsPathsTrusted;
  const registration = windowsRegistration(instanceId, lifecycle);
  const taskName = registration.taskName as string;
  const wrapperPath = registration.unitPath;
  const log = logPath(lifecycle, instanceId);
  const serviceDir = win32.dirname(wrapperPath);
  const logDir = win32.dirname(log);
  ensureWindowsDirectoriesTrusted(run, [lifecycle.baseDir, serviceDir, logDir]);
  assertWindowsPathsTrusted(
    run,
    manifestCommandTargets({ nodePath, repoPath }),
  );
  const existing = windowsServiceStatus(registration, { fs, run });
  if (typeof existing.error === 'string') {
    throw new Error(
      `Cannot reinstall Station Task Scheduler service while backend status is unknown: ${existing.error}`,
    );
  }
  const priorWrapper =
    existing.present === true && fs.existsSync(wrapperPath)
      ? fs.readFileSync(wrapperPath, 'utf8')
      : null;
  const priorTaskXml =
    existing.present === true ? verifiedTaskXml(registration, run) : null;
  const prior = {
    taskXml: priorTaskXml,
    wasActive: existing.active === true,
    wrapper: priorWrapper,
  };
  const rollback = () =>
    restoreWindowsReplacement(registration, prior, {
      fs,
      hardenWindowsPaths: hardenPaths,
      run,
    });
  try {
    if (prior.wasActive) {
      // `/Create /F` may replace the registration while its old wrapper is
      // still executing. End and observe that exact task first; otherwise the
      // replacement can report healthy through the prior Station generation.
      stopWindowsService(registration, { fs, run });
      waitForWindowsStopped(registration, {
        fs,
        run,
        sleep: dependencies.sleep,
      });
    }
    fs.mkdirSync(logDir, { mode: 0o700, recursive: true });
    fs.mkdirSync(serviceDir, { mode: 0o700, recursive: true });
    const content = renderWindowsServiceCommand({
      instanceId,
      lifecycle,
      nodePath,
      repoPath,
    });
    fs.writeFileSync(wrapperPath, content, { mode: 0o600 });
    fs.chmodSync(wrapperPath, 0o600);
    fs.writeFileSync(log, '', { mode: 0o600, flag: 'a' });
    fs.chmodSync(log, 0o600);
    hardenPaths(run, [
      { kind: 'file', path: wrapperPath },
      { kind: 'file', path: log },
    ]);
    // This is immediately before registration: the scheduler must never be
    // handed a wrapper or command path whose ACL changed after preparation.
    assertWindowsServiceExecutionTrusted(
      { nodePath, repoPath, unitPath: wrapperPath },
      lifecycle,
      run,
    );
    requireSuccess(
      'schtasks create',
      run(windowsSystemUtilityPath('schtasks'), [
        '/Create',
        '/TN',
        taskName,
        '/TR',
        renderWindowsTaskInvocation(wrapperPath),
        '/SC',
        'ONLOGON',
        '/RL',
        'LIMITED',
        '/RU',
        currentWindowsIdentity(run).account,
        '/F',
      ]),
    );
    setWindowsTaskPriority(registration, run);
    // Task registration can take long enough for a writable command path to
    // change. Recheck the full control/execution boundary immediately before
    // asking Task Scheduler to execute the wrapper.
    assertWindowsServiceExecutionTrusted(
      {
        nodePath,
        repoPath,
        unitPath: wrapperPath,
      },
      lifecycle,
      run,
    );
    startWindowsService(registration, {
      fs,
      run,
      sleep: dependencies.sleep,
    });
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new Error(
        `Task Scheduler replacement failed (${(error as Error).message}); rollback failed (${(rollbackError as Error).message})`,
      );
    }
    throw error;
  }
  return {
    host: lifecycle.host ?? '127.0.0.1',
    installedAt: '',
    instanceId,
    nodePath,
    platform: 'win32',
    repoPath,
    serverPort: lifecycle.serverPort,
    taskName,
    uiPort: lifecycle.uiPort,
    unitPath: wrapperPath,
    rollback,
  };
}

export function uninstallWindowsService(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  if (!registration.taskName) {
    throw new Error('Windows service uninstall requires a task name');
  }
  const before = windowsServiceStatus(registration, dependencies);
  if (typeof before.error === 'string') {
    throw new Error(
      `Cannot uninstall Station Task Scheduler service while backend status is unknown: ${before.error}`,
    );
  }
  if (before.present === true) {
    if (before.active === true) {
      requireSuccess(
        'schtasks end',
        dependencies.run(windowsSystemUtilityPath('schtasks'), [
          '/End',
          '/TN',
          registration.taskName,
        ]),
      );
    }
    requireSuccess(
      'schtasks delete',
      dependencies.run(windowsSystemUtilityPath('schtasks'), [
        '/Delete',
        '/TN',
        registration.taskName,
        '/F',
      ]),
    );
  }
  const after = windowsServiceStatus(registration, dependencies);
  if (after.present === true || typeof after.error === 'string') {
    throw new Error(
      `Failed to uninstall Station Task Scheduler service; ${after.error ?? 'task remains registered'}`,
    );
  }
  dependencies.fs.rmSync(registration.unitPath, { force: true });
}

export function startWindowsService(
  registration: ServiceRegistration,
  dependencies: {
    fs: ServiceFs;
    run: CommandRunner;
    sleep?: (milliseconds: number) => void;
  },
): void {
  const before = windowsServiceStatus(registration, dependencies);
  if (
    !registration.taskName ||
    before.present !== true ||
    typeof before.error === 'string'
  ) {
    throw new Error(
      `Cannot start Station Task Scheduler service while backend status is unknown: ${before.error ?? 'task is absent'}`,
    );
  }
  requireSuccess(
    'schtasks run',
    dependencies.run(windowsSystemUtilityPath('schtasks'), [
      '/Run',
      '/TN',
      registration.taskName,
    ]),
  );
  waitForWindowsRunning(registration, dependencies);
}

export function stopWindowsService(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): void {
  const before = windowsServiceStatus(registration, dependencies);
  if (!registration.taskName || typeof before.error === 'string') {
    throw new Error(
      `Cannot stop Station Task Scheduler service while backend status is unknown: ${before.error ?? 'task name is missing'}`,
    );
  }
  if (before.active !== true) return;
  requireSuccess(
    'schtasks end',
    dependencies.run(windowsSystemUtilityPath('schtasks'), [
      '/End',
      '/TN',
      registration.taskName,
    ]),
  );
}
