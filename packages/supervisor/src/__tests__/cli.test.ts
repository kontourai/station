import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SUPERVISOR_MAIN } from './harness.ts';

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
});
