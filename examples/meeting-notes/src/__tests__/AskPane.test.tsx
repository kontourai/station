/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AskPane } from '../AskPane';

const searchImpl = vi.fn();
const knowledgeRecordQueryMock = vi.fn();
const navigateMock = vi.fn();

const PERSONAL_ROOT = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/personal',
  displayName: 'Personal (default store)',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const PROJECT_A_ROOT = {
  id: 'root:proj-a',
  scope: { kind: 'project', projectSlug: 'proj-a' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/proj-a',
  displayName: 'Project A',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const PROJECT_B_ROOT = {
  id: 'root:proj-b',
  scope: { kind: 'project', projectSlug: 'proj-b' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/proj-b',
  displayName: 'Project B',
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@kontourai/station-sdk', () => ({
  isRelevantKnowledgeRoot: (
    root: { scope: { kind: string; projectSlug?: string } },
    project: string | null,
  ) => root.scope.kind === 'personal' || root.scope.projectSlug === project,
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
  useNavigation: () => ({ selectedProject: 'proj-a', navigate: navigateMock }),
  useKnowledgeRootsQuery: () => ({
    isLoading: false,
    isError: false,
    data: [PERSONAL_ROOT, PROJECT_A_ROOT, PROJECT_B_ROOT],
  }),
  useKnowledgeRecordQuery: (...args: unknown[]) =>
    knowledgeRecordQueryMock(...args),
  // A hand-rolled but behaviorally faithful double of the real
  // `useMutation`-backed hook (`useSearchKnowledgeIndexMutation`,
  // `packages/sdk/src/query-domains/knowledgeStores.ts`) — real `useState`
  // so idle -> pending -> success/error transitions are observable via
  // `waitFor`, without pulling react-query itself into this component test.
  useSearchKnowledgeIndexMutation: () => {
    const [state, setState] = useState<{
      status: 'idle' | 'pending' | 'success' | 'error';
      data?: unknown;
      error?: unknown;
    }>({ status: 'idle' });

    return {
      isIdle: state.status === 'idle',
      isPending: state.status === 'pending',
      isError: state.status === 'error',
      isSuccess: state.status === 'success',
      data: state.data,
      error: state.error,
      mutate: (vars: unknown) => {
        setState({ status: 'pending' });
        Promise.resolve()
          .then(() => searchImpl(vars))
          .then(
            (data) => setState({ status: 'success', data }),
            (error) => setState({ status: 'error', error }),
          );
      },
    };
  },
}));

function renderAskPane() {
  return render(<AskPane />);
}

describe('AskPane', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('shows the honest empty placeholder before any query is submitted', () => {
    renderAskPane();
    expect(screen.getByText(/Ask about your meetings…/)).toBeTruthy();
  });

  test('query -> results rendered as answer cards with a working provenance link', async () => {
    searchImpl.mockResolvedValue([
      {
        recordId: 'rec_compiled_1',
        rootId: 'root:personal',
        score: 0.874,
        title: 'Weekly sync',
        excerpt: 'We decided to ship K5 this week.',
        category: 'meeting',
      },
    ]);
    knowledgeRecordQueryMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        id: 'rec_compiled_1',
        type: 'compiled',
        title: 'Weekly sync',
        body: 'Full compiled note body.',
        category: 'meeting',
      },
    });

    renderAskPane();

    fireEvent.change(screen.getByTestId('mn-ask-query'), {
      target: { value: 'what did we decide about the roadmap?' },
    });
    fireEvent.click(screen.getByTestId('mn-ask-submit'));

    await waitFor(() => screen.getByTestId('mn-ask-results'));
    expect(screen.getByText('Weekly sync')).toBeTruthy();
    expect(screen.getByText('We decided to ship K5 this week.')).toBeTruthy();
    expect(screen.getByText(/Relevance score: 0.874/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('mn-ask-source-link-rec_compiled_1'));

    expect(knowledgeRecordQueryMock).toHaveBeenCalledWith(
      'root:personal',
      'rec_compiled_1',
    );
    await waitFor(() => screen.getByTestId('mn-ask-detail'));
    expect(screen.getByText('Full compiled note body.')).toBeTruthy();
  });

  test('renders an honest NO_EMBEDDER error state with a fix affordance', async () => {
    searchImpl.mockRejectedValue(
      new Error(
        'No embedding provider connection is configured — enable one before rebuilding or migrating the knowledge index',
      ),
    );

    renderAskPane();

    fireEvent.change(screen.getByTestId('mn-ask-query'), {
      target: { value: 'anything' },
    });
    fireEvent.click(screen.getByTestId('mn-ask-submit'));

    await waitFor(() =>
      expect(screen.getByText('No embedding model configured')).toBeTruthy(),
    );
    expect(screen.getByText(/embedding-capable Model connection/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('mn-ask-configure-embedder'));
    expect(navigateMock).toHaveBeenCalledWith('/connections/models');
  });

  test('renders an honest empty state when a query has zero matching excerpts', async () => {
    searchImpl.mockResolvedValue([]);

    renderAskPane();

    fireEvent.change(screen.getByTestId('mn-ask-query'), {
      target: { value: 'nothing relevant' },
    });
    fireEvent.click(screen.getByTestId('mn-ask-submit'));

    await waitFor(() =>
      expect(screen.getByText('No matching excerpts found')).toBeTruthy(),
    );
  });

  test('scope picker: "All roots" passes every relevant root id; a specific root passes only that id', async () => {
    searchImpl.mockResolvedValue([]);
    renderAskPane();

    // Personal + the active project's root only — root:proj-b is filtered out
    // (R3: never search another project's root).
    expect(screen.queryByText(/Project B/)).toBeNull();

    fireEvent.change(screen.getByTestId('mn-ask-query'), {
      target: { value: 'default scope' },
    });
    fireEvent.click(screen.getByTestId('mn-ask-submit'));

    await waitFor(() =>
      expect(searchImpl).toHaveBeenCalledWith({
        query: 'default scope',
        rootIds: ['root:personal', 'root:proj-a'],
      }),
    );

    fireEvent.change(screen.getByTestId('mn-ask-scope'), {
      target: { value: 'root:proj-a' },
    });
    fireEvent.change(screen.getByTestId('mn-ask-query'), {
      target: { value: 'scoped query' },
    });
    fireEvent.click(screen.getByTestId('mn-ask-submit'));

    await waitFor(() =>
      expect(searchImpl).toHaveBeenCalledWith({
        query: 'scoped query',
        rootIds: ['root:proj-a'],
      }),
    );
  });
});
