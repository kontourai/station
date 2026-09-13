import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { afterEach, expect, test } from 'vitest';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
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

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-operator-key-'));
  roots.push(home);
  const environment = new EnvironmentSecurityService({ homeDir: home });
  const identity = await environment.initialize();
  return {
    home,
    environment,
    identity,
    path: join(home, 'security', 'connection-signing-key.json'),
  };
}

async function run(args: string[]) {
  const execution = executeOwnedCommand(
    process.execPath,
    ['--import', 'tsx', 'scripts/connection-key.ts', ...args],
    spawn,
    'connection key CLI test',
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
          () => reject(new Error('Key CLI exceeded liveness bound')),
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
      processLabel: 'connection key CLI test',
    });
    expect(stopped.settled).toBe(true);
    expect(stopped.errors).toEqual([]);
  }
}

function report(output: { stdout: string }) {
  return JSON.parse(output.stdout.trim());
}

test('operator CLI initializes once across processes, inspects public metadata, and rotates only the observed key', async () => {
  const { home, path, identity, environment } = await fixture();
  const absent = await run(['inspect', `--home=${home}`]);
  expect(absent.result.status).toBe(2);
  expect(report(absent.output).status).toBe('absent');
  expect(existsSync(path)).toBe(false);
  const first = await run(['initialize', `--home=${home}`]);
  expect(first.result.status).toBe(0);
  const initial = report(first.output);
  expect(initial.trust.stationId).toBe(identity.environmentId);
  expect(initial.keyId).toBe(
    await calculateJwkThumbprint(initial.trust.signingKey),
  );
  const originalBytes = readFileSync(path);
  const again = await run(['initialize', `--home=${home}`]);
  expect(again.result.status).toBe(0);
  expect(report(again.output)).toEqual(initial);
  expect(readFileSync(path)).toEqual(originalBytes);
  const rotation = [
    'rotate',
    `--home=${home}`,
    '--expected-generation=1',
    `--expected-key-id=${initial.keyId}`,
    '--acknowledge-device-reapproval',
  ];
  const contenders = await Promise.all([run(rotation), run(rotation)]);
  expect(contenders.filter((entry) => entry.result.status === 0)).toHaveLength(
    1,
  );
  expect(contenders.filter((entry) => entry.result.status === 1)).toHaveLength(
    1,
  );
  const changed = contenders.find((entry) => entry.result.status === 0)!;
  const loser = contenders.find((entry) => entry.result.status === 1)!;
  expect(loser.output.stderr).toContain('key_generation_conflict');
  const current = report(changed.output);
  expect(current.trust.generation).toBe(2);
  expect(current.trust.enrollmentId).toBe(initial.trust.enrollmentId);
  expect(current.keyId).not.toBe(initial.keyId);
  const changedBytes = readFileSync(path);
  const stale = await run(rotation);
  expect(stale.result.status).toBe(1);
  expect(stale.output.stderr).toContain('key_generation_conflict');
  expect(readFileSync(path)).toEqual(changedBytes);
  const inspect = await run(['inspect', `--home=${home}`]);
  expect(inspect.result.status).toBe(0);
  expect(report(inspect.output).trust).toEqual(current.trust);
  for (const output of [
    first.output,
    again.output,
    changed.output,
    stale.output,
    inspect.output,
  ]) {
    expect(JSON.stringify(output)).not.toContain(identity.credential);
    expect(JSON.stringify(output)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(output)).not.toContain(home);
  }
  expect(environment.verifyOperatorCredential(identity.credential)).toBe(true);
});

test('rotation refuses the wrong key even when the generation matches', async () => {
  const { home, path } = await fixture();
  expect((await run(['initialize', `--home=${home}`])).result.status).toBe(0);
  const bytes = readFileSync(path);
  const refused = await run([
    'rotate',
    `--home=${home}`,
    '--expected-generation=1',
    `--expected-key-id=${'a'.repeat(43)}`,
    '--acknowledge-device-reapproval',
  ]);
  expect(refused.result.status).toBe(1);
  expect(refused.output.stderr).toContain('key_generation_conflict');
  expect(readFileSync(path)).toEqual(bytes);
});

test('invalid flags never create a key and missing homes are not initialized', async () => {
  const { home, path } = await fixture();
  for (const args of [
    ['initialize'],
    ['initialize', '--home=relative'],
    ['initialize', `--home=${home}`, `--home=${home}`],
    ['initialize', `--home=${home}`, '--operator=true'],
    [
      'rotate',
      `--home=${home}`,
      '--expected-generation=1',
      `--expected-key-id=${'a'.repeat(43)}`,
    ],
    [
      'rotate',
      `--home=${home}`,
      '--expected-generation=1',
      `--expected-key-id=${'a'.repeat(43)}`,
      '--acknowledge-device-reapproval=false',
    ],
  ]) {
    const result = await run(args);
    expect(result.result.status).toBe(1);
    expect(result.output.stderr).toContain('invalid_arguments');
    expect(existsSync(path)).toBe(false);
  }
  const missing = join(home, 'missing');
  expect((await run(['initialize', `--home=${missing}`])).result.status).toBe(
    1,
  );
  expect(existsSync(missing)).toBe(false);
});

test('corruption remains untouched and private parser input stays out of command errors', async () => {
  const { home, path } = await fixture();
  const privateBytes = 'private-fixture-marker{';
  writeFileSync(path, privateBytes, { mode: 0o600 });
  const result = await run(['initialize', `--home=${home}`]);
  expect(result.result.status).toBe(1);
  expect(result.output.stdout).toBe('');
  expect(result.output.stderr).toContain('key_store_invalid');
  expect(result.output.stderr).not.toContain(privateBytes);
  expect(result.output.stderr).not.toContain(home);
  expect(readFileSync(path, 'utf8')).toBe(privateBytes);
});
