/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeTerminalFrame,
  encodeTerminalSize,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_OUTPUT,
  TERMINAL_RESIZE,
  TERMINAL_SOCKET_PROTOCOL_V2,
} from '@kontourai/station-contracts/terminal-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionStore } from '../../client/terminal-session-store';
import { TerminalController } from '../../terminal-view/controller';
import type { EnginePort } from '../../terminal-view/engine/engine-client';
import { EngineHost } from '../../terminal-view/engine/engine-host';
import type {
  CellMetrics,
  FontSpec,
} from '../../terminal-view/render/glyph-atlas';
import type { TerminalRenderer } from '../../terminal-view/render/renderer';
import type {
  ScreenModel,
  TerminalTheme,
} from '../../terminal-view/render/screen-model';
import type {
  TerminalViewSession,
  TerminalViewSessionListener,
} from '../../terminal-view/session';
import { toTerminalViewSession } from '../../terminal-view/store-session';

// jsdom gives `import.meta.url` a non-file scheme; `__dirname` stays a path.
const WASM_PATH = join(
  __dirname,
  '../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
);

/** Draws nothing; records what the controller asked of it. */
class FakeRenderer implements TerminalRenderer {
  readonly kind = 'canvas2d' as const;
  themes: TerminalTheme[] = [];
  sizes: [number, number][] = [];
  frames: { cols: number; rows: number }[] = [];
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  setTheme(theme: TerminalTheme) {
    this.themes.push(theme);
  }
  render(model: ScreenModel) {
    this.frames.push({ cols: model.cols, rows: model.rows.length });
  }
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

/**
 * The engine worker, run in this thread on the real vendored module. A message
 * with a transfer list is cloned with it, so its buffers detach on the sending
 * side exactly as they do when posted to a real Worker.
 */
function inThreadPort(): EnginePort {
  const port: EnginePort = {
    onmessage: null,
    onerror: null,
    postMessage: (message, transfer) => {
      void host.handle(
        transfer.length ? structuredClone(message, { transfer }) : message,
      );
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

/**
 * One session several views share, as the SDK session store does: each chunk
 * is one array handed to every subscriber and retained for later ones.
 */
function sharedSession() {
  const listeners = new Set<TerminalViewSessionListener>();
  const retained: Uint8Array[] = [];
  const session = {
    state: 'ready' as const,
    readOnly: false,
    subscribe(next: TerminalViewSessionListener) {
      listeners.add(next);
      for (const chunk of retained) next.output(chunk, 'replay');
      return () => {
        listeners.delete(next);
      };
    },
    write: vi.fn((_bytes: Uint8Array) => true),
    resize: vi.fn((_cols: number, _rows: number) => undefined),
  } satisfies TerminalViewSession;
  const output = (text: string) => {
    // This realm's array, as the store's socket frames are: transferable.
    const chunk = new Uint8Array(new TextEncoder().encode(text));
    retained.push(chunk);
    for (const listener of listeners) listener.output(chunk, 'live');
  };
  return { session, output, retained };
}

const storedTerminalId = '62b97fa1-b690-4d77-82b1-747dc86d3c11';

/** Only the wire is simulated; the store, adapter, controller and engine run. */
class SessionSocket extends EventTarget {
  readyState = 0;
  protocol = TERMINAL_SOCKET_PROTOCOL_V2;
  binaryType = 'arraybuffer';
  sent: (Record<string, unknown> | Uint8Array)[] = [];

  send(value: string | Uint8Array) {
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
  }

  controls() {
    return this.sent.filter(
      (value): value is Record<string, unknown> =>
        !(value instanceof Uint8Array),
    );
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    this.message({ type: 'authenticated', protocolVersion: 2 });
  }

  message(value: object | ArrayBuffer) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: value instanceof ArrayBuffer ? value : JSON.stringify(value),
      }),
    );
  }

  attached(
    replayThrough: number,
    terminalId = storedTerminalId,
    status: 'running' | 'exited' | 'failed' = 'running',
  ) {
    const request = this.controls()
      .reverse()
      .find((command) => command.type === 'open' || command.type === 'attach');
    if (!request) throw new Error('The real store sent no attachment request');
    this.message({
      type: 'attached',
      requestId: request.requestId,
      channel: request.channel,
      terminalId,
      status,
      replayThrough,
      readOnly: false,
      maxOutstandingOutputFrames: TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
    });
    return Number(request.channel);
  }

  ready(channel: number, seq: number) {
    this.message({ type: 'ready', channel, seq });
  }

  output(channel: number, seq: number, text: string) {
    this.message(
      new Uint8Array(
        encodeTerminalFrame(
          TERMINAL_OUTPUT,
          channel,
          seq,
          new TextEncoder().encode(text),
        ),
      ).buffer,
    );
  }

  resized(channel: number, seq: number, cols: number, rows: number) {
    this.message(
      new Uint8Array(
        encodeTerminalFrame(
          TERMINAL_RESIZE,
          channel,
          seq,
          encodeTerminalSize(cols, rows),
        ),
      ).buffer,
    );
  }

  close() {
    this.drop(1000);
  }

  drop(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

async function acknowledged(
  socket: SessionSocket,
  channel: number,
  seq: number,
) {
  await vi.waitFor(() =>
    expect(
      socket
        .controls()
        .filter(
          (command) => command.type === 'ack' && command.channel === channel,
        )
        .slice(-1)[0],
    ).toMatchObject({ seq }),
  );
}

async function renderedGrid(
  renderer: FakeRenderer,
  cols: number,
  rows: number,
) {
  await vi.waitFor(() =>
    expect(renderer.frames[renderer.frames.length - 1]).toEqual({ cols, rows }),
  );
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
  // Fires only for what is observed: unhooking the view's observer must
  // leave a resize unseen.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly targets = new Set<Element>();
      constructor(callback: () => void) {
        resizeObservers.push(() => {
          if (this.targets.size) callback();
        });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
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

async function startController(
  shared?: ReturnType<typeof sharedSession>,
  createWorker = inThreadPort,
) {
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
      createWorker,
      createRenderer: () => renderer,
      measureCell,
    },
  );
  const { session, output } = shared ?? fakeSession();
  controller.setSession(session);
  await controller.start();
  await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'));
  return { controller, renderer, session, output, root };
}

async function startStoredController({
  recordInitialSize = true,
  createWorker = inThreadPort,
} = {}) {
  rect = { width: 80 * 8, height: 24 * 16 };
  const view = await startController(undefined, createWorker);
  const sockets: SessionSocket[] = [];
  const store = new TerminalSessionStore({
    apiBase: 'http://127.0.0.1:4198/prefix',
    requestTicket: async () => ({ ticket: 'T'.repeat(43), expiresAt: 1 }),
    createSocket: () => {
      const socket = new SessionSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const dispose = () => {
    view.controller.dispose();
    store.dispose();
  };
  const lines = Array.from(
    { length: 40 },
    (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
  );
  const session = store.open(
    { projectId: 'grid', bindingKey: 'replay' },
    { cols: 80, rows: 24 },
  );
  view.controller.setSession(toTerminalViewSession(session));
  const socketAt = async (index: number) => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
    return sockets[index]!;
  };
  const resizeView = async (cols: number, rows: number) => {
    rect = { width: cols * 8, height: rows * 16 };
    for (const observe of resizeObservers) observe();
    await renderedGrid(view.renderer, cols, rows);
  };
  try {
    const socket = await socketAt(0);
    socket.open();
    const channel = socket.attached(0);
    socket.ready(channel, 0);
    expect(session.state).toBe('ready');
    if (recordInitialSize) socket.resized(channel, 1, 80, 24);
    const initialSeq = recordInitialSize ? 2 : 1;
    socket.output(channel, initialSeq, `${lines.join('\r\n')}\r\n`);
    await acknowledged(socket, channel, initialSeq);
    await renderedGrid(view.renderer, 80, 24);
    return {
      ...view,
      store,
      session,
      socket,
      channel,
      socketAt,
      resizeView,
      lines,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function selectedText(controller: TerminalController) {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  controller.selectAll();
  expect(await controller.copy()).toBe(true);
  return String(writeText.mock.lastCall?.[0]);
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

  // Docking a Terminal right and back left a hidden dock view and the lower
  // panel's view on one session; the first view's transfer detached the
  // chunk, the second view's post threw, and the store reconnected forever.
  it('leaves output intact for every other view of the same session', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const shared = sharedSession();
    const first = await startController(shared);
    // One view alone must not detach what the session retains.
    shared.output('kept');
    expect(shared.retained[0]?.byteLength).toBe(4);
    const second = await startController(shared);
    expect(() => shared.output('seen by both views')).not.toThrow();
    // A view that subscribes later replays the retained chunk.
    const late = await startController(shared);
    for (const { controller } of [first, second, late]) {
      await vi.waitFor(async () => {
        controller.selectAll();
        expect(await controller.copy()).toBe(true);
        expect(writeText).toHaveBeenLastCalledWith('keptseen by both views');
      });
      controller.dispose();
    }
  });

  // "Reconnect terminal" and a read-only change keep the view and hand it a
  // fresh attachment, which replays the journal from its start. Without a
  // reset first, the history drew again under the screen it had restored.
  it('restores a reattached session from its replay once, without the old screen', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const first = sharedSession();
    const { controller } = await startController(first);
    first.output('$ make\r\nbuilt\r\n');
    controller.setSession(null);
    const reattached = sharedSession();
    reattached.output('$ make\r\nbuilt\r\n');
    reattached.output('$ ls\r\nREADME\r\n');
    controller.setSession(reattached.session);
    await vi.waitFor(async () => {
      controller.selectAll();
      expect(await controller.copy()).toBe(true);
      const text = String(writeText.mock.lastCall?.[0]);
      expect(text).toContain('README');
      expect(text.match(/built/g)).toHaveLength(1);
    });
    controller.dispose();
  });

  // Station's own shortcuts (the command palette, Settings, the shortcut
  // list) were swallowed while a terminal had focus: the view encoded every
  // modifier chord and prevented it, and the app skips prevented keys.
  it.each([
    { platform: 'MacIntel', host: { key: 'k', metaKey: true } },
    {
      platform: 'Linux x86_64',
      host: { key: 'D', ctrlKey: true, shiftKey: true },
    },
  ])(
    'leaves app chords to the page and Control chords to the program on $platform',
    async ({ platform, host }) => {
      vi.stubGlobal('navigator', { ...navigator, platform });
      const { controller, session, root } = await startController();
      const input = root.querySelector('textarea')!;
      const press = (init: KeyboardEventInit) => {
        const event = new KeyboardEvent('keydown', {
          ...init,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        return event;
      };
      expect(press(host).defaultPrevented).toBe(false);
      expect(session.write).not.toHaveBeenCalled();
      expect(
        press({ key: 'd', code: 'KeyD', ctrlKey: true }).defaultPrevented,
      ).toBe(true);
      await vi.waitFor(() =>
        expect(
          session.write.mock.calls.map(([bytes]) =>
            new TextDecoder().decode(bytes),
          ),
        ).toContain('\x04'),
      );
      controller.dispose();
    },
  );

  // #4625: ConPTY repaints its whole screen for a new size. Replayed at the
  // view's size instead, that repaint landed on lines that had scrolled.
  it('replays output at its recorded sizes, keeping lines that scrolled before a resize', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const lines = Array.from(
      { length: 15 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    );
    // Written at 100x10: the first six lines scroll. Then the terminal was
    // resized to 100x5 and repainted its five rows from the top.
    const events: (
      | { text: string }
      | { size: { cols: number; rows: number } }
    )[] = [
      { size: { cols: 100, rows: 10 } },
      { text: `${lines.join('\r\n')}\r\n` },
      { size: { cols: 100, rows: 5 } },
      {
        text: `\x1b[H${lines
          .slice(11)
          .map((line) => `${line}\x1b[K`)
          .join('\r\n')}\r\n\x1b[K\x1b[J`,
      },
    ];
    const replaying = (applySizes: boolean) => {
      const session = {
        state: 'ready' as const,
        readOnly: false,
        subscribe(next: TerminalViewSessionListener) {
          for (const event of events)
            if ('text' in event)
              next.output(new TextEncoder().encode(event.text), 'replay');
            else if (applySizes)
              next.resize?.(event.size.cols, event.size.rows, 'replay');
          next.replayed?.();
          return () => undefined;
        },
        write: vi.fn((_bytes: Uint8Array) => true),
        resize: vi.fn((_cols: number, _rows: number) => undefined),
      } satisfies TerminalViewSession;
      return session;
    };
    const copied = async (controller: TerminalController) => {
      let text = '';
      await vi.waitFor(async () => {
        controller.selectAll();
        expect(await controller.copy()).toBe(true);
        text = String(writeText.mock.lastCall?.[0]);
        expect(text).toContain('line-15');
      });
      return text;
    };
    // The view's box is 100x20.
    const { controller } = await startController();
    controller.setSession(replaying(true));
    const screen = await copied(controller);
    for (const line of lines) expect(screen, line).toContain(line);
    // Control: without the recorded sizes the repaint overwrites them.
    controller.setSession(replaying(false));
    const unsized = await copied(controller);
    expect(unsized).not.toContain('line-01');
    controller.dispose();
  });

  it.each(['running', 'exited', 'failed'] as const)(
    'restores the last live grid before incremental replay for %s programs',
    async (status) => {
      const f = await startStoredController();
      try {
        f.socket.drop();
        expect(f.session.state).toBe('reconnecting');
        await f.resizeView(100, 40);
        const resumed = await f.socketAt(1);
        resumed.open();
        expect(resumed.controls().slice(-1)[0]).toMatchObject({
          type: 'attach',
          terminalId: storedTerminalId,
          fromSeq: 2,
        });
        const channel = resumed.attached(3, storedTerminalId, status);
        expect(f.session.status).toBe(status);
        expect(f.controller.getSnapshot().session).toBe(
          status === 'running' ? 'replaying' : 'exited',
        );
        const repaint = `\x1b[H${f.lines
          .slice(17)
          .map((line) => `${line}\x1b[K`)
          .join('\r\n')}\r\n\x1b[K\x1b[J`;
        resumed.output(channel, 3, repaint);
        await acknowledged(resumed, channel, 3);
        await renderedGrid(f.renderer, 80, 24);
        const text = await selectedText(f.controller);
        for (const line of f.lines) expect(text.split(line)).toHaveLength(2);
        expect(
          resumed.controls().filter((command) => command.type === 'resize'),
        ).toEqual([]);
        resumed.ready(channel, 3);
        await renderedGrid(f.renderer, 100, 40);
        expect(f.controller.getSnapshot().session).toBe(
          status === 'running' ? 'ready' : 'exited',
        );

        // Finishing one replay must not forget the grid for the next one.
        resumed.drop();
        await f.resizeView(120, 45);
        const again = await f.socketAt(2);
        again.open();
        expect(again.controls().slice(-1)[0]).toMatchObject({
          type: 'attach',
          fromSeq: 3,
        });
        const nextChannel = again.attached(4, storedTerminalId, status);
        again.output(nextChannel, 4, '\r\nsecond-replay');
        await acknowledged(again, nextChannel, 4);
        await renderedGrid(f.renderer, 80, 24);
        again.ready(nextChannel, 4);
        await renderedGrid(f.renderer, 120, 45);
        expect(await selectedText(f.controller)).toContain('second-replay');
      } finally {
        f.dispose();
      }
    },
  );

  it('rebuilds an unsized prefix before a later recorded grid on resync', async () => {
    const ports: EnginePort[] = [];
    const f = await startStoredController({
      recordInitialSize: false,
      createWorker: () => {
        const port = inThreadPort();
        ports.push(port);
        return port;
      },
    });
    try {
      const repaint = `\x1b[H${f.lines
        .slice(17)
        .map((line) => `${line}\x1b[K`)
        .join('\r\n')}\r\n\x1b[K\x1b[J`;
      f.socket.output(f.channel, 2, repaint);
      await acknowledged(f.socket, f.channel, 2);
      const before = await selectedText(f.controller);
      for (const line of f.lines) expect(before.split(line)).toHaveLength(2);
      f.socket.resized(f.channel, 3, 100, 40);
      await acknowledged(f.socket, f.channel, 3);
      await renderedGrid(f.renderer, 80, 24);

      const previousFrames = f.renderer.frames.length;
      expect(ports).toHaveLength(1);
      expect(ports[0]!.onmessage).toEqual(expect.any(Function));
      ports[0]!.onmessage!(
        new MessageEvent('message', { data: { type: 'overflow', id: 2 } }),
      );
      await vi.waitFor(() => expect(f.controller.resyncs).toBe(1));
      await vi.waitFor(() =>
        expect(f.renderer.frames.length).toBeGreaterThan(previousFrames),
      );
      await renderedGrid(f.renderer, 80, 24);
      expect(f.session.state).toBe('ready');
      const after = await selectedText(f.controller);
      for (const line of f.lines) expect(after.split(line)).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it('uses a later live recorded grid for incremental replay', async () => {
    const f = await startStoredController();
    try {
      f.socket.resized(f.channel, 3, 90, 20);
      await acknowledged(f.socket, f.channel, 3);
      await renderedGrid(f.renderer, 80, 24);
      f.socket.drop();
      await f.resizeView(100, 40);
      const resumed = await f.socketAt(1);
      resumed.open();
      expect(resumed.controls().slice(-1)[0]).toMatchObject({
        type: 'attach',
        fromSeq: 3,
      });
      const channel = resumed.attached(4);
      resumed.output(channel, 4, '\r\nlater-grid');
      await acknowledged(resumed, channel, 4);
      await renderedGrid(f.renderer, 90, 20);
      resumed.ready(channel, 4);
      await renderedGrid(f.renderer, 100, 40);
      expect(await selectedText(f.controller)).toContain('later-grid');
    } finally {
      f.dispose();
    }
  });

  it.each(['reset', 'session replacement'] as const)(
    'does not reuse a recorded grid after %s',
    async (boundary) => {
      const f = await startStoredController();
      try {
        await f.resizeView(100, 40);
        let session = f.session;
        let channel = f.channel;
        let seq = 11;
        if (boundary === 'reset') {
          f.socket.message({
            type: 'reset',
            channel,
            fromSeq: 10,
            replayThrough: 11,
          });
        } else {
          session = f.store.open(
            { projectId: 'grid', bindingKey: 'replacement' },
            { cols: 100, rows: 40 },
          );
          f.controller.setSession(toTerminalViewSession(session));
          channel = f.socket.attached(
            1,
            '86e59280-af94-4562-9a7e-dca42652b0b1',
          );
          seq = 1;
        }
        expect(session.state).toBe('replaying');
        f.socket.output(channel, seq, 'new-history');
        await acknowledged(f.socket, channel, seq);
        await renderedGrid(f.renderer, 100, 40);
        const text = await selectedText(f.controller);
        expect(text).toContain('new-history');
        expect(text).not.toContain('line-01');
        f.socket.ready(channel, seq);
        expect(session.state).toBe('ready');
      } finally {
        f.dispose();
      }
    },
  );

  // A dock region put away keeps its view mounted with no box; sizing the
  // shared shell from it squeezed every other view to two columns.
  it('never sizes the session from a view with no box', async () => {
    rect = { width: 0, height: 0 };
    const { controller, session } = await startController();
    await new Promise((done) => setTimeout(done, 150));
    expect(session.resize).not.toHaveBeenCalled();
    rect = { width: 800, height: 320 };
    for (const observe of resizeObservers) observe();
    await vi.waitFor(() =>
      expect(session.resize).toHaveBeenLastCalledWith(100, 20),
    );
    session.resize.mockClear();
    rect = { width: 0, height: 0 };
    for (const observe of resizeObservers) observe();
    await new Promise((done) => setTimeout(done, 150));
    expect(session.resize).not.toHaveBeenCalled();
    controller.dispose();
  });
});

/**
 * The events Gboard sends Android Chrome, as recorded from a real emulator
 * (#3994): every letter is a keydown 229 then `beforeinput insertText`; the
 * Send key and a Backspace on an empty field are real keydowns with `key`
 * set and `code` empty; a Backspace over text the keyboard typed is a
 * keydown 229 then `beforeinput deleteContentBackward`.
 */
describe('TerminalController with an Android soft keyboard', () => {
  const keydown = (key: string, keyCode: number) => {
    const event = new KeyboardEvent('keydown', {
      key,
      code: '',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    return event;
  };
  const beforeinput = (inputType: string, data: string | null = null) =>
    new InputEvent('beforeinput', {
      inputType,
      data,
      bubbles: true,
      cancelable: true,
    });
  const written = (session: { write: { mock: { calls: unknown[][] } } }) =>
    session.write.mock.calls
      .map(([bytes]) => new TextDecoder().decode(bytes as Uint8Array))
      .join('');

  it('runs a typed command with the Send key and deletes with Backspace', async () => {
    const { controller, session } = await startController();
    const input = document.querySelector('textarea')!;
    const kept: boolean[] = [];
    for (const char of 'echo hix') {
      input.dispatchEvent(keydown('Unidentified', 229));
      const insert = beforeinput('insertText', char);
      input.dispatchEvent(insert);
      kept.push(!insert.defaultPrevented);
      // What the browser does with an insertion nobody cancelled.
      input.value += char;
    }
    // The keyboard's edits are left in the field, so its view of the field
    // stays true and its later deletes reach the page.
    expect(kept.every(Boolean)).toBe(true);
    input.dispatchEvent(keydown('Unidentified', 229));
    const remove = beforeinput('deleteContentBackward');
    input.dispatchEvent(remove);
    expect(remove.defaultPrevented).toBe(false);
    input.value = input.value.slice(0, -1);
    // The field the keyboard believes empty: a real Backspace with no code.
    input.dispatchEvent(keydown('Backspace', 8));
    input.dispatchEvent(keydown('Enter', 13));
    await vi.waitFor(() => expect(written(session)).toBe('echo hix\x7f\x7f\r'));
    // The line went; the next one starts from an empty field.
    expect(input.value).toBe('');
    controller.dispose();
  });

  it('sends Tab and arrows that name no code', async () => {
    const { controller, session } = await startController();
    const input = document.querySelector('textarea')!;
    input.dispatchEvent(keydown('Tab', 9));
    input.dispatchEvent(keydown('ArrowUp', 38));
    await vi.waitFor(() => expect(written(session)).toBe('\t\x1b[A'));
    controller.dispose();
  });
});

describe('output credit to the engine worker (#3994)', () => {
  async function controllerWith(
    createWorker: () => EnginePort,
    session: TerminalViewSession,
  ) {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => DOMRect.fromRect(rect);
    const canvas = document.createElement('canvas');
    const input = document.createElement('textarea');
    root.append(canvas, input);
    document.body.append(root);
    const controller = new TerminalController(
      { root, canvas, input },
      {
        font: { family: 'monospace', size: 13, lineHeight: 1.2 },
        screenReader: false,
        reducedMotion: true,
        createWorker,
        createRenderer: () => new FakeRenderer(),
        measureCell,
      },
    );
    controller.setSession(session);
    await controller.start();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().status).toBe('ready'),
    );
    return controller;
  }

  it('settles a view’s output only after its worker parsed it', async () => {
    // The real engine, with its `written` answers held back.
    const held: MessageEvent[] = [];
    let release = () => {};
    const createWorker = () => {
      const port = inThreadPort();
      let deliver: EnginePort['onmessage'] = null;
      Object.defineProperty(port, 'onmessage', {
        get: () => deliver,
        set: (next: EnginePort['onmessage']) => {
          release = () => {
            for (const event of held.splice(0)) next?.(event);
          };
          deliver = (event: MessageEvent) => {
            if ((event.data as { type?: string }).type === 'written')
              held.push(event);
            else next?.(event);
          };
        },
      });
      return port;
    };
    const { session, output } = fakeSession();
    const controller = await controllerWith(createWorker, session);
    let settled = false;
    const consumed = output('parsed later') as unknown;
    expect(consumed).toBeInstanceOf(Promise);
    void (consumed as Promise<void>).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await vi.waitFor(() => expect(settled).toBe(true));
    controller.dispose();
  });

  it('bounds output posted to a worker that never parses it, and replays instead of dropping it', async () => {
    let postedBytes = 0;
    let resets = 0;
    const stalled = (): EnginePort => {
      const port: EnginePort = {
        onmessage: null,
        onerror: null,
        postMessage: (message) => {
          const request = message as { type: string; bytes?: Uint8Array };
          if (request.type === 'init')
            queueMicrotask(() =>
              port.onmessage?.(
                new MessageEvent('message', { data: { type: 'ready' } }),
              ),
            );
          if (request.type === 'write')
            postedBytes += request.bytes?.byteLength ?? 0;
          if (request.type === 'reset') resets++;
        },
        terminate: () => undefined,
      };
      return port;
    };
    // A session that ignores the view's credit and floods it.
    let subscriptions = 0;
    let listener: TerminalViewSessionListener | null = null;
    const session = {
      state: 'ready' as const,
      readOnly: false,
      subscribe(next: TerminalViewSessionListener) {
        subscriptions++;
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
      write: () => true,
      resize: () => undefined,
    } satisfies TerminalViewSession;
    const controller = await controllerWith(stalled, session);
    const chunk = new Uint8Array(2048).fill(0x61);
    for (let i = 0; i < 8192; i++)
      (listener as TerminalViewSessionListener | null)?.output(chunk, 'live');
    // 16 MiB offered; the worker was never given more than its bound.
    expect(postedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    await vi.waitFor(() => expect(controller.resyncs).toBeGreaterThan(0));
    // Recovery: the screen starts over and the session replays into it.
    expect(resets).toBeGreaterThan(0);
    expect(subscriptions).toBeGreaterThan(1);
    controller.dispose();
  });
});
