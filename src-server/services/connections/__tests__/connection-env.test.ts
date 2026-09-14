import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BOOT_INTERNAL_SECRET_ENV_KEYS } from '../../../utils/child-process-environment.js';
import {
  appHomeActive,
  CONNECTION_CONFIG_HOME_ENV_KEYS,
  connectionSpawnEnv,
  sanitizeConnectionConfigHome,
  sanitizeConnectionEnvMap,
} from '../connection-env.js';

describe('sanitizeConnectionEnvMap (station#2072)', () => {
  test('keeps well-formed entries and drops malformed names', () => {
    expect(
      sanitizeConnectionEnvMap({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        _LEADING_UNDERSCORE: 'ok',
        lower_case: 'ok',
        '1STARTS-DIGIT': 'dropped',
        'HAS-DASH': 'dropped',
        'HAS SPACE': 'dropped',
        '': 'dropped',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
      _LEADING_UNDERSCORE: 'ok',
      lower_case: 'ok',
    });
  });

  test('refuses every boot-internal secret key and TMPDIR outright', () => {
    const refused: Record<string, string> = {};
    for (const key of [...BOOT_INTERNAL_SECRET_ENV_KEYS, 'TMPDIR']) {
      refused[key] = `value-for-${key}`;
    }
    refused['ANTHROPIC_BASE_URL'] = 'kept';
    expect(sanitizeConnectionEnvMap(refused)).toEqual({
      ANTHROPIC_BASE_URL: 'kept',
    });
  });

  test('keeps empty-string values — masking an inherited variable is legitimate', () => {
    expect(
      sanitizeConnectionEnvMap({
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'cliproxy-local',
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'cliproxy-local',
    });
  });

  test('drops non-string values, NUL-bearing values, oversized values', () => {
    expect(
      sanitizeConnectionEnvMap({
        NOT_A_STRING: 42,
        ALSO_NOT: { nested: true },
        NUL_CARRIER: 'bad\u0000value',
        TOO_BIG: 'x'.repeat(32 * 1024 + 1),
        FINE: 'y'.repeat(32 * 1024),
      }),
    ).toEqual({ FINE: 'y'.repeat(32 * 1024) });
  });

  test('caps the map at 64 entries — and an entry beyond the cap is DROPPED, not merged', () => {
    const oversized: Record<string, string> = {};
    for (let i = 0; i < 70; i += 1) oversized[`VAR_${i}`] = 'v';
    const sanitized = sanitizeConnectionEnvMap(oversized);
    expect(Object.keys(sanitized).length).toBe(64);
    // Pin the boundary entries independently: a length-only assertion cannot
    // notice WHICH entries survived.
    expect(sanitized['VAR_0']).toBe('v');
    expect(sanitized['VAR_63']).toBe('v');
    expect(sanitized['VAR_64']).toBeUndefined();
  });

  test('non-object input yields an empty map', () => {
    expect(sanitizeConnectionEnvMap(undefined)).toEqual({});
    expect(sanitizeConnectionEnvMap(null)).toEqual({});
    expect(sanitizeConnectionEnvMap('env')).toEqual({});
    expect(sanitizeConnectionEnvMap(['A'])).toEqual({});
  });
});

describe('sanitizeConnectionConfigHome (station#2072)', () => {
  test('trims and keeps a tilde path AS AUTHORED — expansion is a spawn-time concern', () => {
    expect(sanitizeConnectionConfigHome('  ~/.codex_vibe  ')).toBe(
      '~/.codex_vibe',
    );
  });

  test('drops non-strings, empty-after-trim, and NUL-bearing values', () => {
    expect(sanitizeConnectionConfigHome(undefined)).toBeUndefined();
    expect(sanitizeConnectionConfigHome(42)).toBeUndefined();
    expect(sanitizeConnectionConfigHome('   ')).toBeUndefined();
    expect(sanitizeConnectionConfigHome('/bad\u0000path')).toBeUndefined();
  });
});

describe('appHomeActive precedence (station#2072)', () => {
  test('an explicit configHome wins over the useAppHome opt-in', () => {
    expect(
      appHomeActive({ configHome: '~/.codex_vibe', useAppHome: true }),
    ).toBe(false);
  });

  test('without configHome the opt-in decides', () => {
    expect(appHomeActive({ useAppHome: true })).toBe(true);
    expect(appHomeActive({ useAppHome: false })).toBe(false);
    expect(appHomeActive(undefined)).toBe(false);
  });
});

describe('connectionSpawnEnv (station#2072)', () => {
  test('maps the engine to its config-home key and expands the tilde at spawn time', () => {
    expect(
      connectionSpawnEnv({ configHome: '~/.codex_vibe' }, 'codex'),
    ).toEqual({ CODEX_HOME: join(homedir(), '.codex_vibe') });
    expect(connectionSpawnEnv({ configHome: '~' }, 'claude')).toEqual({
      CLAUDE_CONFIG_DIR: homedir(),
    });
  });

  test('the validated configHome key wins over a same-named env-map entry', () => {
    const resolved = connectionSpawnEnv(
      {
        configHome: '~/.codex_vibe',
        env: { CODEX_HOME: '/ambient-sneaky', ANTHROPIC_BASE_URL: 'http://x' },
      },
      'codex',
    );
    expect(resolved).toEqual({
      CODEX_HOME: join(homedir(), '.codex_vibe'),
      ANTHROPIC_BASE_URL: 'http://x',
    });
  });

  test('returns the env map alone when only env is configured', () => {
    expect(
      connectionSpawnEnv(
        { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318' } },
        'claude',
      ),
    ).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318' });
  });

  test('returns undefined when the connection configured neither — byte-identical spawn env today', () => {
    expect(connectionSpawnEnv(undefined, 'codex')).toBeUndefined();
    expect(connectionSpawnEnv({}, 'claude')).toBeUndefined();
    expect(
      connectionSpawnEnv({ useAppHome: true, defaultModel: 'x' }, 'claude'),
    ).toBeUndefined();
  });

  test('both engines have a config-home key', () => {
    expect(CONNECTION_CONFIG_HOME_ENV_KEYS.claude).toBe('CLAUDE_CONFIG_DIR');
    expect(CONNECTION_CONFIG_HOME_ENV_KEYS.codex).toBe('CODEX_HOME');
  });
});
