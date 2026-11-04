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
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
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
  expect(result.status).toBe(1);
  // It never listened.
  expect(stdout.text).not.toContain(readyPrefix);
  const markerLine = stderr.text
    .split('\n')
    .find((line) => line.startsWith(`${MARKER}:`));
  expect(markerLine, stderr.text.slice(-3000)).toBeDefined();
  expect(markerLine).toContain(policyPath);
  return { stderr: markerLine as string, fullStderr: stderr.text, policyPath };
}

describe('managed policy at real server startup', () => {
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
      name: 'a limits key this build does not enforce',
      body: JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        limits: { telemetry: false },
      }),
      reason:
        'limits.telemetry: this limit is not supported by this version of Station',
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
        execFileSync('mkfifo', [path]),
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
          deviceName: 'managed-policy-test',
          clientInstanceId: randomUUID(),
        }),
      },
    );
    const grantBody = await grant.text();
    expect(grant.status, grantBody).toBe(200);
    const { credential } = JSON.parse(grantBody) as { credential: string };
    expect(credential).toBeTruthy();

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
});
