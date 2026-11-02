// @vitest-environment jsdom

import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceRecord,
} from '@kontourai/station-contracts/live-surface';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import { createLiveSurfaceStreamAdmission } from '../liveSurfaceStreamAdmission';
import { liveSurfaceH264Declines, useLiveSurface } from '../useLiveSurface';

test('does not send queued input to a different surface after an old request settles', async () => {
  let resolveInput!: (response: Response) => void;
  const inputReply = new Promise<Response>((resolve) => {
    resolveInput = resolve;
  });
  const requests: string[] = [];
  const bodies: string[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/frames')) return new Response(new ReadableStream());
      requests.push(url);
      bodies.push(String(init?.body));
      return url.includes('/first/') ? inputReply : Response.json({});
    },
  );
  const visibilityRef = createRef<Element>();
  const { result, rerender, unmount } = renderHook(
    ({ surfaceId }) =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId,
        visibilityRef,
        onFrame: () => {},
        transport,
      }),
    { initialProps: { surfaceId: 'first' } },
  );
  act(() => result.current.sendInput([{ kind: 'text', text: 'first' }]));
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() => result.current.sendInput([{ kind: 'text', text: 'queued' }]));
  rerender({ surfaceId: 'second' });
  act(() => result.current.sendInput([{ kind: 'text', text: 'new' }]));
  await waitFor(() => expect(requests).toHaveLength(2));
  await act(async () => {
    resolveInput(
      Response.json({
        data: {
          ok: true,
          accepted: 1,
          lease: {
            surfaceId: 'first',
            epoch: 9,
            holder: null,
            expiresAt: null,
          },
        },
      }),
    );
    await inputReply;
  });
  expect(requests).toEqual([
    'http://station.test/api/live-surfaces/first/input',
    'http://station.test/api/live-surfaces/second/input',
  ]);
  expect(result.current.lease).toBeNull();
  expect(JSON.parse(bodies[1]).events).toEqual([{ kind: 'text', text: 'new' }]);
  unmount();
});

test('past the per-origin cap a viewer waits as queued, without a request, until a stream ends (#2760)', async () => {
  const admission = createLiveSurfaceStreamAdmission(2);
  const opened: string[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      opened.push(new URL(String(input)).pathname.split('/')[3]!);
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        }),
      );
    },
  );
  const viewer = (surfaceId: string) =>
    renderHook(() =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId,
        visibilityRef: createRef<Element>(),
        onFrame: () => {},
        transport,
        streamAdmission: admission,
      }),
    );
  const a = viewer('a');
  const b = viewer('b');
  const c = viewer('c');
  await waitFor(() => expect(c.result.current.status).toBe('queued'));
  expect(opened).toEqual(['a', 'b']);
  // Input is not admitted: it never waits for a frame-stream slot.
  act(() => c.result.current.sendInput([{ kind: 'text', text: 'x' }]));
  await waitFor(() => expect(opened).toEqual(['a', 'b', 'c']));
  expect(transport.mock.calls.at(-1)![0]).toBe(
    'http://station.test/api/live-surfaces/c/input',
  );
  // Closing one viewer admits the waiting one: one frames request, no storm.
  a.unmount();
  await waitFor(() => expect(c.result.current.status).toBe('connecting'));
  await waitFor(() => expect(opened).toEqual(['a', 'b', 'c', 'c']));
  expect(transport.mock.calls.at(-1)![0]).toBe(
    'http://station.test/api/live-surfaces/c/frames',
  );
  b.unmount();
  c.unmount();
});

test('after the hub switches a viewer to images, reconnects and a reopened pane ask for images (#4418)', async () => {
  liveSurfaceH264Declines.clear();
  const urls: string[] = [];
  const frame = (seq: number, codec: 'h264' | 'jpeg'): LiveSurfaceRecord => ({
    kind: 'frame',
    header: {
      surfaceId: 'device:a',
      seq,
      epoch: 0,
      codec,
      ...(codec === 'h264' ? { keyframe: true } : {}),
      width: 576,
      height: 1280,
      deviceScaleFactor: 1,
      capturedAt: 1,
    },
    body: new Uint8Array([seq]),
  });
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    // The first stream: H.264, then the hub's downgrade to images, then it
    // ends (a dropped connection).
    const records =
      urls.length === 1 ? [frame(1, 'h264'), frame(2, 'jpeg')] : [];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const record of records)
            controller.enqueue(encodeLiveSurfaceRecord(record));
          if (urls.length === 1) controller.close();
        },
      }),
    );
  });
  const mount = () =>
    renderHook(() =>
      useLiveSurface({
        apiBase: 'http://127.0.0.1:3999',
        surfaceId: 'device:a',
        visibilityRef: createRef<Element>(),
        onFrame: () => {},
        transport,
        acceptH264: true,
      }),
    );
  const first = mount();
  await waitFor(() => expect(urls).toHaveLength(2), { timeout: 3_000 });
  first.unmount();
  const reopened = mount();
  await waitFor(() => expect(urls).toHaveLength(3));
  expect(urls.map((url) => new URL(url).searchParams.has('codec'))).toEqual([
    true,
    false,
    false,
  ]);
  reopened.unmount();
  liveSurfaceH264Declines.clear();
});
