import { afterEach, expect, test, vi } from 'vitest';
import {
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '../client/http';
import { importWalkthrough } from '../client/walkthroughs';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  setClientRequestTimeout(undefined);
});
test('Walkthrough upload survives the ordinary 30s deadline and honors an explicit shorter timeout', async () => {
  setClientCredentialResolver(() => ({
    credential: 'test',
    origin: 'http://station',
  }));
  setClientRequestTimeout(30_000);
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
          setTimeout(
            () =>
              resolve(
                Response.json({
                  success: true,
                  data: { operation: { status: 'accepted' } },
                }),
              ),
            31_000,
          );
        }),
    ),
  );
  const result = importWalkthrough(
    'http://station',
    'alpha',
    new Blob(['video']),
    'review.mp4',
    'request-id',
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(31_001);
  expect(await result).toMatchObject({ operation: { status: 'accepted' } });
  const short = importWalkthrough(
    'http://station',
    'alpha',
    new Blob(['video']),
    'review.mp4',
    'request-id',
    { timeoutMs: 1000 },
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await short).toMatchObject({ name: 'StationRequestTimeoutError' });
});
