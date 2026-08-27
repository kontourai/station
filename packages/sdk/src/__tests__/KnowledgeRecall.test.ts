/**
 * @vitest-environment jsdom
 */

import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, useLayoutEffect, useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import {
  isRelevantKnowledgeRoot,
  KnowledgeRecallBrowser,
  knowledgeFreshnessLabel,
  knowledgeRecordFreshness,
  knowledgeRootIncarnationKey,
} from '../components/KnowledgeRecall';

const personalRoot: KnowledgeStoreRoot = {
  id: 'root:personal',
  scope: { kind: 'personal' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/personal',
  displayName: 'Personal',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const projectRoot: KnowledgeStoreRoot = {
  id: 'root:project-alpha',
  scope: { kind: 'project', projectSlug: 'alpha' },
  adapterId: 'kit-default-store',
  storeRoot: '/tmp/alpha',
  displayName: 'Alpha',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Knowledge recall contract', () => {
  test('shares personal plus active-project root scoping', () => {
    expect(isRelevantKnowledgeRoot(personalRoot, null)).toBe(true);
    expect(isRelevantKnowledgeRoot(projectRoot, 'alpha')).toBe(true);
    expect(isRelevantKnowledgeRoot(projectRoot, 'beta')).toBe(false);
    expect(isRelevantKnowledgeRoot(projectRoot, null)).toBe(false);
  });

  test('treats same-id adapter and store changes as new authority', () => {
    expect(
      knowledgeRootIncarnationKey({
        ...personalRoot,
        adapterId: 'kit-obsidian-store',
      }),
    ).not.toBe(knowledgeRootIncarnationKey(personalRoot));
    expect(
      knowledgeRootIncarnationKey({
        ...personalRoot,
        storeRoot: '/tmp/replacement',
      }),
    ).not.toBe(knowledgeRootIncarnationKey(personalRoot));
  });

  test('derives explicit, ttl, invalid, and absent freshness honestly', () => {
    const base = {
      id: 'record',
      type: 'concept' as const,
      title: 'Record',
      body: 'Body',
      category: 'test',
      provenance: { agent: 'test' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(
      knowledgeFreshnessLabel(
        knowledgeRecordFreshness({
          ...base,
          expires_at: '2026-02-01T00:00:00.000Z',
        }),
      ),
    ).toBe('Expires at 2026-02-01T00:00:00.000Z');
    expect(
      knowledgeFreshnessLabel(
        knowledgeRecordFreshness({ ...base, ttl_seconds: 60 }),
      ),
    ).toBe('Expires at 2026-01-01T00:01:00.000Z');
    expect(
      knowledgeFreshnessLabel(
        knowledgeRecordFreshness({ ...base, expires_at: 'not-a-date' }),
      ),
    ).toBe('Invalid expiry declaration: not-a-date');
    expect(knowledgeFreshnessLabel(knowledgeRecordFreshness(base))).toBe(
      'No expiry declared',
    );
  });

  test('owns node, record-link, and provenance-source navigation', async () => {
    const graph = {
      nodes: [
        {
          id: 'decision',
          type: 'concept' as const,
          title: 'Decision',
          category: 'decision',
        },
        {
          id: 'source',
          type: 'raw' as const,
          title: 'Source',
          category: 'source',
        },
      ],
      edges: [{ source: 'decision', target: 'source', kind: 'source' }],
    };
    const refetch = vi.fn(async () => undefined);
    const useRecordQuery = vi.fn((_rootId, recordId) => ({
      isLoading: false,
      isError: false,
      error: undefined,
      refetch,
      data:
        recordId === 'decision'
          ? {
              id: 'decision',
              type: 'concept' as const,
              title: 'Decision',
              body: 'Use the shared boundary.',
              category: 'decision',
              status: 'active' as const,
              expires_at: '2099-01-01T00:00:00.000Z',
              links: [
                {
                  target_id: 'source',
                  kind: 'source',
                  label: 'Decision evidence',
                },
              ],
              provenance: {
                agent: 'knowledge.synthesize',
                source_ids: ['source'],
              },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-02T00:00:00.000Z',
            }
          : {
              id: 'source',
              type: 'raw' as const,
              title: 'Source',
              body: 'Original evidence.',
              category: 'source',
              links: [],
              provenance: { agent: 'knowledge.ingest' },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
    }));

    render(
      createElement(KnowledgeRecallBrowser, {
        rootId: personalRoot.id,
        authorityKey: knowledgeRootIncarnationKey(personalRoot),
        graph,
        useRecordQuery,
        testIds: {
          recordTitle: 'record-title',
          recordProvenance: 'record-provenance',
          recordFreshness: 'record-freshness',
          recordLink: (id) => `record-link-${id}`,
          sourceLink: (id) => `source-link-${id}`,
        },
      }),
    );

    fireEvent.click(screen.getByTestId('knowledge-recall-node-decision'));
    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe('Decision'),
    );
    expect(screen.getByTestId('record-provenance').textContent).toContain(
      'knowledge.synthesize',
    );
    expect(screen.getByTestId('record-freshness').textContent).toContain(
      'Expires at 2099-01-01',
    );

    expect(screen.getByTestId('record-link-source').textContent).toContain(
      'Decision evidence: Source',
    );
    fireEvent.click(screen.getByTestId('record-link-source'));
    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe('Source'),
    );

    fireEvent.click(screen.getByTestId('knowledge-recall-node-decision'));
    await waitFor(() =>
      expect(screen.getByTestId('source-link-source')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('source-link-source'));
    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe('Source'),
    );
    expect(refetch).toHaveBeenCalled();
  });

  test('discloses outside-graph links without making them selectable', async () => {
    const refetch = vi.fn(async () => undefined);
    render(
      createElement(KnowledgeRecallBrowser, {
        rootId: personalRoot.id,
        authorityKey: knowledgeRootIncarnationKey(personalRoot),
        graph: {
          nodes: [
            {
              id: 'record',
              type: 'concept',
              title: 'Record',
              category: 'test',
            },
          ],
          edges: [],
        },
        useRecordQuery: () => ({
          isLoading: false,
          isError: false,
          error: undefined,
          refetch,
          data: {
            id: 'record',
            type: 'concept' as const,
            title: 'Record',
            body: 'Body',
            category: 'test',
            links: [
              {
                target_id: 'outside',
                kind: 'related',
                label: 'External context',
              },
            ],
            provenance: { agent: 'test' },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        }),
      }),
    );
    fireEvent.click(screen.getByTestId('knowledge-recall-node-record'));
    await waitFor(() => expect(screen.getByText(/outside graph/)).toBeTruthy());
    expect(screen.getByText(/External context: outside/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /outside/ })).toBeNull();
  });

  /**
   * Layout effects run inside the commit that first makes the graph
   * interactive, i.e. strictly before that commit's passive effects flush.
   * Selecting from one is the deterministic stand-in for a click landing in
   * that same window — the window that intermittently lost a click in #955.
   */
  function SelectDuringCommit({
    onSelect,
    recordId,
  }: {
    onSelect: (recordId: string) => void;
    recordId: string;
  }) {
    const fired = useRef(false);
    useLayoutEffect(() => {
      if (fired.current) return;
      fired.current = true;
      onSelect(recordId);
    }, [onSelect, recordId]);
    return null;
  }

  function stubRecordQuery(refetch = vi.fn(async () => undefined)) {
    return (_rootId: string | undefined, recordId: string | undefined) => ({
      isLoading: false,
      isError: false,
      error: undefined,
      refetch,
      data: {
        id: recordId ?? 'unknown',
        type: 'concept' as const,
        title: `Record ${recordId}`,
        body: 'Body',
        category: 'test',
        links: [],
        provenance: { agent: 'test' },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });
  }

  const graphA = {
    nodes: [
      {
        id: 'decision',
        type: 'concept' as const,
        title: 'Decision',
        category: 'decision',
      },
    ],
    edges: [],
  };

  test('keeps an uncontrolled selection made before mount effects flush', async () => {
    render(
      createElement(KnowledgeRecallBrowser, {
        rootId: personalRoot.id,
        authorityKey: knowledgeRootIncarnationKey(personalRoot),
        graph: graphA,
        useRecordQuery: stubRecordQuery(),
        renderGraph: ({ onSelect }) =>
          createElement(SelectDuringCommit, { onSelect, recordId: 'decision' }),
        testIds: { detail: 'browser-detail', recordTitle: 'record-title' },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe(
        'Record decision',
      ),
    );
    // Nothing after mount may retract it either.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('record-title').textContent).toBe(
      'Record decision',
    );
  });

  test('clears an uncontrolled selection when the root authority changes', async () => {
    const props = {
      rootId: personalRoot.id,
      graph: graphA,
      useRecordQuery: stubRecordQuery(),
      testIds: { detail: 'browser-detail', recordTitle: 'record-title' },
    };
    const { rerender } = render(
      createElement(KnowledgeRecallBrowser, {
        ...props,
        authorityKey: knowledgeRootIncarnationKey(personalRoot),
      }),
    );

    fireEvent.click(screen.getByTestId('knowledge-recall-node-decision'));
    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe(
        'Record decision',
      ),
    );

    // Same root id, replaced store: a new incarnation, so the previous
    // authority's record id must not survive into this one.
    rerender(
      createElement(KnowledgeRecallBrowser, {
        ...props,
        graph: { nodes: [], edges: [] },
        authorityKey: knowledgeRootIncarnationKey({
          ...personalRoot,
          storeRoot: '/tmp/replacement',
        }),
      }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId('record-title')).toBeNull(),
    );
    expect(screen.getByTestId('browser-detail').textContent).toContain(
      'Select a record',
    );
  });

  test('leaves controlled selection to the caller across an authority change', async () => {
    const props = {
      rootId: personalRoot.id,
      graph: graphA,
      selectedId: 'decision',
      useRecordQuery: stubRecordQuery(),
      testIds: { detail: 'browser-detail', recordTitle: 'record-title' },
    };
    const { rerender } = render(
      createElement(KnowledgeRecallBrowser, {
        ...props,
        authorityKey: knowledgeRootIncarnationKey(personalRoot),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe(
        'Record decision',
      ),
    );

    rerender(
      createElement(KnowledgeRecallBrowser, {
        ...props,
        authorityKey: knowledgeRootIncarnationKey({
          ...personalRoot,
          storeRoot: '/tmp/replacement',
        }),
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('record-title').textContent).toBe(
        'Record decision',
      ),
    );
  });
});
