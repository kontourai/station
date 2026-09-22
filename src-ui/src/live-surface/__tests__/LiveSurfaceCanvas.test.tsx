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

interface OpenStream {
  push(record: LiveSurfaceRecord): Promise<void>;
  close(): Promise<void>;
  signal: AbortSignal | undefined;
}

type InputReply = (body: { epoch: number; events: unknown[] }) => unknown;

function harness(options: { inputReply?: InputReply } = {}) {
  const streams: OpenStream[] = [];
  const inputs: { epoch: number; events: unknown[] }[] = [];
  const inputReply: InputReply =
    options.inputReply ??
    ((body) => ({
      success: true,
      data: {
        ok: true,
        accepted: body.events.length,
        lease: lease(body.epoch + 1, {
          kind: 'human',
          principal: 'human:local:me',
        }),
      },
    }));
  const transport = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(FRAMES_URL)) {
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
        return Response.json(inputReply(body));
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

async function renderLive(h: ReturnType<typeof harness>, initial = lease(0)) {
  render(
    <LiveSurfaceCanvas
      apiBase={API}
      surfaceId={SURFACE}
      label="Browser: example.com"
      transport={h.transport as never}
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

  test('the controller indicator follows the published lease and our own claim', async () => {
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
    // Someone else takes over: the stream publishes it.
    await stream.push(
      stateRecord(lease(5, { kind: 'human', principal: 'human:local:other' })),
    );
    expect(
      screen.getByText(
        'Another person is in control. Interacting takes control.',
      ),
    ).toBeTruthy();
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
