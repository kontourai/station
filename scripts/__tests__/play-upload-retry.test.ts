import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPlayUploadFailure,
  executePlayUploadCommand,
  redactedPlayUploadDiagnostic,
  runPlayUploadWithRetry,
} from '../play-upload-retry.mjs';

const FIXTURE = resolve(
  import.meta.dirname,
  'helpers/play-upload-child.fixture.mjs',
);
const WRAPPER = resolve(import.meta.dirname, '../play-upload-retry.mjs');
const tempDirectories: string[] = [];
const ownedPids = new Set<number>();

afterEach(() => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  ownedPids.clear();
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'station-play-upload-'));
  tempDirectories.push(directory);
  return directory;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPid(output: string) {
  const match = /child-pid=(\d+)/.exec(output);
  if (!match?.[1]) throw new Error(`fixture child pid missing from: ${output}`);
  return Number(match[1]);
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function waitForChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    },
  );
}

function result(exitCode: number, output: string) {
  return { exitCode, output };
}

describe('Play upload retry', () => {
  it('retries a transient provider outage and succeeds with the identical command', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(result(1, 'The service is currently unavailable.'))
      .mockResolvedValueOnce(result(0, 'committed'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const command = '/usr/bin/node';
    const args = ['/runner/upload-google-play.js'];
    const env = { INPUT_RELEASEFILES: '/build/station-nightly.aab' };

    await expect(
      runPlayUploadWithRetry({
        command,
        args,
        env,
        execute,
        sleep,
        random: () => 0,
        baseDelayMs: 10,
        maxDelayMs: 100,
        log: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true, attempts: 2, classification: 'success' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toEqual(execute.mock.calls[1]?.[0]);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ command, args, env });
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('stops after the bounded transient attempt budget', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue(result(1, 'backendError: service unavailable'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      runPlayUploadWithRetry({
        command: 'node',
        execute,
        sleep,
        random: () => 0,
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxAttempts: 3,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      attempts: 3,
      classification: 'transient-exhausted',
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it.each([
    '401 Unauthorized: invalid_grant',
    '403 Forbidden: insufficient permissions',
    'Validation Failed: invalid AAB',
    'Version code 242802 has already been used',
    'Release rejected by policy',
  ])('does not retry a permanent failure: %s', async (diagnostic) => {
    const execute = vi.fn().mockResolvedValue(result(1, diagnostic));
    const sleep = vi.fn();
    const outcome = await runPlayUploadWithRetry({
      command: 'node',
      execute,
      sleep,
      log: vi.fn(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      attempts: 1,
      classification: 'permanent',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('lets a permanent signal override a coincidental transient phrase', () => {
    expect(
      classifyPlayUploadFailure(
        '403 Forbidden: policy denied while service is currently unavailable',
      ),
    ).toBe('permanent');
    expect(classifyPlayUploadFailure('unknown upload failure')).toBe(
      'permanent',
    );
    expect(classifyPlayUploadFailure('provider request timed out')).toBe(
      'permanent',
    );
    expect(
      classifyPlayUploadFailure('provider request timed out', {
        timedOut: true,
      }),
    ).toBe('transient');
    expect(
      classifyPlayUploadFailure('403 Forbidden: request timed out', {
        timedOut: true,
      }),
    ).toBe('permanent');
    expect(
      classifyPlayUploadFailure(
        'Version code 242802 rejected by policy after timeout',
        { timedOut: true },
      ),
    ).toBe('permanent');
  });

  it('redacts credentials and bounds the diagnostic emitted to logs', () => {
    const diagnostic = redactedPlayUploadDiagnostic(
      `Authorization: Bearer secret-token\nprivate_key=secret-key\n${'safe-output '.repeat(500)}`,
    );
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).toContain('private_key=[REDACTED]');
    expect(diagnostic).not.toContain('secret-token');
    expect(diagnostic.length).toBeLessThanOrEqual(4_001);
    expect(diagnostic.endsWith('…')).toBe(true);
  });

  it('runs a real upload child through normal completion', async () => {
    const outcome = await executePlayUploadCommand({
      command: process.execPath,
      args: [FIXTURE, 'normal'],
      env: process.env,
      attemptTimeoutMs: 1_000,
      terminationGraceMs: 100,
    });
    expect(outcome).toMatchObject({
      exitCode: 0,
      timedOut: false,
      escalated: false,
    });
    expect(processIsAlive(childPid(outcome.output))).toBe(false);
  });

  it('terminates and awaits a timed-out real upload child', async () => {
    const outcome = await executePlayUploadCommand({
      command: process.execPath,
      args: [FIXTURE, 'hang'],
      env: process.env,
      attemptTimeoutMs: 100,
      terminationGraceMs: 200,
    });
    expect(outcome).toMatchObject({
      exitCode: 1,
      timedOut: true,
      escalated: false,
    });
    expect(outcome.output).toContain('received-SIGTERM');
    expect(outcome.output).toContain(
      'wrapper-owned Play upload attempt timeout',
    );
    expect(processIsAlive(childPid(outcome.output))).toBe(false);
  });

  it('escalates teardown when the timed-out child ignores TERM', async () => {
    const outcome = await executePlayUploadCommand({
      command: process.execPath,
      args: [FIXTURE, 'ignore-signals'],
      env: process.env,
      attemptTimeoutMs: 100,
      terminationGraceMs: 100,
    });
    expect(outcome).toMatchObject({
      exitCode: 1,
      timedOut: true,
      escalated: true,
    });
    expect(outcome.output).toContain('received-SIGTERM');
    expect(processIsAlive(childPid(outcome.output))).toBe(false);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)(
    'forwards %s through the real wrapper and leaves no uploader orphan',
    async (signal, expectedCode) => {
      const readyPath = join(temporaryDirectory(), 'child.pid');
      const wrapper = spawn(process.execPath, [WRAPPER], {
        env: {
          ...process.env,
          PLAY_UPLOAD_ACTION_PATH: FIXTURE,
          PLAY_UPLOAD_FIXTURE_MODE: 'hang',
          PLAY_UPLOAD_FIXTURE_READY: readyPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      ownedPids.add(wrapper.pid as number);
      await waitForFile(readyPath);
      const uploadPid = Number(readFileSync(readyPath, 'utf8'));
      ownedPids.add(uploadPid);
      const closedPromise = waitForChild(wrapper);
      wrapper.kill(signal);
      const closed = await closedPromise;
      ownedPids.delete(wrapper.pid as number);
      ownedPids.delete(uploadPid);
      expect(closed).toEqual({ code: expectedCode, signal: null });
      expect(processIsAlive(uploadPid)).toBe(false);
    },
  );

  it('retries a real transient child only after teardown completes', async () => {
    const statePath = join(temporaryDirectory(), 'attempts');
    const outcome = await runPlayUploadWithRetry({
      command: process.execPath,
      args: [FIXTURE, 'transient-once', statePath],
      env: process.env,
      sleep: vi.fn().mockResolvedValue(undefined),
      random: () => 0,
      baseDelayMs: 1,
      maxDelayMs: 2,
      attemptTimeoutMs: 1_000,
      terminationGraceMs: 100,
      log: vi.fn(),
    });
    expect(outcome).toEqual({
      ok: true,
      attempts: 2,
      classification: 'success',
    });
    expect(readFileSync(statePath, 'utf8')).toBe('2');
  });

  it.each(['hang-403', 'hang-policy-version'] as const)(
    'does not retry a timed-out real child with permanent evidence: %s',
    async (mode) => {
      const sleep = vi.fn();
      const outcome = await runPlayUploadWithRetry({
        command: process.execPath,
        args: [FIXTURE, mode],
        env: process.env,
        sleep,
        maxAttempts: 3,
        attemptTimeoutMs: 100,
        terminationGraceMs: 200,
        log: vi.fn(),
      });
      expect(outcome).toMatchObject({
        ok: false,
        attempts: 1,
        classification: 'permanent',
      });
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
