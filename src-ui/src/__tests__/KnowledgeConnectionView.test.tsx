/**
 * @vitest-environment jsdom
 */
// archive#242 Knowledge port — asserts KnowledgeConnectionView now renders through the
// canonical page-layout shell (.page/.page--narrow, not the old bespoke
// `.knowledge-view` wrapper) and the canonical `Empty` primitive for both
// empty branches (no bespoke `knowledge-view__empty` className survives).

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let connectionsQueryData: unknown[] = [];
let connectionsQueryState: Record<string, unknown> = {};
let knowledgeStatusQueryState: Record<string, unknown> = {};

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({
    data: connectionsQueryData,
    ...connectionsQueryState,
  }),
  useGlobalKnowledgeStatusQuery: () => ({
    data: undefined,
    ...knowledgeStatusQueryState,
  }),
  useSaveModelConnectionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useTestVectorDbConnectionMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

const navigateMock = vi.fn();
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

vi.mock('../hooks/useCloseShortcut', () => ({
  useCloseShortcut: vi.fn(),
}));

import { PageFrame } from '../components/page-frame';
import { KnowledgeConnectionView } from '../views/KnowledgeConnectionView';

describe('KnowledgeConnectionView (#242 shell port)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/connections/knowledge');
    connectionsQueryData = [];
    connectionsQueryState = {};
    knowledgeStatusQueryState = {};
    navigateMock.mockClear();
  });

  it('renders no page header of its own — the frame owns it', () => {
    const { container } = render(<KnowledgeConnectionView />);

    expect(container.querySelector('.page__header')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
  });

  it('renders the canonical Empty component copy for the no-vector-db state, not a bespoke __empty paragraph', () => {
    const { container } = render(<KnowledgeConnectionView />);

    expect(screen.getByText('No vector database configured')).toBeTruthy();
    expect(container.querySelector('.knowledge-view__empty')).toBeNull();
  });

  it('does not claim vector storage is unconfigured while knowledge status is loading or failed', () => {
    knowledgeStatusQueryState = { isLoading: true };
    const { rerender } = render(<KnowledgeConnectionView />);
    expect(screen.queryByText('No vector database configured')).toBeNull();

    knowledgeStatusQueryState = { isError: true };
    rerender(<KnowledgeConnectionView />);
    expect(
      screen.getByText("Couldn't load vector database configuration."),
    ).toBeTruthy();
    expect(screen.queryByText('No vector database configured')).toBeNull();
  });

  it('renders the canonical Empty component copy + action for the no-embedding-model state', () => {
    render(<KnowledgeConnectionView />);

    expect(screen.getByText('No embedding model configured.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Add one in Models/ }),
    ).toBeTruthy();
  });

  it('publishes an unlinked Connections eyebrow (parent-context text only) into the page frame', () => {
    render(
      <PageFrame
        spec={{ title: 'Knowledge infrastructure', width: 'narrow' }}
        routeIdentity="connections-knowledge"
      >
        <KnowledgeConnectionView />
      </PageFrame>,
    );

    const header = document.querySelector('.page-frame__header');
    expect(header?.textContent).toContain('Connections');
    expect(header?.textContent).toContain('Knowledge infrastructure');
    // The title, not the eyebrow, says 'Knowledge infrastructure' —
    // archive#4463 retired the breadcrumb-as-eyebrow that restated
    // it a second time.
    expect(document.querySelector('.page__label')?.textContent?.trim()).toBe(
      'Connections',
    );
    // Fix round (arbiter decision #4): unlinked — `/connections` is a
    // redirect-only resolver, so a click would be a no-op or a sibling jump.
    expect(document.querySelector('.page__label-link')).toBeNull();
  });

  it('publishes nothing when embedded in another page, which owns its own title', () => {
    render(
      <PageFrame
        spec={{ title: 'Settings', width: 'narrow' }}
        routeIdentity="settings"
      >
        <KnowledgeConnectionView embedded />
      </PageFrame>,
    );

    const header = document.querySelector('.page-frame__header');
    expect(header?.textContent).toContain('Settings');
    expect(header?.textContent).not.toContain('Connections');
  });

  it('uses shared sections and keeps embedding deep links in query state', () => {
    const { container } = render(<KnowledgeConnectionView />);

    expect(container.querySelector('#section-vector-database')).toBeTruthy();
    expect(container.querySelector('#section-embedding-model')).toBeTruthy();
    expect(container.querySelectorAll('[data-page-section]')).toHaveLength(2);

    fireEvent.click(screen.getByRole('link', { name: 'Embedding model' }));
    expect(window.location.search).toBe('?section=embedding-model');
  });

  // archive#settings-revamp 2(b): this
  // cross-link already routed through the internal `guard` correctly
  // (`guard( => navigate(...))`, the pattern the other four cross-link
  // sites were fixed to match) — this file just never asserted the target or
  // the dirty-intercept behavior.
  describe('the "Open Settings → My knowledge store" cross-link', () => {
    it('navigates to /settings with the section param when the page is not dirty', () => {
      render(<KnowledgeConnectionView />);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open Settings → My knowledge store',
        }),
      );

      expect(navigateMock).toHaveBeenCalledWith('/settings', {
        view: 'knowledge',
        highlight: 'personal-knowledge-store',
      });
      expect(screen.queryByText('Unsaved Changes')).toBeNull();
    });

    it('a dirty data-directory edit intercepts navigation with the discard-confirmation modal instead of silently navigating away', () => {
      connectionsQueryData = [
        {
          id: 'lancedb-builtin',
          kind: 'model',
          type: 'lancedb',
          name: 'Built-in Vector Store',
          enabled: true,
          capabilities: ['vectordb'],
          config: { dataDir: '/data/lancedb' },
          status: 'ready',
          prerequisites: [],
          lastCheckedAt: null,
        },
      ];
      render(<KnowledgeConnectionView />);

      fireEvent.change(
        screen.getByDisplayValue('/data/lancedb') as HTMLInputElement,
        { target: { value: '/data/lancedb-edited' } },
      );

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Open Settings → My knowledge store',
        }),
      );

      expect(navigateMock).not.toHaveBeenCalled();
      expect(screen.getByText('Unsaved Changes')).toBeTruthy();
    });
  });

  // Audit : the panel resolved only through `/api/connections`, where the
  // built-in store has no record on a real home — so the section rendered as a
  // blank box while `/api/knowledge/status` was reporting a working store.
  it('renders the built-in vector store from the knowledge-status payload when no connection record backs it', () => {
    knowledgeStatusQueryState = {
      data: {
        vectorDb: {
          id: 'lancedb-builtin',
          name: 'Station Built-In',
          type: 'lancedb',
          enabled: true,
        },
        embedding: null,
        stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
      },
    };
    connectionsQueryData = [];

    render(<KnowledgeConnectionView />);

    expect(screen.getByText('Station Built-In')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.queryByText('No vector database configured')).toBeNull();
  });

  it('offers the section add action when there is genuinely no vector store', () => {
    knowledgeStatusQueryState = {
      data: {
        vectorDb: null,
        embedding: null,
        stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
      },
    };

    render(<KnowledgeConnectionView />);

    expect(screen.getByText('No vector database configured')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Add a knowledge source →' }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/settings?view=knowledge');
  });

  // a zero is the index receipt that matters most — hiding the section
  // until something had been indexed left the capability copy standing beside
  // nothing a reader could check.
  it('shows the server index counts even when nothing has been indexed yet', () => {
    knowledgeStatusQueryState = {
      data: {
        vectorDb: null,
        embedding: null,
        stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
      },
    };

    render(<KnowledgeConnectionView />);

    expect(screen.getByText('documents')).toBeTruthy();
    expect(screen.getByText('chunks')).toBeTruthy();
    expect(
      screen.getByText(/counted by the server when this page loaded/),
    ).toBeTruthy();
  });
});
