import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { TroubleshootReportBoundsError } from '@kontourai/station-contracts/troubleshoot';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  admitTroubleshootSeed,
  boundedTriageLogTail,
  createTriageRunDirectory,
  draftTroubleshootReport,
  homeRelativePath,
  localTriageLogFacts,
  MAX_TRIAGE_CONTEXT_BYTES,
  MAX_TRIAGE_DOCTOR_CHECKS,
  MAX_TRIAGE_LOG_TAIL_LENGTH,
  MAX_TRIAGE_TEXT_LENGTH,
  MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  MAX_TROUBLESHOOT_SEED_ERROR_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
  redactTroubleshootReportText,
  serializeTriageContext,
  summarizeTriageDoctor,
  TROUBLESHOOT_CONTEXT_SCHEMA,
  type TroubleshootContext,
  TroubleshootSeedError,
  validateTroubleshootContext,
} from '../triage-context.js';

const makeTempDir = trackTempDirs();
function tempRoot(): string {
  return makeTempDir('station-triage-context-');
}

const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;
// The shape of a Station pairing/device credential: 32 bytes, base64url.
// Same shape as a real credential (43 base64url chars, mixed case, digits),
// built at runtime so secret scanners do not read a literal key.
const PAIRING_CREDENTIAL = `${'Ab1'.repeat(14)}Z`;

describe('redactTroubleshootReportText', () => {
  test('redacts credentials, pairing secrets, private URLs and home paths', () => {
    const text = [
      `token ${GITHUB_TOKEN}`,
      `pair with ${PAIRING_CREDENTIAL}`,
      'open http://192.168.1.20:3141/#bootstrap=abc',
      'see https://github.com/kontourai/station/issues/4470',
      'log at /Users/alice/Library/Logs/station.log',
      'and /home/bob/.station/config/app.json',
      'and C:\\Users\\carol\\AppData\\station',
      'commit 0123456789abcdef0123456789abcdef01234567',
      'run 4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
      'file src-server/tools/station-control-troubleshoot-tools.ts',
    ].join('\n');
    const redacted = redactTroubleshootReportText(text);
    expect(redacted).not.toContain(GITHUB_TOKEN);
    expect(redacted).not.toContain(PAIRING_CREDENTIAL);
    expect(redacted).not.toContain('192.168.1.20');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('bob');
    expect(redacted).not.toContain('carol');
    expect(redacted).toContain('[REDACTED_URL]');
    expect(redacted).toContain('~/Library/Logs/station.log');
    // Public links, commit SHAs, run ids and repo paths stay readable.
    expect(redacted).toContain(
      'https://github.com/kontourai/station/issues/4470',
    );
    expect(redacted).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(redacted).toContain('4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a');
    expect(redacted).toContain(
      'src-server/tools/station-control-troubleshoot-tools.ts',
    );
  });

  test('keeps only Station public links and redacts every other GitHub path', () => {
    const kept = [
      'https://github.com/kontourai/station/issues/4470',
      'https://github.com/kontourai/station',
      'https://kontourai.github.io/station/guides/troubleshooting',
    ];
    const redactedUrls = [
      // Private sibling repository and a private org's issue.
      'https://github.com/kontourai/station-archive/issues/12',
      'https://github.com/acme-private/secret-product/issues/7',
      // A prefix match would keep these; parsing must not.
      'https://github.com/kontourai/station/../secret-product/issues/7',
      'https://github.com/kontourai/stationary/pulls',
      'https://kontourai.github.io/secret-product/',
      'http://github.com/kontourai/station',
    ];
    // Userinfo is blanked by the credential pass first; it must never survive.
    const withUserinfo = redactTroubleshootReportText(
      'see https://user:hunter2pass@github.com/kontourai/station',
    );
    expect(withUserinfo).not.toContain('hunter2pass');
    expect(withUserinfo).not.toBe(
      'see https://user:hunter2pass@github.com/kontourai/station',
    );
    for (const url of kept) {
      expect(redactTroubleshootReportText(`see ${url}`)).toBe(`see ${url}`);
    }
    for (const url of redactedUrls) {
      const redacted = redactTroubleshootReportText(`see ${url}`);
      expect(redacted).toBe('see [REDACTED_URL]');
      expect(redacted).not.toContain('secret-product');
    }
  });

  test('a URL cannot carry text past its core, and Markdown punctuation survives', () => {
    const station = 'https://github.com/kontourai/station/issues/1';
    const cases: Array<[string, string]> = [
      // Query and fragment of a kept link are dropped.
      [
        `see ${station}?next=https://github.com/acme/secret-product`,
        `see ${station}`,
      ],
      [`see ${station}#secret-product`, `see ${station}`],
      // Text after a bracket may be URL text: never kept, always marked.
      [`see ${station}?title=a)secret-product`, `see ${station})[REDACTED]`],
      [`see ${station}?title=a)]secret-product`, `see ${station})][REDACTED]`],
      [
        'see https://github.com/acme/private/issues/1?title=a)secret-product here',
        'see [REDACTED_URL])[REDACTED] here',
      ],
      [
        `see (${station})https://github.com/acme/secret-product`,
        `see (${station})[REDACTED]`,
      ],
      // Path segments are cut at anything but plain characters.
      [
        'see https://github.com/kontourai/station/blob/main/a)secret-product',
        'see https://github.com/kontourai/station/blob/main/a)[REDACTED]',
      ],
      [
        'see https://github.com/kontourai/station/blob/main/%73ecret-product/x',
        'see https://github.com/kontourai/station/blob/main',
      ],
      // Markdown and sentence punctuation stay intact.
      [
        '[x](https://github.com/acme/secret-product) after prose',
        '[x]([REDACTED_URL]) after prose',
      ],
      [
        '![x](https://github.com/acme/secret-product). Next',
        '![x]([REDACTED_URL]). Next',
      ],
      [`see [link](${station}).`, `see [link](${station}).`],
      [`see ${station}, and more`, `see ${station}, and more`],
    ];
    for (const [input, expected] of cases) {
      const redacted = redactTroubleshootReportText(input);
      expect(redacted).toBe(expected);
      expect(redacted).not.toContain('secret-product');
    }
  });

  test('SSH-style Git remotes are redacted unless they are Station', () => {
    expect(
      redactTroubleshootReportText(
        'remote git@github.com:acme/secret-product.git.',
      ),
    ).toBe('remote [REDACTED_URL].');
    expect(
      redactTroubleshootReportText(
        'remote deploy@git.internal:secret-product/x',
      ),
    ).toBe('remote [REDACTED_URL]');
    expect(
      redactTroubleshootReportText(
        'remote git@github.com:kontourai/station.git',
      ),
    ).toBe('remote git@github.com:kontourai/station.git');
  });

  test('SSH remotes with IPv6 hosts are redacted', () => {
    expect(
      redactTroubleshootReportText(
        'remote git@[2001:db8::1]:secret-product/repo',
      ),
    ).toBe('remote [REDACTED_URL]');
  });

  test('a remote with a long user name is still redacted', () => {
    expect(
      redactTroubleshootReportText(
        `${'x'.repeat(70)}@github.com:acme/secret-product`,
      ),
    ).toBe('[REDACTED_URL]');
  });

  test('a long run with no remote is scanned in linear time', () => {
    // 80k chars: the old per-position retry took ~5.5 s here (quadratic); the
    // bounded pattern takes ~0 ms. A blocking regex cannot be interrupted by a
    // test timeout, so the elapsed time is asserted with wide headroom instead.
    const input = 'a.'.repeat(40_000);
    const started = performance.now();
    expect(redactTroubleshootReportText(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('many adjacent URLs finish without deep recursion', () => {
    const input = 'https://github.com/kontourai/station/)'.repeat(5_000);
    expect(() => redactTroubleshootReportText(input)).not.toThrow();
  });
});

describe('troubleshoot seed admission', () => {
  test('accepts a route at its limit and refuses one character more', () => {
    const atLimit = `/${'r'.repeat(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH - 1)}`;
    expect(admitTroubleshootSeed({ route: atLimit }).route).toBe(
      atLimit.slice(1),
    );
    expect(() => admitTroubleshootSeed({ route: `${atLimit}r` })).toThrow(
      TroubleshootSeedError,
    );
  });

  test('accepts an error summary at its limit and refuses one character more', () => {
    const atLimit = 'e'.repeat(MAX_TROUBLESHOOT_SEED_ERROR_LENGTH);
    expect(
      admitTroubleshootSeed({ errorSummary: atLimit }).errorSummary,
    ).toHaveLength(MAX_TROUBLESHOOT_SEED_ERROR_LENGTH);
    expect(() =>
      admitTroubleshootSeed({ errorSummary: `${atLimit}e` }),
    ).toThrow(TroubleshootSeedError);
  });

  test('refuses a route that is not an in-app path and strips query and fragment', () => {
    expect(() =>
      admitTroubleshootSeed({ route: 'https://evil.example/x' }),
    ).toThrow(TroubleshootSeedError);
    expect(() => admitTroubleshootSeed({ route: '//evil.example' })).toThrow(
      TroubleshootSeedError,
    );
    expect(
      admitTroubleshootSeed({ route: '/settings?token=abc#frag' }).route,
    ).toBe('settings');
    expect(admitTroubleshootSeed({ route: '/' }).route).toBe('');
  });

  test('accepts conversation and turn ids at their limits and refuses one character more', () => {
    const conversationId = 'c'.repeat(
      MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
    );
    const turnId = 't'.repeat(MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH);
    expect(admitTroubleshootSeed({ conversationId, turnId })).toMatchObject({
      conversationId,
      turnId,
    });
    expect(() =>
      admitTroubleshootSeed({ conversationId: `${conversationId}c` }),
    ).toThrow(expect.objectContaining({ reason: 'conversation-id-too-long' }));
    expect(() => admitTroubleshootSeed({ turnId: `${turnId}t` })).toThrow(
      expect.objectContaining({ reason: 'turn-id-too-long' }),
    );
  });

  test('refuses an id with whitespace or a control character', () => {
    for (const conversationId of ['a b', 'a\nb', 'a\tb', '']) {
      expect(() => admitTroubleshootSeed({ conversationId })).toThrow(
        expect.objectContaining({ reason: 'conversation-id-invalid' }),
      );
    }
    expect(() => admitTroubleshootSeed({ turnId: 'turn\u0000' })).toThrow(
      expect.objectContaining({ reason: 'turn-id-invalid' }),
    );
    expect(admitTroubleshootSeed({ turnId: 'provider:abc-1' }).turnId).toBe(
      'provider:abc-1',
    );
  });

  test('redacts secrets and paths from an error summary', () => {
    const seed = admitTroubleshootSeed({
      errorSummary: `failed with ${GITHUB_TOKEN} at /Users/alice/x.ts:1:2`,
    });
    expect(seed.errorSummary).not.toContain(GITHUB_TOKEN);
    expect(seed.errorSummary).not.toContain('alice');
  });
});

describe('bounded summaries', () => {
  test('caps doctor checks and per-field text', () => {
    const summary = summarizeTriageDoctor({
      checks: Array.from({ length: MAX_TRIAGE_DOCTOR_CHECKS + 1 }, () => ({
        label: 'x',
        status: 'warn',
        detail: 'd'.repeat(MAX_TRIAGE_TEXT_LENGTH + 1),
      })),
    });
    expect(summary.checks).toHaveLength(MAX_TRIAGE_DOCTOR_CHECKS);
    expect(summary.checks[0]!.detail.length).toBeLessThanOrEqual(
      MAX_TRIAGE_TEXT_LENGTH,
    );
  });

  test('keeps the newest end of an over-limit log tail', () => {
    const tail = boundedTriageLogTail(
      `${'o'.repeat(MAX_TRIAGE_LOG_TAIL_LENGTH + 1)}NEWEST`,
    );
    expect(tail.length).toBeLessThanOrEqual(MAX_TRIAGE_LOG_TAIL_LENGTH);
    expect(tail.startsWith('…[TRUNCATED]')).toBe(true);
    expect(tail.endsWith('NEWEST')).toBe(true);
  });

  test('refuses to serialize a context over the byte limit', () => {
    expect(() =>
      // redactDeep caps each string, so the overflow comes from many fields.
      serializeTriageContext({
        blobs: Array.from({ length: 40 }, () => 'x'.repeat(3_000)),
      }),
    ).toThrow('byte limit');
    expect(serializeTriageContext({ ok: true })).toContain('"ok": true');
  });
});

function context(): TroubleshootContext {
  return {
    schema: TROUBLESHOOT_CONTEXT_SCHEMA,
    schemaVersion: 1,
    generatedAt: '2026-11-02T00:00:00.000Z',
    runId: '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
    station: {
      name: 'test',
      environmentId: null,
      version: '0.1.0',
      channel: 'development',
      sourceRevision: null,
      builtAt: null,
      platform: 'darwin',
      nodeVersion: 'v24.0.0',
    },
    caller: { role: 'owner', surface: 'web' },
    doctor: { status: 'unavailable', reason: 'not collected' },
    logs: {
      serverLogStore: 'unavailable',
      agentRead: 'requires-operator-grant',
    },
    seed: {
      route: null,
      errorSummary: null,
      conversationId: null,
      turnId: null,
    },
    limits: {
      contextBytes: MAX_TRIAGE_CONTEXT_BYTES,
      doctorChecks: MAX_TRIAGE_DOCTOR_CHECKS,
      textLength: MAX_TRIAGE_TEXT_LENGTH,
    },
  };
}

describe('validateTroubleshootContext', () => {
  test('accepts schema v1 and refuses extra keys, bad roles and long fields', () => {
    expect(() => validateTroubleshootContext(context())).not.toThrow();
    expect(() =>
      validateTroubleshootContext({ ...context(), extra: 1 } as never),
    ).toThrow('schema v1');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        caller: { role: 'admin', surface: 'web' },
      } as never),
    ).toThrow('invalid bounded values');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        station: {
          ...context().station,
          name: 'n'.repeat(MAX_TRIAGE_TEXT_LENGTH + 1),
        },
      }),
    ).toThrow('invalid bounded values');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        seed: {
          ...context().seed,
          turnId: 't'.repeat(MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH + 1),
        },
      }),
    ).toThrow('invalid bounded values');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        seed: { ...context().seed, conversationId: 'a\nb' },
      }),
    ).toThrow('invalid bounded values');
  });
});

describe('createTriageRunDirectory', () => {
  test('creates an owner-only run under an explicit Station root and refuses a cache symlink', () => {
    const root = tempRoot();
    const runDir = createTriageRunDirectory(
      '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b',
      root,
    );
    expect(existsSync(runDir)).toBe(true);
    expect(() =>
      createTriageRunDirectory('5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b', root),
    ).toThrow('reuse');

    const other = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(other, 'cache'));
    expect(() =>
      createTriageRunDirectory('6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c', other),
    ).toThrow('real directory');
    expect(readdirSync(outside)).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')(
    'tightens an owned group-writable cache left by a permissive umask instead of refusing',
    () => {
      const root = tempRoot();
      const cache = join(root, 'cache');
      mkdirSync(cache);
      chmodSync(cache, 0o775);
      mkdirSync(join(cache, 'triage'));
      chmodSync(join(cache, 'triage'), 0o777);

      const runDir = createTriageRunDirectory(
        '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d',
        root,
      );

      expect(existsSync(runDir)).toBe(true);
      expect(statSync(cache).mode & 0o777).toBe(0o755);
      expect(statSync(join(cache, 'triage')).mode & 0o777).toBe(0o700);
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
    },
  );
});

describe('localTriageLogFacts', () => {
  test('shows a location inside the real home as ~ and withholds any other path', () => {
    const userHome = tempRoot();
    expect(
      localTriageLogFacts(
        join(userHome, '.station/instances/stable'),
        userHome,
      ),
    ).toEqual({
      directory: '~/.station/instances/stable/logs',
      status: 'absent',
    });
    // Another user's home is not this user's ~, whatever its name looks like.
    expect(
      localTriageLogFacts('/home/another-user/private', userHome).directory,
    ).toBeNull();
    expect(localTriageLogFacts('/opt/station', userHome).directory).toBeNull();
    // Spaces in the home path are kept intact.
    const spaced = join(userHome, 'Alice Smith');
    mkdirSync(spaced);
    expect(
      localTriageLogFacts(join(spaced, '.station'), userHome).directory,
    ).toBe('~/Alice Smith/.station/logs');
  });

  test('homeRelativePath refuses any path outside the home on its own', () => {
    const userHome = tempRoot();
    expect(homeRelativePath('/home/another-user/private', userHome)).toBeNull();
    expect(
      homeRelativePath(join(userHome, '..', 'sibling'), userHome),
    ).toBeNull();
    expect(homeRelativePath(userHome, userHome)).toBe('~');
    expect(homeRelativePath(join(userHome, 'a', 'b'), userHome)).toBe('~/a/b');
  });

  test('an unavailable home directory withholds the location instead of failing', () => {
    expect(homeRelativePath('/anything', null)).toBeNull();
    expect(homeRelativePath('/anything', '')).toBeNull();
  });

  test('a symlink leading out of the home is withheld', () => {
    const userHome = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(userHome, 'linked'));
    expect(
      localTriageLogFacts(join(userHome, 'linked', 'station'), userHome)
        .directory,
    ).toBeNull();
  });

  test('reports whether the log directory exists', () => {
    const home = tempRoot();
    expect(localTriageLogFacts(home).status).toBe('absent');
    mkdirSync(join(home, 'logs'));
    expect(localTriageLogFacts(home).status).toBe('present');
  });
});

describe('draftTroubleshootReport', () => {
  test('redacts title and fields before building the link', () => {
    const draft = draftTroubleshootReport({
      title: 'Crash at /Users/alice/project',
      fields: {
        'prior-issue': 'https://github.com/acme/private/issues/3',
      },
    });
    expect(draft.title).toBe('Crash at ~/project');
    expect(draft.fields).toEqual({ 'prior-issue': '[REDACTED_URL]' });
    expect(new URL(draft.url).searchParams.get('prior-issue')).toBe(
      '[REDACTED_URL]',
    );
  });

  test('keeps in-app routes while home directories still become ~', () => {
    const draft = draftTroubleshootReport({
      title: 'Turn failed after opening /settings',
      fields: {
        'observed-behavior':
          'Started from /settings, then /projects/x/tasks. Log at /Users/alice/.station/logs and /home/bob/x.',
      },
    });
    expect(draft.title).toBe('Turn failed after opening /settings');
    expect(draft.fields['observed-behavior']).toBe(
      'Started from /settings, then /projects/x/tasks. Log at ~/.station/logs and ~/x.',
    );
    expect(new URL(draft.url).searchParams.get('observed-behavior')).toContain(
      'Started from /settings',
    );
  });

  test('refuses an unknown field by name', () => {
    expect(() =>
      draftTroubleshootReport({
        title: 'x',
        fields: { body: 'y' } as never,
      }),
    ).toThrow(TroubleshootReportBoundsError);
  });
});
