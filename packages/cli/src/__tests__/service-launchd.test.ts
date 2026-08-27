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
import type { CommandRunner } from '../commands/service.js';
import {
  installLaunchd,
  launchdStatus,
  renderLaunchdPlist,
  startLaunchd,
  stopLaunchd,
  uninstallLaunchd,
} from '../commands/service-launchd.js';
import { inspectServiceSchedulingPolicy } from '../commands/service-scheduling.js';

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

describe('launchd service backend', () => {
  // A failed or unparseable plutil conversion must never be reported as
  // conformance. Claiming `current` from a policy we could not read is the
  // exact false-health failure this inspection exists to remove.
  test.each([
    ['plutil exits non-zero', { status: 1, stdout: '' }],
    ['plutil emits unparseable output', { status: 0, stdout: 'not json' }],
    ['plutil emits a non-dictionary', { status: 0, stdout: '"a string"' }],
  ])('reports %s as unknown, never current', (_description, result) => {
    const policy = inspectServiceSchedulingPolicy(
      { platform: 'darwin', unitPath: '/tmp/station-agent.plist' },
      { run: vi.fn(() => result) },
    );
    expect(policy.status).toBe('unknown');
    expect(policy.expected).toBe('ProcessType=Interactive');
  });

  test('reads only the top-level ProcessType from plutil JSON', () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        EnvironmentVariables: { ProcessType: 'Interactive' },
        ProcessType: 'Background',
      }),
    }));

    expect(
      inspectServiceSchedulingPolicy(
        {
          platform: 'darwin',
          unitPath: '/tmp/station-agent.plist',
        },
        { run },
      ),
    ).toEqual({
      expected: 'ProcessType=Interactive',
      observed: 'ProcessType=Background',
      status: 'stale',
    });
    expect(run).toHaveBeenCalledWith('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      '/tmp/station-agent.plist',
    ]);
  });

  test('renders the guarded LaunchAgent contract and install argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const logDir = join(root, '.station', 'logs');
    const serviceDir = join(root, '.station', 'service');
    mkdirSync(logDir, { recursive: true, mode: 0o777 });
    mkdirSync(serviceDir, { recursive: true, mode: 0o777 });
    chmodSync(logDir, 0o777);
    chmodSync(serviceDir, 0o777);
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn((command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === 'launchctl' && args[0] === 'print') {
        return { status: 1, stdout: '' };
      }
      return { status: 0, stdout: '' };
    });

    const manifest = installLaunchd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/opt/node24/bin/node',
      repoPath: '/opt/station',
      run,
      servicePath: '/opt/node24/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    });
    const plist = readFileSync(manifest.unitPath, 'utf8');

    expect(manifest.label).toBe('io.kontourai.station.agent');
    expect(manifest.label).not.toContain('station-dogfood');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain(
      '<key>ProcessType</key><string>Interactive</string>',
    );
    expect(plist).not.toContain(
      '<key>ProcessType</key><string>Background</string>',
    );
    expect(plist).toContain('<key>ExitTimeOut</key><integer>600</integer>');
    expect(plist).toContain('<string>/opt/node24/bin/node</string>');
    expect(plist).toContain(
      '<key>STATION_SERVICE_MANAGED</key><string>1</string>',
    );
    expect(plist).not.toContain('::');
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(statSync(serviceDir).mode & 0o777).toBe(0o700);
    expect(calls.map(([command, args]) => [command, ...args])).toEqual([
      ['plutil', '-lint', expect.stringContaining('.plist.tmp')],
      // Every retired generation is probed, newest-first, before the current
      // identity — a machine carrying either old label must be found.
      [
        'launchctl',
        'print',
        expect.stringMatching(
          /^gui\/\d+\/ai\.kontour\.command-station\.agent$/,
        ),
      ],
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/io\.kontourai\.station\.agent$/),
      ],
      [
        'launchctl',
        'bootstrap',
        expect.stringMatching(/^gui\/\d+$/),
        manifest.unitPath,
      ],
      [
        'launchctl',
        'kickstart',
        '-k',
        expect.stringMatching(/^gui\/\d+\/io\.kontourai\.station\.agent$/),
      ],
    ]);
  });

  test('renders persisted allowed origins as repeated --allowed-origin args (#1672)', () => {
    const plist = renderLaunchdPlist({
      instanceId: 'agent',
      label: 'ai.kontour.station.agent',
      lifecycle: {
        ...lifecycle('/home/user/.station'),
        allowedOrigins: [
          'https://kontour.example.ts.net',
          'https://second.example.ts.net',
        ],
      },
      nodePath: '/opt/node24/bin/node',
      repoPath: '/opt/station',
      servicePath: '/opt/node24/bin:/usr/bin:/bin',
    });
    expect(plist).toContain(
      '<string>--allowed-origin=https://kontour.example.ts.net</string>',
    );
    expect(plist).toContain(
      '<string>--allowed-origin=https://second.example.ts.net</string>',
    );
    // No origins → no flag rendered at all.
    expect(
      renderLaunchdPlist({
        instanceId: 'agent',
        label: 'ai.kontour.station.agent',
        lifecycle: lifecycle('/home/user/.station'),
        nodePath: '/opt/node24/bin/node',
        repoPath: '/opt/station',
        servicePath: '/opt/node24/bin:/usr/bin:/bin',
      }),
    ).not.toContain('--allowed-origin');
  });

  test('boots out and replaces a legacy Station label before installing command-station', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const legacyPath = join(
      root,
      'Library',
      'LaunchAgents',
      'ai.kontour.station.agent.plist',
    );
    mkdirSync(dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '<plist><string>legacy</string></plist>');
    let legacyLoaded = true;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'print') {
        return {
          status:
            args[1]?.endsWith('ai.kontour.station.agent') && legacyLoaded
              ? 0
              : 1,
        };
      }
      if (args[0] === 'bootout') legacyLoaded = false;
      return { status: 0 };
    });

    const manifest = installLaunchd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/node',
      repoPath: '/repo',
      run,
      servicePath: '/usr/bin',
    });

    expect(manifest.label).toBe('io.kontourai.station.agent');
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(run).toHaveBeenCalledWith('launchctl', [
      'bootout',
      expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
    ]);
  });

  test('removes a staged plist when plutil lint fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const run = vi.fn(() => ({ status: 1, stderr: 'invalid plist' }));
    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/opt/node24/bin/node',
        repoPath: '/opt/station',
        run,
        servicePath: '/opt/node24/bin:/usr/bin',
      }),
    ).toThrow('plutil -lint failed: invalid plist');
    expect(run).toHaveBeenCalledOnce();
  });

  test('waits for confirmed bootout before reusing a launchd label', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    let legacyPrintCount = 0;
    let ownedInstanceStopped = false;
    const sleep = vi.fn();
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command === 'launchctl' && args[0] === 'print') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) {
          legacyPrintCount += 1;
          return { status: legacyPrintCount < 3 ? 0 : 1 };
        }
        return { status: 1 };
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        expect(ownedInstanceStopped).toBe(true);
      }
      return { status: 0 };
    });
    const stopOwnedInstance = vi.fn(() => {
      ownedInstanceStopped = true;
    });

    installLaunchd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/node',
      repoPath: '/repo',
      run,
      servicePath: '/usr/bin',
      sleep,
      stopOwnedInstance,
    });

    expect(sleep).toHaveBeenCalledWith(100);
    expect(stopOwnedInstance).toHaveBeenCalledOnce();
    expect(run.mock.calls.map(([command, args]) => [command, ...args])).toEqual(
      expect.arrayContaining([
        [
          'launchctl',
          'bootout',
          expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
        ],
      ]),
    );
  });

  test('reports missing launchctl and makes absent status/uninstall safe', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    let call = 0;
    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/opt/node24/bin/node',
        repoPath: '/opt/station',
        run: () =>
          call++ === 0
            ? { status: 0 }
            : { error: new Error('ENOENT'), status: null },
        servicePath: '/usr/bin',
      }),
    ).toThrow('launchctl print failed: ENOENT');
    expect(
      launchdStatus(
        { platform: 'darwin', unitPath: join(root, 'absent.plist') },
        { fs, run: vi.fn() },
      ),
    ).toEqual({ active: null, label: null, present: false });
    expect(() =>
      uninstallLaunchd(
        {
          label: 'ai.kontour.station.agent',
          platform: 'darwin',
          unitPath: join(root, 'absent.plist'),
        },
        { fs, run: vi.fn(() => ({ status: 1 })) },
      ),
    ).not.toThrow();
  });

  test('treats launchctl print exit 113 as an absent user service', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    expect(
      launchdStatus(
        {
          label: 'ai.kontour.station.agent',
          platform: 'darwin',
          unitPath: join(root, 'absent.plist'),
        },
        { fs, run: vi.fn(() => ({ status: 113 })) },
      ),
    ).toMatchObject({ active: false, error: null, present: false });
  });

  test('propagates bootout failures and reports the loaded job and plist', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const unitPath = join(root, 'agent.plist');
    fs.writeFileSync(unitPath, '<plist/>');
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'bootout') {
        return { status: 1, stderr: 'operation not permitted' };
      }
      return { status: 0 };
    });
    expect(() =>
      uninstallLaunchd(
        {
          label: 'ai.kontour.station.agent',
          platform: 'darwin',
          unitPath,
        },
        { fs, run },
      ),
    ).toThrow(/bootout failed.*job remains loaded.*plist remains/u);
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  test('restores a running prior plist when replacement bootstrap fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      'Library',
      'LaunchAgents',
      'io.kontourai.station.agent.plist',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    const priorPlist = '<plist><string>prior</string></plist>';
    fs.writeFileSync(unitPath, priorPlist);
    let loaded = true;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'print') {
        // Only the current identity is loaded here; no retired generation is
        // present, so every legacy probe must report absent.
        return {
          status: args[1]?.includes('io.kontourai.station.agent')
            ? loaded
              ? 0
              : 1
            : 1,
        };
      }
      if (args[0] === 'bootout') {
        loaded = false;
        return { status: 0 };
      }
      if (args[0] === 'bootstrap') {
        if (readFileSync(unitPath, 'utf8') !== priorPlist) {
          return { status: 1, stderr: 'replacement rejected' };
        }
        loaded = true;
      }
      return { status: 0 };
    });

    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow('launchctl bootstrap failed: replacement rejected');
    expect(readFileSync(unitPath, 'utf8')).toBe(priorPlist);
    expect(loaded).toBe(true);
    expect(
      run.mock.calls.filter(
        ([command, args]) => command === 'launchctl' && args[0] === 'bootstrap',
      ),
    ).toHaveLength(2);
  });

  test('restores a booted-out legacy service when the command-station replacement fails (#1983)', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const agentsDir = join(root, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    const legacyUnitPath = join(agentsDir, 'ai.kontour.station.agent.plist');
    const newUnitPath = join(agentsDir, 'io.kontourai.station.agent.plist');
    const legacyBytes = '<plist><string>legacy</string></plist>';
    fs.writeFileSync(legacyUnitPath, legacyBytes);
    let legacyLoaded = true;
    let legacyRebootstrapped = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'print') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) {
          return { status: legacyLoaded ? 0 : 1 };
        }
        // The new command-station label is never active in this scenario.
        return { status: 1 };
      }
      if (args[0] === 'bootout') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) legacyLoaded = false;
        return { status: 0 };
      }
      if (args[0] === 'bootstrap') {
        // The new-label replacement is rejected...
        if (args[2] === newUnitPath) {
          return { status: 1, stderr: 'replacement rejected' };
        }
        // ...and rollback re-bootstraps the restored legacy service.
        if (args[2] === legacyUnitPath) {
          legacyLoaded = true;
          legacyRebootstrapped = true;
          return { status: 0 };
        }
        return { status: 0 };
      }
      return { status: 0 };
    });

    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow('launchctl bootstrap failed: replacement rejected');

    // The previously working legacy service is restored, not left removed.
    expect(fs.existsSync(legacyUnitPath)).toBe(true);
    expect(fs.readFileSync(legacyUnitPath, 'utf8')).toBe(legacyBytes);
    expect(legacyRebootstrapped).toBe(true);
    // The failed command-station plist is not left behind.
    expect(fs.existsSync(newUnitPath)).toBe(false);
  });

  test('boots out and removes the command-station generation, not only the oldest one', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const agentsDir = join(root, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    // The machine sits on the MIDDLE generation: the pre-rename
    // `ai.kontour.station.*` is long gone, `ai.kontour.command-station.*` is
    // what is loaded. Migrating only the oldest label would leave this job
    // running alongside the newly installed one.
    const commandStationUnitPath = join(
      agentsDir,
      'ai.kontour.command-station.agent.plist',
    );
    fs.writeFileSync(
      commandStationUnitPath,
      '<plist><string>command-station</string></plist>',
    );
    const bootedOut: string[] = [];
    let commandStationLoaded = true;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'print') {
        if (args[1]?.endsWith('ai.kontour.command-station.agent')) {
          return { status: commandStationLoaded ? 0 : 1 };
        }
        return { status: 1 };
      }
      if (args[0] === 'bootout') {
        const label = (args[1] ?? '').split('/').pop() ?? '';
        bootedOut.push(label);
        if (label === 'ai.kontour.command-station.agent') {
          commandStationLoaded = false;
        }
        return { status: 0 };
      }
      return { status: 0 };
    });

    const manifest = installLaunchd('agent', {
      fs,
      lifecycle: lifecycle(join(root, '.station')),
      nodePath: '/node',
      repoPath: '/repo',
      run,
      servicePath: '/usr/bin',
    });

    expect(manifest.label).toBe('io.kontourai.station.agent');
    expect(bootedOut).toContain('ai.kontour.command-station.agent');
    // Its plist is removed, so nothing can re-bootstrap the retired job.
    expect(fs.existsSync(commandStationUnitPath)).toBe(false);
    expect(fs.existsSync(manifest.unitPath)).toBe(true);
  });

  test('restores a booted-out legacy service when bootout confirmation fails (#1983)', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const agentsDir = join(root, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    const legacyUnitPath = join(agentsDir, 'ai.kontour.station.agent.plist');
    const legacyBytes = '<plist><string>legacy</string></plist>';
    fs.writeFileSync(legacyUnitPath, legacyBytes);
    let legacyLoaded = true;
    let failBootoutConfirmation = true;
    let legacyRebootstrapped = false;
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'print') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) {
          if (!legacyLoaded && failBootoutConfirmation) {
            failBootoutConfirmation = false;
            return {
              error: new Error('confirmation unavailable'),
              status: null,
            };
          }
          return { status: legacyLoaded ? 0 : 1 };
        }
        return { status: 1 };
      }
      if (args[0] === 'bootout') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) legacyLoaded = false;
        return { status: 0 };
      }
      if (args[0] === 'bootstrap' && args[2] === legacyUnitPath) {
        legacyLoaded = true;
        legacyRebootstrapped = true;
      }
      return { status: 0 };
    });

    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow(
      'Cannot confirm launchd bootout: launchctl print failed: confirmation unavailable',
    );

    expect(fs.readFileSync(legacyUnitPath, 'utf8')).toBe(legacyBytes);
    expect(legacyRebootstrapped).toBe(true);
  });

  test('refuses replacement before touching a plist when launchd prior state is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      'Library',
      'LaunchAgents',
      'ai.kontour.station.agent.plist',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '<plist><string>prior</string></plist>');
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil') return { status: 0 };
      if (command === 'launchctl' && args[0] === 'print') {
        return { status: 5, stderr: 'permission denied' };
      }
      return { status: 0 };
    });

    expect(() =>
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        nodePath: '/node',
        repoPath: '/repo',
        run,
        servicePath: '/usr/bin',
      }),
    ).toThrow('launchctl print exited 5');
    expect(readFileSync(unitPath, 'utf8')).toContain('prior');
    expect(
      run.mock.calls.some(
        ([command, args]) => command === 'launchctl' && args[0] === 'bootout',
      ),
    ).toBe(false);
  });

  test('treats launchctl execution failure as unknown and refuses uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const registration = {
      label: 'ai.kontour.station.agent',
      platform: 'darwin' as const,
      unitPath: join(root, 'agent.plist'),
    };
    const run = vi.fn(() => ({
      error: new Error('backend unavailable'),
      status: null,
    }));

    expect(launchdStatus(registration, { fs, run })).toMatchObject({
      active: null,
      error: expect.stringContaining('backend unavailable'),
    });
    expect(() => uninstallLaunchd(registration, { fs, run })).toThrow(
      /status is unknown.*backend unavailable/u,
    );
  });

  test('escapes plist values', () => {
    expect(
      renderLaunchdPlist({
        instanceId: 'a&b',
        label: 'ai.kontour.station.a&b',
        lifecycle: lifecycle('/tmp/a&b'),
        nodePath: '/node',
        repoPath: '/repo',
        servicePath: '/usr/bin',
      }),
    ).toContain('a&amp;b');
  });

  test('starts inactive agents by bootstrap then kickstart and restarts active agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const registration = {
      label: 'ai.kontour.station.agent',
      platform: 'darwin' as const,
      unitPath: join(root, 'agent.plist'),
    };
    const inactive = vi.fn<CommandRunner>((command, args) => {
      if (command === 'launchctl' && args[0] === 'print') {
        return { status: 1 };
      }
      return { status: 0 };
    });
    startLaunchd(registration, { fs, run: inactive });
    expect(
      inactive.mock.calls.map(([command, args]) => [command, ...args]),
    ).toEqual([
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
      [
        'launchctl',
        'bootstrap',
        expect.stringMatching(/^gui\/\d+$/),
        registration.unitPath,
      ],
      [
        'launchctl',
        'kickstart',
        '-k',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
    ]);

    const active = vi.fn<CommandRunner>(() => ({ status: 0 }));
    startLaunchd(registration, { fs, run: active });
    expect(
      active.mock.calls.map(([command, args]) => [command, ...args]),
    ).toEqual([
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
      [
        'launchctl',
        'kickstart',
        '-k',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
    ]);
  });

  test('stops active agents with bootout and leaves absent agents alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const registration = {
      label: 'ai.kontour.station.agent',
      platform: 'darwin' as const,
      unitPath: join(root, 'agent.plist'),
    };
    let bootedOut = false;
    const active = vi.fn<CommandRunner>((_command, args) => {
      if (args[0] === 'bootout') bootedOut = true;
      return { status: bootedOut && args[0] === 'print' ? 1 : 0 };
    });
    stopLaunchd(registration, { fs, run: active });
    expect(
      active.mock.calls.map(([command, args]) => [command, ...args]),
    ).toEqual([
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
      [
        'launchctl',
        'bootout',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
      [
        'launchctl',
        'print',
        expect.stringMatching(/^gui\/\d+\/ai\.kontour\.station\.agent$/),
      ],
    ]);

    const absent = vi.fn<CommandRunner>(() => ({ status: 1 }));
    stopLaunchd(registration, { fs, run: absent });
    expect(absent).toHaveBeenCalledOnce();
  });

  test('waits beyond the former two-second bound for a draining launchd job', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const registration = {
      label: 'ai.kontour.station.agent',
      platform: 'darwin' as const,
      unitPath: join(root, 'agent.plist'),
    };
    let bootedOut = false;
    let drainPolls = 0;
    let now = 0;
    const progress = vi.fn();
    const run = vi.fn<CommandRunner>((_command, args) => {
      if (args[0] === 'bootout') bootedOut = true;
      if (args[0] === 'print' && bootedOut) {
        drainPolls += 1;
        return { status: drainPolls <= 25 ? 0 : 1 };
      }
      return { status: 0 };
    });

    expect(() =>
      stopLaunchd(registration, {
        fs,
        monotonicNow: () => now,
        reportProgress: progress,
        run,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).not.toThrow();

    expect(drainPolls).toBe(26);
    expect(progress).toHaveBeenCalledWith(
      'waiting for ai.kontour.station.agent to drain (1s)...',
    );
  });

  test('fails honestly when a launchd job remains draining at its deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    const registration = {
      label: 'ai.kontour.station.agent',
      platform: 'darwin' as const,
      unitPath: join(root, 'agent.plist'),
    };
    let now = 0;
    const run = vi.fn<CommandRunner>(() => ({ status: 0 }));

    expect(() =>
      stopLaunchd(registration, {
        fs,
        monotonicNow: () => now,
        reportProgress: () => undefined,
        run,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toThrow(
      /ai\.kontour\.station\.agent.*605000ms.*launchctl bootout gui\/\d+\/ai\.kontour\.station\.agent/u,
    );
  });

  test('does not claim rollback failed when its final launchd re-check sees the label unloaded', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launchd-test-'));
    process.env.HOME = root;
    const unitPath = join(
      root,
      'Library',
      'LaunchAgents',
      'io.kontourai.station.agent.plist',
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, '<plist><string>prior</string></plist>');
    let bootoutCount = 0;
    let rollbackConfirmationAttempts = 0;
    let now = 0;
    const run = vi.fn<CommandRunner>((command, args) => {
      if (command === 'plutil') return { status: 0 };
      if (command !== 'launchctl') return { status: 0 };
      if (args[0] === 'bootout') {
        bootoutCount += 1;
        return { status: 0 };
      }
      if (args[0] === 'print') {
        if (args[1]?.endsWith('ai.kontour.station.agent')) {
          return { status: 1 };
        }
        if (bootoutCount === 0 || bootoutCount === 1) return { status: 0 };
        // The rollback wait cannot confirm its first observation, but its
        // final re-check sees the label disappear before the failure claim.
        rollbackConfirmationAttempts += 1;
        return rollbackConfirmationAttempts === 1
          ? { error: new Error('confirmation unavailable'), status: null }
          : { status: 1 };
      }
      return { status: 0 };
    });

    let message = '';
    try {
      installLaunchd('agent', {
        fs,
        lifecycle: lifecycle(join(root, '.station')),
        monotonicNow: () => now,
        nodePath: '/node',
        repoPath: '/repo',
        reportProgress: () => undefined,
        run,
        servicePath: '/usr/bin',
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('still draining after 605000ms');
    expect(message).not.toContain('rollback failed');
  });
});
