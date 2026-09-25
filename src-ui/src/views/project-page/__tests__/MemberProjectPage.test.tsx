/** @vitest-environment jsdom */

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

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => authority.current,
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
vi.mock('@kontourai/station-sdk/project-shared-tasks', () => ({
  listProjectSharedTasks: (...args: unknown[]) => {
    const [base, slug, options] = args as [string, string, unknown];
    expect(base).toBe('https://station.example.test');
    expect(slug).toBe('relay-shared');
    const opts = options as Record<string, unknown>;
    expect(opts.requireCredential).toBe(
      authority.current?.requiresEnrolledCredential ?? true,
    );
    expect(opts.authentication).not.toBe('omit');
    expect(opts.requestScope).toEqual(authority.current);
    return sharedWork.read();
  },
}));

import {
  _setApiBase,
  StationHttpError,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { ProjectPage } from '../../ProjectPage';

const project: MemberProjectView = {
  version: 'station.member-project/v1',
  kind: 'member-project',
  id: 'project-shared-1',
  slug: 'relay-shared',
  name: 'Zach shared project',
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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <ProjectPage slug={project.slug} />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
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
});

test('renders the member-safe Project view and shared summaries through one captured signed scope', async () => {
  sdk.memberView = project;
  sharedWork.read.mockResolvedValue([summary]);
  renderPage();

  expect(
    await screen.findByRole('heading', { name: project.name }),
  ).toBeTruthy();
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
      <ProjectPage slug={project.slug} />
      <UpdateProjectControl />
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Review the shared design')).toBeTruthy();
  const initialDetailReads = sdk.projectOptions.length;
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
      <ProjectPage slug={project.slug} />
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
