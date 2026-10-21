/** @vitest-environment jsdom */
import type { EnsembleInspection } from '@kontourai/station-contracts/ensemble';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppViewContent } from '../../app-shell/AppViewContent';
import { resolveViewFromPath } from '../../app-shell/routing';
import {
  NavigationProvider,
  navigationStore,
  useNavigation,
} from '../../contexts/NavigationContext';

const owner = vi.hoisted(() => ({
  current: true,
  key: 'operator-a',
  editorReads: 0,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: owner.key,
    isCurrent: () => owner.current,
  }),
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ isLoading: false, isError: false }),
}));
vi.mock('../agent-editor/useAgentsViewModel', () => ({
  useAgentsViewModel: () => {
    owner.editorReads++;
    if (window.location.search.includes('ensembles'))
      throw new Error('Inspector mounted editor queries');
    return {
      DiscardModal: () => null,
      listItems: [],
      selectedAgent: undefined,
    };
  },
}));
vi.mock('../agent-editor/AgentsViewEditorPane', () => ({
  AgentsViewEditorPane: () => null,
}));
vi.mock('../../components/SplitPaneLayout', () => ({
  SplitPaneLayout: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('../../components/page-frame/PageFrame', () => ({
  PageFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../app-shell/RouteViewBoundary', () => ({
  RouteViewBoundary: ({ children }: { children: ReactNode }) => (
    <Suspense fallback="Loading">{children}</Suspense>
  ),
}));

const result: EnsembleInspection = {
  version: 'station.ensemble.inspection/v1',
  source: {
    sha256: `sha256:${'a'.repeat(64)}`,
    presetId: 'team',
    name: 'Review team',
    stationmaster: 'lead',
  },
  environmentId: 'local',
  observedAt: '2026-10-21T00:00:00Z',
  resolutions: [],
  facts: [
    {
      id: 'member:lead',
      memberId: 'lead',
      category: 'members/models',
      label: 'Lead',
      value: 'codex / selected-model',
      origin: 'authored',
      state: 'configured',
      owner: { label: 'Agent settings', href: '/agents/reviewer' },
    },
    ...(
      [
        'routing/triggers',
        'tools/services',
        'workspace',
        'memory',
        'schedules/webhooks',
        'output destinations',
      ] as const
    ).map((category) => ({
      id: category,
      category,
      label: category,
      value: 'Owner facts unavailable',
      origin: 'unknown' as const,
      state: 'unavailable' as const,
      owner: { label: 'Preset source' },
    })),
  ],
  limits:
    'Authentication, entitlement, execution limits and live group bindings are unverified.',
};

function Harness() {
  const nav = useNavigation();
  return (
    <AppViewContent
      currentView={resolveViewFromPath(
        `${nav.pathname}${window.location.search}`,
      )}
      agents={[]}
      availableModels={[]}
      apiBase="https://station.test"
      onNavigate={() => {}}
      onShowHome={() => {}}
      onReturnToOutlet={() => {}}
      onSettingsSaved={() => {}}
    />
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <Harness />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: 'https://station.test',
    credential: 'test-only',
    requestAuthority: {
      apiBase: 'https://station.test',
      authorityKey: owner.key,
      isCurrent: () => owner.current,
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  owner.current = true;
  owner.key = 'operator-a';
  owner.editorReads = 0;
});

test('the visible Agents action reaches the real SDK inspector without editor queries or URL path disclosure', async () => {
  navigationStore.navigate('/agents');
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: result })),
  );
  vi.stubGlobal('fetch', fetch);
  const client = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Inspect an Ensemble' }),
  );
  expect(window.location.search).toBe('?tab=ensembles');
  await screen.findByRole('heading', { name: 'Inspect an Ensemble' });
  expect(owner.editorReads).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Preset path on This Station'), {
    target: { value: '/private/team.json' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await screen.findByRole('table', {
    name: 'Ensemble configuration and provenance',
  });
  expect(fetch.mock.calls).toHaveLength(1);
  expect(window.location.href).not.toContain('private');
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.options.mutationKey),
    ),
  ).not.toContain('private');
  for (const category of [
    'routing/triggers',
    'tools/services',
    'workspace',
    'memory',
    'schedules/webhooks',
    'output destinations',
  ])
    expect(screen.getAllByText(category).length).toBeGreaterThan(0);
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
    'configuration relationships',
  );
  const agent = screen.getByLabelText('Agent ID');
  fireEvent.change(agent, { target: { value: 'reviewer' } });
  fireEvent.change(screen.getByLabelText('Project ID'), {
    target: { value: 'project' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const secondRequest = fetch.mock.calls[1];
  expect(JSON.parse(String(secondRequest[1]?.body))).toEqual({
    path: '/private/team.json',
    expectedPresetHash: result.source.sha256,
    bindings: { lead: { agent: 'reviewer', projectSlug: 'project' } },
  });
  await screen.findByRole('table', {
    name: 'Ensemble configuration and provenance',
  });
  fireEvent.click(screen.getByRole('link', { name: 'Agent settings' }));
  expect(window.location.pathname).toBe('/agents/reviewer');
});

test('the inspector withholds a pending result when current authority is lost', async () => {
  navigationStore.navigate('/agents?tab=ensembles');
  let settle: ((response: Response) => void) | undefined;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.change(
    await screen.findByLabelText('Preset path on This Station'),
    { target: { value: '/private/team.json' } },
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Inspect configuration' }),
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  owner.current = false;
  if (!settle) throw new Error('Transport did not receive inspection');
  settle(new Response(JSON.stringify({ success: true, data: result })));
  await screen.findByRole('alert');
  expect(screen.queryByRole('table')).toBeNull();
});

test.each([403, 409])(
  'a %s response shows denied/stale guidance and no earlier facts',
  async (status) => {
    navigationStore.navigate('/agents?tab=ensembles');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              code:
                status === 403
                  ? 'ensemble_inspection_authority_required'
                  : 'ensemble_inspection_stale',
            }),
            { status },
          ),
      ),
    );
    mount();
    fireEvent.change(
      await screen.findByLabelText('Preset path on This Station'),
      { target: { value: '/private/team.json' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Inspect configuration' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      status === 403 ? 'Inspection denied' : 'Inspection is stale',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(owner.editorReads).toBe(0);
  },
);
