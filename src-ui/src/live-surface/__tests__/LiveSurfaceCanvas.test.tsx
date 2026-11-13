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
import { resolve } from 'node:path';
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
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sharedActionsTouchFloor } from '../../__tests__/helpers/shared-touch-floor';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { AgentActionOverlay } from '../AgentActionOverlay';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControlState,
} from '../LiveSurfaceCanvas';
import { liveSurfaceH264Declines } from '../useLiveSurface';
import { inputSourceFixture } from './fixtures/inputSourceFixture';

const SURFACE = 'browser:session-1';
const API = 'http://127.0.0.1:3999';
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

/** The viewer's root, which carries its diagnostics attributes. */
function liveSurfaceRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.live-surface');
  if (!root) throw new Error('live surface not rendered');
  return root;
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
  url: string;
}

type InputReply = (body: {
  epoch: number;
  events: unknown[];
}) => unknown | Promise<unknown>;

function harness(
  options: {
    inputReply?: InputReply;
    framesStatus?: number | ((url: string) => number | undefined);
    framesBody?: unknown;
  } = {},
) {
  const streams: OpenStream[] = [];
  const inputs: { epoch: number; events: unknown[] }[] = [];
  const sources = inputSourceFixture();
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
        const framesStatus =
          typeof options.framesStatus === 'function'
            ? options.framesStatus(url)
            : options.framesStatus;
        if (framesStatus) {
          streams.push({
            url,
            signal: init?.signal ?? undefined,
            push: async () => {},
            pushBytes: async () => {},
            close: async () => {},
          });
          return Response.json(options.framesBody ?? { success: false }, {
            status: framesStatus,
          });
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
          url,
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
      if (url === INPUT_URL.replace(/\/input$/, '/lease')) {
        const response = sources.leaseReply(JSON.parse(String(init?.body)));
        if (response) return response;
      }
      if (url === INPUT_URL) {
        const body = JSON.parse(String(init?.body));
        if (!sources.accepts(body.sourceId))
          return Response.json({ success: false }, { status: 409 });
        inputs.push(body);
        const reply = await inputReply(body);
        return reply instanceof Response ? reply : Response.json(reply);
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
  liveSurfaceH264Declines.clear();
  cleanup();
  vi.useRealTimers();
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
  test('reports displayed dimensions when a frame rotates', async () => {
    const h = harness();
    const onFrameSize = vi.fn();
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Device"
        transport={h.transport as never}
        onFrameSize={onFrameSize}
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(frameRecord(1, 0));
    expect(onFrameSize).toHaveBeenLastCalledWith({ width: 1280, height: 800 });
    const frame = frameRecord(2, 0) as FrameRecord;
    await stream.push({ ...frame, header: { ...frame.header, rotation: 90 } });
    expect(onFrameSize).toHaveBeenLastCalledWith({ width: 800, height: 1280 });
  });
  test('agent geometry is placed against the shown viewport, including letterboxing', async () => {
    const h = harness();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('live-surface__stage')
          ? new DOMRect(0, 0, 1000, 400)
          : new DOMRect(0, 0, 1000, 400);
      },
    );
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={h.transport as never}
        agentActionsEnabled
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(frameRecord(1, 0));
    const state = stateRecord(lease(0));
    if (state.kind !== 'state') throw new Error('expected state');
    await stream.push({
      kind: 'state',
      state: {
        ...state.state,
        agentActions: {
          now: 1000,
          events: [
            {
              seq: 1,
              at: 1000,
              generation: 1,
              kind: 'click',
              point: { x: 500, y: 300 },
              box: { x: 300, y: 175, width: 200, height: 125 },
              viewport: { x: 100, y: 50, width: 800, height: 500 },
            },
          ],
        },
      },
    });
    const overlay = screen.getByTestId('agent-action-overlay');
    expect(overlay.style.width).toBe('640px');
    expect(overlay.style.height).toBe('400px');
    expect(screen.getByTestId('agent-cursor').style.left).toBe('50%');
    expect(screen.getByTestId('agent-cursor').style.top).toBe('50%');
    expect(screen.getByTestId('agent-target').style.width).toBe('25%');
  });
  test('the agent cursor fades after its 700 ms display window', () => {
    vi.useFakeTimers();
    const action = {
      seq: 1,
      at: 1000,
      generation: 1,
      kind: 'click' as const,
      point: { x: 50, y: 50 },
      box: { x: 40, y: 40, width: 20, height: 20 },
      viewport: { x: 0, y: 0, width: 100, height: 100 },
    };
    const { container } = render(
      <AgentActionOverlay action={action} expiresAt={1700} now={() => 1000} />,
    );
    const overlay = container.querySelector('.live-surface__agent-action');
    expect(overlay?.getAttribute('data-visible')).toBe('true');
    act(() => vi.advanceTimersByTime(700));
    expect(overlay?.getAttribute('data-visible')).toBe('false');
  });
  test('page keyboard focus does not dispatch a Station shortcut', async () => {
    const h = harness();
    const action = vi.fn();
    function Shortcut() {
      useKeyboardShortcut(
        'test.page-isolation',
        'j',
        ['cmd'],
        'Test action',
        action,
      );
      return null;
    }
    render(
      <KeyboardShortcutsProvider>
        <Shortcut />
        <LiveSurfaceCanvas
          apiBase={API}
          surfaceId={SURFACE}
          label="Browser: example.com"
          transport={h.transport as never}
        />
      </KeyboardShortcutsProvider>,
    );
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    fireEvent.keyDown(keyboard, { key: 'j', ctrlKey: true, bubbles: true });
    fireEvent.keyDown(keyboard, { key: 'j', metaKey: true, bubbles: true });
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, {
      key: 'j',
      ctrlKey: true,
      bubbles: true,
    });
    fireEvent.keyDown(document.body, {
      key: 'j',
      metaKey: true,
      bubbles: true,
    });
    expect(action).toHaveBeenCalledTimes(1);
  });
  test('measures the fitted stage before its first layout commit finishes', () => {
    const h = harness();
    let measured = false;
    const measuredAtCommit: boolean[] = [];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('live-surface__stage')) measured = true;
        return new DOMRect(0, 0, 640, 360);
      },
    );
    const mounted = render(
      <Profiler id="fit" onRender={() => measuredAtCommit.push(measured)}>
        <LiveSurfaceCanvas
          apiBase={API}
          surfaceId={SURFACE}
          label="Fitted device"
          transport={h.transport as never}
          fit={{ aspect: 2 }}
        />
      </Profiler>,
    );
    expect(measuredAtCommit[0]).toBe(true);
    const canvas = screen.getByTestId('live-surface-canvas');
    expect(canvas.style.width).toBe('640px');
    expect(canvas.style.height).toBe('320px');
    mounted.unmount();
  });

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

  test('a frame whose picture cannot be decoded here still sets the frame geometry', async () => {
    // Overlays (the Device accessibility outline) and input wait on the
    // frame size, which must not hang on this browser decoding the picture.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 640, 400),
    );
    for (const decode of [
      undefined,
      vi.fn(async () => Promise.reject(new Error('no'))),
    ]) {
      vi.stubGlobal('createImageBitmap', decode);
      const h = harness();
      const overlay = vi.fn(
        (geometry: { shown: { width: number; height: number } }) => (
          <span data-testid="overlay-shown">
            {`${geometry.shown.width}x${geometry.shown.height}`}
          </span>
        ),
      );
      const view = render(
        <LiveSurfaceCanvas
          apiBase={API}
          surfaceId={SURFACE}
          label="Browser: example.com"
          transport={h.transport as never}
          fit={{ aspect: 1 }}
          renderOverlay={overlay}
        />,
      );
      await flush();
      await h.streams.at(-1)!.push(stateRecord(lease(0)));
      await h.streams.at(-1)!.push(frameRecord(1, 0));
      const canvas = screen.getByTestId(
        'live-surface-canvas',
      ) as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([1280, 800]);
      expect(screen.getByTestId('live-surface-overlay')).toBeTruthy();
      expect(overlay).toHaveBeenLastCalledWith(
        expect.objectContaining({ shown: { width: 1280, height: 800 } }),
      );
      expect(screen.getByTestId('overlay-shown').textContent).toBe('1280x800');
      expect(drawImage).not.toHaveBeenCalled();
      view.unmount();
    }
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
        'An agent is in control. Click or type to take control from it.',
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
        'You are in control from another device. Click or type here to take control.',
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
        'Another person is in control. Click or type to take control.',
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

  const UNKNOWN_DELIVERY =
    'Your last input may not have reached the page. Check it.';

  test('a producer failure of any kind (dispatch-failed) says the input may not have reached the page', async () => {
    // #2442: an SSH-host rotation that timed out (tool-timeout) or hit the
    // producer's own deadline (dispatch-timeout) both arrive as this code.
    const h = harness({
      inputReply: (body) => ({
        success: true,
        data: {
          ok: false,
          code: 'dispatch-failed',
          accepted: 0,
          lease: lease(body.epoch, MY_HOLD),
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
    expect(screen.getByText(UNKNOWN_DELIVERY)).toBeTruthy();
  });

  test('an event that took effect before its error is never sent again: no Retry, no replay (PAY must not become PAYPAY)', async () => {
    // The host typed P, A and Y, then the producer reported a failure on
    // the last one: `accepted` counts only completed dispatches, so the
    // client cannot know Y did not land.
    const applied: string[] = [];
    let call = 0;
    const h = harness({
      inputReply: (body) => {
        call += 1;
        for (const event of body.events as { kind: string; text?: string }[])
          if (event.kind === 'text') applied.push(event.text ?? '');
        return {
          success: true,
          data:
            call === 1
              ? {
                  ok: false,
                  code: 'dispatch-failed',
                  accepted: 0,
                  lease: lease(body.epoch, MY_HOLD),
                }
              : {
                  ok: true,
                  accepted: body.events.length,
                  lease: lease(body.epoch, MY_HOLD),
                },
        };
      },
    });
    await renderLive(h);
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    fireEvent.input(keyboard, { target: { value: 'PAY' } });
    await flush();
    expect(applied.join('')).toBe('PAY');
    expect(screen.getByRole('alert').textContent).toContain(UNKNOWN_DELIVERY);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // Later input goes out alone, with nothing replayed ahead of it.
    fireEvent.input(keyboard, { target: { value: '!' } });
    await flush();
    expect(applied.join('')).toBe('PAY!');
  });

  test('a lost response offers no Retry and replays nothing', async () => {
    let call = 0;
    const h = harness({
      inputReply: (body) => {
        call += 1;
        if (call === 1) throw new TypeError('network connection was lost');
        return {
          success: true,
          data: {
            ok: true,
            accepted: body.events.length,
            lease: lease(body.epoch, MY_HOLD),
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
    await flush();
    expect(screen.getByText(UNKNOWN_DELIVERY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.pointerUp(canvas, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.map((batch) => batch.events.length)).toEqual([1, 1]);
    expect(h.inputs[1]!.events).toEqual([
      expect.objectContaining({ kind: 'pointer', type: 'up' }),
    ]);
  });

  test('a failure that later input gets past clears without Retry', async () => {
    let call = 0;
    const h = harness({
      inputReply: (body) => {
        call += 1;
        return {
          success: true,
          data:
            call === 1
              ? {
                  ok: false,
                  code: 'dispatch-failed',
                  accepted: 0,
                  lease: lease(body.epoch, MY_HOLD),
                }
              : {
                  ok: true,
                  accepted: body.events.length,
                  lease: lease(body.epoch, MY_HOLD),
                },
        };
      },
    });
    await renderLive(h);
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    const press = () =>
      fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
        clientX: 10,
        clientY: 10,
        button: 0,
        pointerId: 1,
      });
    press();
    await flush();
    expect(screen.getByText(UNKNOWN_DELIVERY)).toBeTruthy();
    press();
    await flush();
    expect(h.inputs).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
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

    const shared = sharedActionsTouchFloor();
    expect(shared, 'no shared __actions touch-floor rule').toBeDefined();
    expect(shared?.['min-height']).toBe('44px');
    expect(shared?.['min-width']).toBe('44px');
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
        'An agent is in control. Click or type to take control from it.',
      ),
    ).toBeTruthy();
  });
});

/**
 * #2433: an SSH device host too busy to answer who a device is makes the
 * server answer input 503 `surface-busy`. That is a retryable "try again",
 * not a refusal: the viewer says the host is busy, never that the input was
 * refused or undeliverable, and a 403 still reads as undeliverable.
 */
describe('LiveSurfaceCanvas: a busy host is not a refusal (#2433)', () => {
  function pressOnce() {
    layoutCanvas({ left: 0, top: 0, width: 640, height: 400 });
    fireEvent.pointerDown(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
  }

  const busy = () =>
    Response.json({ success: false, code: 'surface-busy' }, { status: 503 });
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  test('input answered 503 surface-busy says the host is busy, and what queued behind it is not replayed', async () => {
    let answer!: (reply: Response) => void;
    const h = harness({
      inputReply: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await renderLive(h);
    pressOnce();
    await flush();
    expect(h.inputs).toHaveLength(1);
    // Queued behind the in-flight batch: a move, and a key press and release.
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerMove(canvas, { clientX: 30, clientY: 30, pointerId: 1 });
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    );
    fireEvent.keyDown(keyboard, { key: 'a', code: 'KeyA' });
    fireEvent.keyUp(keyboard, { key: 'a', code: 'KeyA' });
    await flush();
    answer(busy());
    await flush();
    await wait(700);
    // Dropped with the busy batch: nothing more was sent...
    expect(h.inputs).toHaveLength(1);
    // ...and the next input goes alone, not behind the dropped events.
    pressOnce();
    await flush();
    answer(busy());
    await flush();
    expect(h.inputs).toHaveLength(2);
    expect(h.inputs[1].events).toEqual([
      expect.objectContaining({ kind: 'pointer', type: 'down' }),
    ]);
    expect(
      screen.getByText('The host is busy, so nothing was sent.'),
    ).toBeTruthy();
    expect(screen.queryByText(/may not have reached the page/)).toBeNull();
  });

  test('the busy notice clears by itself when nothing newer answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = harness({ inputReply: () => busy() });
      await renderLive(h);
      pressOnce();
      await flush();
      expect(screen.getByText(/The host is busy/)).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(5_100);
      });
      expect(screen.queryByText(/The host is busy/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the busy notice clears on the next successful send', async () => {
    let call = 0;
    const h = harness({
      inputReply: (body) => {
        call += 1;
        return call === 1
          ? busy()
          : {
              success: true,
              data: {
                ok: true,
                accepted: body.events.length,
                lease: lease(body.epoch + 1, MY_HOLD),
              },
            };
      },
    });
    await renderLive(h);
    pressOnce();
    await flush();
    expect(screen.getByText(/The host is busy/)).toBeTruthy();
    pressOnce();
    await flush();
    expect(h.inputs).toHaveLength(2);
    expect(screen.queryByText(/The host is busy/)).toBeNull();
  });

  /** Busy on the first send, then accepted. */
  function busyOnce() {
    let call = 0;
    return harness({
      inputReply: (body) => {
        call += 1;
        return call === 1
          ? busy()
          : {
              success: true,
              data: {
                ok: true,
                accepted: body.events.length,
                lease: lease(body.epoch, MY_HOLD),
              },
            };
      },
    });
  }

  test('a busy tap keeps its whole gesture: lifting the finger is not sent alone, and Retry sends the tap once', async () => {
    const h = busyOnce();
    await renderLive(h);
    pressOnce();
    await flush();
    expect(screen.getByText(/The host is busy/)).toBeTruthy();
    fireEvent.pointerUp(screen.getByTestId('live-surface-canvas'), {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    await flush();
    // The release joined the kept press instead of going out (and
    // succeeding as a no-op that would clear Retry).
    expect(h.inputs).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(h.inputs).toHaveLength(2);
    expect(
      h.inputs[1]!.events.map((event) => (event as { type: string }).type),
    ).toEqual(['down', 'up']);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText(/The host is busy/)).toBeNull();
  });

  test('kept input is dropped when control changes hands: no Retry onto the newer epoch', async () => {
    const h = busyOnce();
    const stream = await renderLive(h);
    pressOnce();
    await flush();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // An agent took over: the kept press was meant for epoch 0.
    await stream.push(
      stateRecord(
        lease(1, { kind: 'agent', principal: 'agent:coder', sessionId: 's' }),
      ),
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(h.inputs).toHaveLength(1);
  });

  test('Retry is not offered once this viewer may no longer send input', async () => {
    const h = busyOnce();
    const canvas = (readOnly: boolean) => (
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={h.transport as never}
        readOnly={readOnly}
      />
    );
    const view = render(canvas(false));
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(frameRecord(1, 0));
    pressOnce();
    await flush();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    view.rerender(canvas(true));
    await flush();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(h.inputs).toHaveLength(1);
  });

  test('input answered 403 access-denied is still undeliverable, not busy', async () => {
    const h = harness({
      inputReply: () =>
        Response.json(
          { success: false, code: 'access-denied' },
          { status: 403 },
        ),
    });
    await renderLive(h);
    pressOnce();
    await flush();
    expect(
      screen.getByText(
        'Your last input may not have reached the page. Check it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/The host is busy/)).toBeNull();
  });

  test('Take control answered 503 surface-busy says the host is busy', async () => {
    const h = harness();
    const claims: unknown[] = [];
    const transport = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith('/lease')) {
          claims.push(JSON.parse(String(init?.body)));
          return Response.json(
            { success: false, code: 'surface-busy' },
            { status: 503 },
          );
        }
        return h.transport(input, init);
      },
    );
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={transport as never}
        inputRequiresLease
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    const agentHold = {
      kind: 'agent',
      principal: 'agent:x',
      sessionId: 'agent-1',
    } as const;
    await stream.push(stateRecord(lease(4, agentHold)));
    await stream.push(frameRecord(1, 4));
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await flush();
    expect(claims).toEqual([{ action: 'claim' }]);
    expect(
      screen.getByText('The host is busy, so nothing was sent.'),
    ).toBeTruthy();
  });
});

/**
 * #90 D9 (orchestrator decision): any human input the server accepts claims
 * the lease, so what the canvas SENDS decides whether passing over it steals
 * control from an agent. Hover and wheel never claim; a press, a key and
 * text do; with `inputRequiresLease` nothing goes until an explicit claim.
 * Asserted on the input route itself: what reached the server.
 */
describe('LiveSurfaceCanvas: which input may take control', () => {
  const AGENT_HOLD = {
    kind: 'agent',
    principal: 'agent:x',
    sessionId: 'agent-1',
  } as const;

  /** The harness plus a lease route that grants this client control. */
  function claimableHarness() {
    const h = harness();
    const claims: unknown[] = [];
    const base = h.transport;
    const transport = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith('/lease')) {
          const body = JSON.parse(String(init?.body));
          if (body.action !== 'claim') return base(input, init);
          claims.push(body);
          return Response.json({
            success: true,
            data: { ok: true, lease: lease(8, MY_HOLD) },
          });
        }
        return base(input, init);
      },
    );
    return { ...h, transport, claims };
  }

  async function renderWith(
    h: ReturnType<typeof claimableHarness>,
    initial: LiveSurfaceControlLease,
    extra: { inputRequiresLease?: boolean } = {},
  ) {
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={h.transport as never}
        {...extra}
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(initial));
    await stream.push(frameRecord(1, initial.epoch));
    layoutCanvas({ left: 0, top: 0, width: 1280, height: 800 });
    return stream;
  }

  function hoverAndScroll() {
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerMove(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 120, pointerId: 1 });
    fireEvent.wheel(canvas, { clientX: 140, clientY: 120, deltaY: 120 });
  }

  function click() {
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: 100,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: 100,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });
  }

  test('with an agent in control, hovering and scrolling over the surface send nothing', async () => {
    const h = claimableHarness();
    await renderWith(h, lease(4, AGENT_HOLD));
    hoverAndScroll();
    await flush();
    expect(h.inputs).toEqual([]);
    expect(
      screen.getByText(
        'An agent is in control. Click or type to take control from it.',
      ),
    ).toBeTruthy();
  });

  test('a click is the claiming interaction: it goes, at the current epoch', async () => {
    const h = claimableHarness();
    await renderWith(h, lease(4, AGENT_HOLD));
    click();
    await flush();
    expect(h.inputs.map((batch) => batch.epoch)).toEqual([4]);
    expect(
      h.inputs.flatMap((batch) =>
        batch.events.map((event) => (event as { type: string }).type),
      ),
    ).toEqual(['down', 'up']);
  });

  test('once this viewer holds control, hover and wheel reach the surface', async () => {
    const h = claimableHarness();
    await renderWith(h, lease(5, MY_HOLD));
    hoverAndScroll();
    await flush();
    expect(
      h.inputs.flatMap((batch) =>
        batch.events.map((event) => (event as { type: string }).type),
      ),
    ).toEqual(['move', 'wheel']);
  });

  test("releaseControl (the host's hand-back) posts a release at the held epoch and adopts the lease the server answers", async () => {
    const h = harness();
    const bodies: unknown[] = [];
    const transport = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith('/lease')) {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({
            success: true,
            data: { ok: true, lease: lease(9, null) },
          });
        }
        return h.transport(input, init);
      },
    );
    const states: LiveSurfaceControlState[] = [];
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={transport as never}
        hostControls
        onControlState={(state) => states.push(state)}
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(7, MY_HOLD)));
    await stream.push(frameRecord(1, 7));
    await flush();
    expect(states.at(-1)?.tone).toBe('you');
    await states.at(-1)!.releaseControl();
    await flush();
    expect(bodies).toEqual([{ action: 'release', epoch: 7 }]);
    expect(states.at(-1)?.tone).toBe('none');
  });

  test('keepControlAlive posts a keep-alive (never a claim) at the held epoch', async () => {
    const h = harness();
    const bodies: unknown[] = [];
    const transport = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).endsWith('/lease')) {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({
            success: true,
            data: { ok: true, lease: lease(7, MY_HOLD) },
          });
        }
        return h.transport(input, init);
      },
    );
    const states: LiveSurfaceControlState[] = [];
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Browser: example.com"
        transport={transport as never}
        hostControls
        onControlState={(state) => states.push(state)}
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(7, MY_HOLD)));
    await stream.push(frameRecord(1, 7));
    await flush();
    await states.at(-1)!.keepControlAlive();
    expect(bodies).toEqual([{ action: 'keep-alive', epoch: 7 }]);
  });

  test('inputRequiresLease: nothing is sent — not a click, a key or text — until Take control, and the keyboard target is out of the tab order', async () => {
    const h = claimableHarness();
    await renderWith(h, lease(4, AGENT_HOLD), { inputRequiresLease: true });
    const keyboard = screen.getByLabelText(
      'Keyboard input for Browser: example.com',
    ) as HTMLTextAreaElement;
    expect(keyboard.tabIndex).toBe(-1);
    hoverAndScroll();
    click();
    fireEvent.keyDown(keyboard, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(keyboard, { key: 'Enter', code: 'Enter' });
    fireEvent.input(keyboard, { target: { value: 'h' } });
    await flush();
    expect(h.inputs).toEqual([]);
    // The explicit claim.
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await flush();
    expect(h.claims).toEqual([{ action: 'claim' }]);
    expect(keyboard.tabIndex).toBe(0);
    click();
    await flush();
    expect(h.inputs.map((batch) => batch.epoch)).toEqual([8]);
  });
});

describe('LiveSurfaceCanvas: client H.264 (#4418)', () => {
  const sample = new Uint8Array(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../tests/fixtures/live-surface/android-emulator-1080x2400-baseline.h264',
      ),
    ),
  );
  function videoRecord(seq: number, keyframe: boolean): LiveSurfaceRecord {
    return {
      kind: 'frame',
      header: {
        surfaceId: SURFACE,
        seq,
        epoch: 0,
        codec: 'h264',
        keyframe,
        width: 576,
        height: 1280,
        deviceScaleFactor: 1,
        capturedAt: 1,
      },
      body: keyframe ? sample : Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a]),
    };
  }

  /** WebCodecs in a secure context; `supported` decides the profile check. */
  function webCodecs(supported: boolean) {
    const decoded: { type: string; timestamp: number }[] = [];
    const decoders: { init: VideoDecoderInit }[] = [];
    const control = { withholdOutput: false };
    /** Every picture any decoder produced, with its close spy. */
    const pictures: { timestamp: number; close: ReturnType<typeof vi.fn> }[] =
      [];
    const withheld: {
      decoder: { init: VideoDecoderInit };
      timestamp: number;
    }[] = [];
    const output = (decoder: { init: VideoDecoderInit }, timestamp: number) => {
      const picture = { timestamp, close: vi.fn() };
      pictures.push(picture);
      decoder.init.output(picture as unknown as VideoFrame);
    };
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal(
      'EncodedVideoChunk',
      class {
        constructor(init: object) {
          Object.assign(this, init);
        }
      },
    );
    vi.stubGlobal(
      'VideoDecoder',
      class {
        static async isConfigSupported(config: VideoDecoderConfig) {
          return { supported, config };
        }
        state = 'unconfigured';
        constructor(readonly init: VideoDecoderInit) {
          decoders.push(this);
        }
        configure() {
          this.state = 'configured';
        }
        decode(chunk: { type: string; timestamp: number }) {
          decoded.push({ type: chunk.type, timestamp: chunk.timestamp });
          if (control.withholdOutput) {
            withheld.push({ decoder: this, timestamp: chunk.timestamp });
            return;
          }
          // Emit a picture for it, as a real decoder would.
          output(this, chunk.timestamp);
        }
        close() {
          this.state = 'closed';
        }
      },
    );
    return {
      decoded,
      decoders,
      pictures,
      /** Emit what was withheld, as a decoder whose output lags would. */
      releaseWithheld() {
        for (const { decoder, timestamp } of withheld.splice(0))
          output(decoder, timestamp);
      },
      set withholdOutput(value: boolean) {
        control.withholdOutput = value;
      },
    };
  }

  async function mount(h: ReturnType<typeof harness>) {
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Device: emulator"
        transport={h.transport as never}
      />,
    );
    await flush();
  }

  test('a capable page asks for H.264, decodes from the keyframe and says so', async () => {
    const codecs = webCodecs(true);
    const h = harness();
    await mount(h);
    const stream = h.streams.at(-1)!;
    expect(new URL(stream.url).searchParams.get('codec')).toBe('h264');
    await stream.push(stateRecord(lease(0)));
    await stream.push(videoRecord(1, true));
    await stream.push(videoRecord(2, false));
    await flush();
    expect(codecs.decoded).toEqual([
      { type: 'key', timestamp: 1 },
      { type: 'delta', timestamp: 2 },
    ]);
    // Each picture is drawn at the header's size, the box input maps to.
    expect(drawImage).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      0,
      576,
      1280,
    );
    expect(liveSurfaceRoot().dataset.codec).toBe('h264');
    // Diagnostics, never resting copy under the picture.
    expect(screen.queryByText(/H\.?264|JPEG|PNG/i)).toBeNull();
  });

  test('a decode error reconnects for a keyframe; a second inside the window waits for its end', async () => {
    const codecs = webCodecs(true);
    const h = harness();
    await mount(h);
    const first = h.streams.at(-1)!;
    await first.push(stateRecord(lease(0)));
    await first.push(videoRecord(1, true));
    await act(async () => {
      codecs.decoders
        .at(-1)!
        .init.error(new DOMException('bad', 'EncodingError'));
    });
    await flush();
    expect(h.streams).toHaveLength(2);
    expect(first.signal?.aborted).toBe(true);
    const second = h.streams[1]!;
    expect(new URL(second.url).searchParams.get('codec')).toBe('h264');
    await second.push(stateRecord(lease(0)));
    await second.push(videoRecord(2, true));
    await act(async () => {
      codecs.decoders
        .at(-1)!
        .init.error(new DOMException('bad', 'EncodingError'));
    });
    await flush();
    expect(h.streams).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(h.streams).toHaveLength(3);
  }, 10_000);

  test('every decoded picture is closed: painted, after unmount, and from a decoder a reconnect retired', async () => {
    const codecs = webCodecs(true);
    const h = harness();
    const view = render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Device: emulator"
        transport={h.transport as never}
      />,
    );
    await flush();
    let stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(videoRecord(1, true));
    // Painted, then closed.
    expect(codecs.pictures).toHaveLength(1);
    expect(codecs.pictures[0]!.close).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    // A reconnect retires the decoder; its late output is closed unpainted.
    codecs.withholdOutput = true;
    await stream.push(videoRecord(2, false));
    await stream.close();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    codecs.releaseWithheld();
    expect(codecs.pictures[1]!.close).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
    // Unmount closes the decoder; output arriving after that is closed too.
    stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(videoRecord(3, true));
    view.unmount();
    codecs.releaseWithheld();
    expect(codecs.pictures[2]!.close).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  test('publishes adopted JPEG and H.264 frame geometry on the canvas', async () => {
    const codecs = webCodecs(true);
    codecs.withholdOutput = true;
    const h = harness();
    await mount(h);
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    const jpeg = frameRecord(1, 0) as FrameRecord;
    await stream.push({ ...jpeg, header: { ...jpeg.header, codec: 'jpeg' } });
    const canvas = screen.getByTestId('live-surface-canvas');
    expect(canvas.getAttribute('data-surface-width')).toBe('1280');
    expect(canvas.getAttribute('data-surface-height')).toBe('800');
    expect(canvas.getAttribute('data-surface-scale')).toBe('2');
    await stream.push(videoRecord(2, true));
    expect(canvas.getAttribute('data-surface-width')).toBe('576');
    expect(canvas.getAttribute('data-surface-height')).toBe('1280');
    expect(canvas.getAttribute('data-surface-scale')).toBe('1');
    expect(codecs.pictures).toHaveLength(0);
  });

  test('an H.264 frame gives the overlay and input its geometry before any picture is decoded', async () => {
    const codecs = webCodecs(true);
    codecs.withholdOutput = true;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 576, 1280),
    );
    const h = harness();
    const overlay = vi.fn(
      (geometry: { shown: { width: number; height: number } }) => (
        <span data-testid="overlay-shown">
          {`${geometry.shown.width}x${geometry.shown.height}`}
        </span>
      ),
    );
    render(
      <LiveSurfaceCanvas
        apiBase={API}
        surfaceId={SURFACE}
        label="Device: emulator"
        transport={h.transport as never}
        fit={{ aspect: 1 }}
        renderOverlay={overlay}
      />,
    );
    await flush();
    const stream = h.streams.at(-1)!;
    await stream.push(stateRecord(lease(0)));
    await stream.push(videoRecord(1, true));
    // The decoder holds the unit: no picture has come out.
    expect(codecs.pictures).toHaveLength(0);
    expect(drawImage).not.toHaveBeenCalled();
    const canvas = screen.getByTestId(
      'live-surface-canvas',
    ) as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([576, 1280]);
    expect(screen.getByTestId('overlay-shown').textContent).toBe('576x1280');
    // Input maps against that geometry already.
    layoutCanvas({ left: 0, top: 0, width: 576, height: 1280 });
    fireEvent.pointerDown(canvas, {
      clientX: 288,
      clientY: 320,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: 288,
      clientY: 320,
      button: 0,
      pointerId: 1,
    });
    await flush();
    expect(h.inputs.flatMap((batch) => batch.events)).toEqual([
      expect.objectContaining({ type: 'down', x: 288, y: 320 }),
      expect.objectContaining({ type: 'up', x: 288, y: 320 }),
    ]);
  });

  test('a profile the browser refuses reconnects for images', async () => {
    const codecs = webCodecs(false);
    const h = harness();
    await mount(h);
    const first = h.streams.at(-1)!;
    await first.push(stateRecord(lease(0)));
    await first.push(videoRecord(1, true));
    await flush();
    await flush();
    expect(codecs.decoded).toEqual([]);
    expect(first.signal?.aborted).toBe(true);
    expect(h.streams).toHaveLength(2);
    const second = h.streams[1]!;
    expect(new URL(second.url).searchParams.has('codec')).toBe(false);
    await second.push(stateRecord(lease(0)));
    await second.push(frameRecord(2, 0));
    expect(liveSurfaceRoot().dataset.codec).toBe('png');
  });

  test('a host too old for ?codec= (400 invalid-request) is asked once more, for images, and no more', async () => {
    webCodecs(true);
    const h = harness({
      framesStatus: (url) =>
        new URL(url).searchParams.has('codec') ? 400 : undefined,
      framesBody: { success: false, code: 'invalid-request' },
    });
    await mount(h);
    await flush();
    await flush();
    expect(
      h.streams.map((s) => new URL(s.url).searchParams.has('codec')),
    ).toEqual([true, false]);
    await h.streams[1]!.push(stateRecord(lease(0)));
    await h.streams[1]!.push(frameRecord(1, 0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(h.streams).toHaveLength(2);
  });

  test('a 400 naming the codec declines H.264; one naming another key does not', async () => {
    webCodecs(true);
    for (const [field, declined] of [
      ['codec', true],
      ['stream-params', false],
    ] as const) {
      const h = harness({
        framesStatus: (url) =>
          new URL(url).searchParams.has('codec') ? 400 : undefined,
        framesBody: { success: false, code: 'invalid-request', field },
      });
      const view = render(
        <LiveSurfaceCanvas
          apiBase={API}
          surfaceId={SURFACE}
          label="Device: emulator"
          transport={h.transport as never}
        />,
      );
      await flush();
      await flush();
      expect(
        h.streams.map((s) => new URL(s.url).searchParams.has('codec')),
        field,
      ).toEqual(declined ? [true, false] : [true]);
      view.unmount();
      liveSurfaceH264Declines.clear();
    }
  });

  test('a 400 that is not the unknown-key refusal does not switch to images', async () => {
    webCodecs(true);
    const h = harness({
      framesStatus: (url) =>
        new URL(url).searchParams.has('codec') ? 400 : undefined,
      framesBody: { success: false, code: 'invalid-surface-id' },
    });
    await mount(h);
    await flush();
    await flush();
    expect(
      h.streams.map((s) => new URL(s.url).searchParams.has('codec')),
    ).toEqual([true]);
  });

  test('three decoder failures with no picture between them stop asking for H.264', async () => {
    const codecs = webCodecs(true);
    const h = harness();
    await mount(h);
    const fail = async () => {
      const stream = h.streams.at(-1)!;
      await stream.push(stateRecord(lease(0)));
      await stream.push(videoRecord(h.streams.length * 10, true));
      // Fail before the picture comes out (outputs are synchronous here).
      codecs.decoders
        .at(-1)!
        .init.error(new DOMException('bad', 'EncodingError'));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_100));
      });
    };
    codecs.withholdOutput = true;
    await fail();
    await fail();
    expect(
      h.streams.map((s) => new URL(s.url).searchParams.get('codec')),
    ).toEqual(['h264', 'h264', 'h264']);
    await fail();
    expect(new URL(h.streams.at(-1)!.url).searchParams.has('codec')).toBe(
      false,
    );
  }, 15_000);

  test('a Station that is not on loopback is never asked for H.264', async () => {
    webCodecs(true);
    const transport = vi.fn(async () => new Response(new ReadableStream()));
    render(
      <LiveSurfaceCanvas
        apiBase="https://station.example.com"
        surfaceId={SURFACE}
        label="Device: emulator"
        transport={transport as never}
      />,
    );
    await flush();
    const url = new URL(String((transport.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.has('codec')).toBe(false);
  });

  test('a page without a secure context never asks for H.264', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('VideoDecoder', class {});
    const h = harness();
    await mount(h);
    expect(new URL(h.streams.at(-1)!.url).searchParams.has('codec')).toBe(
      false,
    );
  });
});
