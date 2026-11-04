/**
 * #4518: the managed approval ceiling at the real server entrypoint.
 *
 * Boots `src-server/index.ts` as a child process with an isolated home and an
 * injected policy (`STATION_MANAGED_POLICY_TEST_FILE`), so the ceiling is
 * installed exactly as production installs it: by the entrypoint, after the
 * policy loads and before the runtime is built. Then, over HTTP:
 * - the summary exposes the ceiling;
 * - a thread's mode switch above it is refused with the managed message;
 * A policy whose managed default is above its own ceiling never starts.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const DENIAL =
  "Acme's policy manages approval modes: the broadest allowed is Ask first. For help, visit https://help.acme.example/station";

type Owned = ReturnType<typeof executeOwnedCommand>;
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

function boot(policy: unknown) {
  const root = makeTempDir('station-approval-ceiling-');
  chmodSync(root, 0o700);
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  const osHome = join(root, 'os-home');
  const temp = join(root, 'tmp');
  for (const dir of [osHome, temp]) mkdirSync(dir, { recursive: true });
  const env = {
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
    // An ephemeral port: never the operator's 3141, 3000 or 3774.
    PORT: '0',
    STATION_INSTANCE: 'approval-ceiling-fixture',
    STATION_INSTANCE_ID: 'approval-ceiling-fixture',
    STATION_STDOUT_HANDSHAKE: '1',
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    STATION_MANAGED_POLICY_TEST_FILE: policyPath,
  };
  const owned: Owned = executeOwnedCommand(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(repoRoot, 'src-server/index.ts'),
    ],
    spawn,
    'approval-ceiling Station',
    {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const capture = captureOwnedProcessOutput(owned, { maxBytes: 512 * 1024 });
  cleanups.push(async () => {
    const result = await terminateSuiteExecution(owned, {
      waitForSuiteSettlement,
      terminationGraceMs: 15_000,
      terminationForceMs: 5_000,
      processLabel: 'approval-ceiling Station',
    });
    capture.finish();
    expect(result.errors).toEqual([]);
  });
  return { owned, capture, env, policyPath };
}

async function listening(owned: Owned): Promise<number> {
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
  return bounded(Promise.race([ready, early]), 'readiness', 150_000);
}

describe('#4518: the managed approval ceiling at real server startup', () => {
  test('a ceiling of ask is reported, and a mode switch above it is refused', async () => {
    const { owned, env } = boot({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.acme.example/station',
      limits: { maxApprovalMode: 'ask' },
    });
    const apiBase = `http://127.0.0.1:${await listening(owned)}`;
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
          deviceName: 'approval-ceiling-test',
          clientInstanceId: randomUUID(),
        }),
      },
    );
    const grantBody = await grant.text();
    expect(grant.status, grantBody).toBe(200);
    const { credential } = JSON.parse(grantBody) as { credential: string };
    const authorized = (init: RequestInit = {}) => ({
      ...init,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const status = await fetch(
      `${apiBase}/api/settings/managed-policy`,
      authorized(),
    );
    expect(status.status).toBe(200);
    expect(
      ((await status.json()) as { data: { summary: { limits: unknown } } }).data
        .summary.limits,
    ).toEqual({ maxApprovalMode: 'ask' });

    // A thread's mode switch: refused at the commands route, before the
    // thread is looked up, with the managed message and code.
    const pick = await fetch(
      `${apiBase}/api/orchestration/commands`,
      authorized({
        method: 'POST',
        body: JSON.stringify({
          type: 'setApprovalMode',
          threadId: 'thread-under-ceiling',
          approvalMode: 'auto',
          basedOnSequence: null,
        }),
      }),
    );
    const pickText = await pick.text();
    expect(pick.status, pickText).toBe(403);
    expect(JSON.parse(pickText)).toEqual({
      success: false,
      code: 'managed-policy-approval-ceiling',
      error: DENIAL,
    });
  }, 300_000);

  test('a managed default above the policy’s own ceiling refuses startup', async () => {
    const { owned, capture, policyPath } = boot({
      schemaVersion: 1,
      organization: 'Acme',
      settings: { defaultApprovalMode: { value: 'never', locked: false } },
      limits: { maxApprovalMode: 'auto' },
    });
    const result = await bounded(owned.completion, 'refused boot', 90_000);
    const { stdout, stderr } = capture.finish();
    expect(result.status).toBe(1);
    expect(stdout.text).not.toContain(readyPrefix);
    const markerLine = stderr.text
      .split('\n')
      .find((line) => line.startsWith(`${MARKER}:`));
    expect(markerLine, stderr.text.slice(-3000)).toBeDefined();
    expect(markerLine).toContain(policyPath);
    expect(markerLine).toContain(
      'settings.defaultApprovalMode.value: "never" is broader than limits.maxApprovalMode ("auto")',
    );
    // Settings parse since #4517: the cross-check is the only problem.
    expect(markerLine).not.toContain('not supported');
  }, 300_000);
});
