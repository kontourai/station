// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let roots: unknown[] = [];
let rootsError: Error | null = null;
const refetchRoots = vi.fn();
let graphData: unknown;
let graphError: Error | null = null;
const refetchGraph = vi.fn();

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  // Stubbed so the cached-data-survives-a-refetch-error tests below can
  // assert MemoryTab's own branch choice without depending on the real
  // browser's internal record query.
  KnowledgeRecallBrowser: ({ rootId }: { rootId: string }) => (
    <div data-testid="knowledge-recall-browser">{rootId}</div>
  ),
  useKnowledgeRootsQuery: () => ({
    data: roots,
    isLoading: false,
    isError: rootsError !== null,
    error: rootsError,
    refetch: refetchRoots,
  }),
  useGlobalKnowledgeStatusQuery: () => ({
    data: undefined,
    isError: false,
  }),
  useKnowledgeGraphQuery: () => ({
    data: graphData,
    isLoading: false,
    isError: graphError !== null,
    error: graphError,
    refetch: refetchGraph,
  }),
}));

import MemoryTab from '../MemoryTab';

/**
 * archive#771 regression. Both `rootsLoading` and `graphLoading` gates used
 * to fall straight through to a fabricated negative fact on a settled error
 * "No memory stores are configured." / "no recall graph available" —
 * indistinguishable from a host that genuinely has none.
 */
describe('MemoryTab (#771)', () => {
  beforeEach(() => {
    roots = [];
    rootsError = null;
    refetchRoots.mockReset();
    graphData = undefined;
    graphError = null;
    refetchGraph.mockReset();
  });

  test('renders an error state with retry when the knowledge roots query fails', () => {
    rootsError = new Error('knowledge roots unavailable');

    render(<MemoryTab />);

    expect(screen.getByText("Couldn't load memory stores")).toBeTruthy();
    expect(screen.getByText('knowledge roots unavailable')).toBeTruthy();
    expect(screen.queryByText('No memory stores are configured.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchRoots).toHaveBeenCalledTimes(1);
  });

  test('renders an error state with retry when the recall graph query fails', () => {
    roots = [
      {
        id: 'root-1',
        displayName: 'Root one',
        adapterId: 'adapter-1',
        scope: { kind: 'global' },
      },
    ];
    graphError = new Error('recall graph unavailable');

    render(<MemoryTab />);

    expect(
      screen.getByText("Couldn't load this memory store's recall graph"),
    ).toBeTruthy();
    expect(screen.getByText('recall graph unavailable')).toBeTruthy();
    expect(
      screen.queryByText(
        'The selected memory store has no recall graph available.',
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchGraph).toHaveBeenCalledTimes(1);
  });

  test('still shows the genuine empty state when nothing errored', () => {
    render(<MemoryTab />);
    expect(screen.getByText('No memory stores are configured.')).toBeTruthy();
  });

  // archive#771: both error branches used to
  // outrank the data unconditionally, so a REFETCH failure with cached
  // roots/graph on hand blanked a working tab behind an error card — the
  // exact regression archive#769 exists to prevent.
  test('keeps rendering cached roots when a roots refetch fails', () => {
    roots = [
      {
        id: 'root-1',
        displayName: 'Root one',
        adapterId: 'adapter-1',
        scope: { kind: 'global' },
      },
    ];
    graphData = { nodes: [], edges: [] };
    rootsError = new Error('roots refetch failed');

    render(<MemoryTab />);

    expect(screen.getByTestId('knowledge-recall-browser')).toBeTruthy();
    expect(screen.queryByText("Couldn't load memory stores")).toBeNull();
    expect(screen.queryByText('roots refetch failed')).toBeNull();
  });

  test('keeps rendering the cached recall graph when a graph refetch fails', () => {
    roots = [
      {
        id: 'root-1',
        displayName: 'Root one',
        adapterId: 'adapter-1',
        scope: { kind: 'global' },
      },
    ];
    graphData = { nodes: [], edges: [] };
    graphError = new Error('graph refetch failed');

    render(<MemoryTab />);

    expect(screen.getByTestId('knowledge-recall-browser')).toBeTruthy();
    expect(
      screen.queryByText("Couldn't load this memory store's recall graph"),
    ).toBeNull();
    expect(screen.queryByText('graph refetch failed')).toBeNull();
  });
});
