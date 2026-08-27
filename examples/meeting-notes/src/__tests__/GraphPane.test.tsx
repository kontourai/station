/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GraphPane } from '../GraphPane';

const useKnowledgeGraphQueryMock = vi.fn();
const useKnowledgeRecordQueryMock = vi.fn();
const useKnowledgeGraphNeo4jQueryMock = vi.fn();
const useSyncKnowledgeGraphNeo4jMutationMock = vi.fn();
const graphRefetchMock = vi.fn(async () => undefined);
const neo4jRefetchMock = vi.fn(async () => undefined);
const recordRefetchMock = vi.fn(async () => undefined);

const PERSONAL_ROOT = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/personal',
  displayName: 'Personal (default store)',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    useNavigation: () => ({ selectedProject: null }),
    useKnowledgeRootsQuery: () => ({
      isLoading: false,
      isError: false,
      data: [PERSONAL_ROOT],
    }),
    useKnowledgeGraphQuery: (...args: unknown[]) => ({
      ...useKnowledgeGraphQueryMock(...args),
      refetch: graphRefetchMock,
    }),
    useKnowledgeRecordQuery: (...args: unknown[]) => ({
      ...useKnowledgeRecordQueryMock(...args),
      refetch: recordRefetchMock,
    }),
    useKnowledgeGraphNeo4jQuery: (...args: unknown[]) => ({
      ...useKnowledgeGraphNeo4jQueryMock(...args),
      refetch: neo4jRefetchMock,
    }),
    useSyncKnowledgeGraphNeo4jMutation: () =>
      useSyncKnowledgeGraphNeo4jMutationMock(),
  };
});

function renderGraphPane() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GraphPane />
    </QueryClientProvider>,
  );
}

function selectPersonalRoot() {
  fireEvent.change(screen.getByTestId('mn-root-select'), {
    target: { value: 'root:personal' },
  });
}

async function switchToNeo4j() {
  fireEvent.click(screen.getByTestId('mn-graph-view-neo4j'));
  await waitFor(() => expect(neo4jRefetchMock).toHaveBeenCalled());
}

describe('GraphPane', () => {
  beforeEach(() => {
    graphRefetchMock.mockClear();
    neo4jRefetchMock.mockClear();
    recordRefetchMock.mockClear();
    useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: false,
      data: undefined,
    });
    useSyncKnowledgeGraphNeo4jMutationMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('prompts for a root before querying the graph', () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    });

    renderGraphPane();

    expect(screen.getByText(/Select a knowledge root/)).toBeTruthy();
    expect(screen.queryByTestId('mn-graph-svg')).toBeNull();
  });

  test('renders a loading skeleton while the graph query is pending', async () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    });

    renderGraphPane();
    selectPersonalRoot();

    await waitFor(() => expect(graphRefetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('mn-graph-loading')).toBeTruthy();
  });

  test('renders an honest error state on query failure', async () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('graph route unreachable'),
      data: undefined,
    });

    renderGraphPane();
    selectPersonalRoot();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'graph route unreachable',
    );
  });

  test('renders empty-graph guidance without an ad-hoc "No X" string', async () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { nodes: [], edges: [] },
    });

    renderGraphPane();
    selectPersonalRoot();

    expect(
      await screen.findByText(/Capture a meeting in the Capture tab/),
    ).toBeTruthy();
    expect(screen.queryByTestId('mn-graph-svg')).toBeNull();
  });

  test('renders nodes/edges from a fixture graph, then selects a node on click', async () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        nodes: [
          {
            id: 'rec_raw_1',
            type: 'raw',
            title: 'Raw transcript',
            category: 'meeting-transcript',
          },
          {
            id: 'rec_compiled_1',
            type: 'compiled',
            title: 'Compiled note',
            category: 'meeting-note',
          },
        ],
        edges: [
          { source: 'rec_compiled_1', target: 'rec_raw_1', kind: 'source' },
        ],
      },
    });
    useKnowledgeRecordQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        id: 'rec_compiled_1',
        type: 'compiled',
        title: 'Compiled note',
        body: 'Summary of the meeting.',
        category: 'meeting-note',
        links: [{ target_id: 'rec_raw_1', kind: 'source' }],
        provenance: { agent: 'station.meeting-notes.compile' },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });

    renderGraphPane();
    selectPersonalRoot();

    expect(await screen.findByTestId('mn-graph-node-rec_raw_1')).toBeTruthy();
    expect(screen.getByTestId('mn-graph-node-rec_compiled_1')).toBeTruthy();
    expect(screen.getAllByTestId('mn-graph-edge')).toHaveLength(1);

    fireEvent.click(await screen.findByTestId('mn-graph-node-rec_compiled_1'));

    await waitFor(() =>
      expect(screen.getByTestId('mn-graph-detail-title').textContent).toBe(
        'Compiled note',
      ),
    );
    expect(screen.getByTestId('mn-graph-detail-body').textContent).toContain(
      'Summary of the meeting.',
    );
    expect(
      screen.getByTestId('mn-graph-detail-provenance').textContent,
    ).toContain('station.meeting-notes.compile');
    expect(screen.getByTestId('mn-graph-detail-freshness').textContent).toBe(
      'No expiry declared',
    );
    expect(screen.getByTestId('mn-graph-detail-link-rec_raw_1')).toBeTruthy();
  });

  test('clicking a linked node in the detail panel re-selects it', async () => {
    useKnowledgeGraphQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        nodes: [
          {
            id: 'rec_raw_1',
            type: 'raw',
            title: 'Raw transcript',
            category: 'meeting-transcript',
          },
          {
            id: 'rec_compiled_1',
            type: 'compiled',
            title: 'Compiled note',
            category: 'meeting-note',
          },
        ],
        edges: [
          { source: 'rec_compiled_1', target: 'rec_raw_1', kind: 'source' },
        ],
      },
    });
    useKnowledgeRecordQueryMock.mockImplementation(
      (_rootId: string, recordId: string) => {
        if (recordId === 'rec_compiled_1') {
          return {
            isLoading: false,
            isError: false,
            data: {
              id: 'rec_compiled_1',
              type: 'compiled',
              title: 'Compiled note',
              body: 'Summary of the meeting.',
              category: 'meeting-note',
              links: [{ target_id: 'rec_raw_1', kind: 'source' }],
              provenance: { agent: 'station.meeting-notes.compile' },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          };
        }
        if (recordId === 'rec_raw_1') {
          return {
            isLoading: false,
            isError: false,
            data: {
              id: 'rec_raw_1',
              type: 'raw',
              title: 'Raw transcript',
              body: 'Alice: hi\nBob: hi',
              category: 'meeting-transcript',
              links: [],
              provenance: { agent: 'station.meeting-notes.capture' },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          };
        }
        return { isLoading: false, isError: false, data: undefined };
      },
    );

    renderGraphPane();
    selectPersonalRoot();

    fireEvent.click(await screen.findByTestId('mn-graph-node-rec_compiled_1'));
    await waitFor(() =>
      expect(screen.getByTestId('mn-graph-detail-title').textContent).toBe(
        'Compiled note',
      ),
    );

    fireEvent.click(screen.getByTestId('mn-graph-detail-link-rec_raw_1'));

    await waitFor(() =>
      expect(screen.getByTestId('mn-graph-detail-title').textContent).toBe(
        'Raw transcript',
      ),
    );
    expect(
      screen.getByText(/This record has no outgoing links\./),
    ).toBeTruthy();
  });

  describe('Neo4j view toggle (Wave 3 cleanup)', () => {
    test('does not fetch the Neo4j graph until the toggle is switched', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });

      renderGraphPane();
      selectPersonalRoot();

      await waitFor(() => expect(graphRefetchMock).toHaveBeenCalled());
      expect(screen.queryByTestId('mn-graph-neo4j-loading')).toBeNull();
      expect(
        screen.getByTestId('mn-graph-view-files').getAttribute('aria-pressed'),
      ).toBe('true');
    });

    test('renders fixture nodes from the Neo4j view and selects a node on click', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });
      useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        isSuccess: true,
        data: {
          nodes: [
            {
              id: 'rec_raw_1',
              type: 'raw',
              title: 'Raw transcript',
              category: 'meeting-transcript',
            },
            {
              id: 'rec_compiled_1',
              type: 'compiled',
              title: 'Compiled note',
              category: 'meeting-note',
            },
          ],
          edges: [
            { source: 'rec_compiled_1', target: 'rec_raw_1', kind: 'source' },
          ],
        },
      });
      useKnowledgeRecordQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: {
          id: 'rec_compiled_1',
          type: 'compiled',
          title: 'Compiled note',
          body: 'Summary of the meeting.',
          category: 'meeting-note',
          links: [{ target_id: 'rec_raw_1', kind: 'source' }],
          provenance: { agent: 'station.meeting-notes.compile' },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      });

      renderGraphPane();
      selectPersonalRoot();
      await switchToNeo4j();

      expect(await screen.findByTestId('mn-graph-node-rec_raw_1')).toBeTruthy();
      expect(screen.getByTestId('mn-graph-node-rec_compiled_1')).toBeTruthy();

      fireEvent.click(screen.getByTestId('mn-graph-node-rec_compiled_1'));

      await waitFor(() =>
        expect(screen.getByTestId('mn-graph-detail-title').textContent).toBe(
          'Compiled note',
        ),
      );
    });

    test('renders an honest "not configured" state on a 503, distinct from a generic error', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });
      useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
        isLoading: false,
        isError: true,
        isSuccess: false,
        error: new Error(
          'Neo4j graph-view connection is not configured — register one before syncing or reading the graph view',
        ),
        data: undefined,
      });

      renderGraphPane();
      selectPersonalRoot();
      await switchToNeo4j();

      expect(
        await screen.findByText(/Neo4j graph view isn't configured/),
      ).toBeTruthy();
      expect(
        screen.getByText(/No Neo4j graph-view connection is registered/),
      ).toBeTruthy();
    });

    test('renders a generic error state for a non-"not configured" Neo4j failure', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });
      useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
        isLoading: false,
        isError: true,
        isSuccess: false,
        error: new Error('unexpected server failure'),
        data: undefined,
      });

      renderGraphPane();
      selectPersonalRoot();
      await switchToNeo4j();

      expect(
        await screen.findByText(/Could not load the Neo4j graph view/),
      ).toBeTruthy();
      expect(screen.getByText(/unexpected server failure/)).toBeTruthy();
    });

    test('Sync now calls the sync mutation with the selected root id', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });
      useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        isSuccess: true,
        data: { nodes: [], edges: [] },
      });
      const mutate = vi.fn();
      useSyncKnowledgeGraphNeo4jMutationMock.mockReturnValue({
        mutate,
        isPending: false,
        isSuccess: false,
        isError: false,
      });

      renderGraphPane();
      selectPersonalRoot();
      await switchToNeo4j();
      fireEvent.click(screen.getByTestId('mn-graph-neo4j-sync'));

      expect(mutate).toHaveBeenCalledWith('root:personal');
    });

    test('reports sync stats after a successful sync', async () => {
      useKnowledgeGraphQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        data: { nodes: [], edges: [] },
      });
      useKnowledgeGraphNeo4jQueryMock.mockReturnValue({
        isLoading: false,
        isError: false,
        isSuccess: true,
        data: { nodes: [], edges: [] },
      });
      useSyncKnowledgeGraphNeo4jMutationMock.mockReturnValue({
        mutate: vi.fn(),
        isPending: false,
        isSuccess: true,
        isError: false,
        data: {
          rootId: 'root:personal',
          recordsScanned: 2,
          linksScanned: 1,
          nodesWritten: 1,
          nodesUnchanged: 1,
          linksWritten: 1,
          linksUnchanged: 0,
          linksSkippedDangling: 0,
        },
      });

      renderGraphPane();
      selectPersonalRoot();
      await switchToNeo4j();

      expect(
        screen.getByTestId('mn-graph-neo4j-sync-stats').textContent,
      ).toContain('1 node(s) written');
    });
  });
});
