import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { afterEach, expect, test, vi } from 'vitest';
import { runMediaToolsCommand } from '../commands/media-tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClientCredentialResolver(undefined);
});
test('download refuses absent or string consent before any network call', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(runMediaToolsCommand(['download'])).rejects.toThrow(
    'Pass --yes',
  );
  await expect(
    runMediaToolsCommand(['download', '--yes=true']),
  ).rejects.toThrow('Usage:');
  expect(fetcher).not.toHaveBeenCalled();
});
test('consented CLI prints component version and bytes and starts a server download', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ consent: true });
    return Response.json({
      success: true,
      data: {
        components: [
          {
            component: 'ffmpeg',
            version: 'b6.1.1',
            bytes: 38457651,
            resolution: { status: 'needs-consent', downloads: [] },
            progress: { receivedBytes: 100, totalBytes: 38457651 },
          },
        ],
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await runMediaToolsCommand([
    'download',
    '--yes',
    '--api-base=http://127.0.0.1:36477',
    '--credential=fixture',
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining(
      'ffmpeg b6.1.1: needs-consent; 38457651 download bytes; 100/38457651',
    ),
  );
});
