// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
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
