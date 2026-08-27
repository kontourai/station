import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  defaultCodexGlobalConfigDir,
  detectCodexAuthState,
} from '../codex-auth.js';

describe('defaultCodexGlobalConfigDir', () => {
  test('prefers a trimmed CODEX_HOME override', () => {
    expect(
      defaultCodexGlobalConfigDir(
        { CODEX_HOME: '  /custom/codex-home  ' },
        '/home/user',
      ),
    ).toBe('/custom/codex-home');
  });

  test('falls back to <home>/.codex when CODEX_HOME is absent or blank', () => {
    expect(defaultCodexGlobalConfigDir({}, '/home/user')).toBe(
      '/home/user/.codex',
    );
    expect(
      defaultCodexGlobalConfigDir({ CODEX_HOME: '   ' }, '/home/user'),
    ).toBe('/home/user/.codex');
  });
});

describe('detectCodexAuthState', () => {
  test('reports authenticated for a tokens-bearing auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'station-codex-auth-'));
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'private-value' } }),
      { mode: 0o600 },
    );
    await expect(detectCodexAuthState(dir)).resolves.toBe('authenticated');
  });

  test('reports authenticated for an API-key auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'station-codex-auth-'));
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-private' }),
      { mode: 0o600 },
    );
    await expect(detectCodexAuthState(dir)).resolves.toBe('authenticated');
  });

  test('reports unauthenticated when auth.json is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'station-codex-auth-'));
    await expect(detectCodexAuthState(dir)).resolves.toBe('unauthenticated');
  });

  test('reports unknown for unreadable or malformed auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'station-codex-auth-'));
    await writeFile(join(dir, 'auth.json'), '{');
    await expect(detectCodexAuthState(dir)).resolves.toBe('unknown');
  });
});
