// @vitest-environment jsdom
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeStores } from '../ProjectKnowledgeStores';

const state = vi.hoisted(() => ({
  roots: [] as KnowledgeStoreRoot[],
  manage: true,
  error: false,
  graphError: false,
  placeholderPermissions: false,
  create: vi.fn(),
  recall: vi.fn(),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'account-a',
  }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useKnowledgeSourceCapabilitiesQuery: () => ({
    isPlaceholderData: state.placeholderPermissions,
    data: {
      canManageSources: state.manage,
      canAttachLegacy: state.manage,
      canCheckHostPaths: state.manage,
    },
    refetch: vi.fn(),
  }),
  useKnowledgeRootsQuery: () => ({
    data: state.roots,
    isLoading: false,
    isError: state.error,
    error: new Error('Store read failed'),
    refetch: vi.fn(),
  }),
  useCreateKnowledgeRootMutation: () => ({
    mutate: state.create,
    isPending: false,
    isError: false,
  }),
  useKnowledgeRecallGraph: (rootId: string, authorityKey: string) => {
    state.recall(rootId, authorityKey);
    return {
      data: { nodes: [], edges: [] },
      isAuthorityLoading: false,
      isError: state.graphError,
      error: new Error('Graph access denied'),
    };
  },
  KnowledgeRecallBrowser: ({ rootId }: { rootId: string }) => (
    <div>Records for {rootId}</div>
  ),
}));
beforeEach(() => {
  state.roots = [];
  state.manage = true;
  state.error = false;
  state.graphError = false;
  state.placeholderPermissions = false;
  state.create.mockClear();
  state.recall.mockClear();
});

test('creates a store for the current Project and reports failed detection without inventing absence', () => {
  const view = render(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create store' }));
  expect(state.create).toHaveBeenCalledWith({
    scope: { kind: 'project', projectSlug: 'demo' },
    expectedProjectId: 'project-demo',
    adapterId: 'kit-default-store',
  });
  state.error = true;
  view.rerender(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load stores',
  );
  expect(screen.queryByRole('button', { name: 'Create store' })).toBeNull();
});

test('detects only current Project stores and loads canonical records on expansion', async () => {
  state.roots = [
    {
      id: 'demo-store',
      projectId: 'project-demo',
      adapterId: 'kit-default-store',
      createdAt: '2026-10-03T00:00:00.000Z',
      storeRoot: '/tmp/demo',
      displayName: 'Demo records',
      scope: { kind: 'project', projectSlug: 'demo' },
    },
    {
      id: 'other-store',
      adapterId: 'kit-default-store',
      createdAt: '2026-10-03T00:00:00.000Z',
      storeRoot: '/tmp/other',
      displayName: 'Other records',
      scope: { kind: 'project', projectSlug: 'other' },
    },
  ];
  render(<ProjectKnowledgeStores slug="demo" projectId="project-demo" />);
  expect(screen.queryByText('Other records')).toBeNull();
  expect(state.recall).not.toHaveBeenCalled();
  const summary = screen.getByText('Demo records');
  const details = summary.closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() =>
    expect(screen.getByText('Records for demo-store')).toBeTruthy(),
  );
  expect(state.recall).toHaveBeenCalledWith('demo-store', expect.any(String));
});

test('a failed fresh graph read withholds its retained record navigation', async () => {
  state.roots = [
    {
      id: 'demo-store',
      projectId: 'project-demo',
      adapterId: 'kit-default-store',
      createdAt: '2026-10-03T00:00:00Z',
      storeRoot: '/tmp/demo',
      displayName: 'Demo records',
      scope: { kind: 'project', projectSlug: 'demo' },
    },
  ];
  const view = render(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  const details = screen.getByText('Demo records').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await screen.findByText('Records for demo-store');
  state.graphError = true;
  view.rerender(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  expect(screen.queryByText('Records for demo-store')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load records',
  );
  state.error = true;
  view.rerender(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  expect(screen.queryByText('Demo records')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load stores',
  );
});

test('Project identity survives a rename and excludes former or unbound registrations with the same name', () => {
  const root = {
    id: 'current',
    projectId: 'project-demo',
    adapterId: 'kit-default-store',
    createdAt: '2026-10-03T00:00:00Z',
    storeRoot: '/tmp/current',
    displayName: 'Current source',
    scope: { kind: 'project' as const, projectSlug: 'old-name' },
  };
  state.roots = [
    root,
    {
      ...root,
      id: 'former',
      projectId: 'former-project-id',
      displayName: 'Former private source',
      scope: { kind: 'project', projectSlug: 'demo' },
    },
    {
      ...root,
      id: 'legacy',
      projectId: undefined,
      displayName: 'Unbound source',
      scope: { kind: 'project', projectSlug: 'demo' },
    },
  ];
  render(<ProjectKnowledgeStores slug="demo" projectId="project-demo" />);
  expect(screen.getByText('Current source')).toBeTruthy();
  expect(screen.queryByText('Former private source')).toBeNull();
  expect(screen.queryByText('Unbound source')).toBeNull();
});

test('a read-only Project connection does not offer store creation', () => {
  state.manage = false;
  render(<ProjectKnowledgeStores slug="demo" projectId="project-demo" />);
  expect(screen.queryByRole('button', { name: 'Create store' })).toBeNull();
  expect(state.create).not.toHaveBeenCalled();
});

test('held permissions cannot authorize store creation', () => {
  state.placeholderPermissions = true;
  const view = render(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  expect(screen.queryByRole('button', { name: 'Create store' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(
    'Checking store permissions',
  );
  expect(state.create).not.toHaveBeenCalled();
  state.placeholderPermissions = false;
  view.rerender(
    <ProjectKnowledgeStores slug="demo" projectId="project-demo" />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create store' }));
  expect(state.create).toHaveBeenCalledOnce();
});
