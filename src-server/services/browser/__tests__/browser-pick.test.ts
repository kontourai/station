import { describe, expect, it, vi } from 'vitest';
import { pickBrowserElement } from '../browser-pick.js';
import type { BrowserLiveTarget } from '../browser-session-registry.js';

function fixture(changed = false) {
  let frames = 0;
  const calls: Array<{ method: string; params?: object }> = [];
  const cdp = {
    send: vi.fn(async (method: string, params?: object) => {
      calls.push({ method, params });
      switch (method) {
        case 'Page.getFrameTree':
          return {
            frameTree: {
              frame: {
                id: 'frame',
                loaderId: changed && frames++ ? 'new' : 'old',
                url: 'https://example.test/',
              },
            },
          };
        case 'DOM.getNodeForLocation':
          return { backendNodeId: 4 };
        case 'Page.createIsolatedWorld':
          return { executionContextId: 7 };
        case 'DOM.resolveNode':
          return { object: { objectId: 'object' } };
        case 'Runtime.callFunctionOn':
          return {
            result: {
              value: {
                selector: 'html > body > button',
                tagName: 'button',
                role: '',
                name: '',
                html: '<button>',
                styles: {},
                rect: { x: 10, y: 20, width: 50, height: 30 },
              },
            },
          };
        case 'Accessibility.getPartialAXTree':
          return {
            nodes: [{ role: { value: 'button' }, name: { value: 'Save' } }],
          };
        case 'Page.getLayoutMetrics':
          return { cssVisualViewport: { pageX: 100, pageY: 200 } };
        case 'Page.captureScreenshot':
          return {
            data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString(
              'base64',
            ),
          };
        default:
          return {};
      }
    }),
  };
  const live = {
    host: { cdp: () => cdp },
    target: { targetId: 'target', cdpSessionId: 'session' },
    generation: 2,
  } as unknown as BrowserLiveTarget;
  return { live, calls };
}

describe('browser element picking', () => {
  it('maps viewport coordinates to a clipped target screenshot and accessible locator', async () => {
    const h = fixture();
    const result = await pickBrowserElement(
      h.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
    );
    expect(result).toMatchObject({
      role: 'button',
      name: 'Save',
      locator: 'css=html > body > button',
      rect: { x: 10, y: 20, width: 50, height: 30 },
    });
    expect(h.calls).toContainEqual({
      method: 'Page.captureScreenshot',
      params: expect.objectContaining({
        clip: { x: 110, y: 220, width: 50, height: 30, scale: 1 },
        captureBeyondViewport: false,
      }),
    });
    expect(result.screenshot).toBeTruthy();
  });

  it('refuses out-of-bounds points and navigation during capture', async () => {
    const h = fixture(true);
    await expect(
      pickBrowserElement(h.live, { width: 100, height: 80 }, { x: 100, y: 1 }),
    ).rejects.toThrow('outside');
    await expect(
      pickBrowserElement(
        h.live,
        { width: Number.NaN, height: 80 },
        { x: 1, y: 1 },
      ),
    ).rejects.toThrow('outside');
    await expect(
      pickBrowserElement(h.live, { width: 100, height: 80 }, { x: 15, y: 25 }),
    ).rejects.toThrow('changed');
    expect(
      h.calls.some((call) => call.method === 'Runtime.releaseObjectGroup'),
    ).toBe(true);
  });
});
