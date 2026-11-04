/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR, type RowCells } from '../../terminal-view/engine/frame';
import type { CellMetrics } from '../../terminal-view/render/glyph-atlas';
import {
  ScreenModel,
  type TerminalTheme,
} from '../../terminal-view/render/screen-model';
import { WebGl2Renderer } from '../../terminal-view/render/webgl2-renderer';

/**
 * A WebGL2 context reduced to what the renderer's setup calls, following the
 * specification where it matters here: once the context is lost,
 * `getExtension` answers null, and `WEBGL_lose_context.restoreContext` gives
 * back only a context that extension lost (a browser may also refuse).
 */
function fakeContext(canvas: HTMLCanvasElement) {
  const state = { lost: false, lostByExtension: false, restorable: true };
  const ext = {
    loseContext() {
      if (state.lost) return;
      state.lost = true;
      state.lostByExtension = true;
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    },
    restoreContext() {
      if (!state.lost || !state.lostByExtension || !state.restorable) return;
      state.lost = false;
      state.lostByExtension = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
  const uploads: { x: number; y: number; width: number; height: number }[] =
    [];
  const calls = {
    texSubImage2D: (...args: unknown[]) => {
      const image = args[6] as { width: number; height: number };
      uploads.push({
        x: args[2] as number,
        y: args[3] as number,
        width: image.width,
        height: image.height,
      });
    },
    getExtension: (name: string) =>
      state.lost || name !== 'WEBGL_lose_context' ? null : ext,
    isContextLost: () => state.lost,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getParameter: () => 2048,
  } as Record<string, unknown>;
  const gl = new Proxy(calls, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      if (property in target) return target[property];
      // Enum constants are numbers; every other call succeeds with an object.
      if (/^[A-Z0-9_]+$/.test(property)) return 1;
      return () => ({});
    },
  });
  canvas.getContext = (() => gl) as unknown as HTMLCanvasElement['getContext'];
  return {
    state,
    uploads,
    /** The browser takes the context itself (a GPU reset, app backgrounded). */
    browserLoses() {
      state.lost = true;
      state.lostByExtension = false;
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    },
  };
}

function start() {
  const canvas = document.createElement('canvas');
  const context = fakeContext(canvas);
  const callbacks = { invalidated: vi.fn(), failed: vi.fn() };
  const renderer = WebGl2Renderer.create(canvas, callbacks);
  if (!renderer) throw new Error('the fake context should give a renderer');
  return { renderer, context, callbacks };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The glyph atlas rasterizes on a 2D canvas, which jsdom does not draw. */
function stubTwoD() {
  const twoD = new Proxy({} as Record<string, unknown>, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (property === 'measureText')
        return () => ({
          width: 8,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 3,
        });
      if (property === 'getImageData')
        return (_x: number, _y: number, width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(4),
        });
      return () => undefined;
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => twoD as unknown as RenderingContext,
  );
}

const metrics: CellMetrics = {
  dpr: 1,
  width: 8,
  height: 16,
  baseline: 12,
  cssWidth: 8,
  cssHeight: 16,
  font: { family: 'monospace', size: 13, lineHeight: 1.2 },
};
const theme: TerminalTheme = {
  foreground: 0x111111,
  background: 0xffffff,
  cursor: 0x000000,
  cursorText: 0xffffff,
  selectionBackground: 0xcccccc,
  selectionForeground: null,
  ansi: Array.from({ length: 16 }, () => 0x808080),
  scheme: 'light',
};

function screen(text: string) {
  const cols = 4;
  const codepoints = new Uint32Array(cols);
  [...text].forEach((char, i) => {
    codepoints[i] = char.codePointAt(0)!;
  });
  const row: RowCells = {
    id: 'r0',
    y: 0,
    codepoints,
    clusters: {},
    fg: new Uint32Array(cols).fill(DEFAULT_COLOR),
    bg: new Uint32Array(cols).fill(DEFAULT_COLOR),
    attrs: new Uint16Array(cols),
    selection: null,
    wrapped: false,
  };
  const model = new ScreenModel();
  model.apply({
    cols,
    rows: 1,
    full: true,
    rowIds: ['r0'],
    dirty: [row],
    cursor: null,
    colors: {
      background: 0xffffff,
      foreground: 0x111111,
      cursor: null,
      palette: new Uint32Array(256),
    },
    scrollbar: { total: 1, offset: 0, length: 1 },
    atBottom: true,
  });
  return model;
}

const overlay = { focused: true, cursorOn: true, link: null };

describe('WebGl2Renderer context loss (#3994)', () => {
  it('gets its context back when a hidden view is shown again', () => {
    const { renderer, context, callbacks } = start();
    renderer.suspend();
    expect(context.state.lost).toBe(true);
    renderer.resume();
    // Restored through the extension held from before the loss: looked up
    // afterwards it is null, and the view stayed blank.
    expect(context.state.lost).toBe(false);
    expect(callbacks.invalidated).toHaveBeenCalledTimes(1);
    expect(callbacks.failed).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('draws in 2D when the browser will not give the context back', () => {
    vi.useFakeTimers();
    const { renderer, context, callbacks } = start();
    renderer.suspend();
    // Android Chrome, after the app was in the background.
    context.state.restorable = false;
    renderer.resume();
    expect(context.state.lost).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(callbacks.failed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(callbacks.failed).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('draws in 2D when a shown view loses its context and it never returns', () => {
    vi.useFakeTimers();
    const { renderer, context, callbacks } = start();
    context.browserLoses();
    vi.advanceTimersByTime(2000);
    expect(callbacks.failed).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it('uploads the glyphs drawn before the loss into the restored texture', () => {
    stubTwoD();
    const { renderer, context } = start();
    renderer.setTheme(theme);
    renderer.resize(4, 1, metrics);
    const model = screen('hi');
    renderer.render(model, overlay);
    const before = context.uploads.splice(0);
    expect(before.length).toBeGreaterThan(0);
    renderer.suspend();
    renderer.resume();
    renderer.render(model, overlay);
    // Nothing new was rasterized, yet the empty new texture needs every tile
    // it had: without them only the cursor was drawn.
    const after = context.uploads.splice(0);
    for (const tile of before)
      expect(
        after.some(
          (upload) =>
            upload.x <= tile.x &&
            upload.y <= tile.y &&
            upload.x + upload.width >= tile.x + tile.width &&
            upload.y + upload.height >= tile.y + tile.height,
        ),
      ).toBe(true);
    renderer.dispose();
  });

  it('keeps WebGL when a lost context comes back in time', () => {
    vi.useFakeTimers();
    const { renderer, context, callbacks } = start();
    renderer.suspend();
    renderer.resume();
    vi.advanceTimersByTime(5000);
    expect(context.state.lost).toBe(false);
    expect(callbacks.failed).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('waits for nothing while hidden', () => {
    vi.useFakeTimers();
    const { renderer, context, callbacks } = start();
    renderer.suspend();
    context.state.restorable = false;
    vi.advanceTimersByTime(10_000);
    expect(callbacks.failed).not.toHaveBeenCalled();
    renderer.dispose();
  });
});
