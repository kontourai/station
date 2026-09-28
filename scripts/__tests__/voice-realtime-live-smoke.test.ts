import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();

describe('voice realtime live smoke', () => {
  it('requires an explicit provider selection and runs none by default', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/voice-realtime-live-smoke.mjs'],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      'NOT_VERIFIED: pass --provider <id>; no provider was selected.',
    );
  });

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

  it.each([
    [
      'a completed start/speech/stop run',
      "console.log('NOVA_START_SPEECH_STOP_COMPLETE'); process.exit(2);",
      'NOT_VERIFIED: Nova start/speech/stop completed, but its S2S bridge has no text-turn or explicit interrupt; AC2 remains unproven.',
    ],
    [
      'a child that claims a clean pass',
      "console.log('NOVA_START_SPEECH_STOP_COMPLETE'); process.exit(0);",
      'NOT_VERIFIED: Nova realtime smoke could not complete; no upstream response was printed.',
    ],
  ])(
    'keeps the executable Nova rail NOT_VERIFIED after %s',
    (_case, stub, verdict) => {
      // The rail resolves its smoke child from cwd, so a fixture cwd with a
      // stub child exercises the real branch without reaching AWS.
      const root = makeTempDir('station-nova-rail-');
      mkdirSync(join(root, 'scripts'));
      writeFileSync(
        join(root, 'scripts', 'voice-realtime-nova-smoke.ts'),
        stub,
      );
      mkdirSync(join(root, 'node_modules'));
      symlinkSync(
        resolve('node_modules', 'tsx'),
        join(root, 'node_modules', 'tsx'),
        'dir',
      );
      const result = spawnSync(
        process.execPath,
        [
          resolve('scripts/voice-realtime-live-smoke.mjs'),
          '--provider',
          'nova-s2s',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            AWS_ACCESS_KEY_ID: '',
            AWS_PROFILE: 'station-smoke-profile',
          },
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
        },
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe(verdict);
    },
  );

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
    expect(result.stderr.trim()).toBe(
      'NOT_VERIFIED: credential configuration was found; no live request was made.',
    );
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
    expect(result.stderr.trim()).toBe(
      'NOT_VERIFIED: openai-realtime-compatible requires configured credentials; no live request was made.',
    );
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
    expect(result.stderr.trim()).toBe(
      'NOT_VERIFIED: credential configuration was found; no live request was made.',
    );
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
