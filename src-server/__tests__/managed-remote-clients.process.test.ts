/**
 * #4519: the real server entrypoint under a managed policy whose
 * `limits.clients` leaves out `remote`.
 *
 * Every case boots `src-server/index.ts` as a child process with an isolated
 * home, an injected policy, and a stand-in for the Tailscale CLI (the test
 * seam honored only with the policy override). It asserts the exit status
 * and marker line for the refusals, and for the accepted boot that the
 * server listens on loopback and refuses each way in from off the machine.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { afterEach, describe, expect, test } from 'vitest';
import { localLabEnvironment } from '../../scripts/lib/local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const readyPrefix = '{"event":"listening",';
const MARKER = 'STATION_MANAGED_POLICY_INVALID';

type Owned = ReturnType<typeof executeOwnedCommand>;
// Created before the hook below, so the directories outlive the servers that
// use them: vitest runs after-hooks in reverse registration order.
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function bounded<T>(promise: Promise<T>, label: string, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixtureRoot(): string {
  const root = makeTempDir('station-managed-clients-');
  chmodSync(root, 0o700);
  return root;
}

function isolatedEnv(root: string, policyPath: string) {
  const osHome = join(root, 'os-home');
  const temp = join(root, 'tmp');
  for (const dir of [osHome, temp]) mkdirSync(dir, { recursive: true });
  return {
    ...localLabEnvironment(),
    TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
    DOTENV_CONFIG_PATH: join(root, 'missing.env'),
    HOME: osHome,
    USERPROFILE: osHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: join(osHome, 'config'),
    XDG_CACHE_HOME: join(osHome, 'cache'),
    STATION_HOME: join(root, 'home'),
    STATION_ROOT: join(root, 'station-root'),
    STATION_HOST: '127.0.0.1',
    PORT: '0',
    STATION_INSTANCE: 'managed-clients-fixture',
    STATION_INSTANCE_ID: 'managed-clients-fixture',
    STATION_STDOUT_HANDSHAKE: '1',
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    STATION_MANAGED_POLICY_TEST_FILE: policyPath,
  };
}

function startServer(
  env: Record<string, string>,
  preloads: readonly string[] = [],
) {
  const owned: Owned = executeOwnedCommand(
    process.execPath,
    [
      ...preloads.flatMap((preload) => ['--import', preload]),
      '--import',
      import.meta.resolve('tsx'),
      join(repoRoot, 'src-server/index.ts'),
    ],
    spawn,
    'managed-clients Station',
    {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const capture = captureOwnedProcessOutput(owned, { maxBytes: 512 * 1024 });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const result = await terminateSuiteExecution(owned, {
      waitForSuiteSettlement,
      terminationGraceMs: 15_000,
      terminationForceMs: 5_000,
      processLabel: 'managed-clients Station',
    });
    expect(result.errors).toEqual([]);
  };
  cleanups.push(async () => {
    await stop();
    capture.finish();
  });
  return { owned, capture, stop };
}

const LOCAL_ONLY = JSON.stringify({
  schemaVersion: 1,
  organization: 'Acme',
  limits: { clients: ['desktop', 'local-browser'] },
});
const REMOTE_CODE = 'managed-policy-remote-clients';

/** An env for a local-only policy; `tailscale` is the CLI stand-in. */
function managedEnv(root: string, tailscale: string) {
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, LOCAL_ONLY);
  return {
    ...isolatedEnv(root, policyPath),
    STATION_MANAGED_POLICY_TEST_TAILSCALE_CLI: tailscale,
  };
}

/** A stand-in Tailscale CLI: a shell script with `body`. */
function fakeTailscale(root: string, body: string): string {
  const path = join(root, 'tailscale');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function expectRefusal(env: Record<string, string>) {
  const { owned, capture } = startServer(env);
  const result = await bounded(owned.completion, 'refused boot', 90_000);
  const { stdout, stderr } = capture.finish();
  expect(result.status).toBe(1);
  expect(stdout.text).not.toContain(readyPrefix);
  const markerLine = stderr.text
    .split('\n')
    .find((line) => line.startsWith(`${MARKER}:`));
  expect(markerLine, stderr.text.slice(-3000)).toBeDefined();
  expect(markerLine).toContain('allows no remote clients');
  return markerLine as string;
}

describe('managed limit without remote clients at real server startup', () => {
  test('refuses a non-loopback STATION_HOST before listening', async () => {
    const root = fixtureRoot();
    const env = managedEnv(root, join(root, 'no-tailscale'));
    const line = await expectRefusal({ ...env, STATION_HOST: '0.0.0.0' });
    expect(line).toContain('STATION_HOST is "0.0.0.0"');
  }, 120_000);

  test.skipIf(process.platform === 'win32')(
    'refuses while an installed Tailscale cannot say whether Serve forwards to it',
    async () => {
      const root = fixtureRoot();
      const tailscale = fakeTailscale(
        root,
        'echo "The Tailscale GUI failed to start" >&2\nexit 1',
      );
      const line = await expectRefusal(managedEnv(root, tailscale));
      expect(line).toContain(
        'Station cannot tell whether Tailscale Serve forwards to it',
      );
    },
    120_000,
  );

  test.skipIf(process.platform === 'win32')(
    'refuses when Tailscale Serve forwards to the MCP Apps frame origin, a listener opened after startup',
    async () => {
      const root = fixtureRoot();
      // Round 1, finding 4: the frame origin is not in the startup port
      // list, so only its own admission sees this route.
      const probe = createNetServer();
      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
      const framePort = (probe.address() as AddressInfo).port;
      await new Promise<void>((done) => probe.close(() => done()));
      const route = JSON.stringify({
        Web: {
          'n.example.ts.net:443': {
            Handlers: { '/': { Proxy: `http://127.0.0.1:${framePort}` } },
          },
        },
      });
      const tailscale = fakeTailscale(
        root,
        `if [ "$1" = serve ]; then echo '${route}'; else echo '{"BackendState":"Running"}'; fi`,
      );
      const line = await expectRefusal({
        ...managedEnv(root, tailscale),
        MCP_UI_FRAME_PORT: String(framePort),
      });
      expect(line).toContain(
        `Tailscale Serve forwards port ${framePort} to it`,
      );
    },
    180_000,
  );

  test.skipIf(process.platform === 'win32')(
    'refuses when Tailscale Serve forwards to a port an installed telemetry companion publishes',
    async () => {
      // Round 2, fix 3: the companion outlives Station, so its saved ports
      // are part of the startup check even though Station never binds them.
      const root = fixtureRoot();
      const companionPort = 51_917;
      const installationId = '01234567-89ab-4cde-8fab-0123456789ab';
      const installations = join(
        root,
        'home',
        'telemetry-companion',
        'installations',
      );
      const directory = join(installations, installationId);
      // A home the real schema gate created, as after an earlier run.
      ensureStationHomeSchemaSync(join(root, 'home'));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const dir of [
        join(root, 'home'),
        join(root, 'home', 'telemetry-companion'),
        installations,
        directory,
      ])
        chmodSync(dir, 0o700);
      writeFileSync(
        join(installations, 'current.json'),
        JSON.stringify({ installationId }),
        { mode: 0o600 },
      );
      // The shape the installer writes (`telemetry-companion-install.ts`).
      writeFileSync(
        join(directory, 'deployment.json'),
        JSON.stringify({
          owner: '1'.repeat(24),
          project: `station-telemetry-${'1'.repeat(24)}`,
          endpoint: 'unix:///fixture.sock',
          daemonId: 'daemon-fixture',
          architecture: 'arm64',
          imageId: `sha256:${'7'.repeat(64)}`,
          manifestSha256: 'b'.repeat(64),
          custody: 'c'.repeat(64),
          homeCustody: { path: join(root, 'home'), device: '1', inode: '2' },
          ports: [51_915, 51_916, companionPort],
          containerIds: ['1', '2', '3', '4', '5', '6'].map((v) => v.repeat(64)),
        }),
        { mode: 0o600 },
      );
      const route = JSON.stringify({
        TCP: { '8443': { TCPForward: `127.0.0.1:${companionPort}` } },
      });
      const tailscale = fakeTailscale(
        root,
        `if [ "$1" = serve ]; then echo '${route}'; else echo '{"BackendState":"Running"}'; fi`,
      );
      const line = await expectRefusal(managedEnv(root, tailscale));
      expect(line).toContain(
        `Tailscale Serve forwards port ${companionPort} to it`,
      );
    },
    180_000,
  );

  test('binds loopback without STATION_HOST and refuses pairing offers, access requests and nearby discovery', async () => {
    const root = fixtureRoot();
    // Absent executable: Tailscale is not installed, so nothing forwards.
    const env: Record<string, string> = managedEnv(
      root,
      join(root, 'no-tailscale'),
    );
    delete env.STATION_HOST;
    const { owned } = startServer(env);
    const child = owned.child;
    if (!('stdout' in child) || !child.stdout)
      throw new Error('Station stdout unavailable');
    let pending = '';
    const ready = new Promise<{ port: number; host: string }>(
      (resolveReady) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines)
            if (line.startsWith(readyPrefix)) resolveReady(JSON.parse(line));
        });
      },
    );
    const early = owned.completion.then((result) => {
      throw new Error(`Station exited before listening (${result.status})`);
    });
    void early.catch(() => {});
    const { port, host } = await bounded(
      Promise.race([ready, early]),
      'readiness',
      150_000,
    );
    expect(host).toBe('127.0.0.1');
    const apiBase = `http://127.0.0.1:${port}`;

    // The desktop's home-possession mint still works.
    const grant = await fetch(
      `${apiBase}/.well-known/station/v1/pairing/local-grant`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: readFileSync(
            join(env.STATION_HOME, 'runtime/local-grant.secret'),
            'utf8',
          ).trim(),
          deviceName: 'managed-clients-test',
          clientInstanceId: randomUUID(),
        }),
      },
    );
    const grantBody = await grant.text();
    expect(grant.status, grantBody).toBe(200);
    const { credential } = JSON.parse(grantBody) as { credential: string };
    const operator = (
      JSON.parse(
        readFileSync(
          join(env.STATION_HOME, 'security/environment.json'),
          'utf8',
        ),
      ) as { credential: string }
    ).credential;

    const summary = await fetch(`${apiBase}/api/settings/managed-policy`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(
      ((await summary.json()) as { data: { summary: { limits: unknown } } })
        .data.summary.limits,
    ).toEqual({ clients: ['desktop', 'local-browser'] });

    // A pairing offer, from the operator itself.
    const offer = await fetch(`${apiBase}/api/pairing/offers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operator}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint: 'https://station.example.test' }),
    });
    const offerBody = await offer.text();
    expect(offer.status, offerBody).toBe(403);
    expect(JSON.parse(offerBody)).toEqual({ error: REMOTE_CODE });

    // An access request, which anyone who can reach the server may send.
    const access = await fetch(
      `${apiBase}/.well-known/station/v1/pairing/access-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: apiBase },
        body: JSON.stringify({
          deviceName: 'Phone',
          clientInstanceId: randomUUID(),
        }),
      },
    );
    const accessBody = await access.text();
    expect(access.status, accessBody).toBe(403);
    expect(JSON.parse(accessBody)).toMatchObject({ error: REMOTE_CODE });

    // Nearby discovery: turning it on is refused with the managed sentence.
    const lan = await fetch(`${apiBase}/config/app`, {
      method: 'PUT',
      headers: {
        // The desktop's credential: the operator gate for this toggle runs
        // first, so this reaches the managed refusal.
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lanDiscoveryEnabled: true }),
    });
    const lanBody = await lan.text();
    expect(lan.status, lanBody).toBe(403);
    expect(JSON.parse(lanBody)).toMatchObject({
      success: false,
      code: REMOTE_CODE,
      error: expect.stringContaining("Acme's policy manages remote access"),
    });
  }, 300_000);

  test('binds 127.0.0.1 for STATION_HOST=localhost even when the resolver maps localhost to another address', async () => {
    const root = fixtureRoot();
    // Round 1, finding 1: a resolver (hosts file, DNS) controls `localhost`.
    // This preload maps it to every interface for any lookup in the server
    // process, so passing the name to listen() would bind 0.0.0.0.
    const preload = join(root, 'localhost-resolver.mjs');
    writeFileSync(
      preload,
      [
        "import dns from 'node:dns';",
        'const real = dns.lookup;',
        'dns.lookup = function (host, options, callback) {',
        "  if (String(host).toLowerCase() !== 'localhost') return real.apply(this, arguments);",
        "  const done = typeof options === 'function' ? options : callback;",
        "  const all = typeof options === 'object' && options !== null && options.all;",
        "  process.nextTick(() => all ? done(null, [{ address: '0.0.0.0', family: 4 }]) : done(null, '0.0.0.0', 4));",
        '};',
      ].join('\n'),
    );
    const env: Record<string, string> = {
      ...managedEnv(root, join(root, 'no-tailscale')),
      STATION_HOST: 'localhost',
    };
    const { owned } = startServer(env, [pathToFileURL(preload).href]);
    const child = owned.child;
    if (!('stdout' in child) || !child.stdout)
      throw new Error('Station stdout unavailable');
    let pending = '';
    const ready = new Promise<{ port: number; host: string }>(
      (resolveReady) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines)
            if (line.startsWith(readyPrefix)) resolveReady(JSON.parse(line));
        });
      },
    );
    const early = owned.completion.then((result) => {
      throw new Error(`Station exited before listening (${result.status})`);
    });
    void early.catch(() => {});
    const { port, host } = await bounded(
      Promise.race([ready, early]),
      'readiness',
      150_000,
    );
    expect(host).toBe('127.0.0.1');
    // Reachable on loopback, and on no other interface of this machine.
    const handshake = '/.well-known/station/v1';
    expect((await fetch(`http://127.0.0.1:${port}${handshake}`)).ok).toBe(true);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (lan)
      await expect(
        fetch(`http://${lan.address}:${port}${handshake}`, {
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toThrow();
  }, 300_000);
});
