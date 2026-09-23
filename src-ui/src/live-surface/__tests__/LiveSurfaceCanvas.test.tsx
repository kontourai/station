// @vitest-environment jsdom

/**
 * #90: the live-surface canvas against a synthetic record stream.
 *
 * Interactions use `fireEvent` with the real DOM event types a user produces
 * (pointerdown/up, keydown/keyup, input): this repository does not ship
 * `@testing-library/user-event` (see deviceWorkspacePaneHarness.tsx). IME
 * composition is a named domain-event seam — no user-event API drives an IME
 * either — dispatched as the compositionstart/compositionend pair a browser
 * emits.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceControlLease,
  type LiveSurfaceRecord,
} from '@kontourai/station-contracts/live-surface';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LiveSurfaceCanvas } from '../LiveSurfaceCanvas';

const SURFACE = 'browser:session-1';
const API = 'http://station.test';
const FRAMES_URL = `${API}/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;
const INPUT_URL = `${API}/api/live-surfaces/${encodeURIComponent(SURFACE)}/input`;

function lease(
  epoch: number,
  holder: LiveSurfaceControlLease['holder'] = null,
): LiveSurfaceControlLease {
  return { surfaceId: SURFACE, epoch, holder, expiresAt: holder ? 9e12 : null };
}

/** Who the server tells this client it is. */
const ME = { principal: 'human:local:me', device: 'device:mine' } as const;
const MY_HOLD = { kind: 'human', ...ME } as const;

function stateRecord(l: LiveSurfaceControlLease): LiveSurfaceRecord {
  return {
    kind: 'state',
    state: {
      surfaceId: SURFACE,
      lease: l,
      effectiveParams: {
        maxFps: 10,
        quality: 70,
        maxWidth: 1280,
        maxHeight: 1280,
      },
      viewer: { ...ME },
    },
  };
}

function frameRecord(seq: number, epoch: number): LiveSurfaceRecord {
  return {
    kind: 'frame',
    header: {
      surfaceId: SURFACE,
      seq,
      epoch,
      codec: 'png',
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
      capturedAt: 1,
    },
    body: new Uint8Array([seq]),
  };
}

type FrameRecord = Extract<LiveSurfaceRecord, { kind: 'frame' }>;

interface OpenStream {
  push(record: LiveSurfaceRecord): Promise<void>;
  /** Raw bytes, e.g. part of a large frame still in transit. */
  pushBytes(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  signal: AbortSignal | undefined;
}

type InputReply = (body: {
  epoch: number;
  events: unknown[];
}) => unknown | Promise<unknown>;

function harness(
  options: { inputReply?: InputReply; framesStatus?: number } = {},
) {
  const streams: OpenStream[] = [];
  const inputs: { epoch: number; events: unknown[] }[] = [];
  const inputReply: InputReply =
    options.inputReply ??
    ((body) => ({
      success: true,
      data: {
        ok: true,
        accepted: body.events.length,
        lease: lease(body.epoch + 1, MY_HOLD),
      },
    }));
  const transport = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(FRAMES_URL)) {
        if (options.framesStatus) {
          streams.push({
            signal: init?.signal ?? undefined,
            push: async () => {},
            pushBytes: async () => {},
            close: async () => {},
          });
          return Response.json(
            { success: false },
            { status: options.framesStatus },
          );
        }
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('aborted', 'AbortError'));
          } catch {}
        });
        streams.push({
          signal: init?.signal ?? undefined,
          push: async (record) => {
            await act(async () => {
              controller.enqueue(encodeLiveSurfaceRecord(record));
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
          pushBytes: async (bytes) => {
            await act(async () => {
              controller.enqueue(bytes);
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
          close: async () => {
            await act(async () => {
              controller.close();
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (url === INPUT_URL) {
        const body = JSON.parse(String(init?.body));
        inputs.push(body);
        return Response.json(await inputReply(body));
      }
      return Response.json({ success: false }, { status: 500 });
    },
  );
  return { transport, streams, inputs };
}

/** jsdom lays nothing out: give the canvas the box a browser would. */
function layoutCanvas(box: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'getBoundingClientRect',
  ).mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  });
}

const drawImage = vi.fn();
let intersectionCallback: IntersectionObserverCallback | null = null;

beforeEach(() => {
  drawImage.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close() {} })),
  );
  intersectionCallback = null;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderLive(
  h: ReturnType<typeof harness>,
  initial = lease(0),
  now?: () => number,
) {
  render(
    <LiveSurfaceCanvas
      apiBase={API}
      surfaceId={SURFACE}
      label="Browser: example.com"
      transport={h.transport as never}
      {...(now ? { now } : {})}
    />,
  );
  await flush();
  const stream = h.streams.at(-1)!;
  await stream.push(stateRecord(initial));
  await stream.push(frameRecord(1, initial.epoch));
  return stream;
}

describe('LiveSurfaceCanvas', () => {
  test('draws each frame to a canvas sized to the frame', async () => {
    const h = harness();
    await renderLive(h);
    const canvas = screen.getByTestId(
      'live-surface-canvas',
    ) as HTMLCanvasElement;
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(800);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  test('a click maps through letterboxing and the frame DPR, and is forwarded as input', async () => {
    const h = harness();
    await renderLive(h);
    // 1000x400 box: the 1280x800 frame draws at 640x400 with 180 px bars.
    layoutCanvas({ left: 0, top: 0, width: 1000, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 500,
      clientY: 200,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: 500,
      clientY: 200,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toEqual([
      {
        kind: 'pointer',
        type: 'down',
        x: 320,
        y: 200,
        clickCount: 1,
        button: 'left',
      },
      {
        kind: 'pointer',
        type: 'up',
        x: 320,
        y: 200,
        clickCount: 1,
        button: 'left',
      },
    ]);
    expect(h.inputs[0]?.epoch).toBe(0);
    // A press in the letterbox bar hits nothing.
    fireEvent.pointerDown(canvas, {
      clientX: 50,
      clientY: 200,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toHaveLength(2);
  });

  test('the controller indicator compares the holder with the identity the server gave this client (S9)', async () => {
    const h = harness();
    const stream = await renderLive(
      h,
      lease(3, { kind: 'agent', principal: 'agent:coder', sessionId: 's' }),
    );
    expect(
      screen.getByText(
        'An agent is in control. Interacting takes control from it.',
      ),
    ).toBeTruthy();
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs[0]?.epoch).toBe(3);
    expect(screen.getByText('You are in control.')).toBeTruthy();
    // The same person on another device holds it: not "you".
    await stream.push(
      stateRecord(lease(4, { ...MY_HOLD, device: 'device:tablet' })),
    );
    expect(
      screen.getByText(
        'You are in control from another device. Interacting here takes control.',
      ),
    ).toBeTruthy();
    // Someone else takes over: the stream publishes it.
    await stream.push(
      stateRecord(
        lease(5, {
          kind: 'human',
          principal: 'human:local:other',
          device: 'device:x',
        }),
      ),
    );
    expect(
      screen.getByText(
        'Another person is in control. Interacting takes control.',
      ),
    ).toBeTruthy();
  });

  test('a frame older than the last state record never walks the input epoch back (B1)', async () => {
    const h = harness();
    const stream = await renderLive(h, lease(3));
    await stream.push(frameRecord(2, 1));
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.map((batch) => batch.epoch)).toEqual([3]);
  });

  test('a held drag keeps reaching the surface outside the image, clamped to its edge (S4)', async () => {
    const h = harness();
    await renderLive(h);
    // 1000x400 box: the image spans x 180..820 (surface 0..640).
    layoutCanvas({ left: 0, top: 0, width: 1000, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    // Not held: a move in the letterbox is dropped.
    fireEvent.pointerMove(canvas, { clientX: 900, clientY: 200, pointerId: 1 });
    fireEvent.pointerDown(canvas, {
      clientX: 500,
      clientY: 200,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(canvas, { clientX: 950, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(canvas, {
      clientX: 990,
      clientY: 500,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toEqual([
      {
        kind: 'pointer',
        type: 'down',
        x: 320,
        y: 200,
        clickCount: 1,
        button: 'left',
      },
      { kind: 'pointer', type: 'move', x: 640, y: 200 },
      {
        kind: 'pointer',
        type: 'up',
        x: 640,
        y: 400,
        clickCount: 1,
        button: 'left',
      },
    ]);
  });

  test('a cancelled gesture releases the held button at the last point', async () => {
    const h = harness();
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerCancel(canvas, { pointerId: 1 });
    // Losing capture afterwards has nothing left to release.
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toEqual([
      {
        kind: 'pointer',
        type: 'down',
        x: 10,
        y: 20,
        clickCount: 1,
        button: 'left',
      },
      {
        kind: 'pointer',
        type: 'up',
        x: 10,
        y: 20,
        button: 'left',
        clickCount: 1,
      },
    ]);
  });

  test('keys, text and IME composition reach the surface from the focusable keyboard target', async () => {
    const h = harness();
    await renderLive(h);
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    expect(keyboard.tabIndex).toBe(0);
    keyboard.focus();
    expect(document.activeElement).toBe(keyboard);
    fireEvent.keyDown(keyboard, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(keyboard, { key: 'Enter', code: 'Enter' });
    // A printable key is delivered as text by the input event, not as a key.
    fireEvent.keyDown(keyboard, { key: 'h', code: 'KeyH' });
    fireEvent.input(keyboard, { target: { value: 'h' } });
    fireEvent.keyUp(keyboard, { key: 'h', code: 'KeyH' });
    // Ctrl+A is a shortcut, so it goes as a key with its modifier.
    fireEvent.keyDown(keyboard, { key: 'a', code: 'KeyA', ctrlKey: true });
    // IME: nothing is sent mid-composition; the committed text is.
    fireEvent.compositionStart(keyboard);
    fireEvent.input(keyboard, { target: { value: 'にほ' } });
    fireEvent.compositionEnd(keyboard, { data: '日本' });
    // Tab is left to the host page so focus can leave the surface.
    fireEvent.keyDown(keyboard, { key: 'Tab', code: 'Tab' });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toEqual([
      { kind: 'key', type: 'down', key: 'Enter', code: 'Enter' },
      { kind: 'key', type: 'up', key: 'Enter', code: 'Enter' },
      { kind: 'text', text: 'h' },
      {
        kind: 'key',
        type: 'down',
        key: 'a',
        code: 'KeyA',
        modifiers: { ctrl: true },
      },
      { kind: 'text', text: '日本' },
    ]);
  });

  test('suspends the stream while the pane is out of view and resumes when it returns', async () => {
    const h = harness();
    const first = await renderLive(h);
    expect(h.streams).toHaveLength(1);
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(first.signal?.aborted).toBe(true);
    expect(screen.getByText('Paused while this pane is hidden.')).toBeTruthy();
    await flush();
    expect(h.streams).toHaveLength(1);
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await flush();
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]?.signal?.aborted).toBe(false);
  });

  test('suspends while the document is hidden', async () => {
    const h = harness();
    const first = await renderLive(h);
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(first.signal?.aborted).toBe(true);
    expect(screen.getByText('Paused while this pane is hidden.')).toBeTruthy();
    visibility.mockRestore();
  });

  test('a dropped stream says it is reconnecting and reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = harness();
      const stream = await renderLive(h);
      await stream.close();
      expect(screen.getByText(/^Reconnecting…/)).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      await flush();
      expect(h.streams).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('stale-epoch drops queued input instead of replaying it, and swallows the orphaned release (H1, S4)', async () => {
    let resolveFirst!: () => void;
    const firstReply = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const h = harness({
      inputReply: async (body) => {
        if (h.inputs.length === 1) await firstReply;
        return {
          success: false,
          data: {
            ok: false,
            code: 'stale-epoch',
            accepted: 0,
            lease: lease(body.epoch + 1, {
              kind: 'agent',
              principal: 'agent:coder',
              sessionId: 's',
            }),
          },
        };
      },
    });
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush(); // the down is in flight
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 10, pointerId: 1 });
    await flush(); // queued behind it
    expect(h.inputs).toHaveLength(1);
    await act(async () => {
      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    // Refused, so the queued move is dropped, not sent at the new epoch.
    expect(h.inputs.map((batch) => batch.epoch)).toEqual([0]);
    // The server released the button at the handoff; this client's own
    // release would be fresh input that retakes control, so it is swallowed.
    fireEvent.pointerUp(canvas, {
      clientX: 20,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs).toHaveLength(1);
    // A deliberate new press does go, at the epoch the refusal taught it.
    fireEvent.pointerDown(canvas, {
      clientX: 30,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.map((batch) => batch.epoch)).toEqual([0, 1]);
  });

  test('an auto-repeated key after a stale-epoch refusal gets its release sent (D4)', async () => {
    const h = harness({
      inputReply: (body) =>
        h.inputs.length === 1
          ? {
              success: false,
              data: {
                ok: false,
                code: 'stale-epoch',
                accepted: 0,
                lease: lease(body.epoch + 1, {
                  kind: 'agent',
                  principal: 'agent:coder',
                  sessionId: 's',
                }),
              },
            }
          : {
              success: true,
              data: {
                ok: true,
                accepted: body.events.length,
                lease: lease(body.epoch + 1, MY_HOLD),
              },
            },
    });
    await renderLive(h);
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    fireEvent.keyDown(keyboard, { key: 'Enter', code: 'Enter' });
    await flush(); // refused: Enter is now an orphan the server cancelled
    // The key is still held, so the OS auto-repeats it: fresh input.
    fireEvent.keyDown(keyboard, { key: 'Enter', code: 'Enter', repeat: true });
    await flush();
    fireEvent.keyUp(keyboard, { key: 'Enter', code: 'Enter' });
    await flush();
    expect(
      h.inputs.map((batch) =>
        batch.events.map((event) => (event as { type: string }).type),
      ),
    ).toEqual([['down'], ['down'], ['up']]);
  });

  test('a wedged surface says the page is not responding, and clears when it recovers (W1a)', async () => {
    const h = harness();
    const stream = await renderLive(h);
    const notice =
      'The page is not responding to input (it may be showing a dialog).';
    expect(screen.queryByText(notice)).toBeNull();
    const wedged = stateRecord(lease(0));
    if (wedged.kind === 'state') {
      wedged.state.wedged = true;
      wedged.state.wedgedSince = 5;
    }
    await stream.push(wedged);
    expect(screen.getByText(notice)).toBeTruthy();
    await stream.push(stateRecord(lease(0)));
    expect(screen.queryByText(notice)).toBeNull();
  });

  test('a stale-fence refusal is a control change too: dropped, noticed, and its release swallowed (F1)', async () => {
    const h = harness({
      inputReply: (body) => ({
        success: false,
        data: {
          ok: false,
          code: 'stale-fence',
          accepted: 0,
          lease: lease(body.epoch + 1, {
            kind: 'agent',
            principal: 'agent:coder',
            sessionId: 's',
          }),
        },
      }),
    });
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(
      screen.getByText(
        'Control changed before your input arrived, so it was not sent.',
      ),
    ).toBeTruthy();
    // The server cancelled the press at the handoff: this release would be
    // fresh input that takes control back, so it is not sent.
    fireEvent.pointerUp(canvas, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs).toHaveLength(1);
  });

  test('losing focus releases held keys and buttons while this client holds control', async () => {
    const h = harness();
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    await flush(); // this client now holds control (the reply says so)
    fireEvent.keyDown(keyboard, { key: 'Shift', code: 'ShiftLeft' });
    await flush();
    fireEvent.blur(keyboard);
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events).slice(2)).toEqual([
      {
        kind: 'pointer',
        type: 'up',
        x: 10,
        y: 20,
        button: 'left',
        clickCount: 1,
      },
      { kind: 'key', type: 'up', key: 'Shift', code: 'ShiftLeft' },
    ]);
  });

  test('hiding the page releases held input; a client that lost control sends nothing', async () => {
    const h = harness();
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    await flush();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toHaveLength(2);
    expect(h.inputs[1]?.events[0]).toMatchObject({
      type: 'up',
      button: 'left',
    });
    visibility.mockRestore();
    // Visible again: the stream resumes on a new connection.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    const resumed = h.streams.at(-1)!;
    await resumed.push(frameRecord(2, 1));
    // Press again (this client holds control), then another person takes
    // over: a later page hide has nothing to send — the server cancelled
    // this client's press at that handoff.
    fireEvent.pointerDown(canvas, {
      clientX: 10,
      clientY: 20,
      button: 2,
      pointerId: 2,
    });
    await flush();
    await resumed.push(
      stateRecord(
        lease(9, {
          kind: 'human',
          principal: 'human:local:other',
          device: 'device:x',
        }),
      ),
    );
    const before = h.inputs.length;
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    expect(h.inputs.length).toBe(before);
  });

  test('pagehide releases a held button while this client holds control', async () => {
    const h = harness();
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    expect(h.inputs[1]?.events).toEqual([
      {
        kind: 'pointer',
        type: 'up',
        x: 10,
        y: 20,
        button: 'left',
        clickCount: 1,
      },
    ]);
  });

  // Responsive-action-surface inventory evidence. jsdom computes no layout,
  // so this does NOT measure 44px: it checks the link the inventory entry
  // claims — the toolbar's buttons are DIRECT children of an `__actions` row,
  // and index.css's shared mobile floor selects exactly that and declares the
  // 44px minimums (the same derivation WorkspacePaneAvailabilityList uses).
  test('toolbar actions sit directly inside the row the shared mobile 44px floor selects', async () => {
    const h = harness();
    await renderLive(h);
    const take = screen.getByRole('button', { name: 'Take control' });
    const row = take.parentElement!;
    expect(row.className).toContain('__actions');
    for (const button of Array.from(row.querySelectorAll('button')))
      expect(button.parentElement).toBe(row);

    const indexCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../index.css'),
      'utf8',
    );
    const mobileBlock = indexCss.slice(
      indexCss.indexOf(
        '@media (max-width: 768px), (max-height: 540px) and (pointer: coarse)',
      ),
    );
    const COMBINATOR = '> :is(button, a, .button, [role="button"])';
    const floors: { selectors: string; body: string }[] = [];
    for (let at = mobileBlock.indexOf(COMBINATOR); at > -1; ) {
      floors.push({
        selectors: mobileBlock.slice(Math.max(0, at - 400), at),
        body: mobileBlock.slice(at, mobileBlock.indexOf('\n  }', at)),
      });
      at = mobileBlock.indexOf(COMBINATOR, at + 1);
    }
    const shared = floors.find((rule) =>
      rule.selectors.includes('[class*="__actions"]'),
    );
    expect(shared, 'no shared __actions touch-floor rule').toBeDefined();
    expect(shared?.body).toContain('min-height: 44px');
    expect(shared?.body).toContain('min-width: 44px');
  });

  test('a 404 is a terminal "not available" state with no reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = harness({ framesStatus: 404 });
      render(
        <LiveSurfaceCanvas
          apiBase={API}
          surfaceId={SURFACE}
          label="Browser: example.com"
          transport={h.transport as never}
        />,
      );
      await flush();
      expect(screen.getByText('This surface is not available.')).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await flush();
      expect(h.streams).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([401, 403])(
    'a %s is a terminal "denied" state with no reconnect',
    async (status) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const h = harness({ framesStatus: status });
        render(
          <LiveSurfaceCanvas
            apiBase={API}
            surfaceId={SURFACE}
            label="Browser: example.com"
            transport={h.transport as never}
          />,
        );
        await flush();
        expect(
          screen.getByText('You do not have permission to view this surface.'),
        ).toBeTruthy();
        await act(async () => {
          vi.advanceTimersByTime(60_000);
        });
        await flush();
        expect(h.streams).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('silence past two heartbeats reads as stalled; a large frame still arriving does not (N5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const clock = { t: 1_000_000 };
      const h = harness();
      const stream = await renderLive(h, lease(0), () => clock.t);
      const tick = async (ms: number) => {
        clock.t += ms;
        await act(async () => {
          vi.advanceTimersByTime(ms);
        });
      };
      await tick(11_000);
      expect(screen.queryByText(/stalled/)).toBeNull();
      // A large frame arrives slowly: bytes keep coming, no record completes.
      const big = encodeLiveSurfaceRecord({
        kind: 'frame',
        header: { ...(frameRecord(2, 0) as FrameRecord).header },
        body: new Uint8Array(64 * 1024),
      });
      for (let offset = 0; offset < 48 * 1024; offset += 16 * 1024) {
        await stream.pushBytes(big.subarray(offset, offset + 16 * 1024));
        await tick(6_000);
      }
      expect(screen.queryByText(/stalled/)).toBeNull();
      // Then nothing at all for 13 s: that is a stall.
      await tick(13_000);
      expect(screen.getByText(/^The stream has stalled\./)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('input refused as stale-epoch is dropped and says so', async () => {
    const h = harness({
      inputReply: (body) => ({
        success: false,
        data: {
          ok: false,
          code: 'stale-epoch',
          accepted: 0,
          lease: lease(body.epoch + 1, {
            kind: 'agent',
            principal: 'agent:coder',
            sessionId: 's',
          }),
        },
      }),
    });
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(
      screen.getByText(
        'Control changed before your input arrived, so it was not sent.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'An agent is in control. Interacting takes control from it.',
      ),
    ).toBeTruthy();
  });
});
