import * as nodeFs from 'node:fs';
import { win32 } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ServiceFs } from '../commands/service.js';
import { inspectServiceSchedulingPolicy } from '../commands/service-scheduling.js';
import {
  installWindowsService,
  quoteWindowsArgument,
  renderWindowsServiceCommand,
  startWindowsService,
  stopWindowsService,
  uninstallWindowsService,
  windowsRegistration,
  windowsServiceStatus,
} from '../commands/service-windows.js';

const lifecycle = (baseDir: string) => ({
  baseDir,
  homeSource: '--base' as const,
  host: '127.0.0.1',
  instanceName: 'agent',
  serverPort: 3242,
  uiPort: 5274,
});

function windowsFs(): ServiceFs {
  const translate = (path: nodeFs.PathLike) =>
    String(path).replace(/^\\/u, '/').replaceAll('\\', '/');
  return {
    ...nodeFs,
    chmodSync: (path: nodeFs.PathLike, mode: string | number) =>
      nodeFs.chmodSync(translate(path), mode),
    existsSync: (path: nodeFs.PathLike) => nodeFs.existsSync(translate(path)),
    lstatSync: (path: nodeFs.PathLike) => nodeFs.lstatSync(translate(path)),
    mkdirSync: (
      path: nodeFs.PathLike,
      options?: Parameters<typeof nodeFs.mkdirSync>[1],
    ) => nodeFs.mkdirSync(translate(path), options),
    // A pass-through double: forward whatever options the code under test
    // gave, without narrowing them to one of readFileSync's overloads.
    readFileSync: (path: nodeFs.PathLike, options?: unknown) =>
      (
        nodeFs.readFileSync as (
          path: nodeFs.PathLike,
          options?: unknown,
        ) => string | Buffer
      )(translate(path), options),
    realpathSync: (path: nodeFs.PathLike) =>
      nodeFs.realpathSync(translate(path)),
    renameSync: (oldPath: nodeFs.PathLike, newPath: nodeFs.PathLike) =>
      nodeFs.renameSync(translate(oldPath), translate(newPath)),
    rmSync: (path: nodeFs.PathLike, options?: nodeFs.RmDirOptions) =>
      nodeFs.rmSync(translate(path), options),
    writeFileSync: (
      path: nodeFs.PathLike,
      data: string | Uint8Array,
      options?: nodeFs.WriteFileOptions,
    ) => nodeFs.writeFileSync(translate(path), data, options),
  } as unknown as ServiceFs;
}

const WINDOWS_ACCOUNT = 'DESKTOP-WIN\\casey';
const WINDOWS_SID = 'S-1-5-21-1000';

function whoamiIdentity() {
  return { status: 0, stdout: `"${WINDOWS_ACCOUNT}","${WINDOWS_SID}"\n` };
}

function isWindowsUtility(command: string, utility: string): boolean {
  return command.toLowerCase().endsWith(`\\${utility}.exe`);
}

function taskXml(wrapperPath: string, user = WINDOWS_SID): string {
  return `<Task><Principals><Principal><UserId>${user}</UserId></Principal></Principals><Actions><Exec><Command>C:\\Windows\\System32\\cmd.exe</Command><Arguments>/d /c &quot;${wrapperPath}&quot;</Arguments></Exec></Actions></Task>`;
}

function powerShellProgram(args: string[]): string {
  return Buffer.from(args[3] ?? '', 'base64').toString('utf16le');
}

// Pinned independently of the constants under test (#2970): no execution time
// limit, the scheduler's restart settings, and no battery rules.
const EXPECTED_TASK_SETTINGS =
  'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False';

type TaskSettingName =
  | 'Priority'
  | 'ExecutionTimeLimit'
  | 'RestartCount'
  | 'RestartInterval'
  | 'DisallowStartIfOnBatteries'
  | 'StopIfGoingOnBatteries';
type TaskSettings = Record<TaskSettingName, string>;

/** What `schtasks /Create` leaves without settings XML. */
function schtasksDefaultSettings(): TaskSettings {
  return {
    Priority: '7',
    ExecutionTimeLimit: 'PT72H',
    RestartCount: '0',
    RestartInterval: '',
    DisallowStartIfOnBatteries: 'True',
    StopIfGoingOnBatteries: 'True',
  };
}

function formatTaskSettings(settings: TaskSettings): string {
  return `Priority=${settings.Priority}, ExecutionTimeLimit=${settings.ExecutionTimeLimit}, RestartCount=${settings.RestartCount}, RestartInterval=${settings.RestartInterval}, DisallowStartIfOnBatteries=${settings.DisallowStartIfOnBatteries}, StopIfGoingOnBatteries=${settings.StopIfGoingOnBatteries}`;
}

/**
 * Models the encoded settings program against a persisted task: each
 * `$task.Settings.<name> = <value>` assignment persists unless `ignored` names
 * it (a scheduler that accepted the call but kept its value), and the
 * program's own read-back comparison, if it has one, decides the exit status.
 * Returns null for any other PowerShell program.
 */
function runTaskSettingsProgram(
  program: string,
  settings: TaskSettings,
  ignored: ReadonlySet<string> = new Set(),
): { status: number; stderr?: string } | null {
  if (!program.includes('Set-ScheduledTask -InputObject $task')) return null;
  for (const match of program.matchAll(
    /\$task\.Settings\.(\w+) = '?([^';]*)'?/gu,
  )) {
    const [, name, raw] = match;
    // PowerShell prints a boolean as True or False.
    const value = raw === '$false' ? 'False' : raw === '$true' ? 'True' : raw;
    if (name in settings && !ignored.has(name)) {
      settings[name as TaskSettingName] = value;
    }
  }
  const expected = program.match(/\$observed -ne '([^']*)'/u)?.[1];
  const observed = formatTaskSettings(settings);
  if (expected !== undefined && observed !== expected) {
    return {
      status: 1,
      stderr: `Station Task Scheduler settings did not persist: ${observed}`,
    };
  }
  return { status: 0 };
}

describe('Windows Task Scheduler service backend', () => {
  test('quotes task arguments without shell interpolation', () => {
    expect(quoteWindowsArgument('C:\\Program Files\\Station\\node.exe')).toBe(
      '"C:\\Program Files\\Station\\node.exe"',
    );
    expect(quoteWindowsArgument('a"b\\')).toBe('"a\\"b\\\\"');
    expect(() => quoteWindowsArgument('bad\nvalue')).toThrow(
      'control characters',
    );
  });

  test('runs the service from its checkout instead of the scheduler directory', () => {
    const command = renderWindowsServiceCommand({
      instanceId: 'agent',
      lifecycle: lifecycle('C:\\Station Data'),
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      repoPath: 'C:\\dev\\Station Checkout',
    });
    expect(command).toContain('cd /d "C:\\dev\\Station Checkout" || exit /b 1');
    expect(command.indexOf('cd /d')).toBeLessThan(command.indexOf('node.exe'));
  });

  test.each(['C:\\%TEMP%\\station', 'C:\\bad"root', 'C:\\bad\nroot'])(
    'rejects an unsafe Station root before rendering a wrapper: %s',
    (stationRoot) => {
      expect(() =>
        renderWindowsServiceCommand({
          instanceId: 'agent',
          lifecycle: { ...lifecycle('C:\\Station Data'), stationRoot },
          nodePath: 'C:\\node.exe',
          repoPath: 'C:\\repo',
        }),
      ).toThrow(/unsafe Windows command value/);
    },
  );

  test('renders a safe Station root containing spaces literally', () => {
    expect(
      renderWindowsServiceCommand({
        instanceId: 'agent',
        lifecycle: {
          ...lifecycle('C:\\Station Data'),
          stationRoot: 'C:\\Users\\Me\\Station Root',
        },
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\repo',
      }),
    ).toContain('set "STATION_ROOT=C:\\Users\\Me\\Station Root"');
  });

  test.each([
    ['PowerShell exits non-zero', { status: 1, stderr: 'task query failed' }],
    ['PowerShell emits only the priority', { status: 0, stdout: 'Priority=5' }],
    [
      'PowerShell emits a non-numeric priority',
      {
        status: 0,
        stdout: EXPECTED_TASK_SETTINGS.replace('Priority=5', 'Priority=5.5'),
      },
    ],
  ])('reports %s as unknown, never current', (_description, result) => {
    const registration = windowsRegistration(
      'agent',
      lifecycle('C:\\Station Data'),
    );

    expect(
      inspectServiceSchedulingPolicy(registration, {
        run: vi.fn(() => result),
      }),
    ).toMatchObject({ expected: EXPECTED_TASK_SETTINGS, status: 'unknown' });
  });

  test('a registration missing its task name reports unknown, never current', () => {
    // A fault injection making this branch claim `current` passed the suite:
    // the two query-failure branches were covered, this precondition was not.
    const registration = {
      ...windowsRegistration('agent', lifecycle('C:\\Station Data')),
      taskName: undefined,
    };
    const run = vi.fn();

    expect(inspectServiceSchedulingPolicy(registration, { run })).toMatchObject(
      { expected: EXPECTED_TASK_SETTINGS, status: 'unknown' },
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each<[string, Partial<TaskSettings>]>([
    ['schtasks defaults', {}],
    ['the default 72-hour limit', { ExecutionTimeLimit: 'PT72H' }],
    ['no restart on failure', { RestartCount: '0', RestartInterval: '' }],
    ['a restart count of 3', { RestartCount: '3' }],
    ['the background priority', { Priority: '7' }],
    ['no start on battery', { DisallowStartIfOnBatteries: 'True' }],
    ['a stop when unplugged', { StopIfGoingOnBatteries: 'True' }],
  ])('reports a task with %s as stale scheduling', (_name, drift) => {
    const registration = windowsRegistration(
      'agent',
      lifecycle('C:\\Station Data'),
    );
    const persisted: TaskSettings =
      Object.keys(drift).length === 0
        ? schtasksDefaultSettings()
        : {
            Priority: '5',
            ExecutionTimeLimit: 'PT0S',
            RestartCount: '255',
            RestartInterval: 'PT1M',
            DisallowStartIfOnBatteries: 'False',
            StopIfGoingOnBatteries: 'False',
            ...drift,
          };
    const run = vi.fn((_command: string, args: string[]) => {
      // The probe only reads: it must never change the task it reports on.
      expect(powerShellProgram(args)).not.toContain('Set-ScheduledTask');
      return { status: 0, stdout: `${formatTaskSettings(persisted)}\r\n` };
    });
    expect(inspectServiceSchedulingPolicy(registration, { run })).toEqual({
      expected: EXPECTED_TASK_SETTINGS,
      observed: formatTaskSettings(persisted),
      status: 'stale',
    });
  });

  test('reads every persisted task setting as current scheduling', () => {
    const registration = windowsRegistration(
      'agent',
      lifecycle('C:\\Station Data'),
    );
    const run = vi.fn(() => ({
      status: 0,
      stdout: `${EXPECTED_TASK_SETTINGS}\r\n`,
    }));
    expect(inspectServiceSchedulingPolicy(registration, { run })).toEqual({
      expected: EXPECTED_TASK_SETTINGS,
      observed: EXPECTED_TASK_SETTINGS,
      status: 'current',
    });
  });

  test('installs a no-admin limited on-logon task and manages its lifecycle', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    let settings = schtasksDefaultSettings();
    let running = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return installed
          ? { status: 0, stdout: taskXml(registration.unitPath) }
          : {
              status: 1,
              stderr: 'ERROR: The system cannot find the file specified.',
            };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        const applied = runTaskSettingsProgram(
          powerShellProgram(args),
          settings,
        );
        if (applied) return applied;
        return {
          status: 0,
          stdout: `${running ? '4' : '3'}\n`,
        };
      }
      if (args[0] === '/Create') {
        // /Create /F registers a new definition with schtasks defaults.
        installed = true;
        settings = schtasksDefaultSettings();
        return { status: 0 };
      }
      if (args[0] === '/Run') {
        running = true;
        return { status: 0 };
      }
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Delete') {
        installed = false;
        return { status: 0 };
      }
      return { status: 0 };
    });

    const manifest = installWindowsService('agent', {
      fs,
      lifecycle: lifecycle(baseDir),
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      repoPath: 'C:\\dev\\station',
      run,
    });
    expect(manifest).toMatchObject({
      platform: 'win32',
      taskName: '\\KontourStation-agent',
    });
    const create = run.mock.calls.find(([, args]) => args[0] === '/Create');
    expect(create?.[1]).toEqual(
      expect.arrayContaining([
        '/SC',
        'ONLOGON',
        '/RL',
        'LIMITED',
        '/RU',
        WINDOWS_ACCOUNT,
      ]),
    );
    expect(create?.[1]).not.toContain('/RP');
    expect(create?.[1]?.join(' ')).not.toContain('sc.exe');
    // The test double starts at the schtasks defaults (priority 7, a 72-hour
    // limit, no restart) and models the values the encoded program persists.
    // A missing write or mismatched read-back fails the install before the
    // task may run.
    expect(formatTaskSettings(settings)).toBe(EXPECTED_TASK_SETTINGS);
    const settingsUpdate =
      run.mock.invocationCallOrder[
        run.mock.calls.findIndex(([, args]) =>
          powerShellProgram(args).includes('Set-ScheduledTask'),
        )
      ];
    const firstRun =
      run.mock.invocationCallOrder[
        run.mock.calls.findIndex(([, args]) => args[0] === '/Run')
      ];
    expect(settingsUpdate).toBeLessThan(firstRun);
    expect(run.mock.calls.some(([, args]) => args[0] === '/Run')).toBe(true);
    expect(
      run.mock.calls.some(
        ([command, args]) =>
          isWindowsUtility(command, 'powershell') &&
          args.includes('-NonInteractive') &&
          args[2] === '-EncodedCommand' &&
          args.length === 4 &&
          !Buffer.from(args[3] ?? '', 'base64')
            .toString('utf16le')
            .includes(registration.taskName ?? ''),
      ),
    ).toBe(true);

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        repoPath: 'C:\\dev\\station',
        run,
      }),
    ).not.toThrow();
    expect(
      run.mock.calls.filter(([, args]) => args[0] === '/Create'),
    ).toHaveLength(2);
    // A reinstall over a task registered with schtasks defaults (as every
    // version before #2970 left it) migrates it to the expected settings.
    expect(formatTaskSettings(settings)).toBe(EXPECTED_TASK_SETTINGS);

    startWindowsService(manifest, { fs, run });
    expect(windowsServiceStatus(manifest, { fs, run })).toMatchObject({
      active: true,
      present: true,
    });
    stopWindowsService(manifest, { fs, run });
    expect(windowsServiceStatus(manifest, { fs, run })).toMatchObject({
      active: false,
      present: true,
    });
    uninstallWindowsService(manifest, { fs, run });
    expect(windowsServiceStatus(manifest, { fs, run })).toMatchObject({
      active: false,
      present: false,
    });
  });

  test('waits boundedly for a newly started task to report Running', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-delayed-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    let running = false;
    let stateChecks = 0;
    const sleep = vi.fn();
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return installed
          ? { status: 0, stdout: taskXml(registration.unitPath) }
          : { status: 1, stderr: 'not found' };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        if (
          Buffer.from(args[3] ?? '', 'base64')
            .toString('utf16le')
            .includes('Set-ScheduledTask -InputObject $task')
        ) {
          return { status: 0 };
        }
        stateChecks += 1;
        return {
          status: 0,
          stdout: `${running && stateChecks >= 4 ? '4' : '3'}\n`,
        };
      }
      if (args[0] === '/Create') {
        installed = true;
        return { status: 0 };
      }
      if (args[0] === '/Run') {
        running = true;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
        sleep,
      }),
    ).not.toThrow();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  test('fails closed after ending an attempted fresh task when post-create status parsing is unknown', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-unknown-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return installed
          ? { status: 0, stdout: taskXml(registration.unitPath) }
          : { status: 1, stderr: 'not found' };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        return { status: 0, stdout: 'unknown-localized\n' };
      }
      if (args[0] === '/Create') {
        installed = true;
        return { status: 0 };
      }
      if (args[0] === '/Delete') {
        installed = false;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('Task Scheduler replacement failed');
    expect(fs.existsSync(registration.unitPath)).toBe(true);
    expect(run.mock.calls.some(([, args]) => args[0] === '/End')).toBe(true);
    expect(run.mock.calls.some(([, args]) => args[0] === '/Delete')).toBe(
      false,
    );
    expect(
      run.mock.calls.filter(
        ([, args]) => args[0] === '/Query' && args.includes('/XML'),
      ),
    ).toHaveLength(3);
  });

  test('refuses replacement before touching a wrapper when task lookup is unknown', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-query-failure-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    fs.mkdirSync(win32.dirname(registration.unitPath), { recursive: true });
    fs.writeFileSync(registration.unitPath, '@echo off\r\necho prior\r\n');
    const run = vi.fn((command: string, args: string[]) => {
      if (args[0] === '/Query' && args.includes('/XML')) {
        return { status: 5, stderr: 'access denied' };
      }
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow(
      'Cannot reinstall Station Task Scheduler service while backend status is unknown',
    );
    expect(fs.readFileSync(registration.unitPath, 'utf8')).toContain('prior');
    expect(run.mock.calls.some(([, args]) => args[0] === '/Create')).toBe(
      false,
    );
  });

  test('refuses to replace or delete a task with a conflicting owner or command', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-conflict-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args.includes('/XML'))
        return {
          status: 0,
          stdout: taskXml(registration.unitPath, 'S-1-5-21-9999'),
        };
      return { status: 0, stdout: 'Status: Ready\n' };
    });
    expect(windowsServiceStatus(registration, { fs, run })).toMatchObject({
      error: expect.stringContaining('identity does not match'),
      present: true,
    });
    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('Cannot reinstall Station Task Scheduler service');
    expect(run.mock.calls.some(([, args]) => args[0] === '/Create')).toBe(
      false,
    );
    expect(() => uninstallWindowsService(registration, { fs, run })).toThrow(
      'Cannot uninstall Station Task Scheduler service',
    );
  });

  test('reports a registered disabled task as disabled', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-disabled-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args.includes('/XML')) {
        return {
          status: 0,
          stdout: taskXml(registration.unitPath).replace(
            '</Task>',
            '<Settings><Enabled>false</Enabled></Settings></Task>',
          ),
        };
      }
      if (isWindowsUtility(command, 'powershell')) {
        return { status: 0, stdout: '1\n' };
      }
      return { status: 0 };
    });

    expect(windowsServiceStatus(registration, { fs, run })).toMatchObject({
      active: false,
      enabled: false,
      error: null,
      present: true,
    });
  });

  test('accepts Windows-canonicalized command and wrapper path casing', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-case-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const canonicalizedXml = taskXml(
      registration.unitPath.toUpperCase(),
    ).replace(
      'C:\\Windows\\System32\\cmd.exe',
      '"C:\\WINDOWS\\SYSTEM32\\CMD.EXE"',
    );
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args.includes('/XML')) return { status: 0, stdout: canonicalizedXml };
      if (isWindowsUtility(command, 'powershell')) {
        return { status: 0, stdout: '3\n' };
      }
      return { status: 0 };
    });

    expect(windowsServiceStatus(registration, { fs, run })).toMatchObject({
      active: false,
      error: null,
      present: true,
    });
  });

  test('rolls back a newly staged wrapper when Task Scheduler registration fails', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-rollback-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query') return { status: 1, stderr: 'not found' };
      if (args[0] === '/Create') return { status: 1, stderr: 'access denied' };
      return { status: 0 };
    });
    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('schtasks create failed: access denied');
    expect(fs.existsSync(registration.unitPath)).toBe(false);
    expect(run.mock.calls.some(([, args]) => args[0] === '/Delete')).toBe(true);
  });

  test('removes a fresh task and wrapper when its settings update is denied', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-priority-denied-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    let running = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return installed
          ? { status: 0, stdout: taskXml(registration.unitPath) }
          : { status: 1, stderr: 'not found' };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        if (
          powerShellProgram(args).includes(
            'Set-ScheduledTask -InputObject $task',
          )
        ) {
          return { status: 1, stderr: 'access denied' };
        }
        return { status: 0, stdout: `${running ? '4' : '3'}\n` };
      }
      if (args[0] === '/Create') {
        installed = true;
        return { status: 0 };
      }
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Delete') {
        installed = false;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('Task Scheduler settings update failed: access denied');
    expect(installed).toBe(false);
    expect(running).toBe(false);
    expect(fs.existsSync(registration.unitPath)).toBe(false);
  });

  test.each<[TaskSettingName, string]>([
    [
      'Priority',
      'Priority=7, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False',
    ],
    [
      'ExecutionTimeLimit',
      'Priority=5, ExecutionTimeLimit=PT72H, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False',
    ],
    [
      'RestartCount',
      'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=0, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False',
    ],
    [
      'RestartInterval',
      'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False',
    ],
    [
      'DisallowStartIfOnBatteries',
      'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=True, StopIfGoingOnBatteries=False',
    ],
    [
      'StopIfGoingOnBatteries',
      'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=True',
    ],
  ])(
    'restores a running replacement when its %s does not persist',
    (ignored, observed) => {
      const fs = windowsFs();
      const baseDir = `\\tmp\\station-win-settings-readback-${ignored}-${process.pid}`;
      const registration = windowsRegistration('agent', lifecycle(baseDir));
      const priorWrapper = '@echo off\r\necho prior\r\n';
      fs.mkdirSync(win32.dirname(registration.unitPath), { recursive: true });
      fs.writeFileSync(registration.unitPath, priorWrapper);
      let installed = true;
      const settings = schtasksDefaultSettings();
      let running = true;
      const run = vi.fn((command: string, args: string[]) => {
        if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
        if (args[0] === '/Query' && args.includes('/XML')) {
          return installed
            ? { status: 0, stdout: taskXml(registration.unitPath) }
            : { status: 1, stderr: 'not found' };
        }
        if (isWindowsUtility(command, 'powershell')) {
          if (args.includes('verify') || args.includes('ensure')) {
            return { status: 0, stdout: '{"trusted":true}' };
          }
          // Model a scheduler that accepted the call but kept one default. The
          // program's own read-back must make this transactional.
          const applied = runTaskSettingsProgram(
            powerShellProgram(args),
            settings,
            new Set([ignored]),
          );
          if (applied) return applied;
          return { status: 0, stdout: `${running ? '4' : '3'}\n` };
        }
        if (args[0] === '/End') {
          running = false;
          return { status: 0 };
        }
        if (args[0] === '/Create' && args.includes('/TR')) {
          Object.assign(settings, schtasksDefaultSettings());
          installed = true;
          return { status: 0 };
        }
        if (args[0] === '/Create' && args.includes('/XML')) {
          installed = true;
          return { status: 0 };
        }
        if (args[0] === '/Run') {
          running = true;
          return { status: 0 };
        }
        return { status: 0 };
      });

      expect(() =>
        installWindowsService('agent', {
          fs,
          lifecycle: lifecycle(baseDir),
          nodePath: 'C:\\node.exe',
          repoPath: 'C:\\station',
          run,
        }),
      ).toThrow(
        `Task Scheduler settings update failed: Station Task Scheduler settings did not persist: ${observed}`,
      );
      expect(installed).toBe(true);
      expect(running).toBe(true);
      expect(fs.readFileSync(registration.unitPath, 'utf8')).toBe(priorWrapper);
      expect(
        run.mock.calls.some(
          ([, args]) => args[0] === '/Create' && args.includes('/XML'),
        ),
      ).toBe(true);
    },
  );

  test('ends a running fresh replacement before deleting its task on rollback', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-fresh-running-rollback-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    let running = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return installed
          ? { status: 0, stdout: taskXml(registration.unitPath) }
          : { status: 1, stderr: 'not found' };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        return { status: 0, stdout: `${running ? '4' : '3'}\n` };
      }
      if (args[0] === '/Create') {
        installed = true;
        return { status: 0 };
      }
      if (args[0] === '/Run') {
        running = true;
        return { status: 0 };
      }
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Delete') {
        installed = false;
        return { status: 0 };
      }
      return { status: 0 };
    });

    const manifest = installWindowsService('agent', {
      fs,
      lifecycle: lifecycle(baseDir),
      nodePath: 'C:\\node.exe',
      repoPath: 'C:\\station',
      run,
    });
    manifest.rollback?.();

    expect(running).toBe(false);
    expect(fs.existsSync(registration.unitPath)).toBe(false);
    const endIndex = run.mock.calls.findIndex(([, args]) => args[0] === '/End');
    const deleteIndex = run.mock.calls.findIndex(
      ([, args]) => args[0] === '/Delete',
    );
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(run.mock.invocationCallOrder[endIndex]).toBeLessThan(
      run.mock.invocationCallOrder[deleteIndex],
    );
  });

  test('restores the prior running task and wrapper when post-stop ACL hardening fails', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-acl-rollback-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const priorWrapper = '@echo off\r\necho prior\r\n';
    fs.mkdirSync(win32.dirname(registration.unitPath), { recursive: true });
    fs.writeFileSync(registration.unitPath, priorWrapper);
    let running = true;
    let hardenCalls = 0;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return { status: 0, stdout: taskXml(registration.unitPath) };
      }
      if (isWindowsUtility(command, 'powershell')) {
        return { status: 0, stdout: `${running ? '4' : '3'}\n` };
      }
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Create' && args.includes('/XML')) return { status: 0 };
      if (args[0] === '/Run') {
        running = true;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        hardenWindowsPaths: () => {
          hardenCalls += 1;
          if (hardenCalls === 1) throw new Error('ACL hardening failed');
        },
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('ACL hardening failed');
    expect(fs.readFileSync(registration.unitPath, 'utf8')).toBe(priorWrapper);
    expect(running).toBe(true);
    expect(hardenCalls).toBe(2);
    expect(
      run.mock.calls.some(
        ([, args]) => args[0] === '/Create' && args.includes('/XML'),
      ),
    ).toBe(true);
  });

  test('restores a running prior task and wrapper when replacement registration fails', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-replace-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const priorWrapper = '@echo off\r\necho prior\r\n';
    fs.mkdirSync(win32.dirname(registration.unitPath), { recursive: true });
    fs.writeFileSync(registration.unitPath, priorWrapper);
    let running = true;
    const run = vi.fn((command: string, args: string[]) => {
      if (isWindowsUtility(command, 'whoami')) return whoamiIdentity();
      if (args[0] === '/Query' && args.includes('/XML')) {
        return { status: 0, stdout: taskXml(registration.unitPath) };
      }
      if (isWindowsUtility(command, 'powershell')) {
        if (args.includes('verify') || args.includes('ensure')) {
          return { status: 0, stdout: '{"trusted":true}' };
        }
        return {
          status: 0,
          stdout: `${running ? '4' : '3'}\n`,
        };
      }
      if (args[0] === '/Create' && args.includes('/TR')) {
        running = false;
        return { status: 1, stderr: 'replacement rejected' };
      }
      if (args[0] === '/Create' && args.includes('/XML')) return { status: 0 };
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Run') {
        running = true;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installWindowsService('agent', {
        fs,
        lifecycle: lifecycle(baseDir),
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\station',
        run,
      }),
    ).toThrow('schtasks create failed: replacement rejected');
    expect(fs.readFileSync(registration.unitPath, 'utf8')).toBe(priorWrapper);
    expect(running).toBe(true);
    expect(
      run.mock.calls.some(
        ([, args]) => args[0] === '/Create' && args.includes('/XML'),
      ),
    ).toBe(true);
    const endIndex = run.mock.calls.findIndex(([, args]) => args[0] === '/End');
    const replacementIndex = run.mock.calls.findIndex(
      ([, args]) => args[0] === '/Create' && args.includes('/TR'),
    );
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThanOrEqual(0);
    expect(run.mock.invocationCallOrder[endIndex]).toBeLessThan(
      run.mock.invocationCallOrder[replacementIndex],
    );
  });
});
