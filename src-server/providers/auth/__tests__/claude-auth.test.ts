import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { detectClaudeAuthState } from '../claude-auth.js';

describe('detectClaudeAuthState', () => {
  test('accepts explicit API authentication without touching the CLI', async () => {
    await expect(
      detectClaudeAuthState({ ANTHROPIC_API_KEY: 'configured' }, '/missing'),
    ).resolves.toBe('authenticated');
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
