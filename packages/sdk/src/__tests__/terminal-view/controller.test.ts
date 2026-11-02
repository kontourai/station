/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalController } from '../../terminal-view/controller';
import type { EnginePort } from '../../terminal-view/engine/engine-client';
import { EngineHost } from '../../terminal-view/engine/engine-host';
import type { CellMetrics, FontSpec } from '../../terminal-view/render/glyph-atlas';
import type { TerminalRenderer } from '../../terminal-view/render/renderer';
import type { TerminalTheme } from '../../terminal-view/render/screen-model';
import type {
  TerminalViewSession,
  TerminalViewSessionListener,
} from '../../terminal-view/session';

const WASM_PATH = fileURLToPath(
  new URL('../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm', import.meta.url),
);

/** Draws nothing; records what the controller asked of it. */
class FakeRenderer implements TerminalRenderer {
  readonly kind = 'canvas2d' as const;
  themes: TerminalTheme[] = [];
  sizes: [number, number][] = [];
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  setTheme(theme: TerminalTheme) {
    this.themes.push(theme);
  }
  render() {}
  suspend() {}
  resume() {}
  dispose() {}
}

const measureCell = (font: FontSpec): CellMetrics => ({
  dpr: 1,
  width: 8,
  height: 16,
  baseline: 12,
  cssWidth: 8,
  cssHeight: 16,
  font,
});

/** The engine worker, run in this thread on the real vendored module. */
function inThreadPort(): EnginePort {
  const port: EnginePort = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      void host.handle(message);
    },
    terminate: () => undefined,
  };
  const host = new EngineHost((event) =>
    port.onmessage?.(new MessageEvent('message', { data: event })),
  );
  return port;
}

function fakeSession() {
  let listener: TerminalViewSessionListener | null = null;
  const session = {
    state: 'ready' as const,
    readOnly: false,
    subscribe(next: TerminalViewSessionListener) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    write: vi.fn((_bytes: Uint8Array) => true),
    resize: vi.fn((_cols: number, _rows: number) => undefined),
  } satisfies TerminalViewSession;
  const output = (text: string) =>
    listener?.output(new TextEncoder().encode(text), 'live');
  return { session, output };
}

let resizeObservers: (() => void)[] = [];
let rect = { width: 800, height: 320 };

beforeEach(() => {
  resizeObservers = [];
  rect = { width: 800, height: 320 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(readFileSync(WASM_PATH)))),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeObservers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

async function startController() {
  const root = document.createElement('div');
  root.getBoundingClientRect = () => DOMRect.fromRect(rect);
  const canvas = document.createElement('canvas');
  const input = document.createElement('textarea');
  root.append(canvas, input);
  document.body.append(root);
  const renderer = new FakeRenderer();
  const controller = new TerminalController(
    { root, canvas, input },
    {
      font: { family: 'monospace', size: 13, lineHeight: 1.2 },
      screenReader: false,
      reducedMotion: true,
      wasmUrl: 'http://station.test/ghostty-vt.wasm',
      createWorker: inThreadPort,
      createRenderer: () => renderer,
      measureCell,
    },
  );
  const { session, output } = fakeSession();
  controller.setSession(session);
  await controller.start();
  await vi.waitFor(() =>
    expect(controller.getSnapshot().status).toBe('ready'),
  );
  return { controller, renderer, session, output, root };
}

describe('TerminalController', () => {
  // Replaces TerminalPanel's "copies the complete terminal selection".
  it('copies the complete selection to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { controller, output } = await startController();
    output('copy exactly this');
    controller.selectAll();
    expect(await controller.copy()).toBe(true);
    expect(writeText).toHaveBeenCalledWith('copy exactly this');
    controller.dispose();
  });

  // Replaces TerminalPanel's "repaints the canvas from the terminal variables
  // when the root theme changes".
  it('re-reads the theme from the cascade when light and dark change', async () => {
    const sheet = document.createElement('style');
    sheet.textContent = `
      div { --terminal-background: #1a1a2e; --terminal-foreground: #e0e0e0; }
      [data-theme="light"] div { --terminal-background: #ffffff; --terminal-foreground: #24292f; }
    `;
    document.head.append(sheet);
    document.documentElement.setAttribute('data-theme', 'dark');
    try {
      const { controller, renderer } = await startController();
      expect(renderer.themes[0]).toMatchObject({
        background: 0x1a1a2e,
        scheme: 'dark',
      });
      document.documentElement.setAttribute('data-theme', 'light');
      await vi.waitFor(() =>
        expect(renderer.themes[renderer.themes.length - 1]).toMatchObject({
          background: 0xffffff,
          scheme: 'light',
        }),
      );
      controller.dispose();
    } finally {
      sheet.remove();
    }
  });

  // Replaces TerminalPanel's "coalesces resize bursts into the latest size".
  it('sends the session only the latest size of a resize burst', async () => {
    const { controller, session, renderer } = await startController();
    // 800 x 320 CSS pixels over 8 x 16 cells.
    expect(session.resize).toHaveBeenLastCalledWith(100, 20);
    session.resize.mockClear();
    for (const size of [
      { width: 880, height: 400 },
      { width: 920, height: 448 },
      { width: 960, height: 480 },
    ]) {
      rect = size;
      for (const observe of resizeObservers) observe();
    }
    expect(renderer.sizes[renderer.sizes.length - 1]).toEqual([120, 30]);
    await vi.waitFor(() =>
      expect(session.resize).toHaveBeenCalledWith(120, 30),
    );
    expect(session.resize).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
