import { describe, expect, test } from 'vitest';
import { projectTranscriptMessages } from '../components/chat/transcriptProjection';

describe('transcript message projection (station#1238)', () => {
  test('reuses completed row objects and changes only a streaming delta row', () => {
    const initial = [
      { role: 'user' as const, content: 'question', timestamp: 1 },
      { role: 'assistant' as const, content: 'draft', timestamp: 2 },
      { role: 'assistant' as const, content: 'complete', timestamp: 3 },
    ];
    const first = projectTranscriptMessages('thread-1', initial);
    const next = projectTranscriptMessages(
      'thread-1',
      [
        { ...initial[0] },
        { ...initial[1], content: 'draft plus delta' },
        { ...initial[2] },
      ],
      first,
    );

    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[2]).toBe(first[2]);
  });

  test('returns the previous array when a replay only rematerializes messages', () => {
    const initial = [
      { role: 'user' as const, content: 'question', timestamp: 1 },
      { role: 'assistant' as const, content: 'answer', timestamp: 2 },
    ];
    const first = projectTranscriptMessages('thread-1', initial);
    expect(
      projectTranscriptMessages(
        'thread-1',
        initial.map((message) => ({ ...message })),
        first,
      ),
    ).toBe(first);
  });

  test('keeps a settled assistant turn as ONE row with its work parts intact, in reading order', () => {
    // The interleave contract (station#2652 redesign): `contentParts` order
    // is derived from event order on every producing path, so the projection
    // must never strip or hoist work parts out of the message — the renderer
    // interleaves them with prose exactly as they happened.
    const contentParts = [
      { type: 'tool-invocation' as const, toolName: 'Search' },
      { type: 'text' as const, content: 'Found it.' },
      { type: 'tool-invocation' as const, toolName: 'Read' },
      { type: 'text' as const, content: 'Completed' },
    ];
    const messages = [
      {
        role: 'assistant' as const,
        turnId: 'settled-turn',
        content: 'Completed',
        timestamp: 1,
        contentParts,
      },
    ];
    const rows = projectTranscriptMessages('thread-1', messages);
    expect(rows.map((row) => row.kind)).toEqual(['message:assistant']);
    expect(rows[0].message.contentParts).toBe(contentParts);
  });

  test('keeps the deterministic 2,000-turn and one-megabyte fixture within one projection visit per message', () => {
    const messages = Array.from({ length: 2_000 }, (_, index) => ({
      role: 'assistant' as const,
      content: 'x'.repeat(512),
      timestamp: index,
      contentParts: [
        ...Array.from({ length: 50 }, (_, workIndex) => ({
          type: 'tool-invocation' as const,
          toolName: `Tool ${workIndex}`,
        })),
        { type: 'text' as const, content: 'x'.repeat(512) },
      ],
    }));

    const serializedBytes = new TextEncoder().encode(
      JSON.stringify(messages),
    ).byteLength;
    let messageReads = 0;
    const measuredMessages = new Proxy(messages, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          messageReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const rows = projectTranscriptMessages('long-thread', measuredMessages);
    expect(serializedBytes).toBeGreaterThanOrEqual(1_000_000);
    expect(messageReads).toBeLessThanOrEqual(messages.length);
    expect(rows).toHaveLength(2_000);
  });
});
