import { describe, expect, test, vi } from 'vitest';
import type { DocMeta } from '../views/project-page/types';
import {
  buildKnowledgeScanOptions,
  buildRulesContent,
  splitKnowledgeDocs,
  timeAgo,
} from '../views/project-page/utils';

describe('project-page utils', () => {
  test('timeAgo formats recent timestamps across ranges', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));

    expect(timeAgo('2026-01-02T11:59:40Z')).toBe('just now');
    expect(timeAgo('2026-01-02T11:30:00Z')).toBe('30m ago');
    expect(timeAgo('2026-01-02T09:00:00Z')).toBe('3h ago');
    expect(timeAgo('2025-12-30T12:00:00Z')).toBe('3d ago');

    vi.useRealTimers();
  });

  test('buildRulesContent groups rule chunks by doc and preserves order', () => {
    expect(
      buildRulesContent([
        {
          text: 'second chunk',
          metadata: { docId: 'rules-1', chunkIndex: 1 },
        },
        {
          text: 'first chunk',
          metadata: { docId: 'rules-1', chunkIndex: 0 },
        },
        {
          text: 'other doc',
          metadata: { docId: 'rules-2', chunkIndex: 0 },
        },
      ]),
    ).toBe('first chunk\n\nsecond chunk\n\n---\n\nother doc');
  });

  test('splitKnowledgeDocs partitions directory and uploaded docs by namespace', () => {
    const docs: DocMeta[] = [
      {
        id: '1',
        filename: 'a.md',
        namespace: 'rules',
        source: 'upload',
        chunkCount: 1,
        createdAt: '',
      },
      {
        id: '2',
        filename: 'b.md',
        namespace: 'rules',
        source: 'directory-scan',
        chunkCount: 2,
        createdAt: '',
      },
      {
        id: '3',
        filename: 'c.md',
        source: 'upload',
        chunkCount: 3,
        createdAt: '',
      },
    ];

    expect(splitKnowledgeDocs(docs, 'rules')).toEqual({
      filteredDocs: [docs[0], docs[1]],
      dirDocs: [docs[1]],
      uploadDocs: [docs[0]],
    });
  });

  test('buildKnowledgeScanOptions trims empty patterns', () => {
    expect(
      buildKnowledgeScanOptions('src/**, docs/**', 'dist/**, , node_modules'),
    ).toEqual({
      includePatterns: ['src/**', 'docs/**'],
      excludePatterns: ['dist/**', 'node_modules'],
    });
  });
});
