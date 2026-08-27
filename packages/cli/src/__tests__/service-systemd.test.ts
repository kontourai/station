import * as fs from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { inspectServiceSchedulingPolicy } from '../commands/service-scheduling.js';
import {
  installSystemd,
  renderSystemdUnit,
  startSystemd,
  stopSystemd,
  systemdStatus,
  uninstallSystemd,
} from '../commands/service-systemd.js';

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(() => {
  process.env.HOME = originalHome;
});

const lifecycle = (baseDir: string) => ({
  baseDir,
  homeSource: '--base' as const,
  host: '127.0.0.1',
  instanceName: 'agent',
  serverPort: 3242,
  uiPort: 5274,
});

describe('systemd service backend', () => {
  test('installs a first-time not-found unit and renders a systemd-safe working directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const logDir = join(root, '.station', 'logs');
    mkdirSync(logDir, { recursive: true, mode: 0o777 });
    chmodSync(logDir, 0o777);
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn((command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('is-active'))
        return { status: 4, stdout: 'not-found\n' };
      if (args.includes('is-enabled'))
        return { status: 4, stdout: 'not-found\n' };
      return { status: 0, stdout: '' };
    });

    const manifest = installSystemd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/opt/node24/bin/node',
      repoPath: '/opt/station',
      run,
      servicePath: '/opt/node24/bin:/usr/bin:/bin',
    });
    const unit = readFileSync(manifest.unitPath, 'utf8');

    expect(manifest.unitName).toBe('station-agent.service');
    expect(manifest.unitName).not.toContain('dogfood');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('TimeoutStopSec=30');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('PrivateTmp=true');
    expect(unit).toContain('Environment=STATION_SERVICE_MANAGED=1');
    const assignments = unit
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=', 1)[0]);
    const schedulingDirectives = [
      'Nice',
      'CPUWeight',
      'StartupCPUWeight',
      'CPUQuota',
      'CPUQuotaPeriodSec',
      'CPUAffinity',
      'CPUSchedulingPolicy',
      'CPUSchedulingPriority',
      'CPUSchedulingResetOnFork',
      'IOSchedulingClass',
      'IOSchedulingPriority',
      'IOWeight',
      'StartupIOWeight',
      'Slice',
    ];
    expect(
      assignments.filter((assignment) =>
        schedulingDirectives.includes(assignment),
      ),
    ).toEqual([]);
    expect(unit).toContain('WorkingDirectory=/opt/station');
    expect(unit).not.toContain('WorkingDirectory="/opt/station"');
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(calls.map(([command, args]) => [command, ...args])).toEqual([
      ['systemctl', '--user', 'show-environment'],
      [
        'loginctl',
        'show-user',
        expect.stringMatching(/^\d+$/),
        '-p',
        'Linger',
        '--value',
      ],
      ['systemctl', '--user', 'is-active', 'station-agent.service'],
      ['systemctl', '--user', 'is-enabled', 'station-agent.service'],
      [
        'loginctl',
        'show-user',
        expect.stringMatching(/^\d+$/),
        '-p',
        'Linger',
        '--value',
      ],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'station-agent.service'],
    ]);
  });

  test('fails with guidance when no user manager exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run: () => ({ status: 1 }),
        servicePath: '/usr/bin',
      }),
    ).toThrow('systemd user manager is unavailable');
  });

  test('enables and verifies linger before installing, then reports all layers', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    let lingerChecks = 0;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'systemctl' && args.includes('is-active'))
        return { status: 3, stdout: 'inactive\n' };
      if (command === 'systemctl' && args.includes('is-enabled'))
        return { status: 1, stdout: 'disabled\n' };
      if (command !== 'loginctl') return { status: 0, stdout: '' };
      if (args[0] === 'enable-linger') return { status: 0, stdout: '' };
      lingerChecks += 1;
      return { status: 0, stdout: lingerChecks === 1 ? 'no\n' : 'yes\n' };
    });
    installSystemd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/node',
      repoPath: '/repo',
      run,
      servicePath: '/usr/bin',
    });
    expect(run).toHaveBeenCalledWith('loginctl', [
      'enable-linger',
      expect.stringMatching(/^\d+$/),
    ]);

    const status = systemdStatus(
      {
        platform: 'linux',
        unitName: 'station-agent.service',
        unitPath: '/unit',
      },
      {
        fs,
        run: (command, args) => {
          if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
          if (args.includes('is-active'))
            return { status: 0, stdout: 'active\n' };
          return { status: 0, stdout: 'enabled\n' };
        },
      },
    );
    expect(status).toMatchObject({ active: true, enabled: true, linger: true });
  });

  test('fails clearly when linger cannot be established', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run: (command, args) => {
          if (command === 'systemctl' && args.includes('is-active'))
            return { status: 3, stdout: 'inactive\n' };
          if (command === 'systemctl' && args.includes('is-enabled'))
            return { status: 1, stdout: 'disabled\n' };
          if (command === 'systemctl') return { status: 0 };
          if (args[0] === 'enable-linger') {
            return { status: 1, stderr: 'permission denied' };
          }
          return { status: 0, stdout: 'no\n' };
        },
        servicePath: '/usr/bin',
      }),
    ).toThrow('loginctl enable-linger');
  });

  test('uninstall is repeatable', () => {
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('is-active'))
        return { status: 3, stdout: 'inactive\n' };
      if (args.includes('is-enabled'))
        return { status: 1, stdout: 'disabled\n' };
      return { status: 1 };
    });
    const manifest = {
      host: '127.0.0.1',
      installedAt: '',
      instanceId: 'agent',
      nodePath: '/node',
      platform: 'linux' as const,
      repoPath: '/repo',
      serverPort: 1,
      uiPort: 2,
      unitName: 'station-agent.service',
      unitPath: join(tmpdir(), 'absent-station-agent.service'),
    };
    expect(() => uninstallSystemd(manifest, { fs, run })).not.toThrow();
    expect(() => uninstallSystemd(manifest, { fs, run })).not.toThrow();
  });

  test('propagates disable failures and reports what remains', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    const unitPath = join(root, 'station-agent.service');
    fs.writeFileSync(unitPath, '[Unit]\n');
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('disable')) {
        return { status: 1, stderr: 'access denied' };
      }
      if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
      if (args.includes('is-enabled'))
        return { status: 0, stdout: 'enabled\n' };
      return { status: 0 };
    });
    expect(() =>
      uninstallSystemd(
        {
          platform: 'linux',
          unitName: 'station-agent.service',
          unitPath,
        },
        { fs, run },
      ),
    ).toThrow(/disable --now failed.*unit remains/u);
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  test('restores a running enabled prior unit when replacement activation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      '.config',
      'systemd',
      'user',
      'station-agent.service',
    );
    const priorUnit = '[Service]\nExecStart=/prior\n';
    mkdirSync(dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, priorUnit);
    let active = true;
    let enabled = true;
    let replacementEnableAttempted = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('show-environment')) return { status: 0 };
      if (args.includes('is-active'))
        return {
          status: active ? 0 : 3,
          stdout: active ? 'active\n' : 'inactive\n',
        };
      if (args.includes('is-enabled'))
        return {
          status: enabled ? 0 : 1,
          stdout: enabled ? 'enabled\n' : 'disabled\n',
        };
      if (args.includes('disable')) {
        active = false;
        enabled = false;
        return { status: 0 };
      }
      if (args.includes('stop')) {
        active = false;
        return { status: 0 };
      }
      if (args.includes('enable') && args.includes('--now')) {
        replacementEnableAttempted = true;
        return { status: 1, stderr: 'replacement rejected' };
      }
      if (args.includes('enable')) {
        enabled = true;
        return { status: 0 };
      }
      if (args.includes('restart')) {
        active = true;
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow('systemctl --user enable --now failed: replacement rejected');
    expect(replacementEnableAttempted).toBe(true);
    expect(readFileSync(unitPath, 'utf8')).toBe(priorUnit);
    expect({ active, enabled }).toEqual({ active: true, enabled: true });
    const stopIndex = run.mock.calls.findIndex(([, args]) =>
      args.includes('stop'),
    );
    const replacementIndex = run.mock.calls.findIndex(
      ([, args]) => args.includes('enable') && args.includes('--now'),
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThanOrEqual(0);
    expect(run.mock.invocationCallOrder[stopIndex]).toBeLessThan(
      run.mock.invocationCallOrder[replacementIndex],
    );
  });

  test('replaces a running enabled prior unit successfully', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      '.config',
      'systemd',
      'user',
      'station-agent.service',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '[Service]\nExecStart=/prior\n');
    let active = true;
    let enabled = true;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('show-environment')) return { status: 0 };
      if (args.includes('is-active')) {
        return {
          status: active ? 0 : 3,
          stdout: active ? 'active\n' : 'inactive\n',
        };
      }
      if (args.includes('is-enabled')) {
        return {
          status: enabled ? 0 : 1,
          stdout: enabled ? 'enabled\n' : 'disabled\n',
        };
      }
      if (args.includes('stop')) {
        active = false;
        return { status: 0 };
      }
      if (args.includes('enable') && args.includes('--now')) {
        active = true;
        enabled = true;
        return { status: 0 };
      }
      return { status: 0 };
    });

    const manifest = installSystemd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/node',
      repoPath: '/repo',
      run,
      servicePath: '/usr/bin',
    });

    expect(manifest.unitPath).toBe(unitPath);
    expect(readFileSync(unitPath, 'utf8')).toContain('WorkingDirectory=/repo');
    expect({ active, enabled }).toEqual({ active: true, enabled: true });
    expect(run).toHaveBeenCalledWith('systemctl', [
      '--user',
      'stop',
      'station-agent.service',
    ]);
    expect(run).toHaveBeenCalledWith('systemctl', [
      '--user',
      'enable',
      '--now',
      'station-agent.service',
    ]);
  });

  test('refuses replacement before touching a prior unit when systemd state is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      '.config',
      'systemd',
      'user',
      'station-agent.service',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    const priorUnit = '[Service]\nExecStart=/prior\n';
    fs.writeFileSync(unitPath, priorUnit);
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('show-environment')) return { status: 0 };
      if (args.includes('is-active'))
        return { status: 4, stderr: 'access denied' };
      if (args.includes('is-enabled'))
        return { status: 1, stdout: 'disabled\n' };
      return { status: 0 };
    });

    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow('Cannot snapshot Station systemd service before replacement');
    expect(readFileSync(unitPath, 'utf8')).toBe(priorUnit);
    expect(
      run.mock.calls.some(([, args]) => args.includes('daemon-reload')),
    ).toBe(false);
  });

  test('fails closed for ambiguous status-4 service state', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      '.config',
      'systemd',
      'user',
      'station-agent.service',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    const priorUnit = '[Service]\nExecStart=/prior\n';
    fs.writeFileSync(unitPath, priorUnit);
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('show-environment')) return { status: 0 };
      if (args.includes('is-active'))
        return { status: 4, stderr: 'Failed to connect to bus' };
      if (args.includes('is-enabled'))
        return { status: 1, stdout: 'disabled\n' };
      return { status: 0 };
    });

    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow(
      /Cannot snapshot Station systemd service before replacement.*exited 4/u,
    );
    expect(readFileSync(unitPath, 'utf8')).toBe(priorUnit);
    expect(run).not.toHaveBeenCalledWith('systemctl', [
      '--user',
      'daemon-reload',
    ]);
  });

  test('treats command execution failures as unknown and refuses uninstall', () => {
    const registration = {
      platform: 'linux' as const,
      unitName: 'station-agent.service',
      unitPath: join(tmpdir(), 'absent-station-agent.service'),
    };
    const run = vi.fn(() => ({
      error: new Error('backend unavailable'),
      status: null,
    }));

    expect(systemdStatus(registration, { fs, run })).toMatchObject({
      active: null,
      enabled: null,
      error: expect.stringContaining('backend unavailable'),
      linger: null,
    });
    expect(() => uninstallSystemd(registration, { fs, run })).toThrow(
      /status is unknown.*backend unavailable/u,
    );
  });

  test.each([
    ['active', 'is-active'],
    ['enabled', 'is-enabled'],
  ])(
    'treats not-found with stderr from the %s probe as unknown',
    (_probe, commandName) => {
      const registration = {
        platform: 'linux' as const,
        unitName: 'station-agent.service',
        unitPath: join(tmpdir(), 'absent-station-agent.service'),
      };
      const status = systemdStatus(registration, {
        fs,
        run: (command, args) => {
          if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
          if (args.includes(commandName)) {
            return {
              status: 4,
              stderr: 'Failed to connect to bus',
              stdout: 'not-found\n',
            };
          }
          return args.includes('is-active')
            ? { status: 3, stdout: 'inactive\n' }
            : { status: 1, stdout: 'disabled\n' };
        },
      });

      expect(status).toMatchObject({
        active: commandName === 'is-active' ? null : false,
        enabled: commandName === 'is-enabled' ? null : false,
        error: expect.stringContaining(`systemctl ${commandName} exited 4`),
      });
    },
  );

  test('treats contradictory active and enabled probes as unknown', () => {
    const registration = {
      platform: 'linux' as const,
      unitName: 'station-agent.service',
      unitPath: join(tmpdir(), 'absent-station-agent.service'),
    };
    const status = systemdStatus(registration, {
      fs,
      run: (command, args) => {
        if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
        if (args.includes('is-active')) {
          return { status: 4, stdout: 'not-found\n' };
        }
        return { status: 1, stdout: 'disabled\n' };
      },
    });

    expect(status).toMatchObject({
      active: null,
      enabled: null,
      error: expect.stringContaining('disagree about whether the unit exists'),
    });
  });

  test('refuses a contradictory first-install probe before writing a unit', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-test-'));
    process.env.HOME = root;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('show-environment')) return { status: 0 };
      if (args.includes('is-active'))
        return { status: 4, stdout: 'not-found\n' };
      if (args.includes('is-enabled'))
        return { status: 1, stdout: 'disabled\n' };
      return { status: 0 };
    });

    expect(() =>
      installSystemd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow(
      /Cannot snapshot Station systemd service before replacement.*disagree/u,
    );
    expect(run).not.toHaveBeenCalledWith('systemctl', [
      '--user',
      'daemon-reload',
    ]);
  });

  test('emits raw spaces in WorkingDirectory without quoting the path', () => {
    const unit = renderSystemdUnit({
      instanceId: 'agent',
      lifecycle: lifecycle('/tmp/station home'),
      nodePath: '/node path/node',
      repoPath: '/repo path',
      servicePath: '/usr/bin',
    });
    expect(unit).toContain('WorkingDirectory=/repo path');
    expect(unit).not.toContain('WorkingDirectory=/repo\\x20path');
    expect(unit).not.toContain('WorkingDirectory="/repo path"');
    expect(unit).toContain('ExecStart="/node path/node"');
  });

  test.each([
    ['relative', 'repo'],
    ['percent specifier', '/repo%I'],
    ['control character', '/repo\npath'],
    ['trailing backslash', '/repo\\'],
    ['trailing space', '/repo '],
  ])('rejects invalid WorkingDirectory %s values', (_label, repoPath) => {
    expect(() =>
      renderSystemdUnit({
        instanceId: 'agent',
        lifecycle: lifecycle('/tmp/station'),
        nodePath: '/node',
        repoPath,
        servicePath: '/usr/bin',
      }),
    ).toThrow(/WorkingDirectory/u);
  });

  test.each([
    ['base', { baseDir: '/tmp/station\nhijack' }],
    ['host', { host: '127.0.0.1%I' }],
    ['features', { features: 'voice\u0007' }],
  ])('rejects unsafe %s values', (_label, override) => {
    expect(() =>
      renderSystemdUnit({
        instanceId: 'agent',
        lifecycle: { ...lifecycle('/tmp/station'), ...override },
        nodePath: '/node',
        repoPath: '/repo',
        servicePath: '/usr/bin',
      }),
    ).toThrow('control characters or % specifiers');
  });

  test('reports a scheduling drop-in as an operator override, not Station drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-scheduling-'));
    const unitPath = join(root, 'station-agent.service');
    const overridePath = '/etc/systemd/user/station-.service.d/priority.conf';
    const run = vi.fn(() => ({
      status: 0,
      stdout: `# ${unitPath}\n[Service]\nExecStart=/station\n# ${overridePath}\n[Service]\nNice=10\n`,
    }));

    expect(
      inspectServiceSchedulingPolicy({ platform: 'linux', unitPath }, { run }),
    ).toEqual({
      expected: 'systemd defaults',
      observed: `Nice=10 (from ${overridePath})`,
      status: 'operator-override',
    });
    expect(run).toHaveBeenCalledWith('systemctl', [
      '--user',
      'cat',
      'station-agent.service',
    ]);
  });

  test.each([
    ['empty query', ''],
    [
      'malformed systemctl output',
      '# /tmp/station-agent.service\nthis is not a unit\n',
    ],
  ])('reports a %s as unknown scheduling policy', (_description, output) => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-scheduling-'));
    const unitPath = join(root, 'station-agent.service');

    expect(
      inspectServiceSchedulingPolicy(
        { platform: 'linux', unitPath },
        { run: vi.fn(() => ({ status: 0, stdout: output })) },
      ),
    ).toMatchObject({ expected: 'systemd defaults', status: 'unknown' });
  });

  test('reports a clean main unit without drop-ins as current', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-scheduling-'));
    const unitPath = join(root, 'station-agent.service');

    expect(
      inspectServiceSchedulingPolicy(
        { platform: 'linux', unitPath },
        {
          run: vi.fn(() => ({
            status: 0,
            stdout: `# ${unitPath}\n[Unit]\nDescription=Station\n[Service]\nExecStart=/station\n`,
          })),
        },
      ),
    ).toEqual({
      expected: 'systemd defaults',
      observed: 'systemd defaults',
      status: 'current',
    });
  });

  test('reads systemd-selected hierarchy drop-ins and multiline directives', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-systemd-scheduling-'));
    const unitPath = join(root, 'station-agent.service');
    const overridePath = '/etc/systemd/user/service.d/priority.conf';

    expect(
      inspectServiceSchedulingPolicy(
        { platform: 'linux', unitPath },
        {
          run: vi.fn(() => ({
            status: 0,
            stdout: [
              `# ${unitPath}`,
              '[Service]',
              'ExecStart=/station \\',
              '  service run',
              `# ${overridePath}`,
              '[Service]',
              'Nice=10',
              '',
            ].join('\n'),
          })),
        },
      ),
    ).toEqual({
      expected: 'systemd defaults',
      observed: `Nice=10 (from ${overridePath})`,
      status: 'operator-override',
    });
  });

  test('starts and stops a known user unit without acting on an inactive stop', () => {
    const registration = {
      platform: 'linux' as const,
      unitName: 'station-agent.service',
      unitPath: join(tmpdir(), 'station-agent.service'),
    };
    const active = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
      return { status: 0, stdout: 'enabled\n' };
    });
    startSystemd(registration, { fs, run: active });
    stopSystemd(registration, { fs, run: active });
    expect(active).toHaveBeenCalledWith('systemctl', [
      '--user',
      'start',
      'station-agent.service',
    ]);
    expect(active).toHaveBeenCalledWith('systemctl', [
      '--user',
      'stop',
      'station-agent.service',
    ]);

    const inactive = vi.fn((command: string, args: string[]) => {
      if (command === 'loginctl') return { status: 0, stdout: 'yes\n' };
      if (args.includes('is-active'))
        return { status: 3, stdout: 'inactive\n' };
      return { status: 0, stdout: 'enabled\n' };
    });
    stopSystemd(registration, { fs, run: inactive });
    expect(inactive).not.toHaveBeenCalledWith('systemctl', [
      '--user',
      'stop',
      'station-agent.service',
    ]);
  });
});
