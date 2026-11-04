/**
 * #4519 round 1: `npm run dev:ui` (`vite dev`) under a managed policy that
 * allows no remote clients. Each case runs the real Vite CLI on this repo's
 * `vite.config.ts` as a child process, with a CLI `--host` override, the
 * way an operator would, and asserts the outcome: a wildcard or LAN host
 * refuses before listening; loopback starts; without the policy the same
 * override is untouched.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';

const repoRoot = resolve(import.meta.dirname, '../..');
const viteBin = join(repoRoot, 'node_modules/vite/bin/vite.js');
const makeTempDir = trackTempDirs();
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function policyFile(): string {
  const path = join(makeTempDir('station-vite-policy-'), 'policy.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { clients: ['desktop', 'local-browser'] },
    }),
  );
  return path;
}

/** Runs `vite dev --host <host>`; resolves on exit or on Vite's ready line. */
function viteDev(host: string, port: number, policy?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.STATION_MANAGED_POLICY_TEST_FILE;
  if (policy) env.STATION_MANAGED_POLICY_TEST_FILE = policy;
  const child = spawn(
    process.execPath,
    [viteBin, 'dev', '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  children.push(child);
  let output = '';
  return new Promise<{ outcome: 'exited' | 'listening'; output: string }>(
    (done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`vite neither exited nor listened:\n${output}`)),
        90_000,
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (/Local:|Network:/.test(output)) {
          clearTimeout(timer);
          done({ outcome: 'listening', output });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', () => {
        clearTimeout(timer);
        done({ outcome: 'exited', output });
      });
    },
  );
}

describe('vite dev under a managed policy without remote clients', () => {
  test('refuses a wildcard or LAN --host before listening', async () => {
    const policy = policyFile();
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'localhost']) {
      const port = await freePort();
      const result = await viteDev(host, port, policy);
      expect(result.outcome, result.output).toBe('exited');
      expect(result.output).toContain("Acme's policy manages remote access");
      expect(result.output).toContain('listens only on this computer');
    }
  }, 240_000);

  test('starts on loopback, and without the policy the override is untouched', async () => {
    const loopback = await viteDev('127.0.0.1', await freePort(), policyFile());
    expect(loopback.outcome, loopback.output).toBe('listening');
    const open = await viteDev('0.0.0.0', await freePort());
    expect(open.outcome, open.output).toBe('listening');
    expect(open.output).not.toContain('manages remote access');
  }, 240_000);
});
