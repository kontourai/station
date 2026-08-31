import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  deployUpdateFeed,
  resolveNativeUpdateAuthority,
  validateUpdateConfig,
  writeNativeUpdateAuthorityReceipt,
} from '../native-update-feed.mjs';

const valid = {
  VITE_NATIVE_APP_UPDATE_FEED_URL:
    'https://updates.example.test/mobile/stable.json',
  VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN: 'https://updates.example.test',
  VITE_NATIVE_APP_UPDATE_CHANNEL: 'stable',
  VITE_NATIVE_APP_VERSION: '1.2.3',
  NATIVE_APP_UPDATE_ACTION_URL: 'https://downloads.example.test/station.apk',
  NATIVE_APP_UPDATE_ACTION_KIND: 'artifact',
  NATIVE_APP_UPDATE_ACTION_ORIGINS: 'https://downloads.example.test',
};
const bytes = `${JSON.stringify({ channel: 'stable', version: '1.2.3', releaseUrl: valid.NATIVE_APP_UPDATE_ACTION_URL })}\n`;
const args = {
  endpoint: valid.VITE_NATIVE_APP_UPDATE_FEED_URL,
  actionUrl: valid.NATIVE_APP_UPDATE_ACTION_URL,
  actionKind: 'artifact',
  actionOrigins: valid.NATIVE_APP_UPDATE_ACTION_ORIGINS,
  channel: 'stable',
  version: '1.2.3',
  token: 'secret',
  bytes,
};
const action = (url = valid.NATIVE_APP_UPDATE_ACTION_URL) => ({
  ok: true,
  url,
  headers: new Headers({ 'content-type': 'application/octet-stream' }),
});

describe('native update release contract', () => {
  test('keeps TestFlight/App Store authoritative without a custom feed', () =>
    expect(
      resolveNativeUpdateAuthority({
        VITE_NATIVE_APP_UPDATE_CHANNEL: 'nightly',
        VITE_NATIVE_APP_VERSION: '1.2.3-nightly.7',
      }),
    ).toEqual({
      updateAuthority: 'TestFlight/App Store',
      customFeed: null,
      channel: 'nightly',
      version: '1.2.3-nightly.7',
    }));

  test('records an absent custom feed without changing the store authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-update-authority-'));
    const output = join(directory, 'authority.json');
    try {
      writeNativeUpdateAuthorityReceipt(output, {
        VITE_NATIVE_APP_UPDATE_CHANNEL: 'beta',
        VITE_NATIVE_APP_VERSION: '1.2.3-preview.1',
      });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        schemaVersion: 1,
        kind: 'native-update-authority',
        updateAuthority: 'TestFlight/App Store',
        customFeed: null,
        channel: 'beta',
        version: '1.2.3-preview.1',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('records configured custom-feed metadata separately from store authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-update-authority-'));
    const output = join(directory, 'authority.json');
    try {
      writeNativeUpdateAuthorityReceipt(output, valid);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        kind: 'native-update-authority',
        updateAuthority: 'TestFlight/App Store',
        channel: 'stable',
        version: '1.2.3',
        customFeed: {
          endpoint: valid.VITE_NATIVE_APP_UPDATE_FEED_URL,
          providerOrigin: valid.VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN,
          actionUrl: valid.NATIVE_APP_UPDATE_ACTION_URL,
          actionKind: valid.NATIVE_APP_UPDATE_ACTION_KIND,
          actionOrigins: ['https://downloads.example.test'],
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    'VITE_NATIVE_APP_UPDATE_FEED_URL',
    'VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN',
    'NATIVE_APP_UPDATE_ACTION_URL',
    'NATIVE_APP_UPDATE_ACTION_KIND',
    'NATIVE_APP_UPDATE_ACTION_ORIGINS',
  ])('fails closed when custom feed configuration omits %s', (missing) => {
    const partial: Record<string, string> = { ...valid };
    delete partial[missing];
    expect(() => resolveNativeUpdateAuthority(partial)).toThrow(
      /configuration is partial/,
    );
  });

  test('accepts a protected same-origin channel feed', () =>
    expect(validateUpdateConfig(valid)).toMatchObject({
      updateAuthority: 'TestFlight/App Store',
      customFeed: {
        endpoint: valid.VITE_NATIVE_APP_UPDATE_FEED_URL,
        providerOrigin: valid.VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN,
        actionUrl: valid.NATIVE_APP_UPDATE_ACTION_URL,
      },
    }));
  test('rejects a redirect/cross-origin feed', () =>
    expect(() =>
      validateUpdateConfig({
        ...valid,
        VITE_NATIVE_APP_UPDATE_FEED_URL: 'https://cdn.example.test/feed',
      }),
    ).toThrow(/pinned/));
  test('normalizes one provider trailing slash', () =>
    expect(() =>
      validateUpdateConfig({
        ...valid,
        VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN: 'https://updates.example.test/',
      }),
    ).not.toThrow());
  test('rejects mutable versions', () =>
    expect(() =>
      validateUpdateConfig({ ...valid, VITE_NATIVE_APP_VERSION: 'latest' }),
    ).toThrow(/immutable/));

  test('atomically replaces and verifies while retaining prior bytes and ETag', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old-bytes',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => bytes });
    await deployUpdateFeed({ ...args, fetchImpl });
    expect(fetchImpl.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: bytes,
        headers: expect.objectContaining({ 'If-Match': '"old"' }),
      }),
    );
  });

  test('restores and verifies prior bytes after fetchback failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old-bytes',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => 'stale' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, text: async () => 'old-bytes' });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /prior feed was restored/,
    );
    expect(fetchImpl.mock.calls[4][1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        body: 'old-bytes',
        headers: expect.objectContaining({ 'If-Match': '"new"' }),
      }),
    );
  });

  test('marks rollback failure ambiguous for manual recovery', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
      })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false, status: 412 });
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('recovers an interrupted PUT when the provider committed new bytes', async () => {
    const interrupted = new Error('socket reset');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockRejectedValueOnce(interrupted)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
        text: async () => bytes,
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, text: async () => 'old' });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toBe(
      interrupted,
    );
    expect(fetchImpl.mock.calls[4][1]).toEqual(
      expect.objectContaining({ method: 'PUT', body: 'old' }),
    );
  });

  test('restores a committed feed even when PUT reports HTTP 500', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
        text: async () => bytes,
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, text: async () => 'old' });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /publication failed: 500/,
    );
    expect(fetchImpl.mock.calls[4][1]).toEqual(
      expect.objectContaining({ method: 'PUT', body: 'old' }),
    );
  });

  test('marks a successful PUT without a returned ETag ambiguous', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({ ok: true, headers: new Headers() })
      .mockResolvedValueOnce({ ok: false, headers: new Headers() });
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('rejects staged drift before any executable or network fault', async () => {
    const fetchImpl = vi.fn();
    await expect(
      deployUpdateFeed({ ...args, channel: 'preview', fetchImpl }),
    ).rejects.toThrow(/protected release values/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['downgrade', 'http://downloads.example.test/station.apk'],
    ['cross-origin redirect', 'https://evil.example.test/station.apk'],
  ])('rejects %s final action URL before feed mutation', async (_name, url) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(action(url));
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /protected HTTPS origin policy/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('fails before PUT when current feed lacks an ETag', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        text: async () => 'old',
      });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /ETag/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test.each([401, 429, 500])(
    'treats HTTP %s observation as ambiguous, never absent',
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(action())
        .mockResolvedValueOnce({ ok: false, status });
      await expect(
        deployUpdateFeed({ ...args, fetchImpl }),
      ).rejects.toMatchObject({ ambiguousFeedState: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    ['thrown PUT inspection', new Error('put transport')],
    ['non-2xx PUT inspection', { ok: false, status: 500 }],
  ])('%s GET rejection is ambiguous', async (_name, putResult) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      });
    if (putResult instanceof Error) fetchImpl.mockRejectedValueOnce(putResult);
    else fetchImpl.mockResolvedValueOnce(putResult);
    fetchImpl.mockRejectedValueOnce(new Error('inspection unavailable'));
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('missing-ETag observation GET rejection is ambiguous', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({ ok: true, headers: new Headers() })
      .mockRejectedValueOnce(new Error('observation unavailable'));
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('final fetchback GET rejection restores and verifies prior bytes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
      })
      .mockRejectedValueOnce(new Error('fetchback unavailable'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, text: async () => 'old' });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /prior feed was restored/,
    );
  });

  test('failed-PUT observation body rejection is ambiguous', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockRejectedValueOnce(new Error('put'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => {
          throw new Error('body');
        },
      });
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('missing-ETag observation body rejection is ambiguous', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({ ok: true, headers: new Headers() })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => {
          throw new Error('body');
        },
      });
    await expect(
      deployUpdateFeed({ ...args, fetchImpl }),
    ).rejects.toMatchObject({ ambiguousFeedState: true });
  });

  test('final fetchback body rejection restores and verifies prior bytes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(action())
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"old"' }),
        text: async () => 'old',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ etag: '"new"' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => {
          throw new Error('body');
        },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, text: async () => 'old' });
    await expect(deployUpdateFeed({ ...args, fetchImpl })).rejects.toThrow(
      /prior feed was restored/,
    );
  });
});
