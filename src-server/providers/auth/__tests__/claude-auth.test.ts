import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { detectClaudeAuthState } from '../claude-auth.js';

const secure = vi.hoisted(() => ({
  platform: 'darwin',
  calls: [] as string[][],
  result: undefined as string | undefined,
  failure: undefined as
    | { code?: number | string; killed?: boolean }
    | undefined,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => secure.platform,
  homedir: () => '/missing',
  userInfo: () => ({ username: 'fixture-user' }),
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    secure.calls.push(args);
    callback(
      secure.failure ?? (secure.result === undefined ? { code: 44 } : null),
      secure.result ?? '',
      '',
    );
  },
}));

beforeEach(() => {
  secure.platform = 'darwin';
  secure.calls = [];
  secure.result = undefined;
  secure.failure = undefined;
});

describe('detectClaudeAuthState', () => {
  test('accepts explicit API authentication without touching the CLI', async () => {
    await expect(
      detectClaudeAuthState({ ANTHROPIC_API_KEY: 'configured' }, '/missing'),
    ).resolves.toBe('authenticated');
    expect(secure.calls).toEqual([]);
  });

  test('recognizes the selected secure credential without a credential file', async () => {
    secure.result = JSON.stringify({
      claudeAiOauth: { refreshToken: 'fixture-token' },
    });
    await expect(
      detectClaudeAuthState({ USER: 'fixture-user' }, '/missing'),
    ).resolves.toBe('authenticated');
    expect(secure.calls).toEqual([
      [
        'find-generic-password',
        '-a',
        'fixture-user',
        '-w',
        '-s',
        'Claude Code-credentials',
      ],
    ]);
  });

  test('uses the secure-store override without borrowing a global credential', async () => {
    await expect(
      detectClaudeAuthState(
        {
          USER: 'fixture-user',
          CLAUDE_CONFIG_DIR: '/qa/config',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: '/qa/secure',
        },
        '/missing',
      ),
    ).resolves.toBe('unauthenticated');
    expect(secure.calls).toEqual([
      [
        'find-generic-password',
        '-a',
        'fixture-user',
        '-w',
        '-s',
        'Claude Code-credentials-c7724621',
      ],
    ]);
  });

  test.each([{ code: 36 }, { code: 'ENOENT' }, { code: 44, killed: true }])(
    'retains an unreadable secure-store result as unknown: %j',
    async (failure) => {
      secure.failure = failure;
      await expect(detectClaudeAuthState({}, '/missing')).resolves.toBe(
        'unknown',
      );
    },
  );

  test('does not borrow a file credential after malformed secure state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
    await mkdir(join(home, '.claude'));
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }),
    );
    secure.result = '{';
    await expect(detectClaudeAuthState({}, home)).resolves.toBe('unknown');
  });

  test('recognizes a user-owned OAuth credential without exposing it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
    await mkdir(join(home, '.claude'));
    await writeFile(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { refreshToken: 'private-value' } }),
      { mode: 0o600 },
    );

    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'authenticated',
    );
  });

  test('reports absent credentials as unauthenticated', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
    await expect(detectClaudeAuthState({}, home)).resolves.toBe(
      'unauthenticated',
    );
  });

  test('fails closed on malformed credential state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-claude-auth-'));
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude', '.credentials.json'), '{');
    await expect(detectClaudeAuthState({}, home)).resolves.toBe('unknown');
  });
});
