import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StationRequestTimeoutError,
  setClientRequestTimeout,
} from '../client/http';
import {
  AdoptSessionError,
  adoptOrchestrationSession,
  createAdoptOrchestrationSessionIntent,
} from '../query-domains/chatRuntimeOrchestration';

afterEach(() => {
  setClientRequestTimeout(undefined);
  vi.unstubAllGlobals();
});

describe('adoptOrchestrationSession failure classification', () => {
  it('classifies an HTTP permission response as certain and retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const error = await adoptOrchestrationSession({
      sourceThreadId: 'source-1',
      apiBase: 'https://station.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdoptSessionError);
    expect(error).toMatchObject({
      failureClass: 'certain-response',
      retryable: true,
      status: 403,
    });
    expect((error as Error).message).toMatch(/permission/i);
    expect((error as Error).message).not.toMatch(/not responding/i);
  });

  it('classifies a provable connection refusal as certainly not sent and retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new TypeError('connect ECONNREFUSED 127.0.0.1:3141'),
        ),
    );

    const error = await adoptOrchestrationSession({
      sourceThreadId: 'source-2',
      apiBase: 'https://station.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdoptSessionError);
    expect(error).toMatchObject({
      failureClass: 'certain-not-sent',
      retryable: true,
    });
  });

  it('classifies an ambiguous fetch rejection as uncertain — a bare TypeError proves nothing', async () => {
    // Browsers reject post-send failures as plain 'Failed to fetch' too, and
    // the native relay's timeout/reset outcomes arrive as generic Errors.
    // With no server-side adoption idempotency (station#2635), ambiguity
    // must disable retry.
    for (const rejection of [
      new TypeError('Failed to fetch'),
      new Error(
        'transport_timeout: request timed out before response headers arrived',
      ),
      new Error('transport_reset: connection reset before a response arrived'),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(rejection));
      const error = await adoptOrchestrationSession({
        sourceThreadId: 'source-2b',
        apiBase: 'https://station.test',
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AdoptSessionError);
      expect(error).toMatchObject({
        failureClass: 'uncertain-no-response',
        retryable: true,
      });
    }
  });

  it('classifies a 2xx whose body cannot be read as uncertain — the continuation may exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{truncated', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const error = await adoptOrchestrationSession({
      sourceThreadId: 'source-2c',
      apiBase: 'https://station.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdoptSessionError);
    expect(error).toMatchObject({
      failureClass: 'uncertain-no-response',
      retryable: true,
    });
  });

  it('classifies a timeout without a response as uncertain and non-retryable', async () => {
    setClientRequestTimeout(5);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    const error = await adoptOrchestrationSession({
      sourceThreadId: 'source-3',
      apiBase: 'https://station.test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdoptSessionError);
    expect((error as AdoptSessionError).cause).toBeInstanceOf(
      StationRequestTimeoutError,
    );
    expect(error).toMatchObject({
      failureClass: 'uncertain-no-response',
      retryable: true,
    });
  });
});

describe('adoptOrchestrationSession intent identity', () => {
  it('holds one key across retries and mints a fresh key for a new intent', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: { threadId: 'child', provider: 'claude' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const firstIntent = createAdoptOrchestrationSessionIntent();

    await adoptOrchestrationSession({
      sourceThreadId: 'source',
      apiBase: 'https://station.test',
      intent: firstIntent,
    });
    await adoptOrchestrationSession({
      sourceThreadId: 'source',
      apiBase: 'https://station.test',
      intent: firstIntent,
    });
    await adoptOrchestrationSession({
      sourceThreadId: 'source',
      apiBase: 'https://station.test',
      intent: createAdoptOrchestrationSessionIntent(),
    });

    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    expect(bodies[2].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
  });
});
