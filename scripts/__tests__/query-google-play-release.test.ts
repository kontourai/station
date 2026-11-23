import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  parseGooglePlayObservation,
  queryGooglePlayInternal,
  READBACK_WORST_CASE_MS,
} from '../query-google-play-release.mjs';
import { PLAY_ADAPTER_LIMIT_MS } from '../verify-release-cohort.mjs';

const identity = {
  packageName: 'io.kontourai.station.nightly',
  versionCode: 242801,
  versionName: '0.1.3-nightly.242801',
};
const response = () => ({
  track: {
    releases: [
      {
        name: identity.versionName,
        status: 'completed',
        versionCodes: [String(identity.versionCode)],
      },
    ],
  },
  bundles: {
    bundles: [{ versionCode: identity.versionCode, sha256: 'a'.repeat(64) }],
  },
});
const NODE_STARTUP_HEADROOM_MS = 20_000;

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    response: { status, headers: new Headers(headers) },
  });
const never = () => new Promise<never>(() => {});

type Request = {
  method: string;
  url: string;
  timeout: number;
  signal: AbortSignal;
};
type Handler = (request: Request, attempt: number) => unknown;

/** A healthy publisher unless `handler` returns something other than undefined. */
function publisher(handler: Handler = () => undefined) {
  const calls: {
    attempt: number;
    method: string;
    url: string;
    timeout: number;
  }[] = [];
  let attempt = 0;
  const reply = async (request: Request) => {
    calls.push({
      attempt,
      method: request.method,
      url: request.url,
      timeout: request.timeout,
    });
    const override = await handler(request, attempt);
    if (override !== undefined) return override;
    if (request.method === 'POST') return { data: { id: `edit-${attempt}` } };
    if (request.method === 'DELETE') return { data: {} };
    if (request.url.endsWith('/tracks/internal'))
      return { data: response().track };
    return { data: response().bundles };
  };
  return {
    calls,
    methods: () => calls.map((call) => call.method),
    authFactory: async () => {
      attempt += 1;
      const current = attempt;
      return {
        getClient: async () => ({
          getAccessToken: async (): Promise<unknown> => ({
            token: `token-${current}`,
          }),
          request: reply,
        }),
      };
    },
  };
}

/** Fake clock and sleep: waits advance `now` and cost no real time. */
function fakeTime(start = 0) {
  const state = { now: start, sleeps: [] as number[], logs: [] as string[] };
  return {
    state,
    options: {
      now: () => state.now,
      sleep: async (ms: number) => {
        state.sleeps.push(ms);
        state.now += ms;
      },
      log: (line: string) => state.logs.push(line),
    },
  };
}

describe('Google Play internal observation', () => {
  test('requires one complete observed release and bundle for the Nightly identity', () => {
    expect(parseGooglePlayObservation(identity, response())).toMatchObject({
      provider: 'google-play',
      requested: { track: 'internal', status: 'completed' },
      observed: { versionName: identity.versionName },
      rawResponseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    for (const mutate of [
      (value: any) => (value.track.releases[0].status = 'inProgress'),
      (value: any) => (value.track.releases[0].name = 'unbound'),
      (value: any) => value.track.releases.push(value.track.releases[0]),
      (value: any) => (value.bundles.bundles = []),
      (value: any) => value.bundles.bundles.push(value.bundles.bundles[0]),
    ]) {
      const value = response();
      mutate(value);
      expect(() => parseGooglePlayObservation(identity, value)).toThrow(
        'Google Play cohort verification failed',
      );
    }
    expect(() =>
      parseGooglePlayObservation(
        { ...identity, packageName: 'io.kontourai.station' },
        response(),
      ),
    ).toThrow('Nightly listing');
  });

  test.each([
    ['authenticate', []],
    ['acquire-client', []],
    ['acquire-token', []],
    ['create-edit', ['POST']],
    ['read-track', ['POST', 'GET', 'DELETE']],
    ['read-bundles', ['POST', 'GET', 'GET', 'DELETE']],
    ['validate-observation', ['POST', 'GET', 'GET', 'DELETE']],
  ] as const)(
    'reports a safe, final %s failure and preserves edit custody',
    async (phase, methods) => {
      const calls: string[] = [];
      const privateError = new Error('private-provider-context');
      const time = fakeTime();
      const client = {
        getAccessToken: async () => {
          if (phase === 'acquire-token') throw privateError;
          return { token: 'token' };
        },
        request: async ({ method, url }: { method: string; url: string }) => {
          calls.push(method);
          if (method === 'POST') {
            if (phase === 'create-edit') throw privateError;
            return { data: { id: 'private-edit-id' } };
          }
          if (method === 'DELETE') return { data: {} };
          if (url.endsWith('/tracks/internal')) {
            if (phase === 'read-track') throw privateError;
            const { track } = response();
            if (phase === 'validate-observation')
              track.releases[0].status = privateError.message;
            return { data: track };
          }
          if (phase === 'read-bundles') throw privateError;
          return { data: response().bundles };
        },
      };
      await expect(
        queryGooglePlayInternal(identity, {
          ...time.options,
          authFactory: async () => {
            if (phase === 'authenticate') throw privateError;
            return {
              getClient: async () => {
                if (phase === 'acquire-client') throw privateError;
                return client;
              },
            };
          },
        }),
      ).rejects.toMatchObject({
        message: `Google Play cohort verification failed: ${phase} failed (attempt 1 of 3)`,
        cause:
          phase === 'validate-observation'
            ? expect.objectContaining({
                message: expect.stringContaining(privateError.message),
              })
            : privateError,
      });
      expect(calls).toEqual(methods);
      expect(time.state.sleeps).toEqual([]);
    },
  );

  test('does not delete an edit when its creation returned no valid identity', async () => {
    const play = publisher((request) =>
      request.method === 'POST' ? { data: { id: 42 } } : undefined,
    );
    await expect(
      queryGooglePlayInternal(identity, {
        ...fakeTime().options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow('create-edit failed (attempt 1 of 3)');
    expect(play.methods()).toEqual(['POST']);
  });

  test('uses ADC, bounds every request and deletes the temporary edit', async () => {
    const play = publisher((request) =>
      request.method === 'POST'
        ? { data: { id: 'edit/unsafe;literal' } }
        : undefined,
    );
    await expect(
      queryGooglePlayInternal(identity, {
        ...fakeTime().options,
        authFactory: play.authFactory,
      }),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(play.methods()).toEqual(['POST', 'GET', 'GET', 'DELETE']);
    expect(play.calls.every((call) => call.timeout === 15_000)).toBe(true);
    expect(play.calls.at(-1)?.url).toContain('edit%2Funsafe%3Bliteral');
  });
});

describe('Google Play readback retry', () => {
  test.each([
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [599, true],
    [400, false],
    [403, false],
    [404, false],
    [499, false],
  ])('HTTP %i from create-edit is retried: %s', async (status, retried) => {
    const play = publisher((request, attempt) =>
      request.method === 'POST' && attempt === 1
        ? Promise.reject(httpError(status))
        : undefined,
    );
    const time = fakeTime();
    const run = queryGooglePlayInternal(identity, {
      ...time.options,
      authFactory: play.authFactory,
    });
    if (retried) {
      await expect(run).resolves.toMatchObject({ provider: 'google-play' });
      expect(play.methods()).toEqual(['POST', 'POST', 'GET', 'GET', 'DELETE']);
      expect(time.state.logs).toEqual([
        `Google Play cohort verification failed: create-edit failed with HTTP ${status} (attempt 1 of 3); retrying in 2000 ms from a new edit`,
      ]);
    } else {
      await expect(run).rejects.toThrow(
        `Google Play cohort verification failed: create-edit failed with HTTP ${status} (attempt 1 of 3)`,
      );
      expect(play.methods()).toEqual(['POST']);
      expect(time.state.sleeps).toEqual([]);
    }
  });

  test.each([
    ['ECONNRESET', { code: 'ECONNRESET' }, true],
    ['ENOTFOUND', { code: 'ENOTFOUND' }, true],
    [
      'nested UND_ERR_SOCKET',
      { cause: { cause: { code: 'UND_ERR_SOCKET' } } },
      true,
    ],
    ['an abort', { name: 'AbortError' }, true],
    ['a non-transport error', {}, false],
    ['an unknown code', { code: 'ERR_INVALID_URL' }, false],
  ])('%s from read-track is retried: %s', async (_label, shape, retried) => {
    const play = publisher((request, attempt) =>
      request.url.endsWith('/tracks/internal') && attempt === 1
        ? Promise.reject(Object.assign(new Error('private'), shape))
        : undefined,
    );
    const run = queryGooglePlayInternal(identity, {
      ...fakeTime().options,
      authFactory: play.authFactory,
    });
    if (retried)
      await expect(run).resolves.toMatchObject({ provider: 'google-play' });
    else
      await expect(run).rejects.toThrow('read-track failed (attempt 1 of 3)');
    expect(play.calls.filter((call) => call.method === 'POST')).toHaveLength(
      retried ? 2 : 1,
    );
  });

  test('waits 2 s then 5 s, uses a new client and edit per attempt, then fails naming the last attempt', async () => {
    const play = publisher((request) =>
      request.method === 'GET' && request.url.endsWith('/bundles')
        ? Promise.reject(httpError(503))
        : undefined,
    );
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow(
      'Google Play cohort verification failed: read-bundles failed with HTTP 503 (attempt 3 of 3)',
    );
    expect(time.state.sleeps).toEqual([2_000, 5_000]);
    expect(time.state.logs).toHaveLength(2);
    expect(time.state.logs[1]).toContain(
      '(attempt 2 of 3); retrying in 5000 ms',
    );
    // Each attempt deleted the edit it created, from its own client.
    for (const attempt of [1, 2, 3]) {
      const own = play.calls.filter((call) => call.attempt === attempt);
      expect(own.map((call) => call.method)).toEqual([
        'POST',
        'GET',
        'GET',
        'DELETE',
      ]);
      expect(
        own
          .slice(1)
          .every((call) => call.url.includes(`/edits/edit-${attempt}`)),
      ).toBe(true);
    }
  });

  test('a longer Retry-After on 429 sets the wait; a shorter one does not', async () => {
    for (const [header, wait] of [
      ['30', 30_000],
      ['1', 2_000],
    ] as const) {
      const play = publisher((request, attempt) =>
        request.method === 'POST' && attempt === 1
          ? Promise.reject(httpError(429, { 'retry-after': header }))
          : undefined,
      );
      const time = fakeTime();
      await queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      });
      expect(time.state.sleeps).toEqual([wait]);
    }
  });

  test('nothing read in a failed attempt is reused by the next', async () => {
    // Attempt 1 reads a good track and then fails; attempt 2's own track no
    // longer shows the release, so only reuse could produce an observation.
    const play = publisher((request, attempt) => {
      if (request.url.endsWith('/bundles') && attempt === 1)
        return Promise.reject(httpError(503));
      if (request.url.endsWith('/tracks/internal') && attempt === 2)
        return { data: { releases: [] } };
      return undefined;
    });
    await expect(
      queryGooglePlayInternal(identity, {
        ...fakeTime().options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow('validate-observation failed (attempt 2 of 3)');
  });

  test('a rejected observation is final', async () => {
    const play = publisher((request) =>
      request.url.endsWith('/tracks/internal')
        ? { data: { releases: [] } }
        : undefined,
    );
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow('validate-observation failed (attempt 1 of 3)');
    expect(play.methods()).toEqual(['POST', 'GET', 'GET', 'DELETE']);
    expect(time.state.sleeps).toEqual([]);
  });

  test.each([
    ['abort', 'aborted', 3],
    ['local deadline', 'local deadline elapsed', 3],
    ['unrelated failure after deadline', 'failed', 1],
  ] as const)(
    'reports %s without exposing the transport error',
    async (input, outcome, attempts) => {
      const play = publisher((request) => {
        if (request.method !== 'GET') return undefined;
        if (input === 'abort')
          return Promise.reject(
            new DOMException('private-context', 'AbortError'),
          );
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(
              input === 'local deadline'
                ? request.signal.reason
                : new Error('private-context'),
            ),
          ),
        );
      });
      await expect(
        queryGooglePlayInternal(identity, {
          ...fakeTime().options,
          authFactory: play.authFactory,
          requestTimeoutMs: input === 'abort' ? 15_000 : 1,
        }),
      ).rejects.toMatchObject({
        message: `Google Play cohort verification failed: read-track ${outcome} (attempt ${attempts} of 3)`,
      });
    },
  );
});

describe('Google Play readback token stage', () => {
  /** The first attempt's token request uses `firstToken`; later ones succeed. */
  const firstTokenFails = (firstToken: () => Promise<unknown>) => {
    const play = publisher();
    let factories = 0;
    return {
      play,
      factories: () => factories,
      authFactory: async () => {
        factories += 1;
        const current = factories;
        const auth = await play.authFactory();
        const client = await auth.getClient();
        return {
          getClient: async () =>
            current === 1 ? { ...client, getAccessToken: firstToken } : client,
        };
      },
    };
  };

  test('a token request that ignores its signal is abandoned at its limit and retried from a new client', async () => {
    const auth = firstTokenFails(never);
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: auth.authFactory,
        requestTimeoutMs: 20,
      }),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(auth.factories()).toBe(2);
    expect(time.state.logs).toEqual([
      'Google Play cohort verification failed: acquire-token local deadline elapsed (attempt 1 of 3); retrying in 2000 ms from a new edit',
    ]);
    expect(auth.play.methods()).toEqual(['POST', 'GET', 'GET', 'DELETE']);
  });

  test.each([
    [503, 2],
    [400, 1],
  ])('a token exchange HTTP %i makes %i attempts', async (status, attempts) => {
    const auth = firstTokenFails(() => Promise.reject(httpError(status)));
    const run = queryGooglePlayInternal(identity, {
      ...fakeTime().options,
      authFactory: auth.authFactory,
    });
    if (attempts === 2)
      await expect(run).resolves.toMatchObject({ provider: 'google-play' });
    else
      await expect(run).rejects.toThrow(
        'acquire-token failed with HTTP 400 (attempt 1 of 3)',
      );
    expect(auth.factories()).toBe(attempts);
  });

  test('the token limit is taken from the remaining budget', async () => {
    // Attempt 2 starts with 42 ms of budget left, so its stalled token
    // request is abandoned after 42 ms, not after the 60 s request bound.
    const time = fakeTime();
    let factories = 0;
    const play = publisher((request, attempt) => {
      if (request.method === 'POST' && attempt === 1) {
        time.state.now = 958;
        return Promise.reject(httpError(503));
      }
      return undefined;
    });
    const started = performance.now();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: async () => {
          factories += 1;
          const current = factories;
          const auth = await play.authFactory();
          const client = await auth.getClient();
          return {
            getClient: async () =>
              current === 1 ? client : { ...client, getAccessToken: never },
          };
        },
        requestTimeoutMs: 60_000,
        totalBudgetMs: 3_000,
        minAttemptBudgetMs: 30,
      }),
    ).rejects.toThrow(
      'readback budget spent: 0 ms of the 3000 ms budget would remain after a 5000 ms wait, below the 30 ms an attempt needs; last failure: acquire-token local deadline elapsed (attempt 2 of 3)',
    );
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('Google Play readback budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('does not start an attempt with less than the minimum left (real defaults)', async () => {
    const time = fakeTime();
    const play = publisher((request, attempt) => {
      if (request.method !== 'POST' || attempt > 2) return undefined;
      // Attempt 1 fails at 45 s (13 s would remain after the 2 s wait);
      // attempt 2 fails at 50 s (5 s would remain after the 5 s wait).
      time.state.now = attempt === 1 ? 45_000 : 50_000;
      return Promise.reject(httpError(503));
    });
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow(
      'Google Play cohort verification failed: readback budget spent: 5000 ms of the 60000 ms budget would remain after a 5000 ms wait, below the 10000 ms an attempt needs; last failure: create-edit failed with HTTP 503 (attempt 2 of 3)',
    );
    expect(play.methods()).toEqual(['POST', 'POST']);
  });

  test('the worst case with the real defaults ends within READBACK_WORST_CASE_MS, under the verifier limit', async () => {
    expect(READBACK_WORST_CASE_MS).toBe(65_000);
    // The verifier's real limit on this adapter, pinned beside the import so
    // the headroom check does not derive everything from the constant.
    expect(PLAY_ADAPTER_LIMIT_MS).toBe(90_000);
    expect(
      READBACK_WORST_CASE_MS + NODE_STARTUP_HEADROOM_MS,
    ).toBeLessThanOrEqual(PLAY_ADAPTER_LIMIT_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Attempt 1: create stalls (15 s), wait 2 s. Attempt 2: token stalls
    // (15 s), wait 5 s. Attempt 3 starts at 37 s: track answers after 14 s,
    // bundles stall until the 60 s deadline, and the stalled cleanup gets the
    // 5 s floor. Every stall ignores its signal.
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    let attempt = 0;
    const start = Date.now();
    let settledAt = 0;
    const run = queryGooglePlayInternal(identity, {
      authFactory: async () => {
        attempt += 1;
        const current = attempt;
        return {
          getClient: async () => ({
            getAccessToken: async () =>
              current === 2 ? never() : { token: 'token' },
            request: async (request: Request) => {
              if (request.method === 'POST')
                return current === 1 ? never() : { data: { id: 'edit' } };
              if (request.url.endsWith('/tracks/internal')) {
                await sleep(14_000);
                return { data: response().track };
              }
              return never();
            },
          }),
        };
      },
      log: () => {},
    }).finally(() => {
      settledAt = Date.now() - start;
    });
    run.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(run).rejects.toThrow(
      'delete-edit local deadline elapsed (attempt 3 of 3) after read-bundles local deadline elapsed (attempt 3 of 3)',
    );
    expect(settledAt).toBeGreaterThan(READBACK_WORST_CASE_MS - 1_000);
    expect(settledAt).toBeLessThanOrEqual(READBACK_WORST_CASE_MS + 10);
  });
});

describe('Google Play readback cleanup', () => {
  test.each([
    [
      'fails',
      () => Promise.reject(httpError(500)),
      'delete-edit failed with HTTP 500',
    ],
    ['stalls', never, 'delete-edit local deadline elapsed'],
  ])(
    'a cleanup that %s after a good read is a warning naming the edit',
    async (_label, remove, detail) => {
      const play = publisher((request) =>
        request.method === 'DELETE' ? remove() : undefined,
      );
      const time = fakeTime();
      await expect(
        queryGooglePlayInternal(identity, {
          ...time.options,
          authFactory: play.authFactory,
          requestTimeoutMs: 20,
        }),
      ).resolves.toMatchObject({ provider: 'google-play' });
      expect(time.state.logs).toEqual([
        `Google Play readback warning: ${detail} (attempt 1 of 3) for temporary edit edit-1; the edit was never committed`,
      ]);
      expect(play.methods()).toEqual(['POST', 'GET', 'GET', 'DELETE']);
    },
  );

  test('a read and its cleanup that both fail transiently are retried and can succeed', async () => {
    const play = publisher((request, attempt) =>
      attempt === 1 &&
      (request.method === 'DELETE' || request.url.endsWith('/tracks/internal'))
        ? Promise.reject(httpError(503))
        : undefined,
    );
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(play.methods()).toEqual([
      'POST',
      'GET',
      'DELETE',
      'POST',
      'GET',
      'GET',
      'DELETE',
    ]);
    expect(time.state.sleeps).toEqual([2_000]);
    expect(time.state.logs).toEqual([
      'Google Play cohort verification failed: delete-edit failed with HTTP 503 (attempt 1 of 3) after read-track failed with HTTP 503 (attempt 1 of 3); retrying in 2000 ms from a new edit',
    ]);
  });

  test('both-transient failures end when every attempt fails, naming both phases', async () => {
    const play = publisher((request) =>
      request.method === 'DELETE' || request.url.endsWith('/tracks/internal')
        ? Promise.reject(httpError(503))
        : undefined,
    );
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).rejects.toThrow(
      'delete-edit failed with HTTP 503 (attempt 3 of 3) after read-track failed with HTTP 503 (attempt 3 of 3)',
    );
    expect(play.methods().filter((method) => method === 'POST')).toHaveLength(
      3,
    );
  });

  test('a transient read failure with a cleanup that is not transient is final', async () => {
    const play = publisher((request) =>
      request.method === 'DELETE'
        ? Promise.reject(httpError(403))
        : request.url.endsWith('/tracks/internal')
          ? Promise.reject(httpError(503))
          : undefined,
    );
    const time = fakeTime();
    await expect(
      queryGooglePlayInternal(identity, {
        ...time.options,
        authFactory: play.authFactory,
      }),
    ).rejects.toMatchObject({
      message:
        'Google Play cohort verification failed: delete-edit failed with HTTP 403 (attempt 1 of 3) after read-track failed with HTTP 503 (attempt 1 of 3)',
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({
            cause: expect.objectContaining({ status: 403 }),
          }),
          expect.objectContaining({
            cause: expect.objectContaining({ status: 503 }),
          }),
        ],
      }),
    });
    expect(play.methods()).toEqual(['POST', 'GET', 'DELETE']);
    expect(time.state.sleeps).toEqual([]);
  });
});
