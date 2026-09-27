/**
 * #2805 — a failed portable-archive smoke must show why. Run 36320671340's
 * first attempt timed out waiting for the server's identity and printed no
 * server log, so the cause was unknowable. The end-to-end case runs the REAL
 * smoke script against a fake archive whose `station start` fails after the
 * "server" wrote its log, and requires the smoke's own output to carry that
 * log and the command's stdout/stderr.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { readPortableNodeRuntime } from '../lib/portable-server-archive.mjs';
import {
  boundedTail,
  DIAGNOSTIC_TAIL_CHARS,
  describeCommandFailure,
  findStationLogs,
  stationLogReport,
} from '../lib/portable-smoke-diagnostics.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();

describe('portable smoke failure diagnostics', () => {
  it('keeps the last characters of long output and says how much it cut', () => {
    // Pinned beside the constant it bounds.
    expect(DIAGNOSTIC_TAIL_CHARS).toBe(16_000);
    expect(boundedTail('short', 10)).toBe('short');
    expect(boundedTail('0123456789abcdef', 6)).toBe(
      '[... 10 earlier characters omitted]\nabcdef',
    );
  });

  it('names a timeout, a spawn error, a signal and an exit, with both streams', () => {
    const timedOut = describeCommandFailure(
      'start',
      {
        error: Object.assign(new Error('spawnSync cmd.exe ETIMEDOUT'), {
          code: 'ETIMEDOUT',
        }),
        status: null,
        signal: 'SIGTERM',
        stdout: 'Station home: C:\\h (default)\nWaiting',
        stderr: 'open #station-ui-bootstrap=secret-token now',
      },
      300_000,
    );
    expect(timedOut).toBe(
      [
        'station start timed out after 300000ms',
        '--- stdout ---',
        'Station home: C:\\h (default)\nWaiting',
        '--- stderr ---',
        'open #station-ui-bootstrap=<redacted> now',
      ].join('\n'),
    );
    expect(
      describeCommandFailure(
        'stop',
        { error: new Error('spawn EACCES'), stdout: '', stderr: '' },
        1,
      ),
    ).toBe(
      'station stop could not run: spawn EACCES\n--- stdout ---\n<empty>\n--- stderr ---\n<empty>',
    );
    expect(
      describeCommandFailure(
        'stop',
        { error: undefined, status: null, signal: 'SIGKILL' },
        1,
      ),
    ).toMatch(/^station stop was killed by SIGKILL\n/);
    expect(
      describeCommandFailure(
        'start',
        {
          error: undefined,
          status: 1,
          stdout: 'x'.repeat(DIAGNOSTIC_TAIL_CHARS + 5),
          stderr: 'boom',
        },
        1,
      ),
    ).toMatch(
      /^station start exited 1\n--- stdout ---\n\[\.\.\. 5 earlier characters omitted\]\nx+\n--- stderr ---\nboom$/,
    );
  });

  it('finds Station logs under several roots, newest first, bounded, skipping node_modules', () => {
    // Real paths: the report names each log once, by its resolved path.
    const home = realpathSync(makeTempDir('portable-smoke-logs-home-'));
    const announced = realpathSync(makeTempDir('portable-smoke-logs-temp-'));
    const write = (path: string, text: string, mtimeSeconds: number) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      utimesSync(path, mtimeSeconds, mtimeSeconds);
    };
    const channelLog = join(
      home,
      '.station',
      'instances',
      'nightly',
      'logs',
      'station-a.log',
    );
    const rotated = `${channelLog}.previous`;
    const temporaryLog = join(announced, 'logs', 'station-b.log');
    write(channelLog, 'channel', 3_000);
    write(rotated, 'rotated', 1_000);
    write(temporaryLog, 'temporary', 2_000);
    write(join(home, 'node_modules', 'x', 'logs', 'dep.log'), 'dep', 9_000);
    write(join(home, 'logs', 'notes.txt'), 'not a log', 9_000);
    write(join(home, 'elsewhere', 'station-c.log'), 'not in logs/', 9_000);

    expect(findStationLogs([home, announced, join(home, 'missing')])).toEqual([
      channelLog,
      temporaryLog,
      rotated,
    ]);
    expect(findStationLogs([home, announced], 2)).toEqual([
      channelLog,
      temporaryLog,
    ]);
    const report = stationLogReport([home, announced], 1);
    expect(report).toBe(`--- ${channelLog} ---\nchannel`);
    expect(stationLogReport([join(home, 'missing')])).toBe(
      `no Station log files under ${join(home, 'missing')}`,
    );
  });
});

/**
 * A portable archive whose launcher is a shell script: it passes the smoke's
 * pre-boot identity checks, refuses `build` (writing a log under HOME the way
 * a channel instance would), then fails `start --temp-home` after "the
 * server" logged into a temporary home outside HOME.
 */
function fakeArchive(directory: string, temporaryHome: string) {
  const root = join(directory, 'tree', 'station');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'node'), '');
  writeFileSync(join(root, 'lib', 'station-cli.mjs'), 'export {};\n');
  const release = { ref: 'refs/fake', sha: 'f'.repeat(40), channel: 'nightly' };
  writeFileSync(join(root, '.station-release.json'), JSON.stringify(release));
  const identity = {
    node: `v${readPortableNodeRuntime().version}`,
    ref: release.ref,
    sha: release.sha,
    platform: `${process.platform}-${process.arch}`,
  };
  const launcher = join(root, 'bin', 'station');
  writeFileSync(
    launcher,
    `#!/bin/sh
root=$(cd "$(dirname "$0")/.." && pwd -P)
case "$1" in
  --version)
    if [ "$2" = --json ]; then
      printf '%s\\n' '${JSON.stringify(identity).slice(0, -1)},"execPath":"'"$root"'/runtime/node"}'
    else
      echo 'station fake'
    fi ;;
  build)
    mkdir -p "$HOME/.station/instances/nightly/logs"
    echo 'HOME-LOG-MARKER from an earlier run' > "$HOME/.station/instances/nightly/logs/station-plain.log"
    echo 'cannot build a prebuilt Station archive' >&2
    exit 1 ;;
  start)
    echo 'Station home: ${temporaryHome} (--temp-home)'
    mkdir -p '${temporaryHome}/logs'
    echo 'TEMP-LOG-MARKER server crashed; link #station-ui-bootstrap=SECRET-TOKEN' > '${temporaryHome}/logs/station-t.log'
    echo 'Timed out waiting for http://127.0.0.1:1/api/system/identity (fetch failed) STDERR-MARKER' >&2
    exit 1 ;;
  stop) exit 0 ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(launcher, 0o755);
  const archive = join(directory, 'station-server-fake.tar');
  const packed = spawnSync(
    'tar',
    ['-cf', archive, '-C', join(directory, 'tree'), 'station'],
    {
      encoding: 'utf8',
    },
  );
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  return archive;
}

describe('portable smoke end to end', () => {
  it.skipIf(process.platform === 'win32')(
    'prints the failing start command output and every Station log before cleanup',
    () => {
      const directory = makeTempDir('portable-smoke-e2e-');
      const temporaryHome = makeTempDir('portable-smoke-e2e-temp-home-');
      const archive = fakeArchive(directory, temporaryHome);
      const result = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts', 'smoke-portable-server-archive.mjs'),
          '--archive',
          archive,
          '--work-dir',
          join(directory, 'work'),
        ],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      // The smoke reached the failing start, not an earlier precondition.
      expect(result.stderr).toContain(
        '[portable-smoke] FAIL: station start --temp-home',
      );
      expect(result.status).toBe(1);
      // The command's own stdout and stderr, in full.
      expect(result.stderr).toMatch(
        /exited 1\n--- stdout ---\nStation home: .+ \(--temp-home\)\n--- stderr ---\nTimed out waiting for .+STDERR-MARKER/,
      );
      // The log in the announced temporary home (outside HOME) and the one
      // under HOME, printed before the work directory was removed.
      expect(result.stderr).toContain('Station logs after the failure:');
      expect(result.stderr).toContain('TEMP-LOG-MARKER server crashed');
      expect(result.stderr).toContain('HOME-LOG-MARKER from an earlier run');
      expect(output).toContain('#station-ui-bootstrap=<redacted>');
      expect(output).not.toContain('SECRET-TOKEN');
    },
  );
});
