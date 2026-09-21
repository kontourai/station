import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireStationHomeRuntimeLease } from '@kontourai/station-shared/station-home-lifecycle';
import { calculateJwkThumbprint } from 'jose';
import { afterEach, expect, test } from 'vitest';
import { localLabEnvironment } from '../lib/local-collaboration-process.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-connector-identity-'));
  roots.push(dir);
  return dir;
}

async function run(home: string) {
  const execution = executeOwnedCommand(
    process.execPath,
    ['--import', 'tsx', 'scripts/self-hosted-connector-identity.ts', home],
    spawn,
    'connector identity CLI test',
    {
      cwd: resolve(import.meta.dirname, '../..'),
      windowsHide: true,
      env: localLabEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = captureOwnedProcessOutput(execution, { maxBytes: 16 * 1024 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execution.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Connector identity CLI exceeded liveness bound')),
          30000,
        );
      }),
    ]);
    const output = capture.finish();
    expect(output.truncated).toBe(false);
    expect(output.invalidUtf8).toBe(false);
    return {
      result,
      output: { stdout: output.stdout.text, stderr: output.stderr.text },
    };
  } finally {
    clearTimeout(timer);
    const stopped = await terminateSuiteExecution(execution, {
      waitForSuiteSettlement,
      terminationGraceMs: 2000,
      terminationForceMs: 3000,
      processLabel: 'connector identity CLI test',
    });
    expect(stopped.settled).toBe(true);
    expect(stopped.errors).toEqual([]);
  }
}

test.skipIf(process.platform === 'win32')(
  'offline init is idempotent and publishes only the public descriptor',
  async () => {
    const home = join(freshRoot(), 'station-home');
    const first = await run(home);
    expect(first.result.status).toBe(0);
    const initial = JSON.parse(first.output.stdout.trim());
    expect(initial.schema).toBe('station.self-hosted-connector-identity/v1');
    expect(initial.status).toBe('present');
    expect(initial.trust.generation).toBe(1);
    expect(initial.keyId).toBe(
      await calculateJwkThumbprint(initial.trust.signingKey),
    );
    const keyPath = join(home, 'security', 'connection-signing-key.json');
    const originalBytes = readFileSync(keyPath);
    const again = await run(home);
    expect(again.result.status).toBe(0);
    expect(JSON.parse(again.output.stdout.trim())).toEqual(initial);
    expect(readFileSync(keyPath)).toEqual(originalBytes);
    // Public output never carries the environment record, private key, or
    // operator credential.
    for (const text of [first.output.stdout, again.output.stdout]) {
      expect(text).not.toContain('privateKeyPem');
      expect(text).not.toContain('credential');
      expect(text).not.toContain('operator');
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'corrupt key custody refuses without initializing',
  async () => {
    const home = join(freshRoot(), 'station-home');
    const primed = await run(home);
    expect(primed.result.status).toBe(0);
    const keyPath = join(home, 'security', 'connection-signing-key.json');
    writeFileSync(keyPath, JSON.stringify({ schemaVersion: 1, corrupt: true }));
    const refused = await run(home);
    expect(refused.result.status).toBe(1);
    expect(refused.output.stderr).toContain('key_store_invalid');
    expect(readFileSync(keyPath, 'utf8')).toBe(
      JSON.stringify({ schemaVersion: 1, corrupt: true }),
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'active home refuses before any writes',
  async () => {
    const home = join(freshRoot(), 'station-home');
    const primed = await run(home);
    expect(primed.result.status).toBe(0);
    const lease = acquireStationHomeRuntimeLease(home);
    try {
      const refused = await run(home);
      expect(refused.result.status).toBe(1);
      expect(refused.output.stderr).toContain('connector_identity_home_active');
    } finally {
      lease.release();
    }
    const after = await run(home);
    expect(after.result.status).toBe(0);
    expect(JSON.parse(after.output.stdout.trim()).trust).toEqual(
      JSON.parse(primed.output.stdout.trim()).trust,
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'symlinked home refuses',
  async () => {
    const root = freshRoot();
    const target = join(root, 'real-home');
    const primed = await run(target);
    expect(primed.result.status).toBe(0);
    const link = join(root, 'linked-home');
    symlinkSync(target, link);
    const refused = await run(link);
    expect(refused.result.status).toBe(1);
    expect(refused.output.stderr).toContain('connector_identity_home_symlink');
  },
);
