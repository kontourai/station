import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BOOT_INTERNAL_SECRET_ENV_KEYS } from '../../../utils/child-process-environment.js';
import {
  appHomeActive,
  connectionSpawnEnv,
  sanitizeConnectionConfigHome,
  sanitizeConnectionEnvMap,
  sanitizeCredentialProfileEnv,
  sanitizeCredentialProfileEnvInvalidNames,
  validateCredentialProfileEnv,
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
});

describe('validateCredentialProfileEnv (#2966)', () => {
  test('accepts non-secret literals and an empty mask on a credential-shaped name', () => {
    expect(
      validateCredentialProfileEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      }),
    ).toEqual({
      ok: true,
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    });
    expect(validateCredentialProfileEnv({})).toEqual({ ok: true, env: {} });
  });

  test.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'client_secret',
    'DB_PASSWORD',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AWS_CREDENTIAL',
  ])(
    'refuses a non-empty literal under the credential-shaped name %s without echoing it',
    (name) => {
      const result = validateCredentialProfileEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        [name]: 'canary-secret-value',
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(name);
      expect(JSON.stringify(result)).not.toContain('canary-secret-value');
      // All-or-nothing: the registry form never keeps the valid remainder.
      expect(
        sanitizeCredentialProfileEnv({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
          [name]: 'canary-secret-value',
        }),
      ).toBeUndefined();
    },
  );

  test.each([
    ['OPENAI_API_KEYS', 'sk-a,sk-b'],
    ['GITHUB_PAT', 'ghp_x'],
    ['ANTHROPIC_AUTH', 'abc'],
    ['GITHUB_OAUTH', 'abc'],
    ['ANTHROPIC_CUSTOM_HEADERS', 'X-Team: platform'],
    ['DB_PASSWD', 'x'],
    ['HTTPS_PROXY', 'http://user:pw@proxy.example.internal:8080'],
    ['UPSTREAM_URL', 'https://token@host.example.internal/v1'],
    // Schemes whose only letter sits far from `://`, or none at all.
    ['UPSTREAM_URL', `a${'1'.repeat(40)}://user:pw@host`],
    ['UPSTREAM_URL', `a${'-'.repeat(32)}://user:pw@host`],
    ['UPSTREAM_URL', `s3+${'0'.repeat(32)}://k:s@h`],
    ['EXTRA', 'Authorization: Bearer abc'],
    ['EXTRA', 'proxy-authorization: Basic dXNlcjpwYXNz'],
    ['EXTRA', 'x-api-key: abc'],
    ['EXTRA', 'bearer abc.def'],
    ['EXTRA', 'Basic dXNlcjpwYXNzd29yZA=='],
  ])(
    'refuses the credential-shaped %s=<value> heuristic case and reports only the name',
    (name, value) => {
      const result = validateCredentialProfileEnv({ [name]: value });
      expect(result).toMatchObject({ ok: false, names: [name] });
      expect(JSON.stringify(result)).not.toContain(value);
    },
  );

  test('keeps near-miss names and ordinary URLs', () => {
    expect(
      validateCredentialProfileEnv({
        COMPAT: 'x',
        PATH_HINT: 'x',
        HTTPS_PROXY: 'http://proxy.example.internal:8080',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318/v1?x=a@b',
        NOTE: 'basic mode',
        ANTHROPIC_CUSTOM_HEADERS: '',
      }).ok,
    ).toBe(true);
    expect(validateCredentialProfileEnv(null)).toEqual({ ok: true, env: {} });
  });

  test('never echoes a malformed name, which could be pasted secret text', () => {
    const result = validateCredentialProfileEnv({ 'sk-live-canary': 'x' });
    expect(result).toMatchObject({ ok: false, names: [] });
    expect(JSON.stringify(result)).not.toContain('sk-live-canary');
  });

  test.each([
    'TMPDIR',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    ...BOOT_INTERNAL_SECRET_ENV_KEYS,
  ])('refuses the Station-owned name %s even with an empty value', (name) => {
    expect(validateCredentialProfileEnv({ [name]: '' }).ok).toBe(false);
    expect(validateCredentialProfileEnv({ [name]: '/elsewhere' }).ok).toBe(
      false,
    );
  });

  test('refuses malformed names, non-string values, NUL, and oversize values', () => {
    for (const env of [
      { 'HAS-DASH': 'x' },
      { NUMERIC: 1 },
      { WITH_NUL: 'a\u0000b' },
      { TOO_LONG: 'x'.repeat(32 * 1024 + 1) },
      [],
      'ANTHROPIC_BASE_URL=x',
    ]) {
      expect(validateCredentialProfileEnv(env).ok).toBe(false);
    }
    expect(
      validateCredentialProfileEnv({ EXACT_CAP: 'x'.repeat(32 * 1024) }).ok,
    ).toBe(true);
  });

  test('validates a full-cap overlay of letter runs in linear time, and still finds userinfo behind a long scheme', () => {
    // 64 values x 32,768 letters: a quadratic URL-userinfo scan took tens of
    // seconds here and would time this test out.
    const letters = 'a'.repeat(32 * 1024);
    const overlay = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`OPT_${index}`, letters]),
    );
    expect(validateCredentialProfileEnv(overlay).ok).toBe(true);
    const longScheme = `${'x'.repeat(100)}://user:pw@host.example.internal`;
    expect(
      validateCredentialProfileEnv({ UPSTREAM: longScheme }),
    ).toMatchObject({ ok: false, names: ['UPSTREAM'] });
  });

  test('refuses the 65th entry rather than truncating to 64', () => {
    const entries = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`VAR_${index}`, 'v']),
      );
    expect(validateCredentialProfileEnv(entries(64)).ok).toBe(true);
    expect(validateCredentialProfileEnv(entries(65)).ok).toBe(false);
  });
});

describe('sanitizeCredentialProfileEnvInvalidNames (#2966)', () => {
  test('keeps bounded, well-formed, de-duplicated names and caps the list at 64', () => {
    expect(
      sanitizeCredentialProfileEnvInvalidNames([
        'ANTHROPIC_API_KEY',
        'sk-live canary',
        'B'.repeat(129),
        'C'.repeat(128),
        7,
        'ANTHROPIC_API_KEY',
      ]),
    ).toEqual(['ANTHROPIC_API_KEY', 'C'.repeat(128)]);
    expect(
      sanitizeCredentialProfileEnvInvalidNames(
        Array.from({ length: 100 }, (_, index) => `V${index}`),
      ),
    ).toHaveLength(64);
    expect(
      sanitizeCredentialProfileEnvInvalidNames('ANTHROPIC_API_KEY'),
    ).toEqual([]);
  });
});
