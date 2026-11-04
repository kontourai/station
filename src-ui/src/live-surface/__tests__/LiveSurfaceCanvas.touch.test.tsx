// @vitest-environment jsdom

/**
 * The live surface on a phone: pinch zoom (viewing, never input), presses
 * held back until they are not the start of a pinch, taps mapped through the
 * zoom, and the immersive (full-screen) viewer with its tap-revealed chrome
 * and per-surface slot. The REAL `LiveSurfaceCanvas` over a synthetic record
 * stream; pointer events carry `pointerType: 'touch'` as a phone sends them.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeviceImmersiveActions } from '../../workspace-panes/device/DeviceImmersiveActions';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControlState,
  TOUCH_PRESS_HOLD_MS,
} from '../LiveSurfaceCanvas';
import { CONTROLS_AUTO_HIDE_MS } from '../LiveSurfaceViewerControls';
import {
  API,
  canvasHarness,
  flush,
  layoutStage,
  lease,
  MY_HOLD,
  renderCanvas,
  SURFACE,
} from './fixtures/canvasStreamHarness';

// The stage is 400x250 and the 1280x800 (2x) frame fills it exactly, so a
// client pixel is 1.6 surface pixels at fit.
const STAGE = { width: 400, height: 250 };

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
  layoutStage(STAGE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const touch = (pointerId: number, clientX: number, clientY: number) => ({
  pointerId,
  pointerType: 'touch',
  button: 0,
  clientX,
  clientY,
});

function canvas() {
  return screen.getByTestId('live-surface-canvas');
}

/** Two fingers spread from 100px apart to 200px about the stage centre. */
function pinchOutAtCentre() {
  const target = canvas();
  fireEvent.pointerDown(target, touch(1, 150, 125));
  fireEvent.pointerDown(target, touch(2, 250, 125));
  fireEvent.pointerMove(target, touch(1, 100, 125));
  fireEvent.pointerMove(target, touch(2, 300, 125));
  fireEvent.pointerUp(target, touch(1, 100, 125));
  fireEvent.pointerUp(target, touch(2, 300, 125));
}

function tap(x: number, y: number, pointerId = 9) {
  fireEvent.pointerDown(canvas(), touch(pointerId, x, y));
  fireEvent.pointerUp(canvas(), touch(pointerId, x, y));
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe('pinch zoom', () => {
  test('a pinch zooms the picture about the fingers and sends nothing to the page, even while in control', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    pinchOutAtCentre();
    // Past the hold: the first finger's held-back press never goes out.
    await wait(TOUCH_PRESS_HOLD_MS + 50);
    await flush();
    expect(h.events()).toEqual([]);
    expect(screen.getByTestId('live-surface-zoom').style.transform).toBe(
      'translate(-200px, -125px) scale(2)',
    );
    expect(
      screen.getByRole('button', { name: 'Zoom 200%. Reset to fit' }),
    ).toBeTruthy();
  });

  test('while zoomed, a tap lands on the surface pixel drawn under the finger', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    pinchOutAtCentre();
    // Client (100, 62.5) shows picture point (150, 93.75) of the 400x250
    // fit: surface (240, 150). Unzoomed it would be (160, 100).
    tap(100, 62.5);
    await flush();
    expect(h.events()).toEqual([
      {
        kind: 'pointer',
        type: 'down',
        x: 240,
        y: 150,
        clickCount: 1,
        button: 'left',
        pointerType: 'touch',
      },
      {
        kind: 'pointer',
        type: 'up',
        x: 240,
        y: 150,
        clickCount: 1,
        button: 'left',
        pointerType: 'touch',
      },
    ]);
  });

  test('a finger a host captured (it never lifted here) does not join the next pinch', async () => {
    const h = canvasHarness();
    await renderCanvas(h, { inputRequiresLease: true });
    // Finger 1 goes down here, then a host (the float's drag) captures it:
    // its lift is never delivered to the canvas.
    fireEvent.pointerDown(canvas(), { ...touch(1, 20, 20), isPrimary: true });
    // A new gesture: two fresh fingers spread 100 -> 200 about the centre.
    fireEvent.pointerDown(canvas(), { ...touch(5, 150, 125), isPrimary: true });
    fireEvent.pointerDown(canvas(), {
      ...touch(6, 250, 125),
      isPrimary: false,
    });
    fireEvent.pointerMove(canvas(), touch(5, 100, 125));
    fireEvent.pointerMove(canvas(), touch(6, 300, 125));
    expect(screen.getByTestId('live-surface-zoom').style.transform).toBe(
      'translate(-200px, -125px) scale(2)',
    );
  });

  test('a double tap while zoomed returns to fit and is not input', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    pinchOutAtCentre();
    tap(200, 125, 10);
    await flush();
    const sent = h.events().length;
    tap(200, 125, 11);
    await flush();
    expect(screen.getByTestId('live-surface-zoom').style.transform).toBe('');
    // The second tap of the pair went nowhere.
    expect(h.events()).toHaveLength(sent);
  });

  test('a double tap while only watching zooms in at the tap, and is not input', async () => {
    const h = canvasHarness();
    await renderCanvas(h, { inputRequiresLease: true });
    tap(100, 125, 10);
    tap(100, 125, 11);
    await flush();
    expect(h.events()).toEqual([]);
    expect(screen.getByTestId('live-surface-zoom').style.transform).toBe(
      'translate(-100px, -125px) scale(2)',
    );
  });

  test('a trackpad pinch (Ctrl+wheel) zooms the view and never reaches the page', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      clientX: 200,
      clientY: 125,
      cancelable: true,
    });
    canvas().dispatchEvent(wheel);
    await flush();
    expect(wheel.defaultPrevented).toBe(true);
    expect(h.events()).toEqual([]);
    expect(screen.getByTestId('live-surface-zoom').style.transform).toMatch(
      /scale\(2\.7/,
    );
  });
});

describe('touch presses are held back until they are not a pinch', () => {
  test('a tap goes out when the finger lifts', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    await flush();
    expect(h.events()).toEqual([]);
    fireEvent.pointerUp(canvas(), touch(1, 100, 62.5));
    await flush();
    expect(h.events()).toMatchObject([
      { type: 'down', x: 160, y: 100, pointerType: 'touch' },
      { type: 'up', x: 160, y: 100, pointerType: 'touch' },
    ]);
  });

  test('a finger held still goes out after the hold (a long press reaches the page)', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    await wait(TOUCH_PRESS_HOLD_MS + 50);
    await flush();
    expect(h.events()).toMatchObject([{ type: 'down', x: 160, y: 100 }]);
  });

  test('a finger that moves past the slop is a drag on the page, from where it started', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(0, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    fireEvent.pointerMove(canvas(), touch(1, 150, 62.5));
    await flush();
    expect(h.events()).toMatchObject([
      { type: 'down', x: 160, y: 100 },
      { type: 'move', x: 240, y: 100 },
    ]);
  });
});

describe('a held-back touch press meets the eligibility of when it goes out', () => {
  test('turning read-only during the hold cancels the press', async () => {
    const h = canvasHarness();
    const view = await renderCanvas(h, {}, lease(0, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    await flush();
    view.rerender(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={h.transport as never}
        readOnly
      />,
    );
    await wait(TOUCH_PRESS_HOLD_MS + 50);
    await flush();
    expect(h.events()).toEqual([]);
  });

  test('control lost and regained during the hold never sends the press in the new control', async () => {
    const h = canvasHarness();
    await renderCanvas(h, {}, lease(1, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    await flush();
    // An agent takes over, then this viewer takes control back, all within
    // the hold: the press was made in control that has since ended.
    await h.pushState(
      lease(2, { kind: 'agent', principal: 'agent:coder', sessionId: 's' }),
    );
    await h.pushState(lease(3, MY_HOLD));
    await wait(TOUCH_PRESS_HOLD_MS + 50);
    await flush();
    expect(h.events()).toEqual([]);
  });

  test('losing control during the hold, where the lease comes first, cancels the press', async () => {
    const h = canvasHarness();
    await renderCanvas(h, { inputRequiresLease: true }, lease(0, MY_HOLD));
    fireEvent.pointerDown(canvas(), touch(1, 100, 62.5));
    await flush();
    await h.pushState(
      lease(1, { kind: 'agent', principal: 'agent:coder', sessionId: 's' }),
    );
    await wait(TOUCH_PRESS_HOLD_MS + 50);
    await flush();
    expect(h.events()).toEqual([]);
  });
});

describe('immersive (full screen)', () => {
  function requestFullscreenStub() {
    const request = vi.fn(async () => {});
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: request,
    });
    return request;
  }

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
  });

  test('Full screen lays the same view over the viewport, asks the platform, shows the chrome, and Exit returns', async () => {
    const request = requestFullscreenStub();
    const h = canvasHarness();
    const { container } = await renderCanvas(h, { fullScreenButton: true });
    const root = container.querySelector('.live-surface') as HTMLElement;
    const before = canvas();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(root.hasAttribute('data-immersive')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    // In place: the very same canvas (the same stream), not a second view.
    expect(canvas()).toBe(before);
    const bar = screen.getByRole('toolbar', {
      name: 'Browser: example.com: full screen controls',
    });
    expect(bar.textContent).toContain('No one is in control');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(root.hasAttribute('data-immersive')).toBe(false);
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy();
  });

  test('a refused Fullscreen API still gets the full-viewport layer', async () => {
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.reject(new Error('not allowed'))),
    });
    const h = canvasHarness();
    const { container } = await renderCanvas(h, { fullScreenButton: true });
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    await flush();
    expect(
      container.querySelector('.live-surface')?.hasAttribute('data-immersive'),
    ).toBe(true);
  });

  test('the chrome hides by itself, and a tap on its handle (or the picture) brings it back', async () => {
    const h = canvasHarness();
    await renderCanvas(h, { fullScreenButton: true, inputRequiresLease: true });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(
      screen.getByRole('button', { name: 'Exit full screen' }),
    ).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(CONTROLS_AUTO_HIDE_MS + 10);
    });
    expect(
      screen.queryByRole('button', { name: 'Exit full screen' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show controls' }));
    expect(
      screen.getByRole('button', { name: 'Exit full screen' }),
    ).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(CONTROLS_AUTO_HIDE_MS + 10);
    });
    expect(
      screen.queryByRole('button', { name: 'Exit full screen' }),
    ).toBeNull();
  });

  test('Escape, or the platform leaving full screen, ends it', async () => {
    requestFullscreenStub();
    const h = canvasHarness();
    const { container } = await renderCanvas(h, { fullScreenButton: true });
    const root = container.querySelector('.live-surface') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(root.hasAttribute('data-immersive')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    let element: Element | null = root;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => element,
    });
    fireEvent(document, new Event('fullscreenchange'));
    expect(root.hasAttribute('data-immersive')).toBe(true);
    element = null; // the system back gesture, Esc in the browser
    fireEvent(document, new Event('fullscreenchange'));
    expect(root.hasAttribute('data-immersive')).toBe(false);
    // The own-property stub goes; the prototype's getter is back.
    Reflect.deleteProperty(document, 'fullscreenElement');
  });

  test('a host enters it through the reported control state, and there a touch drives the surface (the lease-first rule is lifted)', async () => {
    let control: LiveSurfaceControlState | null = null;
    const h = canvasHarness();
    await renderCanvas(h, {
      hostControls: true,
      inputRequiresLease: true,
      onControlState: (state) => {
        control = state;
      },
    });
    tap(100, 62.5, 1);
    await flush();
    expect(h.events()).toEqual([]); // floating: watching only
    act(() => control?.enterImmersive());
    expect(control!.immersive).toBe(true);
    tap(100, 62.5, 2);
    await flush();
    expect(h.events()).toMatchObject([
      { type: 'down', x: 160, y: 100, pointerType: 'touch' },
      { type: 'up', x: 160, y: 100, pointerType: 'touch' },
    ]);
  });

  test('the per-surface slot gets this surface’s API: a device’s Home and Back go through its input', async () => {
    const h = canvasHarness();
    await renderCanvas(
      h,
      {
        fullScreenButton: true,
        renderImmersiveActions: (api) => (
          <DeviceImmersiveActions api={api} platform="android" />
        ),
      },
      lease(0, MY_HOLD),
    );
    // Not in the pane's own chrome: only the full-screen bar carries it.
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await flush();
    expect(h.events()).toEqual([
      { kind: 'device-button', button: 'home' },
      { kind: 'device-button', button: 'back' },
    ]);
    // Holding control: Release control and the keyboard are offered.
    expect(
      screen.getByRole('button', { name: 'Release control' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show keyboard' })).toBeTruthy();
  });
});
