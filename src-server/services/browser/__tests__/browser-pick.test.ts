import { describe, expect, it, vi } from 'vitest';
import { pickBrowserElement } from '../browser-pick.js';
import type { BrowserLiveTarget } from '../browser-session-registry.js';

function fixture(
  changed = false,
  extra?: {
    tagName: string;
    attributes: Array<{ name: string; value: string }>;
  },
) {
  let frames = 0;
  let loader = 'old';
  let invalidContext = false;
  let worldId = 0;
  let scroll = { x: 100, y: 200 };
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
                loaderId: changed && frames++ ? 'new' : loader,
                url: 'https://example.test/',
              },
            },
          };
        case 'DOM.getNodeForLocation':
          return { backendNodeId: 4 };
        case 'Page.createIsolatedWorld':
          return { executionContextId: ++worldId };
        case 'DOM.resolveNode':
          if (invalidContext) {
            invalidContext = false;
            throw new Error('Cannot find context with specified id');
          }
          return { object: { objectId: 'object' } };
        case 'Runtime.callFunctionOn':
          return {
            result: {
              value: {
                selector: 'html > body > button',
                tagName: extra?.tagName ?? 'button',
                role: '',
                name: '',
                attributes: extra?.attributes ?? [
                  {
                    name: 'href',
                    value: 'https://user:pass@example.test/a?token=secret#frag',
                  },
                  { name: 'data-info', value: 'Bearer secret-value' },
                  { name: 'src', value: '/asset?credential=private' },
                  { name: 'action', value: '/submit?session=private' },
                  { name: 'data-other', value: 'sk-abcdefghijk123' },
                  ...['formaction', 'poster', 'xlink:href'].map((name) => ({
                    name,
                    value: '/path?token=private',
                  })),
                  {
                    name: 'ping',
                    value: '/one?token=private /two?secret=private',
                  },
                  {
                    name: 'srcset',
                    value: '/a?token=private 1x, /b?secret=private 2x',
                  },
                  {
                    name: 'style',
                    value:
                      'background:url(https://example.test/?token=private)',
                  },
                ],
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
          return { cssVisualViewport: { pageX: scroll.x, pageY: scroll.y } };
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
  return {
    live,
    calls,
    setScroll: (x: number, y: number) => {
      scroll = { x, y };
    },
    invalidate: () => {
      invalidContext = true;
    },
    navigate: () => {
      loader = 'new';
    },
  };
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
    expect(result.html).toContain('https://example.test/a?[redacted]');
    expect(result.html).toContain(
      'srcset="https://example.test/a?[redacted] 1x, https://example.test/b?[redacted] 2x"',
    );
    expect(result.html).toContain('style="[redacted]"');
    expect(result.html).not.toMatch(
      /user|pass|secret-value|token=|frag|credential=|session=|sk-abcdefghijk123|private/,
    );
  });

  it('redacts additional URL attributes and keeps commas inside srcset URLs', async () => {
    const names = ['data', 'cite', 'background', 'longdesc', 'codebase'];
    const h = fixture(false, {
      tagName: 'object',
      attributes: [
        ...names.map((name) => ({ name, value: '/asset?token=private' })),
        {
          name: 'imagesrcset',
          value: '/one,part?token=private 1x, /two?secret=private 2x',
        },
      ],
    });
    const result = await pickBrowserElement(
      h.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
      false,
    );
    for (const name of names)
      expect(result.html).toContain(
        `${name}="https://example.test/asset?[redacted]"`,
      );
    expect(result.html).toContain(
      'imagesrcset="https://example.test/one,part?[redacted] 1x, https://example.test/two?[redacted] 2x"',
    );
    expect(result.html).not.toContain('private');
    const meta = fixture(false, {
      tagName: 'meta',
      attributes: [
        {
          name: 'content',
          value: '0; URL=https://user:pass@example.test/?token=private',
        },
      ],
    });
    const metaResult = await pickBrowserElement(
      meta.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
      false,
    );
    expect(metaResult.html).toContain('content="[redacted]"');
    expect(metaResult.html).not.toContain('private');
  });

  it('refuses a pick when the page has scrolled since the screenshot', async () => {
    const h = fixture();
    h.setScroll(100, 201);
    await expect(
      pickBrowserElement(
        h.live,
        { width: 100, height: 80 },
        { x: 15, y: 25 },
        true,
        { x: 100, y: 200 },
      ),
    ).rejects.toThrow('scroll changed');
    expect(
      h.calls.some((call) => call.method === 'DOM.getNodeForLocation'),
    ).toBe(false);
  });

  it('reuses an isolated world for the same document and replaces it after navigation', async () => {
    const h = fixture();
    await pickBrowserElement(
      h.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
      false,
    );
    await pickBrowserElement(
      h.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
      false,
    );
    expect(
      h.calls.filter((call) => call.method === 'Page.createIsolatedWorld'),
    ).toHaveLength(1);
    h.navigate();
    await pickBrowserElement(
      h.live,
      { width: 100, height: 80 },
      { x: 15, y: 25 },
      false,
    );
    expect(
      h.calls.filter((call) => call.method === 'Page.createIsolatedWorld'),
    ).toHaveLength(2);
  });

  it('recreates a destroyed cached execution context and retries the pick', async () => {
    const h = fixture();
    const viewport = { width: 100, height: 80 };
    const point = { x: 15, y: 25 };
    await pickBrowserElement(h.live, viewport, point, false);
    h.invalidate();
    const result = await pickBrowserElement(h.live, viewport, point, false);
    expect(result.locator).toBe('css=html > body > button');
    expect(
      h.calls.filter((call) => call.method === 'Page.createIsolatedWorld'),
    ).toHaveLength(2);
    expect(
      h.calls
        .filter((call) => call.method === 'DOM.resolveNode')
        .map(
          (call) =>
            (call.params as { executionContextId: number }).executionContextId,
        ),
    ).toEqual([1, 1, 2]);
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
