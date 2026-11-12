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
      if (url.endsWith('/lease')) {
        const action = JSON.parse(String(init?.body)).action;
        if (action === 'open-input-source')
          return Response.json({
            success: true,
            data: { sourceId: '00000000-0000-4000-8000-000000000001' },
          });
        if (action === 'close-input-source')
          return Response.json({ success: true });
        throw new Error(`Unexpected lease action: ${action}`);
      }
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
      const url = new URL(String(input));
      if (url.pathname.endsWith('/lease')) {
        const action = JSON.parse(String(init?.body)).action;
        if (action === 'open-input-source')
          return Response.json({
            success: true,
            data: { sourceId: '00000000-0000-4000-8000-000000000001' },
          });
        if (action === 'close-input-source')
          return Response.json({ success: true });
        throw new Error(`Unexpected lease action: ${action}`);
      }
      opened.push(url.pathname.split('/')[3]!);
      if (url.pathname.endsWith('/input'))
        return Response.json({
          data: {
            ok: true,
            accepted: 1,
            lease: { surfaceId: 'c', epoch: 1, holder: null, expiresAt: null },
          },
        });
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

test('unmount seals its input source while a sent key is in flight', async () => {
  const sourceId = '00000000-0000-4000-8000-000000000001';
  let finishDown!: () => void;
  const downDone = new Promise<void>((resolve) => {
    finishDown = resolve;
  });
  const calls: string[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/frames'))
        return new Response(new ReadableStream());
      const body = JSON.parse(String(init?.body));
      if (body.action === 'open-input-source') {
        calls.push('open');
        return Response.json({ success: true, data: { sourceId } });
      }
      if (body.action === 'close-input-source') {
        calls.push(`close:${body.sourceId}`);
        return Response.json({ success: true });
      }
      calls.push(`down:${body.sourceId}`);
      await downDone;
      return Response.json({
        data: {
          ok: true,
          accepted: 1,
          lease: {
            surfaceId: 'first',
            epoch: 1,
            holder: null,
            expiresAt: null,
          },
        },
      });
    },
  );
  const { result, unmount } = renderHook(() =>
    useLiveSurface({
      apiBase: 'http://station.test',
      surfaceId: 'first',
      visibilityRef: createRef<Element>(),
      onFrame: () => {},
      transport,
    }),
  );
  act(() =>
    result.current.sendInput([
      { kind: 'key', type: 'down', key: 'a', code: 'KeyA' },
    ]),
  );
  await waitFor(() => expect(calls).toEqual(['open', `down:${sourceId}`]));
  unmount();
  await waitFor(() =>
    expect(calls).toEqual(['open', `down:${sourceId}`, `close:${sourceId}`]),
  );
  finishDown();
  await downDone;
});

test('unmount without input does not register or close a source', () => {
  const transport = vi.fn(
    async (_input: RequestInfo | URL) => new Response(new ReadableStream()),
  );
  const { unmount } = renderHook(() =>
    useLiveSurface({
      apiBase: 'http://station.test',
      surfaceId: 'first',
      visibilityRef: createRef<Element>(),
      onFrame: () => {},
      transport,
    }),
  );
  unmount();
  expect(
    transport.mock.calls.every(([url]) => String(url).endsWith('/frames')),
  ).toBe(true);
});

test('an invalid source discards refused input and registers again only for a new action', async () => {
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  let registrations = 0;
  const inputs: { sourceId: string; events: unknown[] }[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/frames'))
        return new Response(new ReadableStream());
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/lease')) {
        if (body.action === 'open-input-source')
          return Response.json({
            success: true,
            data: { sourceId: ids[registrations++] },
          });
        if (body.action === 'close-input-source')
          return Response.json({ success: true });
        throw new Error(`Unexpected lease action: ${body.action}`);
      }
      if (!String(input).endsWith('/input'))
        throw new Error('Unexpected input route');
      inputs.push(body);
      const ok = body.sourceId === ids[1];
      return Response.json(
        {
          success: ok,
          data: {
            ok,
            ...(ok ? {} : { code: 'invalid-source' }),
            accepted: ok ? body.events.length : 0,
            lease: {
              surfaceId: 'first',
              epoch: ok ? 1 : 0,
              holder: ok
                ? {
                    kind: 'human',
                    principal: 'human:test',
                    device: 'device:test',
                  }
                : null,
              expiresAt: ok ? 1000 : null,
            },
          },
        },
        { status: ok ? 200 : 409 },
      );
    },
  );
  const visibilityRef = createRef<Element>();
  const { result, unmount } = renderHook(() =>
    useLiveSurface({
      apiBase: 'http://station.test',
      surfaceId: 'first',
      visibilityRef,
      onFrame: () => {},
      transport,
      now: () => 0,
    }),
  );
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'refused action' }]),
  );
  await waitFor(() => expect(result.current.inputNotice).toBe('input-failed'));
  expect(result.current.retryableInput).toBe(false);
  expect(registrations).toBe(1);
  expect(inputs).toHaveLength(1);
  act(() => result.current.sendInput([{ kind: 'text', text: 'new action' }]));
  await waitFor(() => expect(inputs).toHaveLength(2));
  expect(registrations).toBe(2);
  expect(inputs.map(({ sourceId }) => sourceId)).toEqual(ids);
  expect(inputs.flatMap(({ events }) => events)).toEqual([
    { kind: 'text', text: 'refused action' },
    { kind: 'text', text: 'new action' },
  ]);
  unmount();
});

test.each(['refusal', 'transport failure'] as const)(
  'registration %s discards pending input and recovers on a new action',
  async (failure) => {
    const sourceId = '00000000-0000-4000-8000-000000000002';
    let attempts = 0;
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const sent: unknown[][] = [];
    const transport = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/frames'))
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () =>
                    controller.error(new DOMException('aborted', 'AbortError')),
                  { once: true },
                );
              },
            }),
          );
        const body = JSON.parse(String(init?.body));
        if (url.endsWith('/lease')) {
          if (body.action === 'open-input-source') {
            attempts += 1;
            if (attempts === 1) {
              await registration;
              if (failure === 'transport failure')
                throw new TypeError('temporary transport outage');
              return Response.json(
                { success: false, code: 'invalid-request' },
                { status: 409 },
              );
            }
            return Response.json({ success: true, data: { sourceId } });
          }
          if (
            body.action === 'close-input-source' &&
            body.sourceId === sourceId
          )
            return Response.json({ success: true });
          throw new Error(`Unexpected lease action: ${body.action}`);
        }
        if (!url.endsWith('/input')) throw new Error('Unexpected input route');
        expect(body.sourceId).toBe(sourceId);
        sent.push(body.events);
        return Response.json({
          success: true,
          data: {
            ok: true,
            accepted: body.events.length,
            lease: {
              surfaceId: 'first',
              epoch: 1,
              holder: {
                kind: 'human',
                principal: 'human:test',
                device: 'device:test',
              },
              expiresAt: 1000,
            },
          },
        });
      },
    );
    const visibilityRef = createRef<Element>();
    const { result, unmount } = renderHook(() =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId: 'first',
        visibilityRef,
        onFrame: () => {},
        transport,
        now: () => 0,
      }),
    );
    act(() =>
      result.current.sendInput([
        { kind: 'key', type: 'down', key: 'Shift', code: 'ShiftLeft' },
      ]),
    );
    await waitFor(() => expect(attempts).toBe(1));
    act(() =>
      result.current.sendInput([
        { kind: 'text', text: 'queued before refusal' },
      ]),
    );
    await act(async () => {
      finishRegistration();
      await registration;
    });
    await waitFor(() =>
      expect(result.current.inputNotice).toBe('input-failed'),
    );
    expect(result.current.retryableInput).toBe(false);
    expect(sent).toEqual([]);
    await act(async () =>
      result.current.sendInput([
        { kind: 'key', type: 'up', key: 'Shift', code: 'ShiftLeft' },
      ]),
    );
    expect(attempts).toBe(1);
    expect(sent).toEqual([]);
    act(() => result.current.sendInput([{ kind: 'text', text: 'new action' }]));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(attempts).toBe(2);
    expect(sent).toEqual([[{ kind: 'text', text: 'new action' }]]);
    unmount();
  },
);

test('changing only the transport aborts the old frame stream and observes the replacement', async () => {
  const streams: {
    name: string;
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal: AbortSignal | undefined;
  }[] = [];
  const makeTransport = (name: string) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/frames'))
        throw new Error('Only viewing is expected');
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push({
              name,
              controller,
              signal: init?.signal ?? undefined,
            });
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
      );
    });
  const first = makeTransport('first');
  const second = makeTransport('second');
  const visibilityRef = createRef<Element>();
  const { result, rerender, unmount } = renderHook(
    ({ transport }) =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId: 'first',
        visibilityRef,
        onFrame: () => {},
        transport,
      }),
    { initialProps: { transport: first } },
  );
  const pushLease = async (index: number, epoch: number) => {
    await act(async () =>
      streams[index]!.controller.enqueue(
        encodeLiveSurfaceRecord({
          kind: 'state',
          state: {
            surfaceId: 'first',
            lease: { surfaceId: 'first', epoch, holder: null, expiresAt: null },
            effectiveParams: {
              maxFps: 10,
              quality: 70,
              maxWidth: 1280,
              maxHeight: 1280,
            },
            viewer: { principal: 'human:test', device: 'device:test' },
          },
        }),
      ),
    );
  };
  await waitFor(() => expect(streams).toHaveLength(1));
  await pushLease(0, 1);
  await waitFor(() => expect(result.current.lease?.epoch).toBe(1));
  rerender({ transport: second });
  await waitFor(() => expect(streams).toHaveLength(2));
  expect(streams[0]!.signal?.aborted).toBe(true);
  expect(streams.map(({ name }) => name)).toEqual(['first', 'second']);
  await pushLease(1, 2);
  await waitFor(() => expect(result.current.lease?.epoch).toBe(2));
  unmount();
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type TransportRequest = {
  url: string;
  body: {
    action?: string;
    sourceId?: string;
    events?: { kind: string; text?: string }[];
  };
};

function transportForSwap(
  onRequest: (request: TransportRequest) => Promise<Response>,
) {
  const requests: TransportRequest[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/frames')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
        );
      }
      const request: TransportRequest = {
        url: url.toString(),
        body: JSON.parse(String(init?.body)),
      };
      requests.push(request);
      return onRequest(request);
    },
  );
  return { transport, requests };
}

const swapSourceA = '00000000-0000-4000-8000-000000000001';
const swapSourceB = '00000000-0000-4000-8000-000000000002';
const swapLeaseUrl =
  'http://station.test/api/live-surfaces/first/lease?projectSlug=alpha';
const swapInputUrl =
  'http://station.test/api/live-surfaces/first/input?projectSlug=alpha';

function sourceReply(sourceId: string) {
  return Response.json({ success: true, data: { sourceId } });
}

function inputReply(
  epoch: number,
  code?: 'page-dialog-open' | 'stale-epoch',
  accepted = 1,
) {
  return Response.json(
    {
      success: !code,
      data: {
        ok: !code,
        ...(code ? { code } : {}),
        accepted: code ? 0 : accepted,
        lease: {
          surfaceId: 'first',
          epoch,
          holder: null,
          expiresAt: null,
        },
      },
    },
    { status: code ? 409 : 200 },
  );
}

test('transport swap closes delayed registration on its original transport without sending retired input', async () => {
  const pendingOpen = deferredResponse();
  const a = transportForSwap(async ({ body }) => {
    if (body.action === 'open-input-source') return pendingOpen.promise;
    if (body.action === 'close-input-source')
      return Response.json({ success: true });
    throw new Error('Unexpected A request');
  });
  const b = transportForSwap(async ({ body }) => {
    if (body.action === 'open-input-source') return sourceReply(swapSourceB);
    if (body.action === 'close-input-source')
      return Response.json({ success: true });
    if (body.events) return inputReply(2);
    throw new Error('Unexpected B request');
  });
  const visibilityRef = createRef<Element>();
  const { result, rerender, unmount } = renderHook(
    ({ transport }) =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId: 'first',
        projectSlug: 'alpha',
        visibilityRef,
        onFrame: () => {},
        transport,
      }),
    { initialProps: { transport: a.transport } },
  );
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'retired action' }]),
  );
  await waitFor(() => expect(a.requests).toHaveLength(1));
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'retired queued' }]),
  );
  rerender({ transport: b.transport });
  act(() => result.current.sendInput([{ kind: 'text', text: 'fresh action' }]));
  await waitFor(() => expect(b.requests).toHaveLength(2));
  await act(async () => {
    pendingOpen.resolve(sourceReply(swapSourceA));
    await pendingOpen.promise;
  });
  await waitFor(() => expect(a.requests).toHaveLength(2));
  expect(a.requests).toEqual([
    { url: swapLeaseUrl, body: { action: 'open-input-source' } },
    {
      url: swapLeaseUrl,
      body: { action: 'close-input-source', sourceId: swapSourceA },
    },
  ]);
  expect(b.requests[0]).toEqual({
    url: swapLeaseUrl,
    body: { action: 'open-input-source' },
  });
  expect(b.requests[1]).toMatchObject({
    url: swapInputUrl,
    body: {
      sourceId: swapSourceB,
      events: [{ kind: 'text', text: 'fresh action' }],
    },
  });
  expect(b.requests).toHaveLength(2);
  unmount();
});

test('late input response from retired transport cannot disturb replacement input and lease', async () => {
  const pendingA = deferredResponse();
  const pendingB = deferredResponse();
  let bInputCount = 0;
  const a = transportForSwap(async ({ body }) => {
    if (body.action === 'open-input-source') return sourceReply(swapSourceA);
    if (body.action === 'close-input-source')
      return Response.json({ success: true });
    if (body.events) return pendingA.promise;
    throw new Error('Unexpected A request');
  });
  const b = transportForSwap(async ({ body }) => {
    if (body.action === 'open-input-source') return sourceReply(swapSourceB);
    if (body.action === 'close-input-source')
      return Response.json({ success: true });
    if (body.events) {
      bInputCount += 1;
      if (bInputCount === 1) return inputReply(2, 'page-dialog-open');
      if (bInputCount === 2) return pendingB.promise;
      if (bInputCount === 3)
        return inputReply(3, undefined, body.events.length);
    }
    throw new Error('Unexpected B request');
  });
  const visibilityRef = createRef<Element>();
  const { result, rerender, unmount } = renderHook(
    ({ transport }) =>
      useLiveSurface({
        apiBase: 'http://station.test',
        surfaceId: 'first',
        projectSlug: 'alpha',
        visibilityRef,
        onFrame: () => {},
        transport,
      }),
    { initialProps: { transport: a.transport } },
  );
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'old in flight' }]),
  );
  await waitFor(() => expect(a.requests).toHaveLength(2));
  act(() => result.current.sendInput([{ kind: 'text', text: 'old queued' }]));
  rerender({ transport: b.transport });
  await waitFor(() => expect(a.requests).toHaveLength(3));
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'replacement first' }]),
  );
  await waitFor(() => expect(result.current.inputNotice).toBe('page-dialog'));
  expect(result.current.lease?.epoch).toBe(2);
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'replacement pending' }]),
  );
  await waitFor(() => expect(bInputCount).toBe(2));
  act(() =>
    result.current.sendInput([{ kind: 'text', text: 'replacement queued' }]),
  );
  await act(async () => {
    pendingA.resolve(inputReply(9, 'stale-epoch'));
    await pendingA.promise;
  });
  expect(result.current.lease?.epoch).toBe(2);
  expect(result.current.inputNotice).toBe('page-dialog');
  expect(bInputCount).toBe(2);
  await act(async () => {
    result.current.sendInput([
      { kind: 'text', text: 'replacement after old response' },
    ]);
    await Promise.resolve();
  });
  expect(bInputCount).toBe(2);
  expect(result.current.lease?.epoch).toBe(2);
  expect(result.current.inputNotice).toBe('page-dialog');
  await act(async () => {
    pendingB.resolve(inputReply(2));
    await pendingB.promise;
  });
  await waitFor(() => expect(bInputCount).toBe(3));
  expect(a.requests).toEqual([
    { url: swapLeaseUrl, body: { action: 'open-input-source' } },
    expect.objectContaining({
      url: swapInputUrl,
      body: expect.objectContaining({
        sourceId: swapSourceA,
        events: [{ kind: 'text', text: 'old in flight' }],
      }),
    }),
    {
      url: swapLeaseUrl,
      body: { action: 'close-input-source', sourceId: swapSourceA },
    },
  ]);
  expect(b.requests[0]).toEqual({
    url: swapLeaseUrl,
    body: { action: 'open-input-source' },
  });
  expect(
    b.requests.slice(1).map(({ body }) => ({
      sourceId: body.sourceId,
      events: body.events,
    })),
  ).toEqual([
    {
      sourceId: swapSourceB,
      events: [{ kind: 'text', text: 'replacement first' }],
    },
    {
      sourceId: swapSourceB,
      events: [{ kind: 'text', text: 'replacement pending' }],
    },
    {
      sourceId: swapSourceB,
      events: [
        { kind: 'text', text: 'replacement queued' },
        { kind: 'text', text: 'replacement after old response' },
      ],
    },
  ]);
  await waitFor(() => expect(result.current.lease?.epoch).toBe(3));
  expect(result.current.inputNotice).toBeNull();
  unmount();
});
