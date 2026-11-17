import { afterEach, describe, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/api-error-message';
import { fetchRemoteSessionHistory } from '../query-domains/sshEnvironments';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRemoteSessionHistory', () => {
  test('reads through the named Station and keeps a refusal typed with its code', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'That computer is not connected.',
          code: 'environment_unavailable',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const refusal = await fetchRemoteSessionHistory(
      'env-a',
      'external:claude:abc',
      { turnLimit: 10 },
      { apiBase: 'http://owner.test' },
    ).catch((error: unknown) => error);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://owner.test/api/environments/ssh/sessions/env-a/external%3Aclaude%3Aabc/history?turnLimit=10',
    );
    expect(refusal).toBeInstanceOf(StationHttpError);
    expect((refusal as StationHttpError).status).toBe(409);
    expect((refusal as StationHttpError).code).toBe('environment_unavailable');
  });
});
