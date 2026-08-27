import {
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '@kontourai/station-sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedApiBase } from '../commands/core-api.js';
import {
  configureRequestTimeout,
  requestJson,
  withRequestTimeout,
} from '../commands/core-api.js';
import {
  describeApiBaseSource,
  explainRequestFailure,
  isIndeterminateWriteFailure,
} from '../commands/errors.js';

/** Node reports every transport failure as `TypeError: fetch failed` + cause. */
function transportError(code: string): TypeError {
  const error = new TypeError('fetch failed');
  (error as { cause?: unknown }).cause = Object.assign(
    new Error(`${code} 127.0.0.1:3141`),
    { code },
  );
  return error;
}

const LOOPBACK: ResolvedApiBase = {
  apiBase: 'http://127.0.0.1:3141',
  source: 'loopback',
};

/**
 * The exact sentence a timed-out read (or an unclassifiable timeout) prints.
 * `after` is the rendered deadline: the end-to-end suite below uses a real
 * millisecond deadline so the tests do not wait 30 seconds each.
 */
const readMessage = (after = '30s') =>
  `Station at http://127.0.0.1:3141 (default) did not respond within ${after}. ` +
  'Check it with ./station doctor, raise the limit with ' +
  'STATION_REQUEST_TIMEOUT_MS=<ms>, or target another Station with ' +
  '--station=<name> or --api-base=<url>.';

/** The exact sentence a timed-out write prints. */
const indeterminateWriteMessage = (after = '30s') =>
  `Gave up waiting for Station at http://127.0.0.1:3141 (default) after ${after}. ` +
  'The request was a write and may still have been applied — the client ' +
  'stopped waiting before Station answered, so it cannot tell. Check whether ' +
  'it took effect before retrying. If Station is simply slow, ' +
  'STATION_REQUEST_TIMEOUT_MS=<ms> raises the deadline for the next attempt.';

describe('describeApiBaseSource', () => {
  it('names every way a base URL can be chosen', () => {
    expect(describeApiBaseSource(LOOPBACK)).toBe('default');
    expect(
      describeApiBaseSource({ apiBase: 'x', source: 'api-base-flag' }),
    ).toBe('from --api-base');
    expect(
      describeApiBaseSource({
        apiBase: 'x',
        source: 'station-flag',
        station: 'home',
      }),
    ).toBe('from --station=home');
    expect(
      describeApiBaseSource({
        apiBase: 'x',
        source: 'station-env',
        station: 'laptop',
      }),
    ).toBe('from STATION_TARGET=laptop');
    expect(
      describeApiBaseSource({ apiBase: 'x', source: 'api-base-flag' }),
    ).toBe('from --api-base');
    expect(
      describeApiBaseSource({ apiBase: 'x', source: 'active-local' }),
    ).toBe('active local desktop Station');
    expect(
      describeApiBaseSource({
        apiBase: 'x',
        source: 'default-station',
        station: 'home',
      }),
    ).toBe('default Station "home"');
  });
});

describe('explainRequestFailure', () => {
  it('turns a refused connection into an actionable sentence', () => {
    const message = explainRequestFailure(
      transportError('ECONNREFUSED'),
      LOOPBACK,
    );

    expect(message).toBe(
      "Can't reach Station at http://127.0.0.1:3141 (default). Is it running? " +
        'Start it with ./station start, or target another Station with ' +
        '--station=<name> or --api-base=<url>.',
    );
  });

  it('says where a non-default base URL came from', () => {
    const message = explainRequestFailure(transportError('ECONNREFUSED'), {
      apiBase: 'http://192.168.1.9:3141',
      source: 'station-flag',
      station: 'laptop',
    });

    expect(message).toContain(
      'http://192.168.1.9:3141 (from --station=laptop)',
    );
  });

  it('distinguishes a DNS failure from an unreachable Station', () => {
    const message = explainRequestFailure(transportError('ENOTFOUND'), {
      apiBase: 'https://typo.example.invalid',
      source: 'api-base-flag',
    });

    expect(message).toContain("Can't resolve the host in");
    expect(message).toContain('station stations list');
  });

  it('names the deadline that expired for a timeout', () => {
    const timeout = Object.assign(new Error('timed out'), {
      name: 'StationRequestTimeoutError',
      timeoutMs: 30_000,
    });

    const message = explainRequestFailure(timeout, LOOPBACK);

    expect(message).toBe(
      'Station at http://127.0.0.1:3141 (default) did not respond within 30s. ' +
        'Check it with ./station doctor, raise the limit with ' +
        'STATION_REQUEST_TIMEOUT_MS=<ms>, or target another Station with ' +
        '--station=<name> or --api-base=<url>.',
    );
  });

  it('recognises a bare AbortSignal.timeout DOMException as a timeout', () => {
    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });

    expect(explainRequestFailure(aborted, LOOPBACK)).toContain(
      'did not respond within',
    );
  });

  it('reports a timed-out write as indeterminate, not as a failure', () => {
    const timeout = Object.assign(
      new Error('Request to http://127.0.0.1:3141/x timed out after 30000ms'),
      {
        name: 'StationRequestTimeoutError',
        timeoutMs: 30_000,
        method: 'POST',
        mutation: true,
      },
    );

    const message = explainRequestFailure(timeout, LOOPBACK);

    expect(message).toBe(indeterminateWriteMessage());
    expect(message).not.toContain('did not respond');
    // It must not promise a command: `config set`, `auth renew` and
    // `checkpoints restore` have no `list` to check against.
    expect(message).not.toContain('list');
  });

  it('treats a timed-out read exactly as before', () => {
    const timeout = Object.assign(new Error('timed out'), {
      name: 'StationRequestTimeoutError',
      timeoutMs: 30_000,
      method: 'GET',
      mutation: false,
    });

    expect(explainRequestFailure(timeout, LOOPBACK)).toBe(readMessage());
  });

  it('keeps the read message for a POST the operation declared read-only', () => {
    // `station knowledge search` — a POST because the query travels in the
    // body. Nothing was written, so there is nothing for the user to check.
    const timeout = Object.assign(new Error('timed out'), {
      name: 'StationRequestTimeoutError',
      timeoutMs: 30_000,
      method: 'POST',
      mutation: false,
    });

    expect(explainRequestFailure(timeout, LOOPBACK)).toBe(readMessage());
  });

  it('claims nothing about state when the request was never classified', () => {
    // A bare `AbortSignal.timeout` from a raw `fetch` call site: no method,
    // so no `mutation`, so no claim in either direction.
    const timeout = Object.assign(new Error('timed out'), {
      name: 'StationRequestTimeoutError',
      timeoutMs: 30_000,
    });

    expect(explainRequestFailure(timeout, LOOPBACK)).toBe(readMessage());
  });

  it('still names the Station for an unclassified fetch failure', () => {
    expect(
      explainRequestFailure(new TypeError('fetch failed'), LOOPBACK),
    ).toContain("Can't reach Station at http://127.0.0.1:3141 (default)");
  });

  it('leaves application errors alone', () => {
    expect(
      explainRequestFailure(
        new Error('Request failed with HTTP 404'),
        LOOPBACK,
      ),
    ).toBeUndefined();
    expect(
      explainRequestFailure(transportError('ECONNREFUSED'), undefined),
    ).toBeUndefined();
  });
});

/**
 * The composition the CLI actually runs, end to end: `requestJson` ->
 * `authenticatedFetch` -> a real `AbortSignal.timeout` -> the thrown
 * `StationRequestTimeoutError` -> `explainRequestFailure`.
 *
 * The unit tests above hand-build the error object, and the SDK's own suite
 * drives `mutateJson`/`getJson` — neither touches `authenticatedFetch`, which
 * is the only path every CLI verb takes. Nothing proved the classification
 * survived that path until this ran.
 */
describe('a timed-out CLI request, end to end', () => {
  /** A real deadline, short enough to run — `timeoutSeconds` rounds it to 0s. */
  const DEADLINE_MS = 20;
  const RENDERED_DEADLINE = '0s';

  /** A `fetch` that never settles until its signal aborts — a hung Station. */
  function hangingFetch() {
    return vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  }

  async function failedRequest(
    init: Parameters<typeof requestJson>[2],
  ): Promise<unknown> {
    return await requestJson(LOOPBACK.apiBase, '/api/agents', init).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  beforeEach(() => {
    setClientRequestTimeout(DEADLINE_MS);
    vi.stubGlobal('fetch', hangingFetch());
  });

  afterEach(() => {
    setClientRequestTimeout(undefined);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('tells the user a write may have landed', async () => {
    const error = await failedRequest({ method: 'POST', body: '{}' });

    expect(isIndeterminateWriteFailure(error)).toBe(true);
    expect(explainRequestFailure(error, LOOPBACK)).toBe(
      indeterminateWriteMessage(RENDERED_DEADLINE),
    );
  });

  it('tells the user a write may have landed through the credentialed transport', async () => {
    // The other half of `authenticatedFetch`: a same-origin credential routes
    // the request through `configured.transport`, a separate deadline path.
    const transport = hangingFetch();
    setClientCredentialResolver(() => ({
      credential: 'test-token',
      origin: LOOPBACK.apiBase,
      transport,
    }));

    const error = await failedRequest({ method: 'POST', body: '{}' });

    expect(transport).toHaveBeenCalled();
    expect(explainRequestFailure(error, LOOPBACK)).toBe(
      indeterminateWriteMessage(RENDERED_DEADLINE),
    );
  });

  it('claims no state change for a read', async () => {
    const error = await failedRequest(undefined);

    expect(isIndeterminateWriteFailure(error)).toBe(false);
    expect(explainRequestFailure(error, LOOPBACK)).toBe(
      readMessage(RENDERED_DEADLINE),
    );
  });

  it('claims no state change for a POST the operation declared read-only', async () => {
    // `station connections test`, `station runs output`, `station knowledge
    // search`: POST because a body is needed, not because anything changes.
    const error = await failedRequest({
      method: 'POST',
      body: '{}',
      readOnly: true,
    });

    expect(isIndeterminateWriteFailure(error)).toBe(false);
    expect(explainRequestFailure(error, LOOPBACK)).toBe(
      readMessage(RENDERED_DEADLINE),
    );
  });

  it('never leaks the readOnly declaration into the wire request', async () => {
    await failedRequest({ method: 'POST', body: '{}', readOnly: true });

    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as RequestInit & { readOnly?: unknown };
    expect(init.readOnly).toBeUndefined();
    expect(init.method).toBe('POST');
  });
});

describe('configureRequestTimeout', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.STATION_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.STATION_REQUEST_TIMEOUT_MS;
    else process.env.STATION_REQUEST_TIMEOUT_MS = original;
  });

  it('applies a 30s deadline by default and honours the override', () => {
    delete process.env.STATION_REQUEST_TIMEOUT_MS;
    configureRequestTimeout();
    expect(withRequestTimeout().signal).toBeInstanceOf(AbortSignal);

    process.env.STATION_REQUEST_TIMEOUT_MS = '0';
    configureRequestTimeout();
    expect(withRequestTimeout().signal).toBeUndefined();
  });

  it('rejects a malformed override instead of silently ignoring it', () => {
    process.env.STATION_REQUEST_TIMEOUT_MS = 'soon';
    expect(() => configureRequestTimeout()).toThrow(
      /STATION_REQUEST_TIMEOUT_MS/,
    );
  });

  it('never overwrites a signal the caller already supplied', () => {
    delete process.env.STATION_REQUEST_TIMEOUT_MS;
    configureRequestTimeout();
    const controller = new AbortController();

    expect(withRequestTimeout({ signal: controller.signal }).signal).toBe(
      controller.signal,
    );
  });
});

/**
 * station#3662 delta-2 HIGH, the CLI half. `station agents update station
 * --data '{"execution":{"agentConnectionId":"claude"}}'` used to print a 2xx
 * success payload for a write the server threw away. The server now refuses
 * it at the service seam every surface shares; what the CLI owes the user is
 * to SURFACE that refusal rather than swallow it into "Request failed with
 * HTTP 409". `requestJson` is the one place every `agents update|create` call
 * goes through, so this is where that is pinned.
 */
describe('a refused Station rebinding reaches the CLI user', () => {
  const REFUSAL =
    "The Station Agent's engine is not an Agent field, so 'claude' cannot be " +
    'persisted on it. It is a Station setting — `builtinAgentEngineConnectionId` ' +
    '(Settings → Station → Built-in agent engine) — resolved fresh on every start ' +
    'against live engine readiness, which is why the Agent record never stores it. ' +
    "Set it there instead. To run the built-in Agent on Station's own engine, " +
    'send `"execution": null`.';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the server sentence verbatim, not the status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error: REFUSAL }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const error = await requestJson(LOOPBACK.apiBase, '/api/agents/station', {
      method: 'PUT',
      body: JSON.stringify({ execution: { agentConnectionId: 'claude' } }),
    }).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(REFUSAL);
    // The generic fallback would have hidden every word that tells the user
    // where the setting actually lives.
    expect(error?.message).not.toContain('Request failed with HTTP');
  });

  it('does not report a refused write as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error: REFUSAL }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      requestJson(LOOPBACK.apiBase, '/api/agents/station', {
        method: 'PUT',
        body: '{}',
      }),
    ).rejects.toThrow(/builtinAgentEngineConnectionId/);
  });
});
