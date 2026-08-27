import { describe, expect, test } from 'vitest';
import {
  MAX_SANITIZED_ERROR_STACK_FRAMES,
  redactDeep,
  redactSecrets,
  sanitizeError,
  sanitizeFreeText,
} from '../redaction.js';

// Synthetic fixtures are concatenated at runtime so the repo's own
// pre-commit secret scanner never sees a literal secret-shaped string.
const FAKE_AKIA = `${'AKIA'}ABCDEFGHIJKLMNOP`;
const FAKE_ASIA = `${'ASIA'}ABCDEFGHIJKLMNOP`;

describe('redactSecrets', () => {
  test.each([
    [`AWS key ${FAKE_AKIA}`, 'AWS key [REDACTED]'],
    [`AWS key ${FAKE_ASIA}`, 'AWS key [REDACTED]'],
    [`token ghp_${'a'.repeat(36)}`, 'token [REDACTED]'],
    [`token gho_${'a'.repeat(36)}`, 'token [REDACTED]'],
    [`token ghu_${'a'.repeat(36)}`, 'token [REDACTED]'],
    [`token ghs_${'a'.repeat(36)}`, 'token [REDACTED]'],
    [`token ghr_${'a'.repeat(36)}`, 'token [REDACTED]'],
    [`token github_pat_${'a_'.repeat(12)}`, 'token [REDACTED]'],
    [
      'Authorization: Bearer abc.def-ghi_jkl',
      'Authorization: Bearer [REDACTED]',
    ],
    [`OpenAI sk-${'a'.repeat(20)}`, 'OpenAI [REDACTED]'],
    [
      '{"password":"hunter2","status":"failed"}',
      '{"password":"[REDACTED]","status":"failed"}',
    ],
    [
      'AWS_SECRET_ACCESS_KEY=temporary-secret',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
    ],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
    ['privateKey: local-key-material', 'privateKey: [REDACTED]'],
    ["passphrase='correct horse'", "passphrase='[REDACTED]'"],
    ['cookie=session=abc123', 'cookie=[REDACTED]'],
    ['password=correct horse', 'password=[REDACTED]'],
    ['"access token" = abc123', '"access token" = [REDACTED]'],
    ["'api key': abc123", "'api key': [REDACTED]"],
    [
      'connection failed: postgres://dbuser:sup3rSecret@db.internal:5432/station',
      'connection failed: postgres://[REDACTED]@db.internal:5432/station',
    ],
    [
      'mongodb+srv://root:hunter2@cluster0.example.net/app',
      'mongodb+srv://[REDACTED]@cluster0.example.net/app',
    ],
    // station#1896 review round 2, HIGH #3: a password containing an
    // unescaped `@` used to redact only up to the FIRST `@`, leaking the
    // password's tail (`ssw0rd@host`) in the output.
    [
      'connection failed: postgres://dbuser:p@ssw0rd@db.internal:5432/station',
      'connection failed: postgres://[REDACTED]@db.internal:5432/station',
    ],
    [
      'postgres://dbuser:p@ss@w@rd@host:5432/db',
      'postgres://[REDACTED]@host:5432/db',
    ],
  ])('redacts %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  test('the connection-string credential pattern has no catastrophic backtracking (station#1896 review round 2, HIGH #3)', () => {
    // A "near miss" designed to maximize backtracking: many scheme-like
    // prefixes each followed by a long run of colon-separated, non-matching
    // content with no terminating `@` — the greedy password group has to
    // walk all the way back to the start of each run before giving up.
    const nearMiss = Array.from(
      { length: 250 },
      (_, i) => `svc${i}://user:${'x:'.repeat(300)}end`,
    ).join(' ');
    expect(nearMiss.length).toBeGreaterThan(100_000);

    const start = performance.now();
    redactSecrets(nearMiss);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(100);
  });

  test.each([
    'v1.24.3',
    '550e8400-e29b-41d4-a716-446655440000',
    '/Users/example/project/config.json',
    'https://example.com/path?mode=doctor',
    '0123456789abcdef0123456789abcdef01234567',
    'postgres://db.internal:5432/station',
  ])('preserves non-secret fixture %s', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe('shared free-text and Error sanitization', () => {
  const unsafeUrl = `https://${'provider'}.example.test/private/path?${'token'}=secret-value#fragment`;

  test('removes complete external URLs rather than retaining their path or query', () => {
    const sanitized = sanitizeFreeText(`engine stderr: ${unsafeUrl}`);
    for (const fragment of [
      'provider',
      'private/path',
      'token',
      'secret-value',
      'fragment',
    ]) {
      expect(sanitized).not.toContain(fragment);
    }
    expect(sanitized).toContain('[REDACTED_URL]');
  });

  test('removes quoted Node ENOENT and module-load paths without touching delimiters', () => {
    const sanitized = sanitizeFreeText(
      'ENOENT: no such file or directory, open \'/Users/brian/station/private/config.json\'; Cannot find module "C:\\Station Data\\private\\module.js"',
    );

    expect(sanitized).toContain("open '[REDACTED_PATH]'");
    expect(sanitized).toContain('module "[REDACTED_PATH]"');
    expect(sanitized).not.toContain('/Users/brian');
    expect(sanitized).not.toContain('C:\\Station Data');
    expect(sanitized).not.toContain('private\\module.js');
  });

  test('removes unquoted V8 source locations with spaces without swallowing labels', () => {
    const sanitized = sanitizeFreeText(
      'at loadProvider (/Users/brian/Station Data/private/provider.ts:42:7)\n' +
        'at executeEngine (C:\\Station Data\\private\\engine.ts:19:2)\n' +
        'at nextFrame (node:internal/process/task_queues:95:5)',
    );

    expect(sanitized).toContain('at loadProvider ([REDACTED_PATH])');
    expect(sanitized).toContain('at executeEngine ([REDACTED_PATH])');
    expect(sanitized).toContain(
      'at nextFrame (node:internal/process/task_queues:95:5)',
    );
    expect(sanitized).not.toContain('/Users/brian/Station Data');
    expect(sanitized).not.toContain('C:\\Station Data\\private\\engine.ts');
  });

  test('bounds Error stacks and rejects unknown throw shapes', () => {
    const error = new Error(`engine stderr: ${unsafeUrl}`);
    error.stack = [
      error.message,
      ...Array.from(
        { length: MAX_SANITIZED_ERROR_STACK_FRAMES + 10 },
        (_, index) => `at ${unsafeUrl}:${index}`,
      ),
    ].join('\n');
    const sanitized = sanitizeError(error);

    expect(sanitized.stack?.split('\n')).toHaveLength(
      MAX_SANITIZED_ERROR_STACK_FRAMES + 1,
    );
    expect(JSON.stringify(sanitized)).not.toContain('provider');
    expect(() => sanitizeError({ message: 'foreign shape' })).toThrow(
      'Error instance',
    );
  });

  test('removes unquoted POSIX and Windows stack paths while retaining function labels', () => {
    const error = new Error('engine failed');
    error.stack = [
      'Error: engine failed',
      '    at loadProvider (/Users/brian/Station Data/private/provider.ts:42:7)',
      '    at executeEngine (C:\\Station Data\\private\\engine.ts:19:2)',
    ].join('\n');

    const sanitized = sanitizeError(error);

    expect(sanitized.stack).toContain('loadProvider');
    expect(sanitized.stack).toContain('executeEngine');
    expect(sanitized.stack).not.toContain('/Users/brian');
    expect(sanitized.stack).not.toContain('C:\\Station Data');
    expect(sanitized.stack).toContain('[REDACTED_PATH]');
  });

  test('enforces an exact UTF-16 code-unit output cap including truncation', () => {
    const capped = sanitizeFreeText('x'.repeat(100), 16);

    expect(capped).toBe('xxxx…[TRUNCATED]');
    expect(capped).toHaveLength(16);
    expect(sanitizeFreeText('x'.repeat(100), 4)).toHaveLength(4);
  });
});

describe('redactDeep', () => {
  test('clones nested values and redacts secret-shaped fields and strings', () => {
    const input = {
      apiKey: 'short-value',
      openaiApiKey: 'provider-value',
      nested: {
        password: 'hunter2',
        description: `uses ghp_${'z'.repeat(36)}`,
      },
      values: [{ access_token: 'A'.repeat(32) }],
      version: '1.2.3',
      outputToken: 'output-secret',
      input_token: 'input-secret',
      maxAccessToken: 'max-access-secret',
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
      apiToken: 'api-secret',
      maxTokens: 8192,
      defaultMaxOutputTokens: 4096,
      promptTokens: 2048,
      tokenizerVersion: '2.0',
      contextTokenLimit: 128_000,
      accessTokenExpiry: 3600,
    };

    expect(redactDeep(input)).toEqual({
      apiKey: '[REDACTED]',
      openaiApiKey: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        description: 'uses [REDACTED]',
      },
      values: [{ access_token: '[REDACTED]' }],
      version: '1.2.3',
      outputToken: '[REDACTED]',
      input_token: '[REDACTED]',
      maxAccessToken: '[REDACTED]',
      refreshToken: '[REDACTED]',
      accessToken: '[REDACTED]',
      apiToken: '[REDACTED]',
      maxTokens: 8192,
      defaultMaxOutputTokens: 4096,
      promptTokens: 2048,
      tokenizerVersion: '2.0',
      contextTokenLimit: 128_000,
      accessTokenExpiry: 3600,
    });
    expect(input.apiKey).toBe('short-value');
  });

  test('redacts recursively inside JSON-encoded string values', () => {
    expect(redactDeep({ metadata: '{"password":"hunter2"}' })).toEqual({
      metadata: '{"password":"[REDACTED]"}',
    });
  });

  test('redacts JSON strings nested through multiple encoding layers', () => {
    const input = JSON.stringify(JSON.stringify({ password: 'hunter2' }));
    const redacted = redactDeep(input);

    expect(redacted).not.toContain('hunter2');
    expect(JSON.parse(JSON.parse(redacted))).toEqual({
      password: '[REDACTED]',
    });
  });

  test('fails closed when JSON encoding exceeds the recursion cap', () => {
    const depthValue = ['depth', 'secret'].join('-');
    let input = JSON.stringify({ password: depthValue });
    for (let layer = 0; layer < 8; layer += 1) {
      input = JSON.stringify(input);
    }

    const redacted = redactDeep({ metadata: input }) as { metadata: string };
    expect(redacted.metadata).not.toContain(depthValue);
  });

  test('preserves an embedded Error as a bounded structured shape', () => {
    const err = new Error('kaboom');
    const redacted = redactDeep({ err, password: 'hunter2' }) as unknown as {
      err: { message: string; type: string; stack?: string };
      password: string;
    };
    expect(redacted.err).not.toBe(err);
    expect(redacted.err.message).toBe('kaboom');
    expect(redacted.err.type).toBe('Error');
    expect(typeof redacted.err.stack).toBe('string');
    expect(redacted.password).toBe('[REDACTED]');
  });
});
