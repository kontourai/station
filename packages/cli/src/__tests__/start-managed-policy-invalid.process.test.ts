/**
 * #4515 fix round 2: `station start` with a managed policy Station cannot
 * enforce refuses before it spawns anything. Before, the CLI left an
 * unloadable policy to the server child, so the UI host listened (on every
 * interface by default) for the whole refused start. This runs the real CLI
 * through the supported source entry with an isolated home and free ports,
 * and probes the server and UI ports, on loopback and on a non-loopback
 * address of this machine, for as long as the CLI runs.
 */
import { spawn } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { MANAGED_POLICY_INVALID_MARKER } from '@kontourai/station-contracts/managed-policy';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();
const posix = process.platform !== 'win32';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolvePort(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

/** A server port with its voice (+2) and consent (+3) neighbours free. */
async function freeBand(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await freePort();
    if (base > 65_000) continue;
    const taken = await Promise.all(
      [base + 2, base + 3].map((port) => accepts('127.0.0.1', port)),
    );
    if (!taken.some(Boolean)) return base;
  }
  throw new Error('no free port band');
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolveAccepts) => {
    const socket = createConnection({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolveAccepts(value);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** A non-loopback IPv4 address of this machine, as a LAN peer would use. */
function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return undefined;
}

const INVALID_POLICIES: Array<[string, (dir: string) => string]> = [
  [
    'a value the parser refuses',
    (dir) => {
      const path = join(dir, 'policy.json');
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { telemetry: true },
        }),
      );
      return path;
    },
  ],
  [
    'an unknown key',
    (dir) => {
      const path = join(dir, 'policy.json');
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, organization: 'Acme', extra: 1 }),
      );
      return path;
    },
  ],
  [
    'a duplicate key',
    (dir) => {
      const path = join(dir, 'policy.json');
      writeFileSync(
        path,
        '{"schemaVersion":1,"organization":"Acme","limits":{"telemetry":false},"limits":{}}',
      );
      return path;
    },
  ],
  [
    'a symbolic link',
    (dir) => {
      const target = join(dir, 'real.json');
      writeFileSync(
        target,
        JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
      );
      const path = join(dir, 'policy.json');
      symlinkSync(target, path);
      return path;
    },
  ],
];

describe.skipIf(!posix)(
  'station start refuses a managed policy it cannot enforce',
  () => {
    test.each(INVALID_POLICIES)(
      'with %s: exits 1 with the marker and nothing listens',
      async (_name, install) => {
        const root = makeTempDir('station-start-invalid-policy-');
        const policyPath = install(root);
        const serverPort = await freeBand();
        let uiPort = await freePort();
        while (uiPort >= serverPort && uiPort <= serverPort + 3)
          uiPort = await freePort();
        const home = join(root, 'home');
        const osHome = join(root, 'os-home');
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            join(repoRoot, 'scripts/station-cli.ts'),
            'start',
            '--instance=managed-invalid-policy-test',
            `--home=${home}`,
            `--port=${serverPort}`,
            `--ui-port=${uiPort}`,
          ],
          {
            cwd: repoRoot,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              HOME: osHome,
              USERPROFILE: osHome,
              STATION_ROOT: join(root, 'station-root'),
              STATION_MANAGED_POLICY_TEST_FILE: policyPath,
              STATION_UI_PORT: '',
            },
          },
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.stdout.resume();
        const exited = new Promise<number | null>((resolveExit) =>
          child.once('exit', (code) => resolveExit(code)),
        );
        // Probe every listener the start would open, on loopback and on a
        // LAN address, until the CLI exits.
        const hosts = ['127.0.0.1', lanAddress()].filter(
          (host): host is string => host !== undefined,
        );
        const seen: string[] = [];
        let running = true;
        void exited.then(() => {
          running = false;
        });
        const deadline = Date.now() + 120_000;
        while (running && Date.now() < deadline) {
          for (const host of hosts)
            for (const port of [serverPort, uiPort])
              if (await accepts(host, port)) seen.push(`${host}:${port}`);
          await new Promise((wait) => setTimeout(wait, 100));
        }
        if (running) child.kill('SIGKILL');
        const code = await exited;
        // And once more after it exits: nothing it started outlives it.
        for (const host of hosts)
          for (const port of [serverPort, uiPort])
            if (await accepts(host, port)) seen.push(`after:${host}:${port}`);

        expect(code, stderr).toBe(1);
        expect(
          stderr
            .split('\n')
            .some((line) =>
              line.startsWith(`${MANAGED_POLICY_INVALID_MARKER}: `),
            ),
          stderr,
        ).toBe(true);
        expect(stderr).toContain(policyPath);
        expect(seen).toEqual([]);
      },
      180_000,
    );
  },
);
