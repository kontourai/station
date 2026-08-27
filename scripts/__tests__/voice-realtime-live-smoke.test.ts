import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('voice realtime live smoke', () => {
  it('reports missing provider authorization as NOT_VERIFIED without values', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/voice-realtime-live-smoke.mjs',
        '--provider',
        'elevenlabs-realtime',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ELEVENLABS_API_KEY: '' },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT_VERIFIED');
    expect(result.stderr).not.toContain('ELEVENLABS_API_KEY=');
  });

  it('keeps the executable Nova rail distinct from a passing AC2 smoke', () => {
    const source = requireSmokeSource();
    expect(source).toContain('voice-realtime-nova-smoke.ts');
    expect(source).toContain('AC2 remains unproven');
  });

  it('accepts a nonempty protected OpenAI credential file without outputting its path or content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-openai-smoke-'));
    const credentialFile = join(directory, 'credential');
    const canary = 'openai-secret-canary';
    writeFileSync(credentialFile, `${canary}\n`, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        'scripts/voice-realtime-live-smoke.mjs',
        '--provider',
        'openai-realtime-compatible',
        '--validate-credentials',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          OPENAI_API_KEY_FILE: credentialFile,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(`${result.stdout}${result.stderr}`).not.toContain(credentialFile);
  });

  it('rejects a group-readable OpenAI credential file without exposing it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-openai-smoke-'));
    const credentialFile = join(directory, 'credential');
    const canary = 'openai-insecure-secret-canary';
    writeFileSync(credentialFile, `${canary}\n`, { mode: 0o600 });
    chmodSync(credentialFile, 0o640);
    const result = spawnSync(
      process.execPath,
      [
        'scripts/voice-realtime-live-smoke.mjs',
        '--provider',
        'openai-realtime-compatible',
        '--validate-credentials',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENAI_API_KEY: '',
          OPENAI_API_KEY_FILE: credentialFile,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(`${result.stdout}${result.stderr}`).not.toContain(credentialFile);
  });

  it('accepts a protected ElevenLabs credential file without exposing it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-eleven-smoke-'));
    const credentialFile = join(directory, 'credential');
    const canary = 'eleven-secret-canary';
    writeFileSync(credentialFile, `${canary}\n`, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        'scripts/voice-realtime-live-smoke.mjs',
        '--provider',
        'elevenlabs-realtime',
        '--validate-credentials',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ELEVENLABS_API_KEY: '',
          ELEVENLABS_API_KEY_FILE: credentialFile,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(`${result.stdout}${result.stderr}`).not.toContain(credentialFile);
  });

  it('accepts AWS profile-only Nova configuration for validation', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/voice-realtime-live-smoke.mjs',
        '--provider',
        'nova-s2s',
        '--validate-credentials',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: '',
          AWS_PROFILE: 'station-smoke-profile',
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('credential configuration was found');
  });
});

function requireSmokeSource(): string {
  return readFileSync('scripts/voice-realtime-live-smoke.mjs', 'utf8');
}
