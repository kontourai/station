/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterAll, afterEach, expect, test, vi } from 'vitest';

const originalPlatform = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
  });
  return descriptor;
});
afterAll(() => {
  if (originalPlatform)
    Object.defineProperty(navigator, 'platform', originalPlatform);
  else Reflect.deleteProperty(navigator, 'platform');
});
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(['browser-experience']),
}));
vi.mock('../../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: () => <div data-testid="live-canvas" />,
}));

import { KeyboardShortcutsProvider } from '../../../contexts/KeyboardShortcutsContext';
import BrowserPane from '../BrowserPane';

afterEach(() => vi.restoreAllMocks());

test('macOS Alt+Left and Alt+Right stay with the address field', async () => {
  const sessionId = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
  const session = {
    browserSessionId: sessionId,
    projectId: 'p-alpha',
    projectSlug: 'alpha',
    principalKey: 'operator',
    reach: 'operator',
    url: 'https://example.com/',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    generation: 1,
    state: 'live',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: { entries: [], total: 0 },
    activity: { agentDriven: false },
    surfaceId: 'browser:test:g1',
  };
  const requests: Array<{ method: string; path: string }> = [];
  const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    requests.push({ method, path });
    const data = path.endsWith('/access')
      ? {
          projectId: 'p-alpha',
          role: 'operator',
          operator: true,
          canDrive: true,
          browser: 'ready',
          experiencePreviewEnabled: true,
        }
      : path.endsWith('/navigation')
        ? {
            generation: 1,
            title: 'Example',
            canGoBack: true,
            canGoForward: true,
          }
        : session;
    return new Response(JSON.stringify({ success: true, data }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  render(
    <KeyboardShortcutsProvider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BrowserPane
          projectSlug="alpha"
          target={{ kind: 'session', browserSessionId: sessionId }}
          onAttach={() => {}}
          transport={transport as never}
        />
      </QueryClientProvider>
    </KeyboardShortcutsProvider>,
  );
  const address = await screen.findByLabelText('Address');
  await screen.findByTestId('live-canvas');
  act(() => address.focus());
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const event = new KeyboardEvent('keydown', {
      key,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      address.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    await act(async () => {});
    expect(
      requests.filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/history'),
      ),
    ).toEqual([]);
  }
});
