/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GuestSharedTaskView } from '../GuestSharedTaskView';

const apiBase = 'https://station.example.test';
const principalA = `human:deployment:${'a'.repeat(64)}`;
const principalB = `human:deployment:${'b'.repeat(64)}`;
const taskId = 'same-local-task';
const project = (id: string, slug: string) => ({ id, slug });
const summary = (projectId: string, slug: string, title: string) => ({
  version: 'station.shared-project-task/v1',
  project: {
    stationId: 'station-1',
    localProjectId: projectId,
    localProjectSlug: slug,
    portableProjectId: `portable-${projectId}`,
  },
  task: {
    id: taskId,
    title,
    status: 'in_progress',
    createdAt: '2026-09-20T00:00:00.000Z',
  },
  shareId: '11111111-1111-4111-8111-111111111111',
  sharedAt: '2026-09-20T00:01:00.000Z',
});
const history = (text: string) => ({
  kind: 'available',
  records: [
    {
      actor: { kind: 'human', label: 'Project member' },
      sequence: 1,
      body: { kind: 'human-message', text },
      digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
      integrity: 'L0',
    },
  ],
  checkpoint: {
    throughSeq: 1,
    checkpointDigest: 'b'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'c'.repeat(64),
  },
  hasMore: false,
});
const account = (principalId = principalA) =>
  Response.json({
    data: {
      principal: { id: principalId, kind: 'human', display: 'Guest' },
      issuer: 'station:test',
      expiresAt: '2099-01-01T00:00:00.000Z',
      contacts: [],
    },
  });
const success = (data: unknown) => Response.json({ success: true, data });

afterEach(() => vi.unstubAllGlobals());

function mount(
  selectedProject = project('project-a', 'alpha'),
  onScopeLost = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <GuestSharedTaskView
        key={`${selectedProject.id}:${selectedProject.slug}`}
        apiBase={apiBase}
        principalId={principalA}
        project={selectedProject}
        onScopeLost={onScopeLost}
      />
    </QueryClientProvider>,
  );
  return { client, onScopeLost, rendered };
}

test('opens only the clicked shared Task human history and document', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      if (path.endsWith('/shared-work'))
        return success([summary('project-a', 'alpha', 'Shared planning')]);
      if (path.endsWith('/history')) return success(history('Visible message'));
      if (path.endsWith('/document'))
        return success({
          kind: 'snapshot',
          project: { id: 'project-a', slug: 'alpha' },
          task: { id: taskId, createdAt: '2026-09-20T00:00:00.000Z' },
          revision: 'revision-1',
          text: '<script>not markup</script>\nVisible document',
        });
      return new Response(null, { status: 500 });
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  expect(await screen.findByText('Visible message')).toBeTruthy();
  expect(screen.getByText(/<script>not markup<\/script>/)).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
});

test('the same Task id in two Projects never reuses content or cache authority', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      const beta = path.includes('/projects/beta/');
      if (path.endsWith('/shared-work'))
        return success([
          summary(
            beta ? 'project-b' : 'project-a',
            beta ? 'beta' : 'alpha',
            beta ? 'Beta Task' : 'Alpha Task',
          ),
        ]);
      if (path.endsWith('/history'))
        return success(history(beta ? 'Beta message' : 'Alpha message'));
      if (path.endsWith('/document')) return success({ kind: 'unavailable' });
      return new Response(null, { status: 500 });
    }),
  );
  const { client, rendered } = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  expect(await screen.findByText('Alpha message')).toBeTruthy();
  rendered.rerender(
    <QueryClientProvider client={client}>
      <GuestSharedTaskView
        key="project-b:beta"
        apiBase={apiBase}
        principalId={principalA}
        project={project('project-b', 'beta')}
        onScopeLost={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Beta Task')).toBeTruthy();
  expect(screen.queryByText('Alpha message')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Read shared Task' }));
  expect(await screen.findByText('Beta message')).toBeTruthy();
  expect(
    client.getQueryData([
      'guest-shared-task-history',
      apiBase,
      principalA,
      'project-a',
      'alpha',
      'station-1',
      'project-a',
      'portable-project-a',
      '11111111-1111-4111-8111-111111111111',
      taskId,
      '2026-09-20T00:00:00.000Z',
    ]),
  ).toBeUndefined();
});

test('a late Project response cannot repopulate a replacement Project', async () => {
  let resolveAlpha!: (response: Response) => void;
  const alphaHistory = new Promise<Response>((resolve) => {
    resolveAlpha = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session')
        return Promise.resolve(account());
      const beta = path.includes('/projects/beta/');
      if (path.endsWith('/shared-work'))
        return Promise.resolve(
          success([
            summary(
              beta ? 'project-b' : 'project-a',
              beta ? 'beta' : 'alpha',
              beta ? 'Beta Task' : 'Alpha Task',
            ),
          ]),
        );
      if (path.endsWith('/history'))
        return beta
          ? Promise.resolve(success(history('Beta message')))
          : alphaHistory;
      if (path.endsWith('/document'))
        return Promise.resolve(success({ kind: 'unavailable' }));
      return Promise.resolve(new Response(null, { status: 500 }));
    }),
  );
  const { client, rendered } = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  rendered.rerender(
    <QueryClientProvider client={client}>
      <GuestSharedTaskView
        key="project-b:beta"
        apiBase={apiBase}
        principalId={principalA}
        project={project('project-b', 'beta')}
        onScopeLost={vi.fn()}
      />
    </QueryClientProvider>,
  );
  resolveAlpha(success(history('Late Alpha message')));
  expect(await screen.findByText('Beta Task')).toBeTruthy();
  expect(screen.queryByText('Late Alpha message')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Read shared Task' }));
  expect(await screen.findByText('Beta message')).toBeTruthy();
});

test('revoked publication hides content and reports scope loss', async () => {
  const onScopeLost = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }),
  );
  mount(project('project-a', 'alpha'), onScopeLost);
  await waitFor(() => expect(onScopeLost).toHaveBeenCalledOnce());
  expect(screen.queryByText('Shared Tasks')).toBeNull();
});

test.each([
  ['gap', 'Shared history is incomplete'],
  ['too-large', 'Shared history is too large'],
  ['unavailable', 'Shared history is unavailable'],
] as const)(
  'names %s history without presenting it as empty',
  async (kind, copy) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        if (path === '/api/account-auth/session') return account();
        if (path.endsWith('/shared-work'))
          return success([summary('project-a', 'alpha', 'Shared planning')]);
        if (path.endsWith('/history')) return success({ kind });
        if (path.endsWith('/document')) return success({ kind: 'too-large' });
        return new Response(null, { status: 500 });
      }),
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Read shared Task' }),
    );
    expect(await screen.findByText(new RegExp(copy))).toBeTruthy();
    expect(
      screen.getByText('Shared document is too large to display.'),
    ).toBeTruthy();
    expect(screen.queryByText(/No human messages/)).toBeNull();
  },
);

test('an unshared Task hides a concurrently delivered document snapshot', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      if (path.endsWith('/shared-work'))
        return success([summary('project-a', 'alpha', 'Shared planning')]);
      if (path.endsWith('/history')) return success({ kind: 'not-found' });
      if (path.endsWith('/document'))
        return success({
          kind: 'snapshot',
          project: { id: 'project-a', slug: 'alpha' },
          task: { id: taskId, createdAt: '2026-09-20T00:00:00.000Z' },
          revision: 'stale-revision',
          text: 'Must be hidden',
        });
      return new Response(null, { status: 500 });
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  expect(
    await screen.findByText(
      'This Task is no longer shared. Shared Tasks were refreshed.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Must be hidden')).toBeNull();
  expect(
    screen.queryByRole('region', { name: 'Shared planning shared content' }),
  ).toBeNull();
});

test('a refreshed publication with the same Task id loads its new content identity', async () => {
  let generation = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      if (path.endsWith('/shared-work')) {
        const value = summary('project-a', 'alpha', 'Shared planning');
        return success([
          {
            ...value,
            shareId:
              generation === 1
                ? value.shareId
                : '22222222-2222-4222-8222-222222222222',
            task: {
              ...value.task,
              createdAt:
                generation === 1
                  ? value.task.createdAt
                  : '2026-09-21T00:00:00.000Z',
            },
          },
        ]);
      }
      if (path.endsWith('/history'))
        return success(history(`Generation ${generation}`));
      if (path.endsWith('/document')) return success({ kind: 'unavailable' });
      return new Response(null, { status: 500 });
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  expect(await screen.findByText('Generation 1')).toBeTruthy();
  generation = 2;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shared Tasks' }));
  expect(await screen.findByText('Generation 2')).toBeTruthy();
  expect(screen.queryByText('Generation 1')).toBeNull();
});

test('a wrong-scope document snapshot closes the shared Project detail', async () => {
  const onScopeLost = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      if (path.endsWith('/shared-work'))
        return success([summary('project-a', 'alpha', 'Shared planning')]);
      if (path.endsWith('/history')) return success({ kind: 'unavailable' });
      if (path.endsWith('/document'))
        return success({
          kind: 'snapshot',
          project: { id: 'different-project', slug: 'alpha' },
          task: { id: taskId, createdAt: '2026-09-20T00:00:00.000Z' },
          revision: 'wrong-scope',
          text: 'Must not render',
        });
      return new Response(null, { status: 500 });
    }),
  );
  mount(project('project-a', 'alpha'), onScopeLost);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  await waitFor(() => expect(onScopeLost).toHaveBeenCalledOnce());
  expect(screen.queryByText('Must not render')).toBeNull();
});

test('a publication refresh closes selected leaf content when sharing disappears', async () => {
  let published = true;
  const onScopeLost = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') return account();
      if (path.endsWith('/shared-work'))
        return success(
          published ? [summary('project-a', 'alpha', 'Shared planning')] : [],
        );
      if (path.endsWith('/history'))
        return success(history('Initially shared'));
      if (path.endsWith('/document')) return success({ kind: 'unavailable' });
      return new Response(null, { status: 500 });
    }),
  );
  mount(project('project-a', 'alpha'), onScopeLost);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Read shared Task' }),
  );
  expect(await screen.findByText('Initially shared')).toBeTruthy();
  published = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shared Tasks' }));
  await waitFor(() => expect(onScopeLost).toHaveBeenCalledOnce());
  expect(screen.queryByText('Initially shared')).toBeNull();
});

test('an account replacement closes a delivered shared Task', async () => {
  let currentPrincipal = principalA;
  let sessionReads = 0;
  const onScopeLost = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/api/account-auth/session') {
        sessionReads += 1;
        if (sessionReads > 1) currentPrincipal = principalB;
        return account(currentPrincipal);
      }
      if (path.endsWith('/shared-work'))
        return success([summary('project-a', 'alpha', 'Shared planning')]);
      return success({ kind: 'unavailable' });
    }),
  );
  mount(project('project-a', 'alpha'), onScopeLost);
  await waitFor(() => expect(onScopeLost).toHaveBeenCalledOnce());
  expect(screen.queryByText('Shared planning')).toBeNull();
});
