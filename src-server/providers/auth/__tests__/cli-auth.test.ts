import { describe, expect, test } from 'vitest';
import {
  buildCliRuntimePrerequisites,
  type CliCommandResult,
  parseCliAuthState,
} from '../cli-auth.js';

describe('parseCliAuthState', () => {
  test('treats explicit login-required output as unauthenticated', () => {
    const result: CliCommandResult = {
      stdout: '',
      stderr: 'Not logged in. Run codex login.',
      code: 1,
    };

    expect(parseCliAuthState(result, 'codex')).toBe('unauthenticated');
  });

  test('treats json auth markers as authenticated', () => {
    const result: CliCommandResult = {
      stdout: JSON.stringify({ authenticated: true }),
      stderr: '',
      code: 0,
    };

    expect(parseCliAuthState(result, 'claude')).toBe('authenticated');
  });

  test('treats zero exit code without markers as authenticated', () => {
    const result: CliCommandResult = {
      stdout: 'Logged in',
      stderr: '',
      code: 0,
    };

    expect(parseCliAuthState(result, 'claude')).toBe('authenticated');
  });

  test('falls back to unknown for inconclusive failures', () => {
    const result: CliCommandResult = {
      stdout: '',
      stderr: 'something unexpected happened',
      code: 1,
    };

    expect(parseCliAuthState(result, 'claude')).toBe('unknown');
  });
});

describe('buildCliRuntimePrerequisites', () => {
  const findInstalledTestBinary = (command: string) => `/test/bin/${command}`;

  test('runs independent version and auth probes concurrently', async () => {
    const resolvers: Array<(result: CliCommandResult) => void> = [];
    const calls: string[][] = [];
    const pending = buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      installStep: 'Install it.',
      authStep: 'Log in.',
      findBinary: findInstalledTestBinary,
      runCommand: async (_command, args) => {
        calls.push(args);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    });

    expect(calls).toEqual([['--version'], ['login', 'status']]);
    expect(resolvers).toHaveLength(2);
    for (const resolve of resolvers) {
      resolve({ stdout: 'ok', stderr: '', code: 0 });
    }

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ id: 'node-cli', status: 'installed' }),
      expect.objectContaining({ id: 'node-auth', status: 'installed' }),
    ]);
  });

  test('reuses identical version and capability probes', async () => {
    const calls: string[][] = [];
    await buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: ['--version'],
      installStep: 'Install it.',
      authStep: 'Log in.',
      findBinary: findInstalledTestBinary,
      runCommand: async (_command, args) => {
        calls.push(args);
        return { stdout: 'v1.0.0', stderr: '', code: 0 };
      },
    });

    expect(calls).toEqual([['--version']]);
  });

  test('uses a non-command auth detector and fails closed when inconclusive', async () => {
    const calls: string[][] = [];
    const prerequisites = await buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: [],
      installStep: 'Install it.',
      authStep: 'Log in.',
      findBinary: findInstalledTestBinary,
      runCommand: async (_command, args) => {
        calls.push(args);
        return { stdout: 'v1.0.0', stderr: '', code: 0 };
      },
      detectAuthState: async () => 'unknown',
    });

    expect(calls).toEqual([['--version']]);
    expect(prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node-auth', status: 'error' }),
      ]),
    );
  });

  test('records a completed version-probe failure on the CLI prerequisite', async () => {
    const prerequisites = await buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: ['--version'],
      installStep: 'Install it.',
      authStep: 'Log in.',
      findBinary: findInstalledTestBinary,
      runCommand: async () => ({
        stdout: '',
        stderr: 'launcher failed',
        code: 1,
      }),
    });

    expect(prerequisites).toEqual([
      expect.objectContaining({ id: 'node-cli', status: 'error' }),
    ]);
  });

  test('keeps a probe with no result as unverifiable auth evidence', async () => {
    const prerequisites = await buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: ['--version'],
      installStep: 'Install it.',
      authStep: 'Log in.',
      findBinary: findInstalledTestBinary,
      runCommand: async () => null,
    });

    expect(prerequisites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node-auth', status: 'error' }),
      ]),
    );
  });

  test('propagates cancellation to every active CLI probe', async () => {
    const controller = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const pending = buildCliRuntimePrerequisites({
      command: 'node',
      displayName: 'Test CLI',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      installStep: 'Install it.',
      authStep: 'Log in.',
      signal: controller.signal,
      findBinary: findInstalledTestBinary,
      runCommand: async (_command, _args, signal) => {
        if (signal) observedSignals.push(signal);
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });

    controller.abort(new Error('probe cancelled'));

    await expect(pending).rejects.toThrow('probe cancelled');
    expect(observedSignals).toEqual([controller.signal, controller.signal]);
  });
});
