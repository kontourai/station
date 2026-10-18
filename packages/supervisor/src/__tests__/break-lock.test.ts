/**
 * `--break-lock` is the guarded way out of a fail-closed lock: it re-checks
 * the holder itself, refuses a live one, demands --force when the holder's
 * identity cannot be verified, and never deletes an epoch.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { processFingerprint } from '../generation-registry.ts';
import { SUPERVISOR_MAIN, startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

function breakLock(
  home: string,
  extra: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      SUPERVISOR_MAIN,
      '--break-lock',
      '--home',
      home,
      '--instance',
      'test',
      ...extra,
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
}

function epochFile(home: string, epoch: number): string {
  return join(home, 'run', `instance-test.lock.${epoch}`);
}

function readEpoch(home: string, epoch: number): Record<string, unknown> {
  return JSON.parse(readFileSync(epochFile(home, epoch), 'utf8'));
}

function writeEpoch(
  home: string,
  epoch: number,
  content: Record<string, unknown>,
): void {
  mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
  writeFileSync(epochFile(home, epoch), JSON.stringify(content));
}

function deadPid(): number {
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return Number(result.stdout);
}

describe('--break-lock (child processes)', () => {
  it('refuses while the holder is a live supervisor', async () => {
    const home = makeTempDir('sup-break-live-');
    const holder = await startSupervisor({ home });
    const result = breakLock(home, ['--force']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      `pid ${holder.child.pid} is running as this instance's supervisor`,
    );
    expect(readEpoch(home, 1).releasedAt).toBeUndefined();
    expect((await holder.status()).state).toBe('serving');
  }, 60_000);

  it('marks a dead holder released, and the next starter serves', async () => {
    const home = makeTempDir('sup-break-dead-');
    writeEpoch(home, 1, {
      pid: deadPid(),
      nonce: randomBytes(16).toString('hex'),
      startFingerprint: 'gone',
      createdAt: Date.now(),
      control: 'x',
    });
    const result = breakLock(home, ['--reason', 'test cleanup']);
    expect(result.status, result.stderr).toBe(0);
    const marked = readEpoch(home, 1);
    expect(marked.releasedAt).toBeTypeOf('number');
    expect(marked.releasedBy).toBe('break-lock');
    expect(marked.releaseReason).toBe('test cleanup');
    expect(
      readdirSync(join(home, 'run')).filter((name) => name.includes('.lock.')),
    ).toEqual(['instance-test.lock.1']);
    const next = await startSupervisor({ home });
    expect(next.output()).toContain('acquired instance lock epoch 2');
  }, 60_000);

  it.skipIf(process.platform !== 'darwin')(
    'demands --force for a holder it cannot verify, then lets the next starter serve',
    async () => {
      const home = makeTempDir('sup-break-unknown-');
      const sleeper = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      children.push(sleeper);
      await once(sleeper, 'spawn');
      const pid = sleeper.pid as number;
      const fingerprint = await processFingerprint(pid);
      writeEpoch(home, 1, {
        pid,
        nonce: randomBytes(16).toString('hex'),
        startFingerprint: fingerprint.status === 'ok' ? fingerprint.value : '',
        createdAt: Date.now(),
        control: 'x',
      });
      // No `ps` on PATH: the holder's identity is unknown.
      const unforced = breakLock(home, [], { PATH: '/nonexistent' });
      expect(unforced.status, unforced.stderr).toBe(1);
      expect(unforced.stderr).toContain(
        `pid ${pid} exists but its identity could not be verified`,
      );
      expect(unforced.stderr).toContain('--force');
      expect(readEpoch(home, 1).releasedAt).toBeUndefined();

      const forced = breakLock(home, ['--force'], { PATH: '/nonexistent' });
      expect(forced.status, forced.stderr).toBe(0);
      expect(readEpoch(home, 1).releasedBy).toBe('break-lock');
      const next = await startSupervisor({ home });
      expect(next.output()).toContain('acquired instance lock epoch 2');
    },
    60_000,
  );

  it('reports that there is no lock to break', () => {
    const result = breakLock(makeTempDir('sup-break-none-'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no instance lock to break');
  });
});
