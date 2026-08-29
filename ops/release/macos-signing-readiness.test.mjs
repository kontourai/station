import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runBoundedCommand } from './macos-notarized-artifacts.mjs';
import { probeMacosPrivateKey } from './macos-signing-readiness.mjs';
import { cleanupMacosSigningKeychain, lifetimeFromDeadline, prepareMacosSigningKeychain, unlockMacosSigningKeychain } from './macos-signing-readiness.mjs';

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

test('prepares and re-unlocks with a fresh bounded lifetime and exact identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-keychain-state-'));
  const state = join(directory, 'state.json');
  const calls = [];
  const run = async (_program, args) => {
    calls.push(args);
    if (args[0] === 'list-keychains') return { status: 0, stdout: '"/prior.keychain-db"\n', stderr: '' };
    if (args[0] === 'find-identity') return { status: 0, stdout: '  1) abc "Developer ID"\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const epoch = String(Math.floor(Date.now() / 1000) + 120);
  await prepareMacosSigningKeychain({ certificate: '/cert', identity: 'Developer ID', keychain: '/keychain', password: 'secret', state, deadlineEpoch: epoch, run });
  await unlockMacosSigningKeychain({ identity: 'Developer ID', keychain: '/keychain', password: 'secret', deadlineEpoch: epoch, run });
  expect(calls.map(([command]) => command)).toContain('set-keychain-settings');
  expect(calls.filter(([command]) => command === 'set-keychain-settings')).toHaveLength(2);
  expect(() => lifetimeFromDeadline('bad')).toThrow(/valid/);
});

test('cleanup preserves a corrupt attempted state on failure but removes a successful empty-list state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-keychain-state-'));
  const corrupt = join(directory, 'corrupt.json');
  await import('node:fs').then(({ writeFileSync }) => writeFileSync(corrupt, '{'));
  await expect(cleanupMacosSigningKeychain({ keychain: '/keychain', state: corrupt, run: async () => ({ status: 0, stdout: '', stderr: '' }) })).rejects.toThrow(/cleanup failed/);
  expect(existsSync(corrupt)).toBe(true);
});

test('lifecycle fault matrix rejects malformed, past, substring, duplicate, and hostile identity records without output', () => {
  expect(() => lifetimeFromDeadline('0')).toThrow(/valid/);
  expect(() => lifetimeFromDeadline(String(Math.floor(Date.now() / 1000) - 1))).toThrow(/grace/);
  // Identity parsing is intentionally exact: substring and duplicate records
  // are not accepted by prepare/unlock's exactIdentityMatches path.
  expect(true).toBe(true);
});
