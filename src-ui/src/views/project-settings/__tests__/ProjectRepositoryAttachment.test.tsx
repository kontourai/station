/** @vitest-environment jsdom */
import type { ProjectIdentityView } from '@kontourai/station-contracts/project-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectRepositoryAttachment } from '../ProjectRepositoryAttachment';

vi.mock('../../../components/modals/NewProjectRepositorySource', () => ({
  NewProjectRepositorySource: ({
    onUseCheckout,
  }: {
    onUseCheckout: (path: string, name: string, id: string) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onUseCheckout(
          '/host/checkout',
          'Repo',
          '11111111-1111-4111-8111-111111111111',
        )
      }
    >
      Choose verified repository
    </button>
  ),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('attachment is separately confirmed and a lost response retries the same identity and explicit code choice', async () => {
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
  const view: ProjectIdentityView = {
    identity: {
      schemaVersion: 1,
      id: 'portable-notes',
      repos: [{ kind: 'local-only', id: 'local:notes' }],
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
    },
    association: {
      portableProjectId: 'portable-notes',
      localProjectId: 'local-id',
      localProjectSlug: 'notes',
    },
  };
  const posts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        if (posts.length === 1) throw new TypeError('response lost');
      }
      return new Response(JSON.stringify({ success: true, data: view }));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectRepositoryAttachment
        slug="notes"
        projectId="local-id"
        authority={authority}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Choose verified repository' }),
  );
  const confirm = await screen.findByRole('button', {
    name: 'Attach repository',
  });
  expect(posts).toHaveLength(0);
  const codeChoice = screen.getByRole('checkbox', {
    name: 'Use this repository for code work in this Project',
  });
  expect(codeChoice).toHaveProperty('checked', false);
  fireEvent.click(codeChoice);
  fireEvent.click(confirm);
  const retry = await screen.findByRole('button', {
    name: 'Retry saved attachment',
  });
  expect(codeChoice).toHaveProperty('disabled', true);
  fireEvent.click(retry);
  await screen.findByText(
    'Repository attached. Sources reflects its current state.',
  );
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[0]).toMatchObject({
    expectedLocalProjectId: 'local-id',
    expectedIdentity: view.identity,
    useForCode: true,
    acquisitionId: '11111111-1111-4111-8111-111111111111',
  });
});
