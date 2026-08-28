import { describe, expect, test, vi } from 'vitest';
import {
  readClaudeUsage,
  readCodexUsage,
  type UsageFetchDeps,
} from '../credential-usage.js';

/**
 * archive#3552. The payload fixtures below are ABRIDGED FROM LIVE RESPONSES
 * captured from real accounts, not invented from the docs — including the
 * shapes that only appear in reality, like Codex's `additional_rate_limits`
 * per-model entries and a `used_percent: 100` that arrives together with an
 * explicit `limit_reached: true`.
 */
const AT = '2026-08-20T12:00:00.000Z';

function deps(overrides: Partial<UsageFetchDeps> = {}): UsageFetchDeps {
  return {
    fetch: vi.fn(async () => new Response('{}', { status: 200 })) as never,
    now: () => new Date(AT),
    readTextFile: vi.fn(async () => '{}'),
    ...overrides,
  };
}

const jsonFetch = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as never;

const CLAUDE_CREDS = JSON.stringify({
  claudeAiOauth: { accessToken: 'tok-claude' },
});
const CODEX_CREDS = JSON.stringify({
  access_token: 'tok-codex',
  account_id: 'acct-1',
});

const CLAUDE_USAGE = {
  five_hour: { utilization: 20, resets_at: '2026-08-20T18:49:59.611882+00:00' },
  seven_day: { utilization: 24, resets_at: '2026-08-22T09:59:59.611910+00:00' },
  limits: [
    { kind: 'session', percent: 20, severity: 'normal' },
    { kind: 'weekly_all', percent: 24, severity: 'normal' },
    {
      kind: 'weekly_scoped',
      percent: 10,
      severity: 'normal',
      resets_at: '2026-08-22T09:59:59.612279+00:00',
      scope: { model: { display_name: 'Fable' } },
    },
  ],
  extra_usage: { spend_limit_reached: false },
};

const CODEX_USAGE = {
  plan_type: 'pro',
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, reset_at: 1787463023 },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 0, reset_at: 1787260874 },
        secondary_window: { used_percent: 1, reset_at: 1787552759 },
      },
    },
  ],
  spend_control: { reached: false },
};

describe('credential usage — Claude', () => {
  test('normalizes the live payload into windows, including the per-model row', async () => {
    const usage = await readClaudeUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch(CLAUDE_USAGE),
      }),
    );
    expect(usage.status).toBe('ok');
    if (usage.status !== 'ok') return;
    expect(usage.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['five-hour', '5-hour limit', 20],
      ['seven-day', '7-day limit', 24],
      ['weekly-Fable', '7-day Fable', 10],
    ]);
    expect(usage.windows[0]?.resetsAt).toBe('2026-08-20T18:49:59.611Z');
    expect(usage.exhausted).toBe(false);
    expect(usage.fetchedAt).toBe(AT);
  });

  // Station must not identify as the CLI. Reading your own usage is not the
  // inference path and both endpoints answer without a client identity.
  test('sends auth and the capability header only — no claude-cli User-Agent', async () => {
    const fetchMock = jsonFetch(CLAUDE_USAGE);
    await readClaudeUsage(
      '/profile',
      deps({ readTextFile: vi.fn(async () => CLAUDE_CREDS), fetch: fetchMock }),
    );
    const headers = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1].headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'anthropic-beta',
    ]);
    expect(JSON.stringify(headers)).not.toMatch(/claude-cli/i);
  });

  test("carries the provider's own exhausted verdict rather than a percentage threshold", async () => {
    const usage = await readClaudeUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch({
          ...CLAUDE_USAGE,
          // Low percentages, but the provider says the spend limit is reached.
          extra_usage: { spend_limit_reached: true },
        }),
      }),
    );
    expect(usage.status === 'ok' && usage.exhausted).toBe(true);
  });
});

describe('credential usage — Codex', () => {
  test('normalizes epoch resets and per-model additional limits', async () => {
    const usage = await readCodexUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CODEX_CREDS),
        fetch: jsonFetch(CODEX_USAGE),
      }),
    );
    expect(usage.status).toBe('ok');
    if (usage.status !== 'ok') return;
    expect(usage.planLabel).toBe('Pro');
    expect(usage.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour limit', 100],
      ['GPT-5.3-Codex-Spark (5-hour)', 0],
      ['GPT-5.3-Codex-Spark (weekly)', 1],
    ]);
    // epoch seconds -> ISO (1787463023 is 2026-08-23T05:30:23Z)
    expect(usage.windows[0]?.resetsAt).toBe('2026-08-23T05:30:23.000Z');
    expect(usage.windows[1]?.resetsAt).toBe('2026-08-20T21:21:14.000Z');
  });

  // The live payload pairs used_percent: 100 with limit_reached: true. A UI
  // keying off the percentage alone would have to guess what 100 means.
  test("reports exhausted from the provider's flags, not from used_percent", async () => {
    const usage = await readCodexUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CODEX_CREDS),
        fetch: jsonFetch(CODEX_USAGE),
      }),
    );
    expect(usage.status === 'ok' && usage.exhausted).toBe(true);

    // Same 100%, but the provider says it is still allowed: not exhausted.
    const allowed = await readCodexUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CODEX_CREDS),
        fetch: jsonFetch({
          ...CODEX_USAGE,
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 100, reset_at: 1787463023 },
          },
        }),
      }),
    );
    expect(allowed.status === 'ok' && allowed.exhausted).toBe(false);
  });

  test('sends no Originator or OpenAI-Beta client identity', async () => {
    const fetchMock = jsonFetch(CODEX_USAGE);
    await readCodexUsage(
      '/profile',
      deps({ readTextFile: vi.fn(async () => CODEX_CREDS), fetch: fetchMock }),
    );
    const headers = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1].headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'Chatgpt-Account-Id',
    ]);
  });
});

// An empty meter that means "nothing used" and one that means "we could not
// ask" must never be the same value.
describe('unknown is never zero', () => {
  const cases: Array<[string, Partial<UsageFetchDeps>, RegExp]> = [
    [
      'no credential on disk',
      {
        readTextFile: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
      },
      /No signed-in credential/i,
    ],
    [
      'expired token (401)',
      {
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch({ error: 'expired' }, 401),
      },
      /rejected.*Sign in again/i,
    ],
    [
      'provider error (500)',
      {
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch({}, 500),
      },
      /returned 500/,
    ],
    [
      'network failure',
      {
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }) as never,
      },
      /could not be reached/i,
    ],
  ];

  for (const [name, overrides, reason] of cases) {
    test(`${name} reports unknown with a reason, never 0%`, async () => {
      const usage = await readClaudeUsage('/profile', deps(overrides));
      expect(usage.status).toBe('unknown');
      if (usage.status !== 'unknown') return;
      expect(usage.reason).toMatch(reason);
      expect(usage.fetchedAt).toBe(AT);
      expect(usage).not.toHaveProperty('windows');
    });
  }

  // This previously asserted `ok` with zero windows. Independent review (Codex)
  // was right that it PINNED the fail-open: a 200 carrying nothing this version
  // recognizes is a reading we do not have, and rendering it as a healthy card
  // with no limits claims the account is fine when we cannot tell.
  test('a payload with nothing recognizable is unknown, not an empty ok', async () => {
    const usage = await readClaudeUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch({ five_hour: { utilization: 'lots' }, limits: null }),
      }),
    );
    expect(usage.status).toBe('unknown');
    expect(usage).not.toHaveProperty('windows');
  });
});

/**
 * Independent review (Codex) found these escape the "unknown is never zero"
 * guarantee: each threw out of the normalizer rather than degrading, and the
 * route's Promise.all then turned one bad account into a 500 for every
 * account.
 */
describe('adversarial 200 bodies degrade to unknown, never throw', () => {
  const bodies: Array<[string, unknown]> = [
    ['a null body', null],
    ['limits as an object, not an array', { limits: {} }],
    ['additional_rate_limits as an object', { additional_rate_limits: {} }],
    ['a negative utilization', { five_hour: { utilization: -20 } }],
    ['a string utilization', { five_hour: { utilization: 'lots' } }],
  ];

  for (const [name, body] of bodies) {
    test(`${name} is unknown with a reason, and never rejects`, async () => {
      for (const read of [readClaudeUsage, readCodexUsage]) {
        const usage = await read(
          '/profile',
          deps({
            readTextFile: vi.fn(async () =>
              read === readClaudeUsage ? CLAUDE_CREDS : CODEX_CREDS,
            ),
            fetch: jsonFetch(body),
          }),
        );
        expect(usage.status).toBe('unknown');
        if (usage.status !== 'unknown') return;
        expect(usage.reason).toBeTruthy();
        expect(usage).not.toHaveProperty('windows');
      }
    });
  }

  // An unusable RESET must not discard a usable PERCENTAGE — the window is
  // still real, we just cannot say when it turns over.
  test('an unrepresentable reset_at drops the reset, not the reading', async () => {
    const usage = await readCodexUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CODEX_CREDS),
        fetch: jsonFetch({
          rate_limit: { primary_window: { used_percent: 5, reset_at: 1e15 } },
        }),
      }),
    );
    expect(usage.status).toBe('ok');
    if (usage.status !== 'ok') return;
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]?.usedPercent).toBe(5);
    expect(usage.windows[0]?.resetsAt).toBeUndefined();
  });

  // A negative is not "nothing used" — it is a value this code does not
  // understand, and clamping it to 0 rendered a healthy empty meter.
  test('a negative percentage is not clamped into a healthy zero', async () => {
    const usage = await readClaudeUsage(
      '/profile',
      deps({
        readTextFile: vi.fn(async () => CLAUDE_CREDS),
        fetch: jsonFetch({
          five_hour: { utilization: -20 },
          seven_day: { utilization: 30 },
        }),
      }),
    );
    expect(usage.status).toBe('ok');
    if (usage.status !== 'ok') return;
    // The unusable window is dropped; the usable one survives.
    expect(usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['seven-day', 30],
    ]);
  });
});
