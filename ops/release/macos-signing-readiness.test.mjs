import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';
import { probeMacosPrivateKey } from './macos-signing-readiness.mjs';

test('runs one timestamp-free private-key probe and removes its scratch Mach-O', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
  const probe = join(directory, 'probe');
  const calls = [];
  await expect(
    probeMacosPrivateKey({
      identity: 'Developer ID',
      probe,
      run: async (program, args, options) => {
        calls.push([program, args, options]);
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
  ).resolves.toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toContain('--timestamp=none');
  expect(calls[0][2].phase).toBe('macOS private-key readiness probe');
  expect(existsSync(probe)).toBe(false);
});

test('keeps private-key failures terminal, secret-free, and cleans the scratch probe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
  const probe = join(directory, 'probe');
  const secret = 'not-a-real-keychain-password';
  let attempts = 0;
  await expect(
    probeMacosPrivateKey({
      identity: 'Developer ID',
      probe,
      run: async () => {
        attempts += 1;
        throw new Error(secret);
      },
    }),
  ).rejects.toThrow('macOS private-key readiness probe failed before timestamp signing.');
  expect(attempts).toBe(1);
  expect(existsSync(probe)).toBe(false);
});

test('bounds a hung private-key probe through the owned process group and removes it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-private-key-probe-'));
  const probe = join(directory, 'probe');
  const logs = [];
  await expect(
    probeMacosPrivateKey({
      identity: 'Developer ID',
      probe,
      run: (_program, _args, options) =>
        runBoundedCommand(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
          {
            ...options,
            logger: { error: (line) => logs.push(line), log: (line) => logs.push(line) },
            terminationGraceMs: 20,
            timeoutMs: 50,
          },
        ),
    }),
  ).rejects.toThrow('macOS private-key readiness probe failed before timestamp signing.');
  expect(logs.join('\n')).toContain('macOS private-key readiness probe');
  expect(existsSync(probe)).toBe(false);
});
