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
      ['Primary limit', 100],
      ['GPT-5.3-Codex-Spark · primary', 0],
      ['GPT-5.3-Codex-Spark · secondary', 1],
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
    expect(allowed.status).toBe('ok');
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

test('Claude quota borrows only the selected secure-store credential without exposing it', async () => {
  const secure = vi.fn(async () => CLAUDE_CREDS);
  const fetch = jsonFetch(CLAUDE_USAGE);
  const usage = await readClaudeUsage(
    '/selected-account',
    deps({
      readTextFile: async () =>
        JSON.stringify({ claudeAiOauth: { accessToken: 'stale-file-token' } }),
      readClaudeSecureCredentials: secure,
      fetch,
    }),
  );
  expect(secure).toHaveBeenCalledWith('/selected-account');
  expect(usage.status).toBe('ok');
  expect(JSON.stringify(usage)).not.toContain('tok-claude');
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tok-claude' }),
    }),
  );
});

test('Codex nested CLI credentials retain their account selector when reading quota', async () => {
  const fetch = jsonFetch(CODEX_USAGE);
  const usage = await readCodexUsage(
    '/selected-account',
    deps({
      readTextFile: async () =>
        JSON.stringify({
          tokens: {
            access_token: 'nested-token',
            account_id: 'nested-account',
          },
        }),
      fetch,
    }),
  );
  expect(usage.status).toBe('ok');
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer nested-token',
        'Chatgpt-Account-Id': 'nested-account',
      }),
    }),
  );
  expect(JSON.stringify(usage)).not.toContain('nested-token');
});

// Values are synthetic; the field shape was observed from wham/usage on 2026-10-01.
test('preserves weekly-only Codex buckets, account credits and model metadata without leaking unhandled values', async () => {
  const usage = await readCodexUsage(
    '/profile',
    deps({
      readTextFile: vi.fn(async () => CODEX_CREDS),
      fetch: jsonFetch({
        user_id: 'user-test',
        account_id: 'account-test',
        email: 'person@example.test',
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 604800,
            reset_after_seconds: 3600,
            reset_at: 1787463023,
          },
          secondary_window: null,
        },
        additional_rate_limits: [
          {
            limit_name: 'Reserve',
            metered_feature: 'reserve',
            normal_model_slug: 'gpt-5.3-codex',
            rate_limit: {
              allowed: false,
              limit_reached: true,
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 604800,
              },
            },
          },
        ],
        model_usage: {
          'gpt-5.3-codex': {
            available: false,
            available_at: null,
            credits_would_enable: true,
          },
        },
        chatpass: {
          windows: [
            {
              used_percent: 10,
              limit_window_seconds: 86400,
              reset_at: 1787463023,
            },
          ],
        },
        credits: {
          has_credits: true,
          unlimited: false,
          overage_limit_reached: false,
          balance: '12.50',
          approx_local_messages: [10, 20],
          approx_cloud_messages: [2, 5],
        },
        spend_control: { reached: false, individual_limit: 100 },
        rate_limit_reset_credits: {
          available_count: 2,
          applicable_available_count: 1,
        },
        promo: { secret: 'PROMO_PRIVATE' },
        future: { token: 'NEVER_RETURN_THIS' },
      }),
    }),
  );
  expect(usage.status).toBe('ok');
  if (usage.status !== 'ok') throw new Error('Expected quota');
  expect(usage.windows).toEqual([
    {
      id: 'primary',
      label: 'Weekly limit',
      usedPercent: 42,
      durationSeconds: 604800,
      resetAfterSeconds: 3600,
      resetsAt: '2026-08-23T05:30:23.000Z',
      allowed: true,
      limitReached: false,
    },
    {
      id: 'Reserve-primary',
      label: 'Reserve · weekly',
      usedPercent: 100,
      durationSeconds: 604800,
      allowed: false,
      limitReached: true,
      model: 'gpt-5.3-codex',
      meteredFeature: 'reserve',
    },
    {
      id: 'chatpass-0',
      label: 'Chat pass · 1-day',
      usedPercent: 10,
      durationSeconds: 86400,
      resetsAt: '2026-08-23T05:30:23.000Z',
    },
  ]);
  expect(usage.metadata).toEqual({
    identity: {
      email: 'person@example.test',
      accountId: 'account-test',
      userId: 'user-test',
    },
    credits: {
      available: true,
      unlimited: false,
      overageLimitReached: false,
      balance: 12.5,
      approximateLocalMessages: [10, 20],
      approximateCloudMessages: [2, 5],
    },
    resetCredits: { available: 2, applicable: 1 },
    models: [
      {
        id: 'gpt-5.3-codex',
        available: false,
        availableAt: undefined,
        creditsWouldEnable: true,
      },
    ],
    capture: {
      source: 'codex-wham-usage',
      credentialStorage: 'file',
      unhandledFields: ['future.token'],
      excludedFields: ['promo.secret', 'spend_control.individual_limit'],
      truncated: false,
    },
  });
  expect(JSON.stringify(usage)).not.toMatch(
    /NEVER_RETURN_THIS|PROMO_PRIVATE|tok-codex/,
  );
});

test('captures Claude model-specific windows and extra usage while reporting response drift', async () => {
  const usage = await readClaudeUsage(
    '/profile',
    deps({
      readTextFile: vi.fn(async () => CLAUDE_CREDS),
      fetch: jsonFetch({
        five_hour: { utilization: 10, resets_at: AT },
        seven_day_sonnet: { utilization: 30, resets_at: AT },
        seven_day_opus: null,
        extra_usage: {
          is_enabled: true,
          used_credits: 0,
          monthly_limit: 5000,
          utilization: 0,
          spend_limit_reached: false,
        },
        future_window: { utilization: 99 },
      }),
    }),
  );
  expect(usage.status).toBe('ok');
  if (usage.status !== 'ok') throw new Error('Expected quota');
  expect(usage.windows.find((w) => w.id === 'seven_day_sonnet')).toEqual({
    id: 'seven_day_sonnet',
    label: 'Weekly · Sonnet',
    usedPercent: 30,
    durationSeconds: 604800,
    resetsAt: AT,
  });
  expect(usage.metadata?.extraUsage).toEqual({
    enabled: true,
    used: 0,
    monthlyLimit: 5000,
    usedPercent: 0,
    limitReached: false,
  });
  expect(usage.metadata?.capture.unhandledFields).toEqual([
    'future_window.utilization',
  ]);
});

test('preserves Codex credits and shape gaps when quota windows are unavailable', async () => {
  const usage = await readCodexUsage(
    '/profile',
    deps({
      readTextFile: vi.fn(async () => CODEX_CREDS),
      fetch: jsonFetch({
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          primary_window: null,
          secondary_window: null,
        },
        credits: { unlimited: true, balance: '12.50' },
        future_limit: { used: 4 },
      }),
    }),
  );
  expect(usage.status).toBe('unknown');
  expect(usage.planLabel).toBe('Pro');
  expect(usage.metadata?.credits).toMatchObject({
    unlimited: true,
    balance: 12.5,
  });
  expect(usage.metadata?.capture.unhandledFields).toEqual([
    'future_limit.used',
  ]);
});

test('reports omitted models and unhandled nested availability as incomplete capture', async () => {
  const models = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [
      `model-${index}`,
      {
        available: true,
        ...(index === 0 ? { future: { available: false } } : {}),
      },
    ]),
  );
  const usage = await readCodexUsage(
    '/profile',
    deps({
      readTextFile: vi.fn(async () => CODEX_CREDS),
      fetch: jsonFetch({ model_usage: models }),
    }),
  );
  expect(usage.metadata?.models).toHaveLength(32);
  expect(usage.metadata?.capture.truncated).toBe(true);
  expect(usage.metadata?.capture.unhandledFields).toEqual([
    'model_usage[].future.available',
  ]);
});

// Sanitized field shape from the successful macOS secure-store probe on 2026-10-01.
test('captures Claude spending units, weekly breakdown and active limit details from the live shape', async () => {
  const usage = await readClaudeUsage(
    '/selected',
    deps({
      readClaudeSecureCredentials: async () => CLAUDE_CREDS,
      fetch: jsonFetch({
        five_hour: { utilization: 20, resets_at: AT },
        extra_usage: {
          is_enabled: false,
          user_disabled: true,
          spend_limit_reached: false,
          credits_ever_enabled: true,
        },
        limits: [
          {
            kind: 'session',
            group: 'included',
            percent: 20,
            severity: 'normal',
            resets_at: AT,
            is_active: true,
            scope: null,
          },
        ],
        spend: {
          used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
          enabled: false,
          percent: 0,
          severity: 'normal',
          can_purchase_credits: true,
          can_toggle: false,
          disclaimer: 'Provider spending information',
        },
        member_dashboard_available: true,
        seven_day_breakdown: {
          as_of: AT,
          window_started_at: AT,
          rows: [{ key: 'code', display_name: 'Claude Code', percent: 12.5 }],
        },
      }),
    }),
  );
  expect(usage.status).toBe('ok');
  expect(usage.metadata?.spending).toMatchObject({
    used: { amountMinor: 1234, currency: 'USD', exponent: 2 },
    enabled: false,
    usedPercent: 0,
    canPurchaseCredits: true,
    canToggle: false,
    disclaimer: 'Provider spending information',
  });
  expect(usage.metadata?.extraUsage).toMatchObject({
    userDisabled: true,
    everEnabled: true,
  });
  expect(usage.metadata?.limitDetails).toEqual([
    {
      kind: 'session',
      group: 'included',
      usedPercent: 20,
      severity: 'normal',
      resetsAt: AT,
      active: true,
      model: undefined,
      modelId: undefined,
      surface: undefined,
    },
  ]);
  expect(usage.metadata?.weeklyBreakdown).toEqual({
    asOf: AT,
    windowStartedAt: AT,
    rows: [{ key: 'code', label: 'Claude Code', usedPercent: 12.5 }],
  });
  expect(usage.metadata?.memberDashboardAvailable).toBe(true);
  expect(usage.metadata?.capture).toEqual({
    source: 'claude-oauth-usage',
    credentialStorage: 'secure-store',
    unhandledFields: [],
    excludedFields: [],
    truncated: false,
  });
});
