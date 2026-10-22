/** @vitest-environment jsdom */

import type { ProjectStartIntent } from '@kontourai/station-contracts/project';
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
import type { FormEvent } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNewProjectSubmit } from '../hooks/useNewProjectSubmit';

const host = vi.hoisted(() => ({
  scope: {
    apiBase: 'http://station.test',
    authorityKey: 'account-a-epoch1',
    draftRecoveryKey: 'account-a',
    isCurrent: () => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => host.scope,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFileSystemBrowseQuery: () => ({
    refetch: async () => ({ data: { entries: [] } }),
  }),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  localStorage.clear();
  host.scope = {
    apiBase: 'http://station.test',
    authorityKey: 'account-a-epoch1',
    draftRecoveryKey: 'account-a',
    isCurrent: () => true,
  };
  _setApiBase(host.scope.apiBase);
  setClientCredentialResolver(() => {
    const captured = host.scope;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => host.scope === captured,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const draft = {
  name: 'Original research',
  slug: 'research',
  workingDirectory: '/selected/repository',
};
function Harness({
  empty = false,
  complete,
  startIntent = 'workspace',
}: {
  empty?: boolean;
  complete: (slug: string, layout?: string) => void;
  startIntent?: ProjectStartIntent;
}) {
  const submission = useNewProjectSubmit({
    apiBase: host.scope.apiBase,
    isOpen: true,
    derivedSlug: empty ? '' : draft.slug,
    normalizedDirectory: empty ? '' : draft.workingDirectory,
    starterLayoutId:
      startIntent === 'knowledge'
        ? null
        : empty
          ? 'builtin:review'
          : 'builtin:coding',
    startIntent,
    onComplete: complete,
  });
  return (
    <form
      onSubmit={(event: FormEvent) =>
        void submission.submit(event, empty ? { name: '', slug: '' } : draft)
      }
    >
      <output>
        {submission.recovery.pending ? 'Saved creation' : 'New creation'}
      </output>
      <output>
        {submission.hasCreatedProject
          ? 'Project observed'
          : 'Project not observed'}
      </output>
      <output>
        {submission.recovery.corrupt ? 'Corrupt saved setup' : ''}
      </output>
      <p role="alert">{submission.error}</p>
      <button
        type="submit"
        disabled={submission.submitting || submission.recoveryBusy}
      >
        Continue
      </button>
      <button type="button" onClick={submission.setAsideRecovery}>
        Set aside
      </button>
    </form>
  );
}
function mount(
  complete = vi.fn(),
  empty = false,
  startIntent?: ProjectStartIntent,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <Harness complete={complete} empty={empty} startIntent={startIntent} />
    </QueryClientProvider>,
  );
  return { ...view, complete, client };
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
  });
}
function storageKey() {
  return JSON.stringify([
    'project-creation',
    host.scope.apiBase,
    host.scope.draftRecoveryKey,
  ]);
}

test('a knowledge start keeps its destination across lost creation response and a workspace-default remount', async () => {
  let id = '';
  let posts = 0;
  const project = {
    id: 'project-original',
    slug: 'research',
    name: 'Original research',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/projects/creation-requests'))
        return response({ available: true });
      if (url.endsWith('/api/projects') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        id = body.creationRequestId;
        posts++;
        expect(body).not.toHaveProperty('startIntent');
        expect(body.starterLayoutId).toBeNull();
        throw new Error('Lost creation response');
      }
      if (id && url.endsWith(`/creation-requests/${id}`))
        return response({
          requestId: id,
          projectId: project.id,
          phase: 'created',
          project,
        });
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const first = mount(vi.fn(), false, 'knowledge');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(posts).toBe(1));
  expect(localStorage.getItem(storageKey())).toContain(
    '"startIntent":"knowledge"',
  );
  first.unmount();
  first.client.clear();
  const restored = mount(vi.fn(), true);
  await screen.findByText('Project observed');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue' }).matches(':disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(restored.complete).toHaveBeenCalledWith(
      'research',
      undefined,
      'knowledge',
    ),
  );
  expect(posts).toBe(1);
});

test('lost creation and starter responses recover after remount without duplicating either effect or replacing the selected starter', async () => {
  let requestId = '';
  let projectPosts = 0;
  let starterPosts = 0;
  let applied = false;
  const project = {
    id: 'project-original',
    slug: 'research',
    name: 'Original research',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response({ available: true });
      if (
        url === 'http://station.test/api/projects' &&
        init?.method === 'POST'
      ) {
        const body = JSON.parse(String(init.body));
        requestId = body.creationRequestId;
        projectPosts += 1;
        expect(body).toMatchObject({
          ...draft,
          starterLayoutId: 'builtin:coding',
        });
        throw new Error('response lost after Project publication');
      }
      if (
        url ===
        `http://station.test/api/projects/creation-requests/${requestId}`
      )
        return response({
          requestId,
          projectId: project.id,
          phase: 'created',
          project,
          ...(applied
            ? {
                starter: {
                  catalogId: 'builtin:coding',
                  layoutId: 'layout-original',
                  phase: 'applied',
                  layoutSlug: 'coding',
                },
              }
            : {}),
        });
      if (
        url === 'http://station.test/api/projects/research/layouts/apply' &&
        init?.method === 'POST'
      ) {
        starterPosts += 1;
        expect(JSON.parse(String(init.body))).toMatchObject({
          layoutId: 'builtin:coding',
          creationRequestId: requestId,
        });
        applied = true;
        throw new Error('response lost after starter publication');
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const first = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Saved creation');
  await waitFor(() => expect(projectPosts).toBe(1));
  expect(localStorage.getItem(storageKey())).toContain(requestId);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('response lost'),
  );
  first.unmount();
  first.client.clear();
  const second = mount(vi.fn(), true);
  await screen.findByText('Project observed');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue' }).matches(':disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(starterPosts).toBe(1));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('response lost'),
  );
  second.unmount();
  second.client.clear();
  const third = mount(vi.fn(), true);
  await screen.findByText('Project observed');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue' }).matches(':disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(third.complete).toHaveBeenCalledWith('research', 'coding'),
  );
  expect(projectPosts).toBe(1);
  expect(starterPosts).toBe(1);
  expect(localStorage.getItem(storageKey())).toBeNull();
});

test('saved setup is hidden from another account and recovers on the creating account with a fresh epoch', async () => {
  const id = 'f665d155-bd50-4ddc-922d-1a75136bafde';
  localStorage.setItem(
    storageKey(),
    JSON.stringify({ requestId: id, draft, starterLayoutId: null }),
  );
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response({ available: true });
      if (url === `http://station.test/api/projects/creation-requests/${id}`) {
        reads.push(host.scope.draftRecoveryKey);
        return response({
          requestId: id,
          projectId: 'original',
          phase: 'created',
          project: { id: 'original', slug: 'research', name: draft.name },
        });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  host.scope = {
    ...host.scope,
    authorityKey: 'account-b-epoch2',
    draftRecoveryKey: 'account-b',
  };
  const other = mount(vi.fn(), true);
  await screen.findByText('New creation');
  expect(screen.queryByText('Saved creation')).toBeNull();
  expect(reads).toEqual([]);
  other.unmount();
  other.client.clear();
  host.scope = {
    ...host.scope,
    authorityKey: 'account-a-epoch3',
    draftRecoveryKey: 'account-a',
  };
  const returning = mount(vi.fn(), true);
  await screen.findByText('Project observed');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue' }).matches(':disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(returning.complete).toHaveBeenCalledWith('research', undefined),
  );
  expect(reads.every((owner) => owner === 'account-a')).toBe(true);
});

test('storage failure refuses dispatch, and malformed retained setup requires explicit set-aside', async () => {
  const posts = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response({ available: true });
      posts(url);
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const view = mount();
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('Storage is unavailable');
    });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'Storage is unavailable',
    ),
  );
  expect(posts).not.toHaveBeenCalled();
  write.mockRestore();
  view.unmount();
  view.client.clear();
  localStorage.setItem(storageKey(), '{broken');
  const reopened = mount();
  await screen.findByText('Corrupt saved setup');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain(
      'could not be read',
    ),
  );
  expect(posts).not.toHaveBeenCalled();
  expect(localStorage.getItem(storageKey())).toBe('{broken');
  fireEvent.click(screen.getByRole('button', { name: 'Set aside' }));
  expect(localStorage.getItem(storageKey())).toBeNull();
  expect(reopened.complete).not.toHaveBeenCalled();
});

test('a successful first response clears the saved request before completion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response({ available: true });
      if (url === 'http://station.test/api/projects' && init?.method === 'POST')
        return response({ id: 'original', name: draft.name, slug: draft.slug });
      if (url === 'http://station.test/api/projects/research/layouts/apply')
        return response({ id: 'layout', slug: 'coding' });
      if (url.startsWith('http://station.test/api/projects/creation-requests/'))
        return response(undefined, 404);
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(view.complete).toHaveBeenCalledWith('research', 'coding'),
  );
  expect(localStorage.getItem(storageKey())).toBeNull();
});

test('a Station predating the capability endpoint keeps the ordinary create protocol', async () => {
  let received: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response(undefined, 404);
      if (
        url === 'http://station.test/api/projects' &&
        init?.method === 'POST'
      ) {
        received = JSON.parse(String(init.body));
        return response({ id: 'legacy', slug: draft.slug });
      }
      if (url === 'http://station.test/api/projects/research/layouts/apply')
        return response({ id: 'legacy-layout', slug: 'coding' });
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() =>
    expect(view.complete).toHaveBeenCalledWith('research', 'coding'),
  );
  expect(received).toEqual(draft);
  expect(localStorage.getItem(storageKey())).toBeNull();
});

test('a tab with stale corrupt state cannot clear a newer valid request saved by another tab', async () => {
  localStorage.setItem(storageKey(), '{broken');
  const id = 'd72324e6-6e5e-41ec-9d04-6196d988d4cc';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'http://station.test/api/projects/creation-requests')
        return response({ available: true });
      if (url === `http://station.test/api/projects/creation-requests/${id}`)
        return response(undefined, 404);
      throw new Error(`Unexpected fixture request: ${url}`);
    }),
  );
  mount();
  await screen.findByText('Corrupt saved setup');
  const newer = JSON.stringify({ requestId: id, draft, starterLayoutId: null });
  localStorage.setItem(storageKey(), newer);
  fireEvent.click(screen.getByRole('button', { name: 'Set aside' }));
  expect(localStorage.getItem(storageKey())).toBe(newer);
  await screen.findByText('Saved creation');
});
