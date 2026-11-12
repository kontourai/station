// @vitest-environment jsdom
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const data = vi.hoisted(() => ({ rows: [] as BrowserSessionView[] }));
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: url.includes('/access')
            ? { projectId: 'p', principalKey: 'owner' }
            : data.rows,
        }),
        { status: 200 },
      ),
  ),
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
vi.mock('../../../float-over-chat/BrowserSessionSurface', () => ({
  BrowserSessionSurface: ({
    session,
  }: {
    session: { browserSessionId: string };
  }) => <div>Live {session.browserSessionId}</div>,
}));

import { browserShownSourceKey } from '../../../float-over-chat/floatSource';
import { announceShownSource } from '../../../float-over-chat/shownSources';
import { InlineBrowserActivity } from '../InlineBrowserActivity';

const scope = {
  apiBase: 'https://station.test',
  requestScope: { apiBase: 'https://station.test', authorityKey: 'authority' },
  projectSlug: 'project',
  threadIds: ['thread'],
  conversationKey: 'conversation',
};
function row(overrides: Partial<BrowserSessionView> = {}): BrowserSessionView {
  return {
    browserSessionId: 'exact',
    projectId: 'p',
    projectSlug: 'project',
    principalKey: 'owner',
    reach: 'operator',
    threadId: 'thread',
    url: 'https://example.test/',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    generation: 1,
    state: 'live',
    surfaceId: 'surface',
    createdAt: '2026-11-06T12:00:00.000Z',
    updatedAt: '2026-11-06T12:00:00.000Z',
    history: { entries: [], total: 0 },
    activity: { agentDriven: true },
    ...overrides,
  };
}
function show(active = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InlineBrowserActivity
        scope={scope}
        browserSessionId="exact"
        active={active}
        toolCount={2}
        status="Done"
      >
        Steps
      </InlineBrowserActivity>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  data.rows = [];
});
test('shows only the exact session bound to this project, principal and thread', async () => {
  data.rows = [
    row({ principalKey: 'other' }),
    row({ threadId: 'other' }),
    row({ browserSessionId: 'other' }),
  ];
  show();
  await screen.findByText(
    'Browser session is unavailable for this conversation.',
  );
  expect(screen.queryByText('Live exact')).toBeNull();
});
test('settled activity never displays the current live browser', async () => {
  data.rows = [row()];
  const view = show();
  await screen.findByText('Live exact');
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <InlineBrowserActivity
        scope={scope}
        browserSessionId="exact"
        active={false}
        toolCount={2}
        status="Done"
      >
        Steps
      </InlineBrowserActivity>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Live exact')).toBeNull());
  expect(screen.getByText('Steps')).toBeTruthy();
});

test('one visible inline card streams while a pane takes priority for the same authority', async () => {
  data.rows = [row()];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <InlineBrowserActivity
        scope={scope}
        browserSessionId="exact"
        active
        toolCount={1}
        status="In progress"
      />
      <InlineBrowserActivity
        scope={scope}
        browserSessionId="exact"
        active
        toolCount={1}
        status="In progress"
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getAllByText('Live exact')).toHaveLength(1),
  );
  const foreign = announceShownSource(
    browserShownSourceKey('exact', scope.apiBase, 'other-authority'),
  );
  expect(screen.getAllByText('Live exact')).toHaveLength(1);
  let release = () => {};
  act(() => {
    release = announceShownSource(
      browserShownSourceKey(
        'exact',
        scope.apiBase,
        scope.requestScope.authorityKey,
      ),
    );
  });
  await waitFor(() => expect(screen.queryByText('Live exact')).toBeNull());
  act(() => {
    release();
    foreign();
  });
  await waitFor(() =>
    expect(screen.getAllByText('Live exact')).toHaveLength(1),
  );
});
