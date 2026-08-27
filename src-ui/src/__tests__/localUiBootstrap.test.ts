/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  bootstrapLocalUiSession,
  captureLocalUiBootstrapToken,
  resetLocalUiBootstrapForTests,
  resolveLocalUiSession,
} from '../lib/local-ui-bootstrap';

const TOKEN = 'a'.repeat(43);

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.location.hash = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local UI bootstrap capability (station#2093)', () => {
  test('reads the fragment capability once and scrubs it from the address bar', () => {
    window.location.hash = `#station-ui-bootstrap=${TOKEN}`;

    expect(captureLocalUiBootstrapToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(captureLocalUiBootstrapToken()).toBeUndefined();
  });

  test('exchanges the capability exactly once for a same-origin browser session', async () => {
    window.location.hash = `#station-ui-bootstrap=${TOKEN}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      bootstrapLocalUiSession('http://127.0.0.1:53792'),
    ).resolves.toBe(true);
    await expect(
      bootstrapLocalUiSession('http://127.0.0.1:53792'),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:53792/.well-known/station/v1/pairing/ui-bootstrap',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );
  });

  test('fails once with the bootstrap response rather than retrying into authentication rate limiting', async () => {
    window.location.hash = `#station-ui-bootstrap=${TOKEN}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      bootstrapLocalUiSession(window.location.origin),
    ).rejects.toThrow(
      'Local UI bootstrap was refused (403). Open a fresh Station start link.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('shares one concurrent identity resolution per page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      resolveLocalUiSession('http://127.0.0.1:53792'),
      resolveLocalUiSession('http://127.0.0.1:53792'),
    ]);

    expect(first).toEqual({ kind: 'authenticated' });
    expect(second).toEqual({ kind: 'authenticated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:53792/api/system/identity',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      },
    );
  });
});
