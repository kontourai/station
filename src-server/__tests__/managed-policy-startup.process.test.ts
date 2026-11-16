/**
 * #4516: the real server entrypoint loads the managed policy before the
 * runtime is built and refuses to start when it cannot enforce it.
 *
 * Every case boots `src-server/index.ts` as a child process with an isolated
 * home and an injected policy (the test override), and asserts the exit
 * status and the marker line the desktop sidecar and the CLI key on. The
 * valid case also reads the summary endpoint and runs `station policy show`
 * against the same server.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EVERY_KEY_ENGINE_GATEWAY,
  EVERY_KEY_ENGINE_SUMMARY,
  EVERY_KEY_FEED_URL,
  EVERY_KEY_POLICY,
  EVERY_KEY_SUMMARY_LIMITS,
} from '../../packages/contracts/src/__tests__/managed-policy-every-key.fixture.js';
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
  const root = makeTempDir('station-managed-policy-');
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
    STATION_INSTANCE: 'managed-policy-fixture',
    STATION_INSTANCE_ID: 'managed-policy-fixture',
    STATION_STDOUT_HANDSHAKE: '1',
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    STATION_MANAGED_POLICY_TEST_FILE: policyPath,
  };
}

function startServer(env: Record<string, string>) {
  const owned: Owned = executeOwnedCommand(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(repoRoot, 'src-server/index.ts'),
    ],
    spawn,
    'managed-policy Station',
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
      processLabel: 'managed-policy Station',
    });
    expect(result.errors).toEqual([]);
  };
  cleanups.push(async () => {
    await stop();
    capture.finish();
  });
  return { owned, capture, stop };
}

/** Boot with `policy` at the override path; expect a fail-closed exit. */
async function expectRefusal(
  install: (policyPath: string) => void,
): Promise<{ stderr: string; fullStderr: string; policyPath: string }> {
  const root = fixtureRoot();
  const policyPath = join(root, 'policy.json');
  install(policyPath);
  const { owned, capture } = startServer(isolatedEnv(root, policyPath));
  const result = await bounded(owned.completion, 'refused boot', 90_000);
  const { stdout, stderr } = capture.finish();
  expect(result.status).toBe(78);
  // It never listened.
  expect(stdout.text).not.toContain(readyPrefix);
  const markerLine = stderr.text
    .split('\n')
    .find((line) => line.startsWith(`${MARKER}:`));
  expect(markerLine, stderr.text.slice(-3000)).toBeDefined();
  expect(markerLine).toContain(policyPath);
  return { stderr: markerLine as string, fullStderr: stderr.text, policyPath };
}

/** Boot a server on `policyPath` and mint a local credential for it. */
async function bootWithGrant(
  root: string,
  policyPath: string,
  extraEnv: Record<string, string> = {},
) {
  const env = { ...isolatedEnv(root, policyPath), ...extraEnv };
  const { owned } = startServer(env);
  const child = owned.child;
  if (!('stdout' in child) || !child.stdout)
    throw new Error('Station stdout unavailable');
  let pending = '';
  const ready = new Promise<number>((resolveReady) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines)
        if (line.startsWith(readyPrefix))
          resolveReady(JSON.parse(line).port as number);
    });
  });
  const early = owned.completion.then((result) => {
    throw new Error(`Station exited before listening (${result.status})`);
  });
  void early.catch(() => {});
  const port = await bounded(
    Promise.race([ready, early]),
    'readiness',
    150_000,
  );
  const apiBase = `http://127.0.0.1:${port}`;

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
        deviceName: 'managed-policy-test',
        clientInstanceId: randomUUID(),
      }),
    },
  );
  const grantBody = await grant.text();
  expect(grant.status, grantBody).toBe(200);
  const { credential } = JSON.parse(grantBody) as { credential: string };
  expect(credential).toBeTruthy();

  return { env, apiBase, credential };
}

describe('managed policy at real server startup', () => {
  test('a home-reset refusal exits with the same terminal startup code', async () => {
    const root = fixtureRoot();
    const policyPath = join(root, 'policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
    );
    const env = isolatedEnv(root, policyPath);
    mkdirSync(env.STATION_HOME, { recursive: true });
    writeFileSync(join(env.STATION_HOME, 'legacy-data.json'), '{}');
    const { owned, capture } = startServer(env);
    const result = await bounded(owned.completion, 'home refusal', 90_000);
    const { stdout, stderr } = capture.finish();
    expect(result.status, stderr.text).toBe(78);
    expect(stderr.text).toContain('STATION_HOME_RESET_REQUIRED:');
    expect(stdout.text).not.toContain(readyPrefix);
  }, 120_000);

  test.each([
    {
      name: 'invalid JSON',
      body: '{"schemaVersion": 1, "organization": ',
      reason: 'it is not valid JSON',
    },
    {
      name: 'an unknown key',
      body: JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        allowEverything: true,
      }),
      reason: 'allowEverything: unknown key',
    },
    {
      name: 'a wrong schemaVersion',
      body: JSON.stringify({ schemaVersion: 2, organization: 'Acme' }),
      reason: 'schemaVersion: 2 is newer than this version of Station',
    },
    {
      name: 'a limits key this build does not know',
      body: JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        // Every planned limit is enforced (#4515): no reserved key remains.
        limits: { retentionDays: 30 },
      }),
      reason:
        'limits.retentionDays: unknown limit; this version of Station refuses keys it cannot enforce',
    },
    {
      name: 'a schema mismatch (organization is not a string)',
      body: JSON.stringify({ schemaVersion: 1, organization: 7 }),
      reason: 'organization: must be a non-empty single line',
    },
  ])(
    'refuses to start on $name',
    async ({ body, reason }) => {
      const { stderr } = await expectRefusal((path) =>
        writeFileSync(path, body),
      );
      expect(stderr).toContain(reason);
    },
    120_000,
  );

  test('refuses to start on a duplicate key instead of keeping the last one', async () => {
    const { stderr } = await expectRefusal((path) =>
      writeFileSync(
        path,
        '{"schemaVersion":1,"organization":"Admin","limits":{"telemetry":false},"limits":{}}',
      ),
    );
    expect(stderr).toContain('duplicate key limits');
  }, 120_000);

  test.skipIf(process.platform === 'win32')(
    'refuses to start on a symbolic link, even a dangling one, instead of reading it as absent',
    async () => {
      // Dangling: without the refusal this read as "no policy", and the
      // test override would then be the one to report a missing file.
      const dangling = await expectRefusal((path) =>
        symlinkSync(`${path}.absent`, path),
      );
      expect(dangling.stderr).toContain('it is a symbolic link');
    },
    120_000,
  );

  test.skipIf(process.platform === 'win32')(
    'refuses to start promptly on a FIFO instead of blocking on open',
    async () => {
      const { stderr } = await expectRefusal((path) =>
        execFileSync('mkfifo', [path], { windowsHide: true }),
      );
      expect(stderr).toContain('it is not a regular file');
    },
    120_000,
  );

  test('a huge unknown key yields a bounded diagnostic that starts with the marker', async () => {
    const key = 'k'.repeat(100_000);
    const { fullStderr, stderr } = await expectRefusal((path) =>
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, organization: 'A', [key]: true }),
      ),
    );
    // The desktop sidecar keeps a 64 KiB tail and matches the leading
    // marker; the whole stderr must stay far below that.
    expect(fullStderr.length).toBeLessThan(16 * 1024);
    expect(fullStderr.startsWith(`${MARKER}:`), fullStderr.slice(0, 200)).toBe(
      true,
    );
    expect(stderr.length).toBeLessThan(4096);
    expect(stderr).toContain('(100000 characters)');
  }, 120_000);

  test('refuses to start when the policy path is a directory', async () => {
    const { stderr } = await expectRefusal((path) => mkdirSync(path));
    expect(stderr).toContain('it is a directory, not a file');
  }, 120_000);

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to start when the policy file is unreadable',
    async () => {
      const { stderr } = await expectRefusal((path) => {
        writeFileSync(
          path,
          JSON.stringify({ schemaVersion: 1, organization: 'A' }),
        );
        chmodSync(path, 0o000);
      });
      expect(stderr).toContain('the file cannot be read (permission denied)');
    },
    120_000,
  );

  test('a valid policy starts, the endpoint reports its digest, and show tracks restarts', async () => {
    const root = fixtureRoot();
    const policyPath = join(root, 'policy.json');
    writeFileSync(
      policyPath,
      // Deliberately not canonical: key order and whitespace differ from
      // the fingerprinted bytes below.
      `{\n  "supportUrl": "https://help.example/station",\n  "schemaVersion": 1,\n  "organization": "Acme"\n}\n`,
    );
    // Independent of the code under test: sorted keys, no whitespace.
    const expectedDigest = `sha256:${createHash('sha256')
      .update(
        '{"organization":"Acme","schemaVersion":1,"supportUrl":"https://help.example/station"}',
      )
      .digest('hex')}`;
    const { env, apiBase, credential } = await bootWithGrant(root, policyPath);
    const unauthenticated = await fetch(
      `${apiBase}/api/settings/managed-policy`,
    );
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`${apiBase}/api/settings/managed-policy`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        state: 'loaded',
        source: { kind: 'test-override', location: policyPath },
        digest: expectedDigest,
        summary: {
          organization: 'Acme',
          supportUrl: 'https://help.example/station',
          lockedSettings: [],
          limits: {},
        },
      },
    });

    const show = async () => {
      const cli = executeOwnedCommand(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          join(repoRoot, 'scripts/station-cli.ts'),
          'policy',
          'show',
          '--json',
          `--api-base=${apiBase}`,
          `--credential=${credential}`,
        ],
        spawn,
        'policy show',
        {
          cwd: repoRoot,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      );
      const output = captureOwnedProcessOutput(cli, { maxBytes: 256 * 1024 });
      const result = await bounded(cli.completion, 'policy show', 60_000);
      const { stdout, stderr } = output.finish();
      expect(result.status, stderr.text).toBe(0);
      return JSON.parse(stdout.text) as {
        installed: { state: string; digest?: string };
        running: { state: string };
        restartNeeded: boolean | null;
      };
    };

    const inSync = await show();
    expect(inSync.installed).toMatchObject({
      state: 'installed',
      digest: expectedDigest,
    });
    expect(inSync.running.state).toBe('read');
    expect(inSync.restartNeeded).toBe(false);

    // Edit the installed policy without restarting the server.
    writeFileSync(
      policyPath,
      JSON.stringify({ schemaVersion: 1, organization: 'Acme Corp' }),
    );
    const stale = await show();
    expect(stale.installed.state).toBe('installed');
    expect(stale.installed.digest).not.toBe(expectedDigest);
    expect(stale.restartNeeded).toBe(true);
  }, 300_000);

  test('refuses to start on a managed setting Station cannot apply (#4517)', async () => {
    const unknown = await expectRefusal((policyPath) =>
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          settings: { noSuchSetting: { value: 1, locked: true } },
        }),
      ),
    );
    expect(unknown.stderr).toContain('settings.noSuchSetting: unknown setting');

    // The contract parser cannot see a composite's structure; the server
    // checks it against the settings schema before it listens.
    const composite = await expectRefusal((policyPath) =>
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          settings: {
            approvalGuardian: { value: { mode: 'sometimes' }, locked: true },
          },
        }),
      ),
    );
    expect(composite.stderr).toContain(
      'a managed setting does not match the settings schema',
    );
  }, 300_000);

  test('a locked setting reaches the endpoint with managed provenance and refuses writes (#4517)', async () => {
    const root = fixtureRoot();
    const policyPath = join(root, 'policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        supportUrl: 'https://help.example/station',
        settings: {
          defaultMaxTurns: { value: 40, locked: true },
          checkoutStaleAfterDays: { value: 9, locked: false },
        },
      }),
    );
    const env = isolatedEnv(root, policyPath);
    const { owned } = startServer(env);
    const child = owned.child;
    if (!('stdout' in child) || !child.stdout)
      throw new Error('Station stdout unavailable');
    let pending = '';
    const ready = new Promise<number>((resolveReady) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines)
          if (line.startsWith(readyPrefix))
            resolveReady(JSON.parse(line).port as number);
      });
    });
    const early = owned.completion.then((result) => {
      throw new Error(`Station exited before listening (${result.status})`);
    });
    void early.catch(() => {});
    const port = await bounded(
      Promise.race([ready, early]),
      'readiness',
      150_000,
    );
    const apiBase = `http://127.0.0.1:${port}`;
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
          deviceName: 'managed-settings-test',
          clientInstanceId: randomUUID(),
        }),
      },
    );
    const grantBody = await grant.text();
    expect(grant.status, grantBody).toBe(200);
    const { credential } = JSON.parse(grantBody) as { credential: string };
    const auth = { Authorization: `Bearer ${credential}` };

    const read = await fetch(`${apiBase}/config/app`, { headers: auth });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      data: Record<string, unknown>;
      provenance: Record<string, unknown>;
    };
    expect(body.data.defaultMaxTurns).toBe(40);
    expect(body.data.checkoutStaleAfterDays).toBe(9);
    const managed = (locked: boolean) => ({
      source: 'managed',
      locked,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
    });
    expect(body.provenance.defaultMaxTurns).toEqual(managed(true));
    expect(body.provenance.checkoutStaleAfterDays).toEqual(managed(false));

    const status = await fetch(`${apiBase}/api/settings/managed-policy`, {
      headers: auth,
    });
    expect(
      ((await status.json()) as { data: { summary: unknown } }).data.summary,
    ).toEqual({
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      lockedSettings: ['defaultMaxTurns'],
      limits: {},
    });

    const write = await fetch(`${apiBase}/config/app`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultMaxTurns: 9 }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toBe(
      "Acme's policy manages this setting. For help, visit https://help.example/station",
    );
    // Policy values never reach the user's file.
    const stored = JSON.parse(
      readFileSync(join(env.STATION_HOME, 'config', 'app.json'), 'utf8'),
    );
    expect(stored).not.toHaveProperty('defaultMaxTurns');
    expect(stored).not.toHaveProperty('checkoutStaleAfterDays');
  }, 300_000);
});

describe('the managed update limit at a real server (#4522)', () => {
  test('off refuses the core update check and apply, and the summary never carries the feed URL', async () => {
    const root = fixtureRoot();
    const policyPath = join(root, 'policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        limits: {
          updates: {
            mode: 'off',
            feedUrl: 'https://mirror.example/feed-secret-token/',
            allowNightly: false,
          },
        },
      }),
    );
    const { apiBase, credential } = await bootWithGrant(root, policyPath);
    const headers = { Authorization: `Bearer ${credential}` };

    const summary = await fetch(`${apiBase}/api/settings/managed-policy`, {
      headers,
    });
    const summaryText = await summary.text();
    expect(summary.status, summaryText).toBe(200);
    expect(summaryText).not.toContain('feed-secret-token');
    expect(JSON.parse(summaryText).data.summary.limits).toEqual({
      updates: { mode: 'off', mirror: true, allowNightly: false },
    });

    const check = await fetch(`${apiBase}/api/system/core-update`, {
      headers,
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      updateAvailable: false,
      managedPolicyCode: 'managed-policy-updates-refused',
      message: "This machine's managed policy turns off Station updates.",
    });

    const apply = await fetch(`${apiBase}/api/system/core-update`, {
      method: 'POST',
      headers,
    });
    expect(apply.status).toBe(403);
    expect(await apply.json()).toMatchObject({
      code: 'managed-policy-updates-refused',
    });
  }, 300_000);
});

describe('every enforced key at a real server (#4515)', () => {
  // The combined policy the contracts round trip and `station policy check`
  // use. Startup composes every slice's installation (settings overlay,
  // capability switches, listener admission, update limit), so one boot
  // proves they load together and each still enforces.
  test('starts, reports every limit as clients see it, and each slice still refuses', async () => {
    const root = fixtureRoot();
    const policyPath = join(root, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(EVERY_KEY_POLICY));
    const { apiBase, credential } = await bootWithGrant(root, policyPath);
    const headers = { Authorization: `Bearer ${credential}` };

    const summary = await fetch(`${apiBase}/api/settings/managed-policy`, {
      headers,
    });
    const summaryText = await summary.text();
    expect(summary.status, summaryText).toBe(200);
    expect(summaryText).not.toContain(EVERY_KEY_FEED_URL);
    expect(summaryText).not.toContain(EVERY_KEY_ENGINE_GATEWAY);
    expect(JSON.parse(summaryText).data.summary).toEqual({
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      lockedSettings: ['defaultMaxTurns'],
      limits: EVERY_KEY_SUMMARY_LIMITS,
      engines: EVERY_KEY_ENGINE_SUMMARY,
    });

    // #4522: updates are off.
    const check = await fetch(`${apiBase}/api/system/core-update`, {
      headers,
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({
      managedPolicyCode: 'managed-policy-updates-refused',
    });

    // #4521: inbound webhooks are refused before anything is read.
    const webhook = await fetch(`${apiBase}/api/webhooks/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const webhookText = await webhook.text();
    expect(webhook.status, webhookText).toBe(403);
    expect(JSON.parse(webhookText).code).toBe(
      'managed-policy-capability-disabled',
    );

    // #4517: the locked setting is in effect and refuses a write.
    const write = await fetch(`${apiBase}/config/app`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultMaxTurns: 41 }),
    });
    const writeText = await write.text();
    expect(write.status, writeText).toBe(403);
    expect(JSON.parse(writeText).code).toBe('managed_setting_locked');
  }, 300_000);
});

// Engine programs installed on the test's own PATH, so the engine-default
// Agents are listed whether or not the host has the real CLIs. Each one only
// reports a version.
function installedEngines(root: string): Record<string, string> {
  const bin = join(root, 'installed-engines');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'muse'])
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} 1.0.0"\n`, {
      mode: 0o755,
    });
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    STATION_DISABLE_LOGIN_PATH_RESOLVE: '1',
  };
}

describe.skipIf(process.platform === 'win32')(
  '#4515: a disallowed engine answers the managed refusal on the real chat and delegation routes',
  () => {
    // No injected refusal: the real server, the real connection inspector
    // (which reads a disallowed engine as disabled), the real Agent catalog
    // and the real execution-target resolver. The verifier saw these answer
    // 400 "Codex is turned off." under a policy that does not allow codex.
    const send = async (
      apiBase: string,
      credential: string,
      route: 'chat' | 'delegations',
      agent: string,
    ) => {
      const target = { environment: { kind: 'current' }, agent };
      const body =
        route === 'chat'
          ? {
              target,
              conversationId: `chat:${randomUUID()}`,
              clientTurnId: randomUUID(),
              message: 'hello',
            }
          : { target, prompt: 'hello', clientTurnId: randomUUID() };
      const response = await fetch(`${apiBase}/api/orchestration/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as { error?: string; code?: string },
      };
    };

    // The engine-default Agents are listed once the connections are
    // inspected; wait for codex as a person opening the picker would.
    const waitForAgent = async (
      apiBase: string,
      credential: string,
      slug: string,
    ) => {
      const deadline = Date.now() + 120_000;
      let last = 0;
      while (Date.now() < deadline) {
        const response = await fetch(`${apiBase}/api/agents/${slug}`, {
          headers: { Authorization: `Bearer ${credential}` },
        });
        last = response.status;
        await response.body?.cancel();
        if (response.ok) return;
        await new Promise((wait) => setTimeout(wait, 500));
      }
      throw new Error(`the ${slug} Agent was never listed (last ${last})`);
    };

    test('with codex not allowed, chat and delegation answer 403 with the code and the organization', async () => {
      const root = fixtureRoot();
      const policyPath = join(root, 'policy.json');
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { engines: { allowed: ['claude', 'station-agent'] } },
        }),
      );
      const { apiBase, credential } = await bootWithGrant(
        root,
        policyPath,
        installedEngines(root),
      );
      await waitForAgent(apiBase, credential, 'codex');
      for (const route of ['chat', 'delegations'] as const) {
        const { status, body } = await send(
          apiBase,
          credential,
          route,
          'codex',
        );
        expect(status, `${route}: ${JSON.stringify(body)}`).toBe(403);
        expect(body.code, route).toBe('managed-policy-engine-refused');
        expect(body.error, route).toContain(
          "Acme's policy manages which engines run on this computer: codex is not allowed",
        );
      }
    }, 300_000);

    test('control: an engine the user turned off keeps the plain message', async () => {
      const root = fixtureRoot();
      const policyPath = join(root, 'policy.json');
      // A policy that limits nothing about engines.
      writeFileSync(
        policyPath,
        JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
      );
      const { apiBase, credential } = await bootWithGrant(
        root,
        policyPath,
        installedEngines(root),
      );
      const off = await fetch(`${apiBase}/config/app`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentConnections: { codex: { enabled: false } },
        }),
      });
      expect(off.status).toBe(200);
      await waitForAgent(apiBase, credential, 'codex');
      for (const route of ['chat', 'delegations'] as const) {
        const { status, body } = await send(
          apiBase,
          credential,
          route,
          'codex',
        );
        expect(status, `${route}: ${JSON.stringify(body)}`).toBe(400);
        expect(body.error, route).toBe('Codex is turned off.');
        expect(body.code, route).toBeUndefined();
      }
    }, 300_000);
  },
);

describe.skipIf(process.platform === 'win32')(
  '#4515: a disallowed engine program is never run, at boot, for Accounts or for system status',
  () => {
    // Executables named for each engine, first on the server's PATH, that
    // record every run. The login-shell PATH is not consulted, so nothing
    // else of the same name can be found instead.
    const markerEngines = (root: string) => {
      const bin = join(root, 'engines-bin');
      const log = join(root, 'engine-runs.log');
      mkdirSync(bin, { recursive: true });
      for (const name of ['claude', 'codex', 'muse'])
        writeFileSync(
          join(bin, name),
          `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> ${JSON.stringify(log)}\nexit 1\n`,
          { mode: 0o755 },
        );
      return {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          STATION_DISABLE_LOGIN_PATH_RESOLVE: '1',
        },
        runs: () =>
          existsSync(log)
            ? readFileSync(log, 'utf8').split('\n').filter(Boolean)
            : [],
      };
    };

    const exercise = async (allowed: string[]) => {
      const root = fixtureRoot();
      const policyPath = join(root, 'policy.json');
      writeFileSync(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { engines: { allowed } },
        }),
      );
      const engines = markerEngines(root);
      const { apiBase, credential } = await bootWithGrant(
        root,
        policyPath,
        engines.env,
      );
      const get = async (path: string) => {
        const response = await fetch(`${apiBase}${path}`, {
          headers: { Authorization: `Bearer ${credential}` },
        });
        const text = await response.text();
        return { status: response.status, text };
      };
      // The engine connections are listed once inspection completes.
      const accounts: Record<string, { status: number; text: string }> = {};
      for (const engine of ['claude', 'codex']) {
        const deadline = Date.now() + 120_000;
        do {
          accounts[engine] = await get(
            `/api/connections/agent/${engine}/accounts`,
          );
          if (accounts[engine].status !== 404) break;
          await new Promise((wait) => setTimeout(wait, 500));
        } while (Date.now() < deadline);
        if (accounts[engine].status === 404)
          accounts[engine].text +=
            ` connections: ${(await get('/api/connections')).text.slice(0, 3000)}`;
      }
      const status = await get('/api/system/status');
      // Boot priming is fire-and-forget; give every probe it or the
      // requests above started time to run before reading the record.
      await new Promise((wait) => setTimeout(wait, 5_000));
      return { accounts, status, runs: engines.runs() };
    };

    test('with no engine allowed, nothing named for an engine runs', async () => {
      const { accounts, status, runs } = await exercise([]);
      for (const [engine, answer] of Object.entries(accounts))
        expect(answer.status, `${engine}: ${answer.text}`).toBe(200);
      expect(status.status, status.text).toBe(200);
      expect(runs).toEqual([]);
    }, 300_000);

    test('control: with claude and codex allowed, the same boot and requests run both', async () => {
      const { accounts, status, runs } = await exercise([
        'claude',
        'codex',
        'station-agent',
      ]);
      for (const [engine, answer] of Object.entries(accounts))
        expect(answer.status, `${engine}: ${answer.text}`).toBe(200);
      expect(status.status, status.text).toBe(200);
      const ran = new Set(runs.map((line) => line.split(' ')[0]));
      expect([...ran].sort(), runs.join('\n')).toEqual(
        expect.arrayContaining(['claude', 'codex']),
      );
      expect(ran.has('muse'), runs.join('\n')).toBe(false);
    }, 300_000);
  },
);
