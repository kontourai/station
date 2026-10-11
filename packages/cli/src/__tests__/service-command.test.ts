import * as nodeFs from 'node:fs';
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  resolveInstallerOwnedArchiveVersion,
  resolveLifecycleCodeRoot,
} from '../commands/lifecycle-code-root.js';
import type { ServiceFs } from '../commands/service.js';
import {
  LAUNCHER_STOP_BUDGET_MS,
  resolveServiceCodeLocation,
  SERVICE_SHUTDOWN_DEADLINE_MS,
  SYSTEMD_STOP_TIMEOUT_SECONDS,
} from '../commands/service-command.js';
import { renderLaunchdPlist } from '../commands/service-launchd.js';
import { collectServicePathCandidates } from '../commands/service-path.js';
import { renderSystemdUnit } from '../commands/service-systemd.js';
import { renderWindowsServiceCommand } from '../commands/service-windows.js';

const makeTempDir = trackTempDirs();

const lifecycle = {
  baseDir: '/home/u/.station',
  homeSource: '--base' as const,
  host: '0.0.0.0',
  instanceName: 'agent',
  serverPort: 3242,
  uiPort: 5274,
  features: 'a,b',
  allowedOrigins: ['https://x.example'],
  stationRoot: '/home/u/root',
};
const windowsLifecycle = {
  ...lifecycle,
  baseDir: 'C:\\Data',
  stationRoot: 'C:\\Root',
};

/**
 * What a source checkout's units rendered before slice C (#2675), byte for
 * byte, except for the two deliberate changes named beside them. A checkout's
 * service must keep running exactly what it ran.
 */
describe('a source checkout service renders what it did before slice C', () => {
  const source = {
    instanceId: 'agent',
    lifecycle,
    nodePath: '/opt/node24/bin/node',
    repoPath: '/opt/station',
    servicePath: '/opt/node24/bin:/usr/bin',
  };

  test('systemd', () => {
    expect(renderSystemdUnit(source)).toBe(
      [
        '[Unit]',
        'Description=Station user service (agent)',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'WorkingDirectory=/opt/station',
        'Environment="PATH=/opt/node24/bin:/usr/bin"',
        'Environment="STATION_ROOT=/home/u/root"',
        'Environment=STATION_SERVICE_MANAGED=1',
        'ExecStart="/opt/node24/bin/node" "/opt/station/node_modules/tsx/dist/cli.mjs" "/opt/station/scripts/station-cli.ts" "service" "run" "--instance=agent" "--base=/home/u/.station" "--port=3242" "--ui-port=5274" "--host=0.0.0.0" "--features=a,b" "--allowed-origin=https://x.example"',
        '# Deliberately no Nice=, CPUWeight=, or IOSchedulingClass=: this user-facing',
        "# service should retain systemd's normal scheduling defaults, not a background tier.",
        'Restart=always',
        'RestartSec=5',
        // Deliberate: was 30, shorter than `service run`'s 60 s shutdown,
        // and now covers the fixed launcher's whole stop (#2675 D).
        'TimeoutStopSec=165',
        'KillMode=mixed',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  test('launchd', () => {
    expect(
      renderLaunchdPlist({ ...source, label: 'io.kontourai.station.agent' }),
    ).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key><string>io.kontourai.station.agent</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/opt/node24/bin/node</string>',
        '    <string>/opt/station/node_modules/tsx/dist/cli.mjs</string>',
        '    <string>/opt/station/scripts/station-cli.ts</string>',
        '    <string>service</string>',
        '    <string>run</string>',
        '    <string>--instance=agent</string>',
        '    <string>--base=/home/u/.station</string>',
        '    <string>--port=3242</string>',
        '    <string>--ui-port=5274</string>',
        '    <string>--host=0.0.0.0</string>',
        '    <string>--features=a,b</string>',
        '    <string>--allowed-origin=https://x.example</string>',
        '  </array>',
        '  <key>WorkingDirectory</key><string>/opt/station</string>',
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>PATH</key><string>/opt/node24/bin:/usr/bin</string>',
        '    <key>STATION_ROOT</key><string>/home/u/root</string>',
        '    <key>STATION_SERVICE_MANAGED</key><string>1</string>',
        '  </dict>',
        '  <key>KeepAlive</key><true/>',
        '  <key>ProcessType</key><string>Interactive</string>',
        '  <key>ExitTimeOut</key><integer>600</integer>',
        '  <key>Umask</key><integer>63</integer>',
        '  <key>StandardOutPath</key><string>/home/u/.station/logs/agent-service.out.log</string>',
        '  <key>StandardErrorPath</key><string>/home/u/.station/logs/agent-service.err.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  test('Windows', () => {
    expect(
      renderWindowsServiceCommand({
        instanceId: 'agent',
        lifecycle: windowsLifecycle,
        nodePath: 'C:\\node\\node.exe',
        repoPath: 'C:\\dev\\Station',
      }),
    ).toBe(
      [
        '@echo off',
        'set "STATION_ROOT=C:\\Root"',
        // Deliberate (#2675 correction 10): launchd and systemd set it too.
        'set "STATION_SERVICE_MANAGED=1"',
        'cd /d "C:\\dev\\Station" || exit /b 1',
        '"C:\\node\\node.exe" "C:\\dev\\Station\\node_modules\\tsx\\dist\\cli.mjs" "C:\\dev\\Station\\scripts\\station-cli.ts" "service" "run" "--instance=agent" "--base=C:\\Data" "--port=3242" "--ui-port=5274" "--host=0.0.0.0" "--features=a,b" "--allowed-origin=https://x.example" >> "C:\\Data\\logs\\agent-service.log" 2>&1',
        '',
      ].join('\r\n'),
    );
  });
});

describe('an installer-owned archive service runs the fixed launcher with current (#2675 C, D)', () => {
  const archive = {
    kind: 'archive' as const,
    installRoot: '/home/u/.station/installs/stable',
    nodePath: '/home/u/.station/installs/stable/current/runtime/bin/node',
    repoPath: '/home/u/.station/installs/stable/current',
  };
  const expectedArgs = [
    '/home/u/.station/installs/stable/current/runtime/bin/node',
    // #2675 D: the launcher outside every version, which runs the active one.
    '/home/u/.station/installs/stable/runtime/station-launcher.mjs',
    'service',
    'run',
    '--instance=agent',
    '--base=/home/u/.station',
    '--port=3242',
    '--ui-port=5274',
    '--host=0.0.0.0',
    '--features=a,b',
    '--allowed-origin=https://x.example',
  ];

  test('systemd runs the fixed launcher with the bundled Node.js through current', () => {
    const unit = renderSystemdUnit({
      ...archive,
      instanceId: 'agent',
      lifecycle,
      servicePath: '/usr/bin',
    });
    expect(unit).toContain(
      `ExecStart=${expectedArgs.map((arg) => `"${arg}"`).join(' ')}\n`,
    );
    expect(unit).toContain(
      'WorkingDirectory=/home/u/.station/installs/stable/current\n',
    );
    expect(unit).not.toContain('tsx');
    expect(unit).not.toContain('/versions/');
  });

  test('launchd runs the same command from the same directory', () => {
    const plist = renderLaunchdPlist({
      ...archive,
      instanceId: 'agent',
      label: 'io.kontourai.station.agent',
      lifecycle,
      servicePath: '/usr/bin',
    });
    expect(plist).toContain(
      `<array>${expectedArgs.map((arg) => `\n    <string>${arg}</string>`).join('')}\n  </array>`,
    );
    expect(plist).toContain(
      '<key>WorkingDirectory</key><string>/home/u/.station/installs/stable/current</string>',
    );
  });

  test('Windows runs the fixed launcher with its frozen node.exe, from the launcher directory (#2675 W3)', () => {
    const command = renderWindowsServiceCommand({
      kind: 'archive',
      installRoot: 'C:\\Station\\installs\\stable',
      nodePath: 'C:\\Station\\installs\\stable\\runtime\\node.exe',
      repoPath: 'C:\\Station\\installs\\stable\\current',
      instanceId: 'agent',
      lifecycle: windowsLifecycle,
    });
    expect(command).toContain(
      'cd /d "C:\\Station\\installs\\stable\\runtime" || exit /b 1\r\n"C:\\Station\\installs\\stable\\runtime\\node.exe" "C:\\Station\\installs\\stable\\runtime\\station-launcher.mjs" "service" "run" "--instance=agent"',
    );
    // Nothing the task runs, nor its working directory, goes through a
    // junction or names a version an update would remove.
    expect(command).not.toContain('current');
    expect(command).not.toContain('versions');
    expect(command).not.toContain('tsx');
  });
});

test('systemd waits out the supervisor and launcher stops before it kills the unit', () => {
  // A literal beside the derived value: the unit text is what systemd reads.
  expect(SYSTEMD_STOP_TIMEOUT_SECONDS).toBe(165);
  expect(SYSTEMD_STOP_TIMEOUT_SECONDS * 1_000).toBeGreaterThanOrEqual(
    SERVICE_SHUTDOWN_DEADLINE_MS + 5_000,
  );
  expect(SYSTEMD_STOP_TIMEOUT_SECONDS * 1_000).toBeGreaterThanOrEqual(
    LAUNCHER_STOP_BUDGET_MS + 30_000,
  );
});

/**
 * A prebuilt archive in install.sh's layout: `<installRoot>/versions/<v>`,
 * the installer's marker, and `current` pointing at the version.
 */
function archiveInstall(root: string, version = '1.2.3') {
  const installRoot = join(root, 'installs', 'stable');
  const versionDir = join(installRoot, 'versions', version);
  mkdirSync(join(versionDir, 'runtime', 'bin'), { recursive: true });
  writeFileSync(
    join(versionDir, '.station-prebuilt-archive'),
    'station-prebuilt-archive-v1\n',
  );
  writeFileSync(
    join(versionDir, '.station-release.json'),
    JSON.stringify({
      schemaVersion: 2,
      sha: 'a'.repeat(40),
      ref: `v${version}`,
      createdAt: '2026-09-26T00:00:00.000Z',
      channel: 'stable',
      releaseChannel: 'stable',
      prerelease: false,
    }),
  );
  writeFileSync(join(versionDir, 'runtime', 'bin', 'node'), '');
  writeFileSync(
    join(installRoot, '.station-portable-install-root'),
    'station-portable-install-root-v1\n',
  );
  symlinkSync(versionDir, join(installRoot, 'current'));
  return {
    installRoot: realpathSync(installRoot),
    versionDir: realpathSync(versionDir),
  };
}

describe('where a service installed from a code root runs', () => {
  const locate = (cwd: string, platform: 'darwin' | 'linux' = 'linux') =>
    resolveServiceCodeLocation({
      codeRoot: resolveLifecycleCodeRoot(cwd),
      execPath: process.execPath,
      fs: nodeFs,
      platform,
    });

  test('the active version of an install.sh install runs its current', () => {
    const { installRoot, versionDir } = archiveInstall(
      makeTempDir('station-service-location-'),
    );
    expect(locate(versionDir)).toEqual({
      kind: 'archive',
      installRoot,
      nodePath: join(installRoot, 'current', 'runtime', 'bin', 'node'),
      repoPath: join(installRoot, 'current'),
    });
  });

  test('on Windows the active version runs the node.exe frozen beside the launcher (#2675 W3)', () => {
    const { installRoot, versionDir } = archiveInstall(
      makeTempDir('station-service-location-'),
    );
    expect(
      resolveServiceCodeLocation({
        codeRoot: resolveLifecycleCodeRoot(versionDir),
        execPath: process.execPath,
        fs: nodeFs,
        platform: 'win32',
      }),
    ).toEqual({
      kind: 'archive',
      installRoot,
      nodePath: win32.join(installRoot, 'runtime', 'node.exe'),
      repoPath: win32.join(installRoot, 'current'),
    });
  });

  test.each([
    {
      name: 'an install root without the installer marker',
      damage: (installRoot: string) =>
        rmSync(join(installRoot, '.station-portable-install-root')),
    },
    {
      name: 'a marker with other content',
      damage: (installRoot: string) =>
        writeFileSync(
          join(installRoot, '.station-portable-install-root'),
          'station-portable-install-root-v2\n',
        ),
    },
  ])('any other archive copy runs from its own path: $name', ({ damage }) => {
    const { installRoot, versionDir } = archiveInstall(
      makeTempDir('station-service-location-'),
    );
    damage(installRoot);
    expect(resolveInstallerOwnedArchiveVersion(versionDir)).toBeNull();
    expect(locate(versionDir)).toEqual({
      kind: 'archive',
      nodePath: join(versionDir, 'runtime', 'bin', 'node'),
      repoPath: versionDir,
    });
  });

  test.each([
    {
      name: 'current naming another version',
      damage: (installRoot: string) => {
        const other = join(installRoot, 'versions', '1.2.4');
        mkdirSync(other);
        rmSync(join(installRoot, 'current'));
        symlinkSync(other, join(installRoot, 'current'));
      },
    },
    {
      name: 'current as a directory, not a link',
      damage: (installRoot: string) => {
        rmSync(join(installRoot, 'current'));
        mkdirSync(join(installRoot, 'current'));
      },
    },
    {
      name: 'no current at all',
      damage: (installRoot: string) => rmSync(join(installRoot, 'current')),
    },
  ])(
    'refuses an inactive version of an install.sh install, which the installer may prune: $name',
    ({ damage }) => {
      const { installRoot, versionDir } = archiveInstall(
        makeTempDir('station-service-location-'),
      );
      damage(installRoot);
      expect(resolveInstallerOwnedArchiveVersion(versionDir)).toEqual({
        installRoot,
        active: false,
      });
      expect(() => locate(versionDir)).toThrow(
        `Cannot install a Station service from ${versionDir}: it is not the version ${join(installRoot, 'current')} names, and the installer may remove it.`,
      );
    },
  );

  test('an archive outside a versions directory is not installer-owned', () => {
    const root = makeTempDir('station-service-location-');
    const { versionDir } = archiveInstall(root);
    const loose = join(root, 'extracted');
    nodeFs.cpSync(versionDir, loose, { recursive: true });
    expect(resolveInstallerOwnedArchiveVersion(loose)).toBeNull();
    expect(locate(loose).repoPath).toBe(realpathSync(loose));
  });

  test('a source checkout runs its own physical path with the resolved host Node.js', () => {
    const checkout = makeTempDir('station-service-location-');
    const linked = join(makeTempDir('station-service-link-'), 'checkout');
    symlinkSync(checkout, linked);
    expect(locate(linked)).toEqual({
      kind: 'source',
      nodePath: realpathSync(process.execPath),
      repoPath: realpathSync(checkout),
    });
  });
});

describe('an archive service PATH follows current', () => {
  test('the unit names current/runtime/bin, not the version it resolves to', () => {
    const { installRoot, versionDir } = archiveInstall(
      makeTempDir('station-service-path-'),
    );
    const nodeDir = join(installRoot, 'current', 'runtime', 'bin');
    const candidates = collectServicePathCandidates(
      () => ({
        status: 0,
        stdout: '__STATION_SERVICE_PATH__/usr/bin__STATION_SERVICE_PATH__\n',
      }),
      nodeFs as unknown as ServiceFs,
      { nodeDir },
    );
    expect(candidates.accepted[0]).toBe(nodeDir);
    expect(candidates.accepted).not.toContain(
      join(versionDir, 'runtime', 'bin'),
    );
    expect(candidates.nodeDir).toBe(nodeDir);
  });
});
