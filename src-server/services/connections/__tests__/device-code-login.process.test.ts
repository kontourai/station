import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DeviceCodeLoginManager } from '../device-code-login.js';

const makeTempDir = trackTempDirs();
const run = promisify(execFile);

async function processAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await run('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const state = stdout.trim();
    return state !== '' && !state.startsWith('Z');
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

afterEach(() => vi.unstubAllEnvs());

test.runIf(process.platform !== 'win32')(
  'device-code login fences a replacement while a TERM-resistant child can still write',
  async () => {
    const bin = makeTempDir('station-device-login-bin-');
    const profile = makeTempDir('station-device-login-profile-');
    const credentialFile = join(profile, 'fixture-credential');
    const workerProgram = `
      const { existsSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const approval = join(process.env.CODEX_HOME, 'approve-' + process.pid);
      let terminating = false;
      process.on('SIGTERM', () => { terminating = true; });
      process.send('ready');
      setTimeout(() => process.exit(1), 20000).unref();
      setInterval(() => {
        if (terminating && existsSync(approval)) {
          writeFileSync(${JSON.stringify(credentialFile)}, 'approved');
        }
      }, 20);
    `;
    await writeFile(
      join(bin, 'codex'),
      `#!${process.execPath}
if (process.argv[3] === '--help') {
  console.log('Usage: codex login --device-auth');
} else if (process.argv[3] === 'status') {
  if (require('node:fs').existsSync(${JSON.stringify(credentialFile)})) {
    console.log('Logged in using ChatGPT');
  } else {
    console.log('Not logged in');
    process.exitCode = 1;
  }
} else if (process.argv[3] === '--device-auth') {
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerProgram)}], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  process.on('SIGTERM', () => worker.kill('SIGTERM'));
  worker.once('message', () => {
    writeFileSync(join(process.env.CODEX_HOME, 'fixture-pids.json'),
      JSON.stringify([process.pid, worker.pid]));
    console.log('https://auth.openai.com/codex/device\\n7IEZ-B1FLE');
  });
}
`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(':'));
    vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
    vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', join(bin, 'registry'));
    const manager = new DeviceCodeLoginManager();
    let pids: number[] = [];
    try {
      expect((await manager.start('codex', profile)).kind).toBe('started');
      await vi.waitFor(
        () => expect(manager.status(profile)?.phase).toBe('awaiting-approval'),
        { timeout: 8000 },
      );
      pids = JSON.parse(
        await readFile(join(profile, 'fixture-pids.json'), 'utf8'),
      );
      expect(await Promise.all(pids.map(processAlive))).toEqual([true, true]);

      expect(manager.cancel(profile)?.phase).toBe('cancelled');
      const replacement = await manager.start('codex', profile);
      await writeFile(join(profile, `approve-${pids[1]}`), '');
      await vi.waitFor(
        async () =>
          expect(await readFile(credentialFile, 'utf8')).toBe('approved'),
        { timeout: 2000 },
      );
      expect(replacement.kind).toBe('busy');
      await vi.waitFor(
        async () => {
          const alive = await Promise.all(pids.map(processAlive));
          expect(alive).toEqual([false, false]);
        },
        { interval: 100, timeout: 8000 },
      );
      await vi.waitFor(
        async () => {
          const next = await manager.start('codex', profile);
          expect(next.kind).toBe('already-signed-in');
        },
        { timeout: 4000 },
      );
    } finally {
      manager.cancelAll();
      await Promise.all(
        pids.map(async (pid) => {
          try {
            if (await processAlive(pid)) process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }),
      );
    }
  },
  24_000,
);
