import { describe, expect, test } from 'vitest';
import {
  isSecretField,
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

describe('#1545: credential vocabulary reachable from a tool-call preview', () => {
  // A tool-call approval preview renders a shell command, so the credential
  // shapes that matter are the ones a command line actually carries — a
  // `--flag=` key and the whole-name env vars. Neither was contextually
  // redacted before.
  test.each([
    ['--password=hunter2', '--password=[REDACTED]'],
    ['mysql --password=hunter2', 'mysql --password=[REDACTED]'],
    ['-password=hunter2', '-password=[REDACTED]'],
    ['--creds=abc123', '--creds=[REDACTED]'],
    ['--api-key=abc123', '--api-key=[REDACTED]'],
    ['PGPASSWORD=hunter2', 'PGPASSWORD=[REDACTED]'],
    ['MYSQL_PWD=hunter2', 'MYSQL_PWD=[REDACTED]'],
    ['env MYSQL_PWD=hunter2', 'env MYSQL_PWD=[REDACTED]'],
  ])('redacts %j', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  // An unquoted value used to run to the end of the line, so ONE non-secret pair
  // earlier on a command line consumed the rest of it and the secret pair was
  // never examined. Every case below came through verbatim before the value
  // learned to stop at a following flag.
  test.each([
    [
      'mysql --user=root --password=hunter2 -h db',
      'mysql --user=root --password=[REDACTED] -h db',
    ],
    [
      'curl --header=x -d a=1 --password=p2',
      'curl --header=x -d a=1 --password=[REDACTED]',
    ],
    [
      '--config=/etc/app.conf --password=hunter2 --verbose',
      '--config=/etc/app.conf --password=[REDACTED] --verbose',
    ],
    [
      'llm --max-tokens=100 --auth-token=abc123',
      'llm --max-tokens=100 --auth-token=[REDACTED]',
    ],
  ])(
    'examines a secret pair that follows a non-secret one: %j',
    (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    },
  );

  test('a quoted value still spans spaces and dashes, so it is not cut at a word that looks like a flag', () => {
    // `-m 'password=hunter2'` is one argument. The quoted-value alternative must
    // keep matching across the whole quoted run, and this string is a commit
    // message rather than a credential assignment, so nothing is redacted.
    expect(redactSecrets("git commit -m 'password=hunter2' --no-verify")).toBe(
      "git commit -m 'password=hunter2' --no-verify",
    );
  });

  test('leaves a non-secret flag alone, dashes and all', () => {
    expect(redactSecrets('--host=db --port=5432')).toBe(
      '--host=db --port=5432',
    );
  });

  test('does not touch the attached single-letter password flag, deliberately', () => {
    // `-p<value>` is mysql's password flag, and also `-p` for a hundred other
    // things. With no separator to anchor on there is nothing to distinguish a
    // secret from a port number, so this is left alone on purpose rather than
    // guessed at. Documented in `redactContextualFields`.
    expect(redactSecrets('mysql -phunter2')).toBe('mysql -phunter2');
    expect(redactSecrets('mysql -p hunter2')).toBe('mysql -p hunter2');
  });

  test.each([
    ['PGPASSWORD', true],
    ['MYSQL_PWD', true],
    ['mysql-pwd', true],
    ['mysqlPwd', true],
    ['creds', true],
    ['AWS_CREDS', true],
    // The segments these whole names decompose into must stay non-secret on
    // their own: `pwd` is also "print working directory", `mysql` is a program.
    ['pwd', false],
    ['mysql', false],
    ['host', false],
  ])('isSecretField(%j) is %s', (key, expected) => {
    expect(isSecretField(key)).toBe(expected);
  });
});
