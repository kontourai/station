// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const network = vi.hoisted(() => ({ constrained: false }));
vi.mock('../../platform/networkCost', () => ({
  useConstrainedNetwork: () => network.constrained,
}));

import { LiveSurfaceCanvas } from '../LiveSurfaceCanvas';
import { liveSurfaceStreamBudget } from '../liveSurfaceStreamBudget';

const SURFACE = 'device:phone-1';
const API = 'http://station.test';
const FRAMES_URL = `${API}/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;
const DEVICE = { maxFps: 15, quality: 70, maxWidth: 1600, maxHeight: 1600 };

describe('liveSurfaceStreamBudget', () => {
  test('asks for what was requested when nothing constrains it', () => {
    expect(
      liveSurfaceStreamBudget(DEVICE, { constrained: false, pixels: null }),
    ).toBe(DEVICE);
  });

  test('never asks for more than the pane shows, or than was requested', () => {
    expect(
      liveSurfaceStreamBudget(DEVICE, {
        constrained: false,
        pixels: { width: 1280, height: 1920 },
      }),
    ).toEqual({ maxFps: 15, quality: 70, maxWidth: 1280, maxHeight: 1600 });
    // An unspecified request starts from the host's default.
    expect(
      liveSurfaceStreamBudget(undefined, {
        constrained: false,
        pixels: { width: 3840, height: 2560 },
      }),
    ).toEqual({ maxFps: 10, quality: 70, maxWidth: 1280, maxHeight: 1280 });
  });

  test('a metered or data-saving connection gets fewer, smaller frames', () => {
    expect(
      liveSurfaceStreamBudget(DEVICE, { constrained: true, pixels: null }),
    ).toEqual({ maxFps: 5, quality: 50, maxWidth: 960, maxHeight: 960 });
  });
});

describe('LiveSurfaceCanvas stream request', () => {
  let resizeObservers: Array<() => void> = [];
  beforeEach(() => {
    network.constrained = false;
    resizeObservers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(readonly callback: () => void) {
          resizeObservers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('devicePixelRatio', 3);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 390,
      height: 600,
      top: 0,
      left: 0,
      right: 390,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function transport() {
    const opened: string[] = [];
    const fn = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(FRAMES_URL)) return Response.json({});
        opened.push(url);
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                try {
                  controller.error(new DOMException('aborted', 'AbortError'));
                } catch {}
              });
            },
          }),
        );
      },
    );
    return { fn, opened };
  }

  async function mount(params = DEVICE) {
    const t = transport();
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Device: phone"
        params={params}
        transport={t.fn as never}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return t;
  }

  test('a phone pane opens one stream, sized to its device pixels', async () => {
    const { opened } = await mount();
    // 390 CSS px at 3x is 1170 device px, stepped up to 1280; the pane's 1800
    // device px of height exceed the 1600 the device pane asked for.
    expect(opened).toHaveLength(1);
    const query = new URL(opened[0]!).searchParams;
    expect(query.get('maxWidth')).toBe('1280');
    expect(query.get('maxHeight')).toBe('1600');
    expect(query.get('maxFps')).toBe('15');
  });

  test('a resize inside the same step keeps the stream', async () => {
    const { opened } = await mount();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      width: 400,
      height: 600,
    } as DOMRect);
    await act(async () => {
      for (const callback of resizeObservers) callback();
    });
    expect(opened).toHaveLength(1);
  });

  test('a metered connection asks for fewer, smaller frames', async () => {
    network.constrained = true;
    const { opened } = await mount();
    expect(opened).toHaveLength(1);
    const query = new URL(opened[0]!).searchParams;
    expect(query.get('maxFps')).toBe('5');
    expect(query.get('quality')).toBe('50');
    expect(query.get('maxWidth')).toBe('960');
  });
});
