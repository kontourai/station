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
  const replies = { identity, resolution, failResolution: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname;
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
  return replies;
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

test('repository identity leads multiple Station-qualified mappings and keeps primary distinct from the starting resource', async () => {
  mount(project(), {
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
  const station = (await screen.findByText('Station repository')).closest(
    'li',
  )!;
  const docs = screen.getByText('example/docs').closest('li')!;
  expect(within(station).getByText('Primary resource')).toBeTruthy();
  expect(within(station).queryByText('Agent starting resource')).toBeNull();
  expect(within(docs).getByText('Agent starting resource')).toBeTruthy();
  expect(within(docs).getByText('Repository changed')).toBeTruthy();
  fireEvent.click(within(station).getByText('Details for Station repository'));
  expect(
    within(station).getByText('Kontour Station · build-host'),
  ).toBeTruthy();
  expect(
    within(station).getByText('/srv/code/station').closest('dl')?.textContent,
  ).toContain('Verified path');
  fireEvent.click(
    within(docs).getByText('Details for gitlab.com/example/docs'),
  );
  expect(
    within(docs).getByText('/srv/code/docs').closest('dl')?.textContent,
  ).toContain('Directory found — identity not verified');
  expect(within(docs).queryByText('Verified path')).toBeNull();
  expect(within(docs).getByText('manual')).toBeTruthy();
  const other = screen.getByText('github.com/other').closest('li')!;
  expect(station.querySelector('svg')).toBeTruthy();
  expect(docs.querySelector('svg')).toBeTruthy();
  expect(other.querySelector('svg')).toBeNull();
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
  await screen.findByText('Working copy verified');
  replies.failResolution = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }));
  await screen.findByText('Working copy availability unknown');
  expect(screen.getByText('Station repository')).toBeTruthy();
  expect(screen.queryByText('Working copy verified')).toBeNull();
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
  fireEvent.click(screen.getByRole('button', { name: 'Retry working copies' }));
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
    if (empty) await screen.findByText('No repositories attached');
    else
      await waitFor(() =>
        expect(
          screen.getAllByText('No working copy on this Station'),
        ).toHaveLength(3),
      );
    expect(screen.queryByText('Working copy missing')).toBeNull();
    expect(screen.queryByRole('button', { name: /repair|clone/i })).toBeNull();
  },
);
