/** @vitest-environment jsdom */
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectPullRequestSettings } from '../ProjectPullRequestSettings';

vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(['pull-request-agent-feedback']),
}));

const project: ProjectConfig = {
  id: 'p1',
  slug: 'widgets',
  name: 'Widgets',
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
  workingDirectory: '/repos/widgets',
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('inactive settings render no placeholder and remount rechecks the repository before offering controls', async () => {
  const authority = {
    apiBase: 'http://station.test',
    authorityKey: 'owner',
    isCurrent: () => true,
  };
  _setApiBase(authority.apiBase);
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
  let available = true;
  let contextReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(String(url));
      expect(path.pathname).toBe('/api/pull-requests/context');
      expect(path.searchParams.get('project')).toBe('widgets');
      expect(path.searchParams.get('workingDirectory')).toBe('/repos/widgets');
      contextReads += 1;
      return Response.json({
        success: true,
        data: available
          ? {
              available: true,
              provider: 'github',
              automation: { feedback: true, taskBranchDiscovery: true },
              host: 'github.com',
              repository: { owner: 'acme', name: 'widgets' },
            }
          : {
              available: false,
              reason: 'The saved folder has no forge repository.',
            },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
  });
  clients.push(client);
  const panel = (active: boolean) => (
    <QueryClientProvider client={client}>
      <ProjectPullRequestSettings
        project={project}
        slug="widgets"
        active={active}
        feedbackAvailable={false}
        onSaved={() => {}}
        onSources={() => {}}
      />
    </QueryClientProvider>
  );
  const first = render(panel(false));
  expect(first.container.firstChild).toBeNull();
  expect(contextReads).toBe(0);
  first.rerender(panel(true));
  expect(
    await screen.findByRole('switch', { name: 'Watch Task pull requests' }),
  ).toBeTruthy();
  expect(contextReads).toBe(1);
  first.unmount();
  available = false;
  render(panel(true));
  await waitFor(() => expect(contextReads).toBe(2));
  expect(
    await screen.findByText('Add a repository to use pull requests'),
  ).toBeTruthy();
  expect(
    screen.queryByRole('switch', { name: 'Watch Task pull requests' }),
  ).toBeNull();
});
