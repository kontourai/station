// @vitest-environment jsdom

/**
 * A foldable's records are opt-in: a device viewer asks `?fold=1`; a host
 * older than the key refuses it, and the viewer asks again without it
 * rather than reconnecting forever. Other viewers never ask.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { liveSurfaceFoldDeclines } from '../useLiveSurface';
import {
  canvasHarness,
  flush,
  layoutStage,
  lease,
  renderCanvas,
} from './fixtures/canvasStreamHarness';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close() {} })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  layoutStage({ width: 640, height: 400 });
  liveSurfaceFoldDeclines.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const framesUrls = (transport: ReturnType<typeof vi.fn>) =>
  transport.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/frames'));

test('a device viewer asks for fold records; other viewers do not', async () => {
  const device = canvasHarness();
  await renderCanvas(device, { acceptFold: true });
  expect(framesUrls(device.transport)[0]).toContain('fold=1');
  cleanup();
  const browser = canvasHarness();
  await renderCanvas(browser);
  expect(framesUrls(browser.transport)[0]).not.toContain('fold');
});

test.each([['unknown'], [undefined], ['fold']])(
  'a host refusing fold=1 (field %s) is asked again without it, and the view goes live',
  async (field) => {
    const h = canvasHarness();
    const delegate = h.transport;
    const transport = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        String(input).includes('fold=1')
          ? Response.json(
              {
                success: false,
                code: 'invalid-request',
                ...(field === undefined ? {} : { field }),
              },
              { status: 400 },
            )
          : delegate(input, init),
    );
    await renderCanvas(
      { ...h, transport } as unknown as ReturnType<typeof canvasHarness>,
      { acceptFold: true },
      lease(0),
    );
    await waitFor(() => expect(framesUrls(transport)).toHaveLength(2));
    const [first, second] = framesUrls(transport);
    expect(first).toContain('fold=1');
    expect(second).not.toContain('fold');
    await h.pushState(lease(0));
    await h.pushFrame(1, 0);
    await flush();
    expect(screen.getByTestId('live-surface-canvas')).toBeTruthy();
    expect(liveSurfaceFoldDeclines.size).toBe(1);
  },
);
