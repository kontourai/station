/** @vitest-environment jsdom */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const authority = vi.hoisted(() => ({
  current: {
    apiBase: 'https://station.example.test',
    authorityKey: 'relay-account:device-generation-3',
    isCurrent: () => true,
  } as
    | {
        apiBase: string;
        authorityKey: string;
        isCurrent: () => boolean;
        requiresEnrolledCredential?: boolean;
      }
    | undefined,
}));
const sdk = vi.hoisted(() => ({
  memberView: undefined as MemberProjectView | undefined,
  detailFailure: undefined as Error | undefined,
  projectOptions: [] as Array<Record<string, unknown>>,
  operatorHook: vi.fn(),
}));
const sharedWork = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ProjectSharedTaskSummary[]>>(),
}));
const sharedDetails = vi.hoisted(() => ({
  publication: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  history: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  document: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  calls: [] as Array<{ kind: string; args: unknown[] }>,
}));
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => authority.current,
}));
vi.mock('../../../contexts/NavigationContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigation: () => ({ navigate: navigation.navigate }),
}));
vi.mock(
  '../../../contexts/AuthorityPersistenceContext',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useAuthorityPersistence: () => ({ namespace: null }),
  }),
);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  getProjectView: vi.fn(
    async (
      _apiBase: string,
      _slug: string,
      options?: Record<string, unknown>,
    ) => {
      sdk.projectOptions.push(options ?? {});
      if (!options?.requestScope) throw new Error('missing captured scope');
      if (sdk.detailFailure) throw sdk.detailFailure;
      return sdk.memberView;
    },
  ),
  useProjectLayoutsQuery: vi.fn(() => {
    sdk.operatorHook();
    throw new Error('operator Project hooks must not mount for a member');
  }),
}));

import {
  _setApiBase,
  StationHttpError,
  setClientCredentialResolver,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { ProjectPage } from '../../ProjectPage';

const project: MemberProjectView = {
  version: 'station.member-project/v1',
  kind: 'member-project',
  id: 'project-shared-1',
  slug: 'relay-shared',
  name: 'Zach shared project',
  icon: 'https://foreign.example.test/project-icon.png',
  description: 'A member-visible description',
  actions: ['view'],
};
const summary: ProjectSharedTaskSummary = {
  version: 'station.shared-project-task/v1',
  project: {
    stationId: 'station-owner-1',
    localProjectId: project.id,
    localProjectSlug: project.slug,
    portableProjectId: 'portable-project-1',
  },
  task: {
    id: 'task-1',
    title: 'Review the shared design',
    status: 'in_progress',
    createdAt: '2026-09-23T12:00:00.000Z',
  },
  shareId: '511a01d9-6226-4f12-836f-1c872b4bf584',
  sharedAt: '2026-09-23T12:01:00.000Z',
};

function installSharedTaskTransport() {
  const apiBase = 'https://station.example.test';
  setClientCredentialResolver(() => ({
    origin: apiBase,
    requestAuthority: authority.current
      ? {
          apiBase: authority.current.apiBase,
          authorityKey: authority.current.authorityKey,
          isCurrent: () => authority.current?.isCurrent() === true,
        }
      : undefined,
    transportBindingIsCurrent: () => authority.current?.isCurrent() === true,
    transport: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const segments = url.pathname.split('/').map(decodeURIComponent);
      if (url.pathname.endsWith('/shared-work'))
        return Response.json({
          success: true,
          data: await sharedWork.read(),
        });
      const kind = segments.at(-1);
      if (kind === 'publication' || kind === 'history' || kind === 'document') {
        const args = [
          url.origin,
          segments[3],
          segments[5],
          {
            requestScope: authority.current,
            requireCredential:
              authority.current?.requiresEnrolledCredential ?? true,
            timeoutMs: 15_000,
            maxResponseBytes: kind === 'publication' ? 64 * 1024 : 1024 * 1024,
            signal: init?.signal,
          },
        ];
        sharedDetails.calls.push({ kind, args });
        const data =
          kind === 'publication'
            ? await sharedDetails.publication(...args)
            : kind === 'history'
              ? await sharedDetails.history(...args)
              : await sharedDetails.document(...args);
        return Response.json({ success: true, data });
      }
      return fetch(input, init);
    },
  }));
}

function renderPage() {
  installSharedTaskTransport();
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ConnectionsProvider store={store}>
        <ProjectPage slug={project.slug} />
      </ConnectionsProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient, store };
}

function UpdateProjectControl() {
  const mutation = useUpdateProjectMutation();
  return (
    <button
      type="button"
      onClick={() =>
        void mutation.mutateAsync({
          slug: project.slug,
          workingDirectory: '/work/shared',
        })
      }
    >
      Update Project settings
    </button>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  _setApiBase('');
  authority.current = {
    apiBase: 'https://station.example.test',
    authorityKey: 'relay-account:device-generation-3',
    isCurrent: () => true,
  };
  sdk.memberView = project;
  sdk.detailFailure = undefined;
  sdk.projectOptions = [];
  sdk.operatorHook.mockClear();
  sharedWork.read.mockReset();
  sharedDetails.publication.mockReset();
  sharedDetails.history.mockReset();
  sharedDetails.document.mockReset();
  sharedDetails.calls.length = 0;
});

test('renders the member-safe Project view and shared summaries without raw icon egress', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  renderPage();

  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  expect(await screen.findByText('Review the shared design')).toBeTruthy();
  expect(screen.getByText('in progress')).toBeTruthy();
  expect(sdk.operatorHook).not.toHaveBeenCalled();
  expect(sdk.projectOptions).toHaveLength(1);
  expect(sdk.projectOptions[0]).toMatchObject({
    requestScope: {
      apiBase: 'https://station.example.test',
      authorityKey: 'relay-account:device-generation-3',
    },
    requireCredential: true,
    timeoutMs: 15_000,
    maxResponseBytes: 64 * 1024,
  });
  expect(sdk.projectOptions[0]).not.toHaveProperty('authentication', 'omit');
});

test('reads publication, human history and document through the captured member scope', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  sharedDetails.publication.mockResolvedValue({
    kind: 'shared',
    publication: summary,
  });
  sharedDetails.history.mockResolvedValue({
    kind: 'available',
    records: [
      {
        actor: { kind: 'human', label: 'Zach' },
        sequence: 2,
        body: { kind: 'human-message', text: 'Please review this section.' },
        digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
        integrity: 'L0',
      },
    ],
    checkpoint: {
      throughSeq: 2,
      checkpointDigest: 'b'.repeat(64),
      retainedAnchorSeq: 1,
      retainedAnchorDigest: 'a'.repeat(64),
    },
    hasMore: false,
  });
  sharedDetails.document.mockResolvedValue({
    kind: 'snapshot',
    project: { id: project.id, slug: project.slug },
    task: { id: summary.task.id, createdAt: summary.task.createdAt },
    revision: 'revision-1',
    text: '# Shared design\n\nThe reviewed decision.',
  });
  renderPage();

  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Read shared item: Review the shared design',
    }),
  );
  await screen.findByText(/Shared on/);
  await waitFor(() =>
    expect(sharedDetails.calls.map((call) => call.kind).sort()).toEqual([
      'document',
      'history',
      'publication',
    ]),
  );
  expect(await screen.findByText('Please review this section.')).toBeTruthy();
  expect(screen.getByLabelText('Shared document').textContent).toContain(
    '# Shared design\n\nThe reviewed decision.',
  );
  expect(screen.getByText(/Shared on/)).toBeTruthy();
  expect(sharedDetails.calls.map((call) => call.kind).sort()).toEqual([
    'document',
    'history',
    'publication',
  ]);
  for (const { args } of sharedDetails.calls) {
    expect(args[0]).toBe('https://station.example.test');
    expect(args[1]).toBe(project.slug);
    expect(args[2]).toBe(summary.task.id);
    expect(args[3]).toMatchObject({
      requestScope: authority.current,
      requireCredential: true,
      timeoutMs: 15_000,
    });
    expect(args[3]).toHaveProperty('signal');
  }
  expect(sdk.operatorHook).not.toHaveBeenCalled();
});

test('hides cached history and document while publication is stale or unshared', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  sharedDetails.publication.mockResolvedValue({
    kind: 'shared',
    publication: summary,
  });
  sharedDetails.history.mockResolvedValue({
    kind: 'available',
    records: [
      {
        actor: { kind: 'human', label: 'Zach' },
        sequence: 2,
        body: { kind: 'human-message', text: 'Private stale history' },
        digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
        integrity: 'L0',
      },
    ],
    checkpoint: {
      throughSeq: 2,
      checkpointDigest: 'b'.repeat(64),
      retainedAnchorSeq: 1,
      retainedAnchorDigest: 'a'.repeat(64),
    },
    hasMore: false,
  });
  sharedDetails.document.mockResolvedValue({
    kind: 'snapshot',
    project: { id: project.id, slug: project.slug },
    task: { id: summary.task.id, createdAt: summary.task.createdAt },
    revision: 'revision-1',
    text: 'Private stale document',
  });
  renderPage();
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Read shared item: Review the shared design',
    }),
  );
  expect(await screen.findByText('Private stale history')).toBeTruthy();
  expect(await screen.findByText('Private stale document')).toBeTruthy();

  let resolvePublication: (value: unknown) => void = () => {};
  const delayedPublication = new Promise<unknown>((resolve) => {
    resolvePublication = resolve;
  });
  sharedDetails.publication.mockReturnValueOnce(delayedPublication);
  fireEvent.click(
    screen.getByRole('button', { name: 'Refresh publication status' }),
  );
  await waitFor(() =>
    expect(
      screen.getByText(
        'History is hidden until a current publication is confirmed.',
      ),
    ).toBeTruthy(),
  );
  expect(screen.queryByText('Private stale history')).toBeNull();
  expect(screen.queryByText('Private stale document')).toBeNull();

  resolvePublication({
    kind: 'unshared',
    project: summary.project,
    task: { id: summary.task.id, createdAt: summary.task.createdAt },
  });
  expect(
    await screen.findByText('This shared item is no longer published.'),
  ).toBeTruthy();
  expect(screen.queryByText('Private stale history')).toBeNull();
  expect(screen.queryByText('Private stale document')).toBeNull();
});

test('reads its own Station through a cookie session without requiring an enrolled credential (#2598)', async () => {
  authority.current = {
    apiBase: 'https://station.example.test',
    authorityKey: 'local-session',
    isCurrent: () => true,
    requiresEnrolledCredential: false,
  };
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  renderPage();

  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeTruthy();
  expect(sdk.projectOptions[0]).toMatchObject({ requireCredential: false });
});

test('still requires the enrolled credential over a relay route', async () => {
  authority.current = {
    apiBase: 'https://station.example.test',
    authorityKey: 'relay-account:device-generation-3',
    isCurrent: () => true,
    requiresEnrolledCredential: true,
  };
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  renderPage();

  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeTruthy();
  expect(sdk.projectOptions[0]).toMatchObject({ requireCredential: true });
});

test('an operator Project update invalidates the member-aware Project page detail cache', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  installSharedTaskTransport();
  _setApiBase('https://station.example.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: true, data: { updated: true } }),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectionsProvider
        store={
          new ConnectionStore({
            storage: {
              get: () => null,
              set: () => {},
              remove: () => {},
            },
          })
        }
      >
        <ProjectPage slug={project.slug} />
        <UpdateProjectControl />
      </ConnectionsProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Review the shared design')).toBeTruthy();
  const initialDetailReads = sdk.projectOptions.length;
  setClientCredentialResolver(undefined);
  fireEvent.click(
    screen.getByRole('button', { name: 'Update Project settings' }),
  );
  await waitFor(() =>
    expect(sdk.projectOptions.length).toBeGreaterThan(initialDetailReads),
  );
});

test('withholds previously loaded shared work after Station refuses the member scope', async () => {
  sharedWork.read
    .mockResolvedValueOnce([summary])
    .mockRejectedValueOnce(new StationHttpError(403));
  renderPage();

  expect(await screen.findByText('Review the shared design')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh shared work' }));
  expect(
    await screen.findByText(
      'Your access may have changed. Refresh the Project to check again.',
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByText('Review the shared design')).toBeNull(),
  );
  expect(sharedWork.read).toHaveBeenCalledTimes(2);
  expect(sdk.operatorHook).not.toHaveBeenCalled();
});

test('does not issue an unscoped request or show cached member details after authority loss', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  const rendered = renderPage();
  expect(await screen.findByText('Review the shared design')).toBeTruthy();

  authority.current = undefined;
  rendered.rerender(
    <QueryClientProvider client={rendered.queryClient}>
      <ConnectionsProvider store={rendered.store}>
        <ProjectPage slug={project.slug} />
      </ConnectionsProvider>
    </QueryClientProvider>,
  );
  expect(
    screen.getByText(
      'Connect to a Station with current access to this Project.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(project.name)).toBeNull();
  await waitFor(() =>
    expect(
      rendered.queryClient.getQueryData([
        'member-project-shared-work',
        'https://station.example.test',
        'relay-account:device-generation-3',
        project.id,
        project.slug,
      ]),
    ).toBeUndefined(),
  );
  expect(sdk.operatorHook).not.toHaveBeenCalled();
});

test('redacts Station detail errors that could disclose a private Project', async () => {
  sdk.detailFailure = new StationHttpError(
    404,
    'private project exists at /srv/private/path',
  );
  renderPage();

  expect(await screen.findByText('Could not load project')).toBeTruthy();
  expect(
    screen.getByText('This Project is unavailable or your access has changed.'),
  ).toBeTruthy();
  expect(screen.queryByText(/private project exists/)).toBeNull();
  expect(screen.queryByText(project.name)).toBeNull();
  expect(sdk.operatorHook).not.toHaveBeenCalled();
});
