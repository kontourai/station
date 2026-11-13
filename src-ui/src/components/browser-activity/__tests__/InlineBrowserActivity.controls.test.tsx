// @vitest-environment jsdom
import {
  encodeLiveSurfaceRecord,
  type LiveSurfaceControlLease,
} from '@kontourai/station-contracts/live-surface';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const network = vi.hoisted(() => ({
  fetch:
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: network.fetch,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: 'authority',
  }),
}));
vi.mock('../../../contexts/useOpenInRegion', () => ({
  useOpenBrowserSessionInRegion: () => null,
}));

import { InlineBrowserActivity } from '../InlineBrowserActivity';

const surfaceId = 'browser:session:g1';
const me = { principal: 'human:local:me', device: 'device:mine' };
const lease = (
  holder: LiveSurfaceControlLease['holder'],
): LiveSurfaceControlLease => ({
  surfaceId,
  epoch: 3,
  holder,
  expiresAt: holder ? 9e12 : null,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  network.fetch.mockReset();
});
test('inline controls claim and release the real canvas lease on the same stream', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const actions: string[] = [];
  let streams = 0;
  network.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/access'))
      return Response.json({
        success: true,
        data: { projectId: 'p', principalKey: 'owner' },
      });
    if (url.pathname === '/api/browser/sessions')
      return Response.json({
        success: true,
        data: [
          {
            browserSessionId: 'session',
            projectId: 'p',
            projectSlug: 'project',
            principalKey: 'owner',
            threadId: 'thread',
            state: 'live',
            surfaceId,
            url: 'https://example.test',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            generation: 1,
          },
        ],
      });
    if (url.pathname.endsWith('/frames')) {
      streams += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
          cancel() {},
        }),
      );
    }
    if (url.pathname.endsWith('/lease')) {
      const request = JSON.parse(String(init?.body));
      actions.push(request.action);
      return Response.json({
        success: true,
        data: {
          ok: true,
          lease: lease(
            request.action === 'claim' ? { kind: 'human', ...me } : null,
          ),
        },
      });
    }
    return Response.json({ success: false }, { status: 404 });
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InlineBrowserActivity
        scope={{
          apiBase: 'https://station.test',
          requestScope: {
            apiBase: 'https://station.test',
            authorityKey: 'authority',
          },
          projectSlug: 'project',
          threadIds: ['thread'],
          conversationKey: 'conversation',
        }}
        browserSessionId="session"
        active
        toolCount={1}
        status="In progress"
      />
    </QueryClientProvider>,
  );
  await screen.findByTestId('live-surface-canvas');
  await waitFor(() => expect(stream).toBeDefined());
  await act(async () => {
    stream.enqueue(
      encodeLiveSurfaceRecord({
        kind: 'state',
        state: {
          surfaceId,
          lease: lease({
            kind: 'agent',
            principal: 'agent:x',
            sessionId: 'agent',
          }),
          effectiveParams: {
            maxFps: 10,
            quality: 70,
            maxWidth: 1280,
            maxHeight: 1280,
          },
          viewer: me,
        },
      }),
    );
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Take control' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Release control' }),
  );
  await waitFor(() => expect(actions).toEqual(['claim', 'release']));
  expect(streams).toBe(1);
  expect(
    await screen.findByRole('button', { name: 'Take control' }),
  ).toBeTruthy();
});
