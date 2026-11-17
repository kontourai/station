import { describe, expect, test } from 'vitest';
import {
  parseGooglePlayObservation,
  queryGooglePlayInternal,
} from '../query-google-play-release.mjs';

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

  test('uses ADC and deletes the temporary edit even when the observation fails', async () => {
    const calls: any[] = [];
    const client = {
      request: async (request: any) => {
        calls.push(request);
        if (request.method === 'POST')
          return { data: { id: 'edit/unsafe;literal' } };
        if (
          request.method === 'GET' &&
          request.url.endsWith('/tracks/internal')
        )
          return { data: response().track };
        if (request.method === 'GET') return { data: response().bundles };
        return { data: {} };
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => client }),
      }),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'DELETE',
    ]);
    expect(calls.every((call) => call.timeout === 15_000 && call.signal)).toBe(
      true,
    );
    expect(calls.at(-1).url).toContain('edit%2Funsafe%3Bliteral');

    const failingClient = {
      request: async (request: any) => {
        calls.push(request);
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') return { data: {} };
        throw new Error('provider timeout');
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => failingClient }),
      }),
    ).rejects.toThrow('provider timeout');
    expect(calls.at(-1).method).toBe('DELETE');

    const cleanupFailure = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') throw new Error('cleanup timeout');
        return request.url.endsWith('/tracks/internal')
          ? { data: response().track }
          : { data: response().bundles };
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => cleanupFailure }),
      }),
    ).rejects.toThrow('temporary edit cleanup failed');

    const dualFailure = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') throw new Error('cleanup failed');
        throw new Error('track read failed');
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => dualFailure }),
      }),
    ).rejects.toThrow(
      'temporary edit cleanup failed: delete temporary edit failed: cleanup failed (attempt 1 of 3); operation also failed: read internal track failed: track read failed (attempt 1 of 3)',
    );

    const hangingClient = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') return { data: {} };
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => hangingClient }),
        requestTimeoutMs: 1,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(
      'read internal track timed out after 1 ms (attempt 3 of 3)',
    );
  });
});

// The shapes gaxios 7 (google-auth-library's transport) rejects with: an HTTP
// error carries `status` and a `response` whose headers are a `Headers`; a
// transport failure carries a string `code`; its own timeout surfaces as
// "The operation was aborted." with an AbortError cause.
const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    status,
    code: String(status),
    response: { status, headers: new Headers(headers) },
  });
const gaxiosAbort = () =>
  Object.assign(new Error('The operation was aborted.'), {
    cause: Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    }),
  });
const waitForAbort = (request: any) =>
  new Promise((_resolve, reject) =>
    request.signal.addEventListener('abort', () => reject(gaxiosAbort())),
  );

type Fault = (request: any, attempt: number) => Promise<any> | undefined;
const step = (request: any) =>
  request.method === 'POST'
    ? 'create'
    : request.method === 'DELETE'
      ? 'delete'
      : request.url.endsWith('/tracks/internal')
        ? 'track'
        : 'bundles';

/** A Play fake whose every attempt gets its own edit id. */
function playFake(
  fault: Fault,
  responses: (attempt: number) => ReturnType<typeof response> = response,
) {
  const calls: any[] = [];
  let attempt = 0;
  const client = {
    request: async (request: any) => {
      if (request.method === 'POST') attempt += 1;
      calls.push({ ...request, attempt, step: step(request) });
      const injected = fault(request, attempt);
      if (injected) return injected;
      if (request.method === 'POST') return { data: { id: `edit-${attempt}` } };
      if (request.method === 'DELETE') return { data: {} };
      const data = responses(attempt);
      return { data: step(request) === 'track' ? data.track : data.bundles };
    },
  };
  return { calls, client };
}

function harness(extra: Record<string, unknown> = {}) {
  let nowMs = 1_000_000;
  const sleeps: number[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    options: (client: any) => ({
      authFactory: async () => ({ getClient: async () => client }),
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      log: (line: string) => logs.push(line),
      ...extra,
    }),
  };
}
const created = (calls: any[]) =>
  calls.filter((call) => call.step === 'create').map((call) => call.attempt);
const deleted = (calls: any[]) =>
  calls
    .filter((call) => call.step === 'delete')
    .map((call) => decodeURIComponent(call.url.split('/edits/')[1]));

describe('Google Play readback retries', () => {
  const LABEL = {
    create: 'create temporary edit',
    track: 'read internal track',
    bundles: 'read bundles',
  } as const;

  for (const failing of ['create', 'track', 'bundles'] as const)
    test(`a timeout in ${LABEL[failing]} is retried from a new edit`, async () => {
      const { calls, client } = playFake((request, attempt) =>
        attempt === 1 && step(request) === failing
          ? waitForAbort(request)
          : undefined,
      );
      const run = harness({ requestTimeoutMs: 5 });
      await expect(
        queryGooglePlayInternal(identity, run.options(client)),
      ).resolves.toMatchObject({ provider: 'google-play' });
      expect(created(calls)).toEqual([1, 2]);
      // The failed attempt's edit is deleted when it was created at all.
      expect(deleted(calls)).toEqual(
        failing === 'create' ? ['edit-2'] : ['edit-1', 'edit-2'],
      );
      expect(run.sleeps).toEqual([2_000]);
      expect(run.logs).toEqual([
        `Google Play cohort verification failed: ${LABEL[failing]} timed out after 5 ms (attempt 1 of 3); retrying in 2000 ms from a new edit`,
      ]);
    });

  test('a cleanup timeout fails closed and is not retried, even after a good read', async () => {
    const { calls, client } = playFake((request) =>
      step(request) === 'delete' ? waitForAbort(request) : undefined,
    );
    const run = harness({ requestTimeoutMs: 5 });
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow(
      'Google Play cohort verification failed: temporary edit cleanup failed: delete temporary edit timed out after 5 ms (attempt 1 of 3)',
    );
    expect(created(calls)).toEqual([1]);
    expect(run.sleeps).toEqual([]);
  });

  test('a gaxios timeout that fires before our own signal is still a timeout', async () => {
    const { calls, client } = playFake((request, attempt) =>
      attempt === 1 && step(request) === 'create'
        ? Promise.reject(gaxiosAbort())
        : undefined,
    );
    const run = harness();
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(created(calls)).toEqual([1, 2]);
    expect(run.logs[0]).toContain(
      'create temporary edit timed out after 15000 ms (attempt 1 of 3)',
    );
  });

  test('a timeout on every attempt fails with the named request and deletes every edit', async () => {
    const { calls, client } = playFake((request) =>
      step(request) === 'bundles' ? waitForAbort(request) : undefined,
    );
    const run = harness({ requestTimeoutMs: 5 });
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow(
      'Google Play cohort verification failed: read bundles timed out after 5 ms (attempt 3 of 3)',
    );
    expect(created(calls)).toEqual([1, 2, 3]);
    expect(deleted(calls)).toEqual(['edit-1', 'edit-2', 'edit-3']);
    expect(run.sleeps).toEqual([2_000, 5_000]);
  });

  test('a network failure and a 5xx are retried', async () => {
    const { calls, client } = playFake((request, attempt) => {
      if (step(request) !== 'track') return undefined;
      if (attempt === 1)
        return Promise.reject(
          Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        );
      if (attempt === 2) return Promise.reject(httpError(503));
      return undefined;
    });
    const run = harness();
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(created(calls)).toEqual([1, 2, 3]);
    expect(run.logs[1]).toContain(
      'read internal track failed with HTTP 503: Request failed with status code 503 (attempt 2 of 3)',
    );
  });

  test('a 429 waits for Retry-After, or the backoff when it has none', async () => {
    for (const [headers, wait] of [
      [{ 'retry-after': '7' }, 7_000],
      [{}, 2_000],
      [{ 'retry-after': '1' }, 2_000],
    ] as const) {
      const { calls, client } = playFake((request, attempt) =>
        attempt === 1 && step(request) === 'create'
          ? Promise.reject(httpError(429, headers))
          : undefined,
      );
      const run = harness();
      await expect(
        queryGooglePlayInternal(identity, run.options(client)),
      ).resolves.toMatchObject({ provider: 'google-play' });
      expect(created(calls)).toEqual([1, 2]);
      expect(run.sleeps).toEqual([wait]);
    }
  });

  test('a 403 is the wrong identity or grant and is never retried', async () => {
    const { calls, client } = playFake((request) =>
      step(request) === 'create' ? Promise.reject(httpError(403)) : undefined,
    );
    const run = harness();
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow(
      'create temporary edit failed with HTTP 403: Request failed with status code 403 (attempt 1 of 3)',
    );
    expect(created(calls)).toEqual([1]);
    expect(run.sleeps).toEqual([]);
  });

  test('an observation the parser rejects is final, not retried', async () => {
    const { calls, client } = playFake(
      () => undefined,
      () => ({ ...response(), bundles: { bundles: [] } }),
    );
    const run = harness();
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow('target bundle is missing');
    expect(created(calls)).toEqual([1]);
    expect(deleted(calls)).toEqual(['edit-1']);
  });

  test("a retry's data stands alone: the earlier attempt's track is never reused", async () => {
    const { calls, client } = playFake(
      (request, attempt) =>
        attempt === 1 && step(request) === 'bundles'
          ? waitForAbort(request)
          : undefined,
      (attempt) => {
        const value = response();
        if (attempt === 2) value.track.releases[0].status = 'inProgress';
        return value;
      },
    );
    const run = harness({ requestTimeoutMs: 5 });
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow('target release status is inProgress, not completed');
    expect(calls.map((call) => `${call.attempt}:${call.step}`)).toEqual([
      '1:create',
      '1:track',
      '1:bundles',
      '1:delete',
      '2:create',
      '2:track',
      '2:bundles',
      '2:delete',
    ]);
  });

  test('the total budget bounds each request and refuses a retry that would pass it', async () => {
    const run = harness();
    const { calls, client } = playFake((request) => {
      if (step(request) !== 'create') return undefined;
      run.advance(30_000);
      return Promise.reject(httpError(503));
    });
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow('(attempt 3 of 3)');
    // 0 s: attempt 1 (30 s); +2 s; 32 s: attempt 2 (30 s); +5 s; 67 s:
    // attempt 3 gets only the 3 s left of the 70 s budget.
    expect(calls.map((call) => call.timeout)).toEqual([15_000, 15_000, 3_000]);
    expect(run.sleeps).toEqual([2_000, 5_000]);

    const late = harness();
    const lateFake = playFake((request, attempt) =>
      attempt === 1 && step(request) === 'create'
        ? Promise.reject(httpError(429, { 'retry-after': '120' }))
        : undefined,
    );
    await expect(
      queryGooglePlayInternal(identity, late.options(lateFake.client)),
    ).rejects.toThrow(
      'no retry: waiting 120000 ms would pass the 70000 ms readback budget',
    );
    expect(created(lateFake.calls)).toEqual([1]);
    expect(late.sleeps).toEqual([]);
  });

  test('a request is not started once the budget is spent, and the edit is still deleted', async () => {
    const run = harness();
    const { calls, client } = playFake((request) => {
      if (step(request) === 'create') run.advance(70_000);
      return undefined;
    });
    await expect(
      queryGooglePlayInternal(identity, run.options(client)),
    ).rejects.toThrow(
      'read internal track was not started: the 70000 ms readback budget is spent (attempt 1 of 3)',
    );
    expect(calls.map((call) => call.step)).toEqual(['create', 'delete']);
    expect(calls.at(-1).timeout).toBe(5_000);
  });
});
