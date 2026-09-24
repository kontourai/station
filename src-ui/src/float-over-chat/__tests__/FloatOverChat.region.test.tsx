// @vitest-environment jsdom

/**
 * #90 D9 B1/S6: "Open in right panel" through the REAL seam, to a rendered
 * pane. The floater's own opener (`useOpenBrowserSessionInRegion`) against
 * the real `RegionModelProvider`; the occurrence the region host mints for
 * the placed id (`regionSurfacePane(...).instance(...)`, the host's own
 * fold); and that occurrence through `RegionBuiltinPane`, the region host's
 * renderer map, to the Browser pane's registry component. The Browser pane's
 * inside is a stub that prints the session it was handed: its own states are
 * `BrowserPane.test.tsx`'s. The live view is a stub: it is not what is under
 * test, and its seam is `FloatOverChat.canvas.test.tsx`'s.
 */

import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings: {} }),
}));
vi.mock('../../live-surface/LiveSurfaceCanvas', () => ({
  LiveSurfaceCanvas: () => <div data-testid="float-canvas" />,
}));
vi.mock('../../workspace-panes/useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => ({
    state: 'resolved',
    project: { id: 'p-alpha', slug: 'alpha', name: 'Alpha' },
    layout: undefined,
  }),
}));
vi.mock('../../workspace-panes/browser-pane/BrowserPane', () => ({
  default: ({
    target,
  }: {
    target: { kind: string; browserSessionId?: string };
  }) => (
    <p data-testid="browser-pane">
      {target.kind}:{target.browserSessionId}
    </p>
  ),
}));

import { LazyBoundary } from '../../components/LazyBoundary';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import {
  RegionModelProvider,
  useRegionModel,
} from '../../contexts/RegionModelContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import { regionSurfacePane } from '../../regions/region-surface-panes';
import { RegionBuiltinPane } from '../../workspace-panes/RegionBuiltinPane';
import FloatOverChat from '../FloatOverChat';
import { resetFloatStoreForTests } from '../floatStore';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';

const SESSION_VIEW: BrowserSessionView = {
  browserSessionId: SESSION,
  projectId: 'p-alpha',
  projectSlug: 'alpha',
  principalKey: 'operator',
  reach: 'operator',
  threadId: 'conversation-1',
  url: 'https://example.com/',
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  generation: 1,
  state: 'live',
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
  history: { entries: [], total: 0 },
  activity: {
    agentDriven: true,
    lastDriver: { kind: 'agent', sessionId: 'agent-1' },
  },
  surfaceId: 'browser:0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77:g1',
};

let model: ReturnType<typeof useRegionModel> | null = null;
function ModelProbe() {
  const value = useRegionModel();
  useEffect(() => {
    model = value;
  }, [value]);
  return null;
}

const transport = vi.fn(async (input: unknown) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/browser/projects/alpha/access')
    return Response.json({
      success: true,
      data: {
        projectId: 'p-alpha',
        role: 'operator',
        principalKey: 'operator',
        operator: true,
        browser: 'ready',
      },
    });
  if (url.pathname === '/api/browser/sessions')
    return Response.json({ success: true, data: [SESSION_VIEW] });
  return Response.json({ success: false }, { status: 404 });
});

beforeEach(() => {
  model = null;
  window.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  resetFloatStoreForTests();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

test('Open in right panel places a Browser pane that renders THIS session', async () => {
  const body = document.createElement('div');
  document.body.appendChild(body);
  body.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 900,
      height: 700,
      right: 900,
      bottom: 700,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionModelProvider>
            <ModelProbe />
            <FloatOverChat
              session={{
                id: 'tab-1',
                conversationId: 'conversation-1',
                projectSlug: 'alpha',
              }}
              transport={transport as never}
            />
          </RegionModelProvider>
        </NavigationProvider>
      </KeyboardShortcutsProvider>
    </QueryClientProvider>,
    { container: body },
  );
  await screen.findByTestId('float-canvas');
  fireEvent.click(
    screen.getByRole('button', { name: /^Floating browser controls/ }),
  );
  act(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Open in right panel' }),
    );
  });
  await waitFor(() => expect(model?.regions.right.panes.length).toBe(1));
  const placed = model?.regions.right.panes[0] ?? '';
  expect(placed).toMatch(/^browser-preview:[0-9a-f]{32}$/);
  expect(model?.regions.right.visible).toBe(true);

  // What the region host renders for the placed id: its own occurrence, its
  // own renderer map.
  const instance = regionSurfacePane(placed)?.instance({
    projectId: 'p-alpha',
    projectSlug: 'alpha',
  });
  if (!instance) throw new Error('the region host could mint no occurrence');
  render(
    <QueryClientProvider client={client}>
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance }}
        pending={<span>Loading pane</span>}
      />
    </QueryClientProvider>,
  );
  expect((await screen.findByTestId('browser-pane')).textContent).toBe(
    `session:${SESSION}`,
  );
  expect(screen.queryByRole('alert')).toBeNull();
});
