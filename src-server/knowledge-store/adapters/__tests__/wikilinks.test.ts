import { describe, expect, test } from 'vitest';
import { extractWikilinks } from '../shared/wikilinks.js';

describe('extractWikilinks', () => {
  test('bounds an unterminated wikilink target (station#2384)', () => {
    const startedAt = performance.now();
    expect(extractWikilinks('[['.repeat(50_000))).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('keeps a long but valid target as a graph edge (station#2384)', () => {
    const target = `doc-${'a'.repeat(2_000)}`;
    expect(extractWikilinks(`See [[${target}|Long document]].`)).toEqual([
      { target_id: target, kind: 'related', label: 'Long document' },
    ]);
  });
});
