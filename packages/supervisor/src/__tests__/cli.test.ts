import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FAKE_CORE, SUPERVISOR_MAIN } from './harness.ts';

function run(args: string[]) {
  return spawnSync(process.execPath, [SUPERVISOR_MAIN, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

describe('supervisor command line (child process)', () => {
  it('prints usage and exits 0 for --help', () => {
    const result = run(['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'usage: station-supervisor --entry <core entry>',
    );
    expect(result.stdout).toContain('--build-root <dir>');
    expect(result.stderr).toBe('');
  });

  it('refuses a home at a filesystem root with one line, exit 2, no stack trace', () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    for (const args of [
      ['--entry', FAKE_CORE, '--home', root, '--instance', 't'],
      ['--break-lock', '--home', root, '--instance', 't'],
    ]) {
      const result = run(args);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(
        'station-supervisor: a Station home cannot be a filesystem root',
      );
      expect(result.stderr).not.toMatch(/^\s+at /m);
    }
  });

  it('rejects an unknown option with one line and usage, exit 2, no stack trace', () => {
    const result = run(['--entry', 'x.js', '--bogus']);
    expect(result.status).toBe(2);
    const lines = result.stderr.trim().split('\n');
    expect(lines[0]).toBe("station-supervisor: unknown option '--bogus'");
    expect(result.stderr).toContain(
      'usage: station-supervisor --entry <core entry>',
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a --control path whose private bind name would not fit sun_path',
    () => {
      // The path itself fits; the private name `.sXXXXXX` beside it does not.
      const limit = process.platform === 'linux' ? 107 : 103;
      const dir = `/tmp/sv-long-${'x'.repeat(limit - 2 - '/tmp/sv-long-'.length)}`;
      const control = `${dir}/a`;
      expect(Buffer.byteLength(control)).toBeLessThanOrEqual(limit);
      const result = spawnSync(
        process.execPath,
        [
          SUPERVISOR_MAIN,
          '--entry',
          FAKE_CORE,
          '--home',
          dir,
          '--instance',
          't',
          '--control',
          control,
        ],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(
        `--control directory is too long for the socket's private bind name: ${control}`,
      );
    },
  );
});
