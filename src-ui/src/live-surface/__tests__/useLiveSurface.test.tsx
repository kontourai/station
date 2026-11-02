// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import { createLiveSurfaceStreamAdmission } from '../liveSurfaceStreamAdmission';
import { useLiveSurface } from '../useLiveSurface';

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
