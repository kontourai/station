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
    readFileSync: (
      path: nodeFs.PathLike,
      options?: nodeFs.ObjectEncodingOptions | BufferEncoding | null,
    ) => nodeFs.readFileSync(translate(path), options),
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

const WINDOWS_ACCOUNT = 'DESKTOP-WIN\\brian';
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
          stationRoot: 'C:\\Users\\Brian\\Station Root',
        },
        nodePath: 'C:\\node.exe',
        repoPath: 'C:\\repo',
      }),
    ).toContain('set "STATION_ROOT=C:\\Users\\Brian\\Station Root"');
  });

  test.each([
    ['PowerShell exits non-zero', { status: 1, stderr: 'task query failed' }],
    [
      'PowerShell emits unparseable output',
      { status: 0, stdout: 'Priority=5' },
    ],
    ['PowerShell emits a non-numeric priority', { status: 0, stdout: '5.5' }],
  ])('reports %s as unknown, never current', (_description, result) => {
    const registration = windowsRegistration(
      'agent',
      lifecycle('C:\\Station Data'),
    );

    expect(
      inspectServiceSchedulingPolicy(registration, {
        run: vi.fn(() => result),
      }),
    ).toMatchObject({ expected: 'Priority=5', status: 'unknown' });
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
      { expected: 'Priority=5', status: 'unknown' },
    );
    expect(run).not.toHaveBeenCalled();
  });

  test('reads the persisted task priority for scheduling status', () => {
    const registration = windowsRegistration(
      'agent',
      lifecycle('C:\\Station Data'),
    );
    let priority = 7;
    const run = vi.fn((_command: string, args: string[]) => {
      const program = powerShellProgram(args);
      expect(program).toContain('$task.Settings.Priority');
      return { status: 0, stdout: `${priority}\n` };
    });
    expect(inspectServiceSchedulingPolicy(registration, { run }).status).toBe(
      'stale',
    );
    priority = 5;
    expect(inspectServiceSchedulingPolicy(registration, { run })).toEqual({
      expected: 'Priority=5',
      observed: 'Priority=5',
      status: 'current',
    });
  });

  test('installs a no-admin limited on-logon task and manages its lifecycle', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    let installed = false;
    let priority = 7;
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
        const program = powerShellProgram(args);
        if (program.includes('Set-ScheduledTask -InputObject $task')) {
          const assigned = program.match(
            /\$task\.Settings\.Priority = (\d+)/u,
          )?.[1];
          const expected = program.match(
            /\$updated\.Settings\.Priority -ne (\d+)/u,
          )?.[1];
          if (assigned === undefined || expected === undefined) {
            return { status: 1, stderr: 'priority program is incomplete' };
          }
          priority = Number(assigned);
          return priority === Number(expected)
            ? { status: 0 }
            : { status: 1, stderr: `priority readback was ${priority}` };
        }
        return {
          status: 0,
          stdout: `${running ? '4' : '3'}\n`,
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
    // The test double starts at Task Scheduler's default (7) and models the
    // persisted value read by the encoded program. This is behavior, not a
    // source-text assertion: a missing write or mismatched readback fails the
    // install before the task may run.
    expect(priority).toBe(5);
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

  test('removes a fresh task and wrapper when its priority mutation is denied', () => {
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
    ).toThrow('Task Scheduler priority update failed: access denied');
    expect(installed).toBe(false);
    expect(running).toBe(false);
    expect(fs.existsSync(registration.unitPath)).toBe(false);
  });

  test('restores a running replacement when its priority readback remains 7', () => {
    const fs = windowsFs();
    const baseDir = `\\tmp\\station-win-priority-readback-${process.pid}`;
    const registration = windowsRegistration('agent', lifecycle(baseDir));
    const priorWrapper = '@echo off\r\necho prior\r\n';
    fs.mkdirSync(win32.dirname(registration.unitPath), { recursive: true });
    fs.writeFileSync(registration.unitPath, priorWrapper);
    let installed = true;
    let priority = 7;
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
        if (
          powerShellProgram(args).includes(
            'Set-ScheduledTask -InputObject $task',
          )
        ) {
          // Model a scheduler that accepted the call but kept its default
          // priority. The command's own readback must make this transactional.
          return { status: 1, stderr: `priority readback was ${priority}` };
        }
        return { status: 0, stdout: `${running ? '4' : '3'}\n` };
      }
      if (args[0] === '/End') {
        running = false;
        return { status: 0 };
      }
      if (args[0] === '/Create' && args.includes('/TR')) {
        priority = 7;
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
    ).toThrow('Task Scheduler priority update failed: priority readback was 7');
    expect(priority).toBe(7);
    expect(installed).toBe(true);
    expect(running).toBe(true);
    expect(fs.readFileSync(registration.unitPath, 'utf8')).toBe(priorWrapper);
    expect(
      run.mock.calls.some(
        ([, args]) => args[0] === '/Create' && args.includes('/XML'),
      ),
    ).toBe(true);
  });

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
