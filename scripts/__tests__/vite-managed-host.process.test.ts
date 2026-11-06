/**
 * #4519 round 1: `npm run dev:ui` (`vite dev`) under a managed policy that
 * allows no remote clients. Each case runs the real Vite CLI on this repo's
 * `vite.config.ts` as a child process, with a CLI `--host` override, the
 * way an operator would, and asserts the outcome: a wildcard or LAN host
 * refuses before listening; loopback starts; without the policy the same
 * override is untouched.
 */
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
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

/**
 * A Tailscale CLI stand-in (honored only with the test policy) that waits
 * `delaySeconds`, then reports a running backend whose Serve has a TCP route
 * to `port`.
 */
function tcpServeTo(port: number, delaySeconds: number): string {
  const path = join(makeTempDir('station-vite-tailscale-'), 'tailscale');
  const route = JSON.stringify({
    TCP: { '8443': { TCPForward: `127.0.0.1:${port}` } },
  });
  writeFileSync(
    path,
    `#!/bin/sh
sleep ${delaySeconds}
if [ "$1" = serve ]; then echo '${route}'; else echo '{"BackendState":"Running"}'; fi
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Runs `vite dev --host <host>`; resolves on exit or on Vite's ready line. */
function viteDev(
  host: string,
  port: number,
  policy?: string,
  tailscale?: string,
) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.STATION_MANAGED_POLICY_TEST_FILE;
  delete env.STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI;
  if (policy) env.STATION_MANAGED_POLICY_TEST_FILE = policy;
  // Absent unless given: no Tailscale, so nothing forwards.
  env.STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI =
    tailscale ?? join(repoRoot, 'no-such-tailscale');
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
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const ready = new Promise<{
    outcome: 'exited' | 'listening';
    output: string;
  }>((done, fail) => {
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
  });
  return Object.assign(ready, { exited, output: () => output });
}

/** One raw request; resolves with every byte received before the socket closed. */
function rawRequest(port: number): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      // A response's head is enough; keep-alive would hold the socket open.
      if (data.includes('\r\n\r\n')) socket.destroy();
    });
    socket.on('error', () => {});
    socket.once('close', () => done(data));
    socket.once('connect', () =>
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n',
      ),
    );
    setTimeout(() => {
      socket.destroy();
      fail(new Error(`request neither answered nor closed: ${data}`));
    }, 60_000);
  });
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

  test.skipIf(process.platform === 'win32')(
    'a Tailscale Serve TCP route to the loopback port refuses it, and a request made while that is checked is never served',
    async () => {
      // Round 2, fix 2: the loopback bind alone is not enough.
      const port = await freePort();
      const run = viteDev('127.0.0.1', port, policyFile(), tcpServeTo(port, 3));
      const ready = await run;
      // Vite announces the port as soon as it is bound; admission (the
      // stand-in's 3 s per call) is still running.
      expect(ready.outcome, ready.output).toBe('listening');
      const received = await rawRequest(port);
      expect(received).toBe('');
      await run.exited;
      expect(run.output()).toContain(
        `Tailscale Serve forwards port ${port} to it`,
      );
    },
    240_000,
  );

  test.skipIf(process.platform === 'win32')(
    'a Serve route to another port admits the server, and a held request is answered',
    async () => {
      const port = await freePort();
      const run = viteDev(
        '127.0.0.1',
        port,
        policyFile(),
        tcpServeTo(port + 1, 1),
      );
      expect((await run).outcome).toBe('listening');
      expect(await rawRequest(port)).toMatch(/^HTTP\/1\.1 \d{3}/);
    },
    240_000,
  );
});
