import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  downloadMediaTools,
  getMediaToolsStatus,
  transcribeAudio,
} from '../client/media-tools';

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
test('media status and explicit consent use authenticated envelopes and preserve refusals', async () => {
  setClientCredentialResolver(() => ({
    credential: 'test',
    origin: 'http://station',
  }));
  const requests: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return Response.json(
        path.endsWith('/download')
          ? { success: false, code: 'operator-required' }
          : { success: true, data: { components: [] } },
        { status: path.endsWith('/download') ? 403 : 200 },
      );
    }),
  );
  expect(await getMediaToolsStatus('http://station')).toEqual({
    components: [],
  });
  await expect(
    Reflect.apply(downloadMediaTools, undefined, [
      'http://station',
      { consent: false },
    ]),
  ).rejects.toThrow('explicit consent');
  expect(requests).toHaveLength(1);
  await expect(
    downloadMediaTools('http://station', { consent: true }),
  ).rejects.toMatchObject({ status: 403, code: 'operator-required' });
  expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
    consent: true,
  });
  expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
    'Bearer test',
  );
});
test('local transcription sends binary audio and preserves unavailable-not-empty', async () => {
  const audio = new Blob([new Uint8Array([0, 255, 1])], { type: 'audio/wav' });
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
    expect(init?.body).toBe(audio);
    return Response.json({
      success: true,
      data: {
        status: 'unavailable',
        reason: 'needs-consent',
        downloads: [{ component: 'speech-model', version: 'pin', bytes: 123 }],
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await transcribeAudio('http://station', audio)).toMatchObject({
    status: 'unavailable',
    reason: 'needs-consent',
  });
  await expect(transcribeAudio('http://station', new Blob())).rejects.toThrow(
    'nonempty',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
