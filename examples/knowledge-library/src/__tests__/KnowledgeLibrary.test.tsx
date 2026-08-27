/** @vitest-environment jsdom */
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KnowledgeLibrary, rootIncarnationKey } from '../KnowledgeLibrary';

const mocks = vi.hoisted(() => ({
  roots: vi.fn(),
  graph: vi.fn(),
  record: vi.fn(),
  graphRefetch: vi.fn(),
  recordRefetch: vi.fn(),
  selectedProject: 'project-a' as string | null,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    useNavigation: () => ({
      selectedProject: mocks.selectedProject,
      navigate: vi.fn(),
    }),
    useKnowledgeRootsQuery: () => mocks.roots(),
    useKnowledgeGraphQuery: (rootId: string | undefined) => mocks.graph(rootId),
    useKnowledgeRecordQuery: (
      rootId: string | undefined,
      recordId: string | undefined,
    ) => mocks.record(rootId, recordId),
  };
});

const root: KnowledgeStoreRoot = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  displayName: 'Personal knowledge',
  adapterId: 'kit-default-store',
  storeRoot: '/personal',
  createdAt: '2026-01-01T00:00:00Z',
};

const projectARoot = {
  ...root,
  id: 'root:project-a',
  scope: { kind: 'project', projectSlug: 'project-a' },
  displayName: 'Project A knowledge',
};

const projectBRoot = {
  ...root,
  id: 'root:project-b',
  scope: { kind: 'project', projectSlug: 'project-b' },
  displayName: 'Project B knowledge',
};

const replacementRoot = {
  ...root,
  adapterId: 'kit-obsidian-store',
  storeRoot: '/replacement-personal',
  displayName: 'Replacement personal knowledge',
  createdAt: '2026-08-01T00:00:00Z',
};

const records = {
  compiled: {
    id: 'compiled',
    type: 'compiled',
    title: 'Unified product decision',
    body: 'Station composes the experience while each product retains authority.',
    category: 'product.decision',
    status: 'active',
    expires_at: '2099-01-01T00:00:00.000Z',
    links: [{ target_id: 'raw', kind: 'source' }],
    provenance: {
      agent: 'knowledge.compile',
      session_id: 'session-42',
      source_ids: ['raw'],
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
  raw: {
    id: 'raw',
    type: 'raw',
    title: 'Source transcript',
    body: 'Original discussion.',
    category: 'source.transcript',
    provenance: { agent: 'knowledge.ingest' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
} as const;

const graph = {
  nodes: [
    {
      id: 'compiled',
      type: 'compiled',
      title: records.compiled.title,
      category: records.compiled.category,
    },
    {
      id: 'raw',
      type: 'raw',
      title: records.raw.title,
      category: records.raw.category,
    },
  ],
  edges: [{ source: 'compiled', target: 'raw', kind: 'source' }],
};

/**
 * Click a node only once React has finished mounting the surface that owns it.
 *
 * `findBy*` resolves off the DOM mutation React makes when it *commits* a
 * render, which happens before it flushes that render's passive effects. The
 * graph list therefore becomes queryable while `KnowledgeRecallBrowser`'s mount
 * effect — the `setInternalSelectedId(null)` in
 * `packages/sdk/src/components/KnowledgeRecall.tsx` — is still pending. A click
 * dispatched inside that window is silently undone: the effect lands after the
 * selection and resets it to `null`, so the detail panel never renders and the
 * test times out looking for `kl-record-detail`.
 *
 * The first `act` drains React's pending work so the click always reaches a
 * settled tree; the second wraps the click so the record refetch it kicks off
 * settles inside `act` too, instead of resolving a microtask later and warning.
 * Both are synchronisation points, not delays — each returns as soon as React
 * has nothing left to flush.
 */
async function clickWhenSettled(testId: string): Promise<HTMLElement> {
  const target = await screen.findByTestId(testId);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(target);
  });
  return target;
}

describe('KnowledgeLibrary', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.selectedProject = 'project-a';
    mocks.graphRefetch.mockReset().mockResolvedValue({});
    mocks.recordRefetch.mockReset().mockResolvedValue({});
    mocks.roots.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [root],
      refetch: vi.fn(),
    });
    mocks.graph.mockImplementation((rootId?: string) => ({
      isLoading: false,
      isError: false,
      data: rootId ? graph : undefined,
      refetch: mocks.graphRefetch,
    }));
    mocks.record.mockImplementation((_rootId?: string, recordId?: string) => ({
      isLoading: false,
      isError: false,
      data: recordId ? records[recordId as keyof typeof records] : undefined,
      refetch: mocks.recordRefetch,
    }));
  });

  test('resolves canonical detail with provenance, lifecycle, and explicit freshness', async () => {
    render(<KnowledgeLibrary />);

    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    expect(await screen.findByTestId('kl-node-compiled')).toBeTruthy();
    expect(screen.getByTestId('kl-authority').textContent).toContain(
      'graph is derived',
    );

    await clickWhenSettled('kl-node-compiled');
    await waitFor(() => {
      expect(screen.getByTestId('kl-record-title').textContent).toBe(
        'Unified product decision',
      );
    });
    expect(screen.getByTestId('kl-record-provenance').textContent).toContain(
      'knowledge.compile',
    );
    expect(screen.getByTestId('kl-record-detail').textContent).toContain(
      'active',
    );
    expect(screen.getByTestId('kl-record-freshness').textContent).toContain(
      'Expires at 2099-01-01',
    );
  });

  test('clears project-scoped data synchronously when project context changes', async () => {
    mocks.roots.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [root, projectARoot, projectBRoot],
      refetch: vi.fn(),
    });
    const view = render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: projectARoot.id },
    });
    await clickWhenSettled('kl-node-compiled');
    expect(await screen.findByTestId('kl-record-detail')).toBeTruthy();

    mocks.selectedProject = 'project-b';
    view.rerender(<KnowledgeLibrary />);

    expect(screen.queryByTestId('kl-authority')).toBeNull();
    expect(screen.queryByTestId('kl-record-detail')).toBeNull();
    expect(screen.getByTestId('kl-root-select')).toHaveProperty('value', '');
    expect(screen.queryByText('Project A knowledge (project)')).toBeNull();
    expect(screen.getByText('Project B knowledge (project)')).toBeTruthy();
  });

  test('clears selected data synchronously when the root is deregistered', async () => {
    const view = render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    await clickWhenSettled('kl-node-compiled');
    expect(await screen.findByTestId('kl-record-detail')).toBeTruthy();

    mocks.roots.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
      refetch: vi.fn(),
    });
    view.rerender(<KnowledgeLibrary />);

    expect(screen.queryByTestId('kl-authority')).toBeNull();
    expect(screen.queryByTestId('kl-record-detail')).toBeNull();
    expect(screen.getByText('No relevant Knowledge Kit root')).toBeTruthy();
  });

  test('fails closed when refreshing root authority fails with cached data', async () => {
    const view = render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    await clickWhenSettled('kl-node-compiled');
    expect(await screen.findByTestId('kl-record-detail')).toBeTruthy();

    mocks.roots.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('root authority unavailable'),
      data: [root],
      refetch: vi.fn(),
    });
    view.rerender(<KnowledgeLibrary />);

    expect(screen.queryByTestId('kl-authority')).toBeNull();
    expect(screen.queryByTestId('kl-record-detail')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'root authority unavailable',
    );
  });

  test('withholds seeded cache until a same-id replacement is refetched', async () => {
    let resolveGraphRefetch: (() => void) | undefined;
    const replacementRefetch = new Promise<void>((resolve) => {
      resolveGraphRefetch = resolve;
    });
    const view = render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    await clickWhenSettled('kl-node-compiled');
    expect(await screen.findByTestId('kl-record-detail')).toBeTruthy();

    mocks.roots.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [replacementRoot],
      refetch: vi.fn(),
    });
    mocks.graph.mockReturnValue({
      isLoading: false,
      isError: false,
      data: graph,
      refetch: vi.fn(() => replacementRefetch),
    });
    view.rerender(<KnowledgeLibrary />);

    expect(rootIncarnationKey(replacementRoot)).not.toBe(
      rootIncarnationKey(root),
    );
    expect(screen.getByTestId('kl-authority').textContent).toContain(
      'Replacement personal knowledge',
    );
    expect(screen.queryByTestId('kl-record-detail')).toBeNull();
    expect(screen.queryByTestId('kl-node-compiled')).toBeNull();

    resolveGraphRefetch?.();
    expect(await screen.findByTestId('kl-node-compiled')).toBeTruthy();
    expect(screen.queryByTestId('kl-record-detail')).toBeNull();
  });

  test('follows a canonical record link by changing graph selection', async () => {
    render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    await clickWhenSettled('kl-node-compiled');
    await clickWhenSettled('kl-record-link-raw');

    await waitFor(() => {
      expect(screen.getByTestId('kl-record-title').textContent).toBe(
        'Source transcript',
      );
    });
    expect(screen.getByTestId('kl-node-raw').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('distinguishes graph and canonical-record failures', async () => {
    mocks.graph.mockImplementation((rootId?: string) => ({
      isLoading: false,
      isError: Boolean(rootId),
      error: rootId ? new Error('graph route failed') : undefined,
      data: undefined,
      refetch: mocks.graphRefetch,
    }));
    const first = render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    expect(
      await screen.findByText('Could not load the knowledge graph'),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'graph route failed',
    );
    first.unmount();

    mocks.graph.mockImplementation((rootId?: string) => ({
      isLoading: false,
      isError: false,
      data: rootId ? graph : undefined,
      refetch: mocks.graphRefetch,
    }));
    mocks.record.mockImplementation((_rootId?: string, recordId?: string) => ({
      isLoading: false,
      isError: Boolean(recordId),
      error: recordId ? new Error('record route failed') : undefined,
      refetch: mocks.recordRefetch,
    }));
    render(<KnowledgeLibrary />);
    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: root.id },
    });
    await clickWhenSettled('kl-node-compiled');
    expect(
      await screen.findByText('Could not load the canonical record'),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'record route failed',
    );
  });
});
