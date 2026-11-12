/**
 * A synthetic record stream and input endpoint for mounting the REAL
 * `LiveSurfaceCanvas` in jsdom: frames and lease state are pushed as the
 * server encodes them, and every input batch the canvas POSTs is recorded.
 * The shapes are the wire contract's (`encodeLiveSurfaceRecord`).
 */
import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceControlLease,
  type LiveSurfaceRecord,
} from '@kontourai/station-contracts/live-surface';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceCanvasProps,
} from '../../LiveSurfaceCanvas';
import { inputSourceFixture } from './inputSourceFixture';

export const SURFACE = 'browser:session-1';
export const API = 'http://127.0.0.1:3999';
const FRAMES_URL = `${API}/api/live-surfaces/${encodeURIComponent(SURFACE)}/frames`;
const INPUT_URL = `${API}/api/live-surfaces/${encodeURIComponent(SURFACE)}/input`;

export const ME = {
  principal: 'human:local:me',
  device: 'device:mine',
} as const;
export const MY_HOLD = { kind: 'human', ...ME } as const;

export function lease(
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
      viewer: { ...ME },
    },
  };
}

/** A 1280x800 frame at 2x: surface pixels are 640x400. */
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

export function canvasHarness(
  options: {
    /** The input endpoint's answer; absent, every batch is accepted. */
    inputReply?: (body: { epoch: number; events: unknown[] }) => Response;
  } = {},
) {
  const inputs: { epoch: number; events: unknown[] }[] = [];
  const sources = inputSourceFixture();
  let push: ((record: LiveSurfaceRecord) => Promise<void>) | null = null;
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
        push = async (record) => {
          await act(async () => {
            controller.enqueue(encodeLiveSurfaceRecord(record));
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        };
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
        if (options.inputReply) return options.inputReply(body);
        return Response.json({
          success: true,
          data: {
            ok: true,
            accepted: body.events.length,
            lease: lease(body.epoch + 1, MY_HOLD),
          },
        });
      }
      return Response.json({ success: false }, { status: 500 });
    },
  );
  return {
    transport,
    inputs,
    /** Every event the canvas sent, in order. */
    events: () => inputs.flatMap((batch) => batch.events),
    async pushState(l: LiveSurfaceControlLease) {
      await push?.(stateRecord(l));
    },
    async pushFrame(seq: number, epoch: number) {
      await push?.(frameRecord(seq, epoch));
    },
  };
}

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * jsdom lays nothing out: give the stage and the canvas the boxes a browser
 * would. A browser reports a transformed element's rect already moved and
 * scaled; so does this, reading the zoom layer's inline transform (the
 * real-cascade check of that is `liveSurfaceZoom.browser.test.ts`).
 */
export function layoutStage(box: { width: number; height: number }) {
  const rectOf = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      x: left,
      y: top,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('live-surface__stage'))
        return rectOf(0, 0, box.width, box.height);
      if (this.classList.contains('live-surface')) {
        return rectOf(0, 0, box.width, box.height);
      }
      return rectOf(0, 0, 0, 0);
    },
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'getBoundingClientRect',
  ).mockImplementation(function (this: HTMLCanvasElement) {
    const zoom = this.closest<HTMLElement>('.live-surface__zoom');
    const match =
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
        zoom?.style.transform ?? '',
      );
    const [x, y, s] = match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : [0, 0, 1];
    return rectOf(x, y, box.width * s, box.height * s);
  });
}

export async function renderCanvas(
  h: ReturnType<typeof canvasHarness>,
  props: Partial<LiveSurfaceCanvasProps> = {},
  initial = lease(0),
) {
  const view = render(
    <LiveSurfaceCanvas
      apiBase={API}
      surfaceId={SURFACE}
      label="Browser: example.com"
      transport={h.transport as never}
      {...props}
    />,
  );
  await flush();
  await h.pushState(initial);
  await h.pushFrame(1, initial.epoch);
  return view;
}
