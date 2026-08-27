/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let queryResult: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
};

vi.mock('@kontourai/station-sdk', () => ({
  useBoardQuery: () => ({ ...queryResult, refetch: vi.fn() }),
}));

import { BoardView } from '../BoardView';

const ATTESTED_CARD = {
  id: 'w1',
  name: 'status',
  tabId: 'default',
  position: 0,
  size: 'md' as const,
  revision: 0,
  generation: 'gen-1',
  pinnedAt: '2026-08-24T00:00:00.000Z',
  block: {
    type: 'card' as const,
    title: 'Status',
    body: 'Summary',
    fields: [{ label: 'state', value: 'green' }],
    derivedFrom: [{ kind: 'toolCallId' as const, toolCallId: 'call-1' }],
    attestationState: 'attested' as const,
    provenanceDigest: 'a'.repeat(64),
  },
};

const UNATTESTED_CARD = {
  ...ATTESTED_CARD,
  id: 'w2',
  name: 'risky',
  position: 1,
  block: {
    ...ATTESTED_CARD.block,
    title: 'Risky',
    derivedFrom: undefined,
    attestationState: 'unattested' as const,
    provenanceDigest: undefined,
  },
};

describe('BoardView', () => {
  beforeEach(() => {
    queryResult = { data: undefined, isLoading: true, error: null };
  });

  test('renders a loading skeleton, not the empty state, while the board is loading', () => {
    const { container } = render(
      <BoardView reference={{ kind: 'session', id: 's-1' }} />,
    );
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(screen.queryByText('Nothing pinned yet')).toBeNull();
  });

  test('renders an empty state for a board with no pinned widgets', () => {
    queryResult = {
      data: { schemaVersion: 1, tabs: [], widgets: [] },
      isLoading: false,
      error: null,
    };
    render(<BoardView reference={{ kind: 'session', id: 's-1' }} />);
    expect(screen.getByText('Nothing pinned yet')).not.toBeNull();
  });

  test('renders pinned blocks via UIBlockRenderer, with size classes and attestation badges', () => {
    queryResult = {
      data: {
        schemaVersion: 1,
        tabs: [{ id: 'default', title: 'Board', position: 0 }],
        widgets: [ATTESTED_CARD, UNATTESTED_CARD],
      },
      isLoading: false,
      error: null,
    };
    const { container } = render(
      <BoardView reference={{ kind: 'session', id: 's-1' }} />,
    );
    // Both pinned card titles render.
    expect(screen.getByText('Status')).not.toBeNull();
    expect(screen.getByText('Risky')).not.toBeNull();
    // The attested card renders no "Unattested" badge; the unattested one
    // does — UIBlockRenderer's own (#1399) badge, reused verbatim here.
    expect(screen.getAllByText('Unattested')).toHaveLength(1);
    // Ordinal grid: size preset maps to a grid-span class.
    const cells = container.querySelectorAll('.board-view__cell');
    expect(cells).toHaveLength(2);
    expect(cells[0]?.className).toContain('board-view__cell--md');
  });

  test('renders an error state with a retry action on failure', () => {
    queryResult = {
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    };
    render(<BoardView reference={{ kind: 'session', id: 's-1' }} />);
    expect(screen.getByText('The board could not be read.')).not.toBeNull();
    expect(screen.getByText('Retry')).not.toBeNull();
  });

  test('titles a session board and a task board distinctly', () => {
    queryResult = {
      data: { schemaVersion: 1, tabs: [], widgets: [] },
      isLoading: false,
      error: null,
    };
    const { rerender } = render(
      <BoardView reference={{ kind: 'session', id: 's-1' }} />,
    );
    expect(screen.getByText('Board · Session s-1')).not.toBeNull();
    rerender(
      <BoardView reference={{ kind: 'task', id: 't-1', projectId: 'p-1' }} />,
    );
    expect(screen.getByText('Board · Task t-1')).not.toBeNull();
  });
});
