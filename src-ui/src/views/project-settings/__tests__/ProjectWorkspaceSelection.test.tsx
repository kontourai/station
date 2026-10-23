/** @vitest-environment jsdom */
import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectWorkspaceSelection } from '../ProjectWorkspaceSelection';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('selecting a second checkout is explicit and a lost response retries the exact saved identity and relative directory', async () => {
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
  let view: ProjectIdentityView = {
    identity: {
      schemaVersion: 1,
      id: 'shared',
      repos: [
        {
          kind: 'git',
          id: 'github.com/example/frontend',
          canonicalRemote: 'github.com/example/frontend',
          role: 'primary',
        },
        {
          kind: 'git',
          id: 'github.com/example/backend',
          canonicalRemote: 'github.com/example/backend',
        },
      ],
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
    association: {
      portableProjectId: 'shared',
      localProjectId: 'local',
      localProjectSlug: 'multi',
    },
  };
  const before = structuredClone(view);
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/identity/execution-root') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        view = {
          ...view,
          identity: {
            ...view.identity,
            executionRoot: body.executionRoot,
            updatedAt: '2026-10-22T00:01:00.000Z',
          },
        };
        if (writes.length === 1) throw new TypeError('response lost');
        return new Response(JSON.stringify({ success: true, data: view }));
      }
      if (path.endsWith('/identity'))
        return new Response(JSON.stringify({ success: true, data: view }));
      if (path.endsWith('/resolution'))
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              posture: 'backing',
              resources: [
                {
                  state: 'bound',
                  resourceId: 'github.com/example/frontend',
                  path: '/host/frontend',
                },
                {
                  state: 'bound',
                  resourceId: 'github.com/example/backend',
                  path: '/host/backend',
                },
              ],
              primary: {
                named: true,
                resourceId: 'github.com/example/frontend',
              },
            },
          }),
        );
      throw new Error(`Unexpected workspace request ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkspaceSelection
        slug="multi"
        projectId="local"
        authority={authority}
      />
    </QueryClientProvider>,
  );
  const picker = await screen.findByRole('combobox', {
    name: 'Starting repository or folder',
  });
  await waitFor(() =>
    expect(
      picker
        .querySelector('option[value="github.com/example/backend"]')
        ?.hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.change(picker, { target: { value: 'github.com/example/backend' } });
  fireEvent.change(
    screen.getByLabelText('Starting directory within that resource'),
    { target: { value: 'apps/api' } },
  );
  expect(writes).toHaveLength(0);
  fireEvent.click(
    screen.getByRole('button', { name: 'Apply starting directory' }),
  );
  await screen.findByRole('button', { name: 'Retry saved directory choice' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Retry saved directory choice' }),
  );
  await screen.findByText('Starting directory updated for new sessions.');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toEqual({
    expectedIdentity: before.identity,
    expectedLocalProjectId: 'local',
    executionRoot: { repoId: 'github.com/example/backend', path: 'apps/api' },
  });
  expect(view.identity.repos).toEqual(before.identity.repos);
});
