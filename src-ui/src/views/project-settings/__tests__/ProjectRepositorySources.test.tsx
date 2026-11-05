/** @vitest-environment jsdom */
import type {
  ProjectIdentityView,
  ProjectResolutionView,
} from '@kontourai/station-contracts/project-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectRepositorySources } from '../ProjectRepositorySources';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function mount(
  identity: ProjectIdentityView,
  resolution: ProjectResolutionView,
) {
  const authority = {
    apiBase: 'http://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  };
  _setApiBase(authority.apiBase);
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
  const replies = {
    identity,
    resolution,
    failResolution: false,
    failAuth: false,
    previewsEnabled: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/feature-previews')
        return Response.json({
          success: true,
          data: [
            {
              id: 'repository-auth-details',
              label: 'Repository sign-in details',
              enabled: replies.previewsEnabled,
            },
          ],
        });
      if (path === '/api/integrations/status')
        return Response.json(
          replies.failAuth
            ? { success: false, error: 'Station unavailable' }
            : {
                success: true,
                data: {
                  connections: [
                    {
                      connectionId: 'github',
                      provider: 'github',
                      actions: [],
                      authentication: {
                        state: 'signed-in',
                        observedAt: 1_000,
                        account: 'checkout-owner',
                        scopes: ['repo', 'read:org'],
                      },
                    },
                  ],
                },
              },
          { status: replies.failAuth ? 503 : 200 },
        );
      if (path.endsWith('/identity'))
        return new Response(
          JSON.stringify({ success: true, data: replies.identity }),
        );
      if (path.endsWith('/resolution'))
        return new Response(
          JSON.stringify(
            replies.failResolution
              ? { success: false, error: 'Station unavailable' }
              : { success: true, data: replies.resolution },
          ),
          { status: replies.failResolution ? 503 : 200 },
        );
      throw new Error(`Unexpected repository request ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectRepositorySources
        slug="notes"
        projectId="local-notes"
        authority={authority}
        stationName="Kontour Station · build-host"
      />
    </QueryClientProvider>,
  );
  return Object.assign(replies, { client });
}

function project(): ProjectIdentityView {
  return {
    identity: {
      schemaVersion: 1,
      id: 'portable-notes',
      createdAt: '2026-11-05T00:00:00.000Z',
      updatedAt: '2026-11-05T00:00:00.000Z',
      repos: [
        {
          kind: 'git',
          id: 'github.com/example/station',
          canonicalRemote: 'github.com/example/station',
          role: 'primary',
          label: 'Station repository',
        },
        {
          kind: 'git',
          id: 'gitlab.com/example/docs',
          canonicalRemote: 'gitlab.com/example/docs',
        },
        {
          kind: 'git',
          id: 'forge.example/github.com/other',
          canonicalRemote: 'forge.example/github.com/other',
        },
      ],
      executionRoot: { repoId: 'gitlab.com/example/docs', path: 'manual' },
    },
    association: {
      portableProjectId: 'portable-notes',
      localProjectId: 'local-notes',
      localProjectSlug: 'notes',
    },
  };
}

test('repository links lead the cards, chat placement is plain, and access belongs to the checkout Station', async () => {
  const replies = mount(project(), {
    posture: 'backing',
    primary: { named: true, resourceId: 'github.com/example/station' },
    resources: [
      {
        state: 'bound',
        resourceId: 'github.com/example/station',
        path: '/srv/code/station',
      },
      {
        state: 'drifted',
        resourceId: 'gitlab.com/example/docs',
        unverifiedPath: '/srv/code/docs',
        reason: 'Origin changed',
      },
      {
        state: 'unbound',
        resourceId: 'forge.example/github.com/other',
        reason: 'Not bound',
      },
    ],
  });
  const link = await screen.findByRole('link', { name: 'example/station' });
  expect(link.getAttribute('href')).toBe('https://github.com/example/station');
  const station = link.closest('li')!;
  const docs = screen
    .getByRole('link', { name: 'example/docs' })
    .closest('li')!;
  expect(within(station).queryByText('Used for new chats')).toBeNull();
  expect(within(docs).getByText('Used for new chats')).toBeTruthy();
  expect(within(station).queryByText('Working copy verified')).toBeNull();
  expect(
    within(docs).getByText(
      'This folder points to a different repository. Choose the right folder.',
    ),
  ).toBeTruthy();
  fireEvent.click(within(station).getByText('Checkout and access details'));
  await within(station).findByText('checkout-owner');
  expect(
    within(station).getByRole('region', {
      name: 'Checkout on Kontour Station · build-host',
    }),
  ).toBeTruthy();
  expect(
    within(station).getByText('/srv/code/station').closest('dl')?.textContent,
  ).toContain('Checkout folder');
  expect(within(station).getByText('repo, read:org')).toBeTruthy();
  expect(
    within(station).getByText('Not checked by this sign-in check'),
  ).toBeTruthy();
  expect(
    within(station).getByText('Primary resource').closest('details')?.open,
  ).toBe(false);
  fireEvent.click(within(docs).getByText('Checkout and access details'));
  expect(
    within(docs).getByText('/srv/code/docs').closest('dl')?.textContent,
  ).toContain('Folder to check');
  expect(within(docs).queryByText('checkout-owner')).toBeNull();
  expect(within(docs).getByText('manual')).toBeTruthy();
  const other = screen
    .getByRole('link', { name: /github.com\/other.*forge.example/ })
    .closest('li')!;
  expect(station.querySelector('svg')).toBeTruthy();
  expect(docs.querySelector('svg')).toBeTruthy();
  expect(other.querySelector('svg')).toBeNull();
  replies.failAuth = true;
  fireEvent.click(
    within(station).getByRole('button', { name: 'Check sign-in' }),
  );
  await within(station).findByText('GitHub sign-in details unavailable');
  expect(screen.getByRole('link', { name: 'example/station' })).toBeTruthy();
  expect(within(station).queryByText('checkout-owner')).toBeNull();
  expect(within(station).queryByText('repo, read:org')).toBeNull();
  replies.failAuth = false;
  fireEvent.click(
    within(station).getByRole('button', { name: 'Retry sign-in check' }),
  );
  await within(station).findByText('checkout-owner');
  replies.previewsEnabled = false;
  await replies.client.invalidateQueries({ queryKey: ['feature-previews'] });
  await within(station).findByText(
    'Enable Repository sign-in details in Settings → Advanced → Feature previews.',
  );
  expect(within(station).queryByText('checkout-owner')).toBeNull();
  expect(within(station).queryByText('repo, read:org')).toBeNull();
});

test('failed refresh retains source identity but withdraws cached verified paths, and retry restores the current mapping', async () => {
  const view = project();
  view.identity.repos = [view.identity.repos[0]];
  delete view.identity.executionRoot;
  const replies = mount(view, {
    posture: 'backing',
    primary: { named: true, resourceId: view.identity.repos[0].id },
    resources: [
      {
        state: 'bound',
        resourceId: view.identity.repos[0].id,
        path: '/srv/code/station',
      },
    ],
  });
  await screen.findByText('/srv/code/station');
  replies.failResolution = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }));
  await screen.findByText('Checkout details unavailable');
  expect(screen.getByText('Station repository')).toBeTruthy();
  expect(
    screen.getByText('Checkout details have not been checked.'),
  ).toBeTruthy();
  expect(screen.queryByText('/srv/code/station')).toBeNull();
  replies.failResolution = false;
  replies.resolution = {
    posture: 'backing',
    primary: { named: true, resourceId: view.identity.repos[0].id },
    resources: [
      {
        state: 'bound',
        resourceId: view.identity.repos[0].id,
        path: '/srv/repaired/station',
      },
    ],
  };
  fireEvent.click(screen.getByRole('button', { name: 'Retry checkouts' }));
  await screen.findByText('/srv/repaired/station');
  expect(screen.queryByText('/srv/code/station')).toBeNull();
});

test.each([true, false])(
  'repo-free or viewing-only Station does not invent a missing checkout (repo-free %s)',
  async (empty) => {
    const view = project();
    if (empty) {
      view.identity.repos = [];
      delete view.identity.executionRoot;
    }
    mount(view, { posture: 'not-backing' });
    if (empty)
      await screen.findByText('Start with documents or connected tools');
    else
      await waitFor(() =>
        expect(
          screen.getAllByText(
            'This Station does not provide a checkout for this Project.',
          ),
        ).toHaveLength(3),
      );
    expect(
      screen.queryByText('The saved folder was not found. Check its location.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /repair|clone/i })).toBeNull();
  },
);
