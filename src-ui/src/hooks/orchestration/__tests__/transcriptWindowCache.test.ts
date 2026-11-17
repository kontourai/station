import { afterEach, describe, expect, test } from 'vitest';
import {
  clearTranscriptWindowCache,
  readTranscriptWindow,
  TRANSCRIPT_WINDOW_CACHE_MAX_BYTES,
  TRANSCRIPT_WINDOW_CACHE_MAX_ENTRIES,
  type TranscriptWindowSnapshot,
  transcriptWindowCacheGeneration,
  transcriptWindowCacheKey,
  transcriptWindowCacheKeys,
  writeTranscriptWindow,
} from '../transcriptWindowCache';

function snapshot(padding = 0): TranscriptWindowSnapshot {
  return {
    events: [
      {
        sequence: 1,
        event: {
          eventId: 'e1',
          method: 'turn.started',
          provider: 'codex',
          threadId: 'thread',
          turnId: 'turn',
          prompt: 'x'.repeat(padding),
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      },
    ] as TranscriptWindowSnapshot['events'],
    watermark: 1,
    handoffs: [],
    contextBoundaries: [],
    partialTurnStartEventIds: [],
  };
}

const key = (conversationId: string) =>
  transcriptWindowCacheKey({
    namespace: 'v1|env=a|principal=human:a|grant=operator',
    apiBase: 'http://station.test',
    conversationId,
  })!;

afterEach(() => clearTranscriptWindowCache());

describe('transcript window cache', () => {
  test('bounds: literal limits pinned beside the constants', () => {
    expect(TRANSCRIPT_WINDOW_CACHE_MAX_ENTRIES).toBe(12);
    expect(TRANSCRIPT_WINDOW_CACHE_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  test('the entry past the count bound evicts the least recently used one', () => {
    for (let index = 0; index < 12; index += 1)
      expect(writeTranscriptWindow(key(`c${index}`), snapshot())).toBe(true);
    // Reading c0 makes c1 the least recently used.
    expect(readTranscriptWindow(key('c0'))).toBeDefined();
    writeTranscriptWindow(key('c12'), snapshot());
    const keys = transcriptWindowCacheKeys();
    expect(keys).toHaveLength(12);
    expect(readTranscriptWindow(key('c1'))).toBeUndefined();
    expect(readTranscriptWindow(key('c0'))).toBeDefined();
    expect(readTranscriptWindow(key('c12'))).toBeDefined();
  });

  test('the entry past the byte bound evicts the oldest until the total fits', () => {
    const third = Math.floor(TRANSCRIPT_WINDOW_CACHE_MAX_BYTES / 3);
    writeTranscriptWindow(key('big-0'), snapshot(third));
    writeTranscriptWindow(key('big-1'), snapshot(third));
    writeTranscriptWindow(key('big-2'), snapshot(third - 3_000));
    expect(transcriptWindowCacheKeys()).toHaveLength(3);
    writeTranscriptWindow(key('big-3'), snapshot(third));
    expect(readTranscriptWindow(key('big-0'))).toBeUndefined();
    expect(transcriptWindowCacheKeys()).toEqual([
      key('big-1'),
      key('big-2'),
      key('big-3'),
    ]);
  });

  test('a snapshot over the byte bound alone is refused, not kept by evicting others', () => {
    writeTranscriptWindow(key('small'), snapshot());
    expect(
      writeTranscriptWindow(
        key('huge'),
        snapshot(TRANSCRIPT_WINDOW_CACHE_MAX_BYTES + 1),
      ),
    ).toBe(false);
    expect(readTranscriptWindow(key('huge'))).toBeUndefined();
    expect(readTranscriptWindow(key('small'))).toBeDefined();
  });

  test('no verified authority, no key; authorities partition one conversation', () => {
    expect(
      transcriptWindowCacheKey({
        namespace: null,
        apiBase: 'http://station.test',
        conversationId: 'c',
      }),
    ).toBeUndefined();
    const a = transcriptWindowCacheKey({
      namespace: 'ns-a',
      apiBase: 'http://station.test',
      conversationId: 'c',
    });
    const b = transcriptWindowCacheKey({
      namespace: 'ns-b',
      apiBase: 'http://station.test',
      conversationId: 'c',
    });
    writeTranscriptWindow(a, snapshot());
    expect(readTranscriptWindow(b)).toBeUndefined();
  });

  test('a write read before a clear is refused', () => {
    const before = transcriptWindowCacheGeneration();
    clearTranscriptWindowCache();
    expect(writeTranscriptWindow(key('late'), snapshot(), before)).toBe(false);
    expect(readTranscriptWindow(key('late'))).toBeUndefined();
  });
});
