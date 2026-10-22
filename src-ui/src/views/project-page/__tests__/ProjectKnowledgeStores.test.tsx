// @vitest-environment jsdom
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectKnowledgeStores } from '../ProjectKnowledgeStores';

const state = vi.hoisted(() => ({
  roots: [] as KnowledgeStoreRoot[],
  error: false,
  graphError: false,
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
  state.error = false;
  state.graphError = false;
  state.create.mockClear();
  state.recall.mockClear();
});

test('creates a store for the current Project and reports failed detection without inventing absence', () => {
  const view = render(<ProjectKnowledgeStores slug="demo" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create store' }));
  expect(state.create).toHaveBeenCalledWith({
    scope: { kind: 'project', projectSlug: 'demo' },
    adapterId: 'kit-default-store',
  });
  state.error = true;
  view.rerender(<ProjectKnowledgeStores slug="demo" />);
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load stores',
  );
  expect(screen.queryByRole('button', { name: 'Create store' })).toBeNull();
});

test('detects only current Project stores and loads canonical records on expansion', async () => {
  state.roots = [
    {
      id: 'demo-store',
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
  render(<ProjectKnowledgeStores slug="demo" />);
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
      adapterId: 'kit-default-store',
      createdAt: '2026-10-03T00:00:00Z',
      storeRoot: '/tmp/demo',
      displayName: 'Demo records',
      scope: { kind: 'project', projectSlug: 'demo' },
    },
  ];
  const view = render(<ProjectKnowledgeStores slug="demo" />);
  const details = screen.getByText('Demo records').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await screen.findByText('Records for demo-store');
  state.graphError = true;
  view.rerender(<ProjectKnowledgeStores slug="demo" />);
  expect(screen.queryByText('Records for demo-store')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load records',
  );
  state.error = true;
  view.rerender(<ProjectKnowledgeStores slug="demo" />);
  expect(screen.queryByText('Demo records')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'Could not load stores',
  );
});
