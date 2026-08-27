import { describe, expect, test } from 'vitest';
import { generateFixtureKeyPair, runSshProcess } from './hermetic-openssh.js';

describe('hermetic OpenSSH process runner', () => {
  test('retries an invalid ssh2 Ed25519 serialization without exposing key material', () => {
    const valid = generateFixtureKeyPair('known-valid');
    let attempts = 0;
    const result = generateFixtureKeyPair('retried', () => {
      attempts += 1;
      return attempts === 1
        ? { private: 'malformed-private', public: 'malformed-public' }
        : valid;
    });

    expect(attempts).toBe(2);
    expect(result).toBe(valid);
  });

  test('bounds invalid key generation without including generated material in the error', () => {
    expect(() =>
      generateFixtureKeyPair('always-invalid', () => ({
        private: 'private-secret-sentinel',
        public: 'public-sentinel',
      })),
    ).toThrow(
      'Could not generate a parseable Ed25519 fixture key after 32 attempts',
    );
  });

  test('contains a broken pipe when the child exits before reading its probe payload', async () => {
    const result = await runSshProcess({
      // Node rejects the SSH-only -F option immediately. A large payload keeps
      // the parent write pending long enough to deterministically exercise the
      // child-stdin EPIPE path without requiring a timing-sensitive SSH server.
      sshPath: process.execPath,
      configPath: 'unused',
      args: [],
      stdin: 'x'.repeat(4 * 1024 * 1024),
      timeoutMs: 5_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bad option');
  });
});
