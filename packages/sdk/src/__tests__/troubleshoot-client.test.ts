import { afterEach, describe, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/http';
import { prepareTroubleshoot } from '../client/troubleshoot';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareTroubleshoot', () => {
  test('posts to the prepare route and returns the prepared run', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ runId: 'r', agentId: 'station' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      prepareTroubleshoot('http://station.test', { surface: 'web' }),
    ).resolves.toMatchObject({ runId: 'r', agentId: 'station' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe(
      'http://station.test/api/diagnostics/troubleshoot/prepare',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ surface: 'web' });
  });

  test('keeps the route refusal status and code on the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: 'Seed context was refused.',
              code: 'route-too-long',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const error = await prepareTroubleshoot('http://station.test').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StationHttpError);
    expect(error).toMatchObject({ status: 400, code: 'route-too-long' });
  });
});
