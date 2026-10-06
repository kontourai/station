import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_TRANSCRIPT_MARKERS,
  extensionTranscriptMarker,
} from '../extension-transcript-markers.js';
import { projectRuntimeEventsToMessages } from '../runtime-event-projection.js';

const base = {
  provider: 'codex',
  threadId: 'external:codex:native-session',
  createdAt: '2026-10-05T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

/** The exact shape `codex-rollout-session-source.ts` writes. */
const codexCompacted = (createdAt = base.createdAt) =>
  ev({
    method: 'extension.notification',
    turnId: 't1',
    createdAt,
    namespace: 'codex-rollout',
    type: 'context-compacted',
    payload: { source: 'provider-event' },
  } as Partial<CanonicalRuntimeEvent> & { method: string });

/** A turn with `notification` between its two halves of text. */
function turnAround(notification: CanonicalRuntimeEvent) {
  return [
    ev({ method: 'turn.started', turnId: 't1', prompt: 'question' }),
    ev({ method: 'content.text-delta', turnId: 't1', delta: 'before. ' }),
    notification,
    ev({ method: 'content.text-delta', turnId: 't1', delta: 'after.' }),
    ev({ method: 'turn.completed', turnId: 't1' }),
  ];
}

const shape = (messages: ReturnType<typeof projectRuntimeEventsToMessages>) =>
  messages.map((message) => ({
    role: message.role,
    parts: message.parts.map(({ type, text }) => ({ type, text })),
  }));

describe('extension transcript markers (station#3415)', () => {
  it('projects a Codex context compaction as a marker row inside its turn', () => {
    const notification = codexCompacted('2026-10-05T00:00:07.000Z');
    const messages = projectRuntimeEventsToMessages(turnAround(notification), {
      stableIds: true,
    });
    expect(shape(messages)).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'before. ' }] },
      {
        role: 'system',
        parts: [{ type: 'transcript-marker', text: 'Context compacted' }],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'after.' }] },
    ]);
    const marker = messages[2]!;
    expect(marker.id).toBe(`${notification.eventId}:transcript-marker`);
    expect(marker.metadata).toEqual({
      timestamp: Date.parse('2026-10-05T00:00:07.000Z'),
    });
    // The turn stayed open across the marker: both halves name it, and the
    // row after the marker is the one that owns the turn's terminal facts.
    expect(messages[1]!.metadata?.turnId).toBe('t1');
    expect(messages[3]!.metadata?.turnId).toBe('t1');
    // The answer row keeps the turn's canonical identity; the segment before
    // the marker takes one of its own, so no two rows share a key.
    expect(messages[3]!.id).toBe(
      `${messages[0]!.metadata?.sourceEventId}:assistant`,
    );
    expect(messages[1]!.id).toBe(
      `${notification.eventId}:assistant-before-marker`,
    );
  });

  it('projects a marker between turns without opening one', () => {
    const messages = projectRuntimeEventsToMessages([
      ev({ method: 'turn.started', turnId: 't1', prompt: 'one' }),
      ev({ method: 'content.text-delta', turnId: 't1', delta: 'answer' }),
      ev({ method: 'turn.completed', turnId: 't1' }),
      ev({
        method: 'extension.notification',
        namespace: 'grok-session',
        type: 'conversation-rewound',
        payload: { targetPromptIndex: 0 },
      } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ev({ method: 'turn.started', turnId: 't2', prompt: 'two' }),
    ]);
    expect(shape(messages)).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
      {
        role: 'system',
        parts: [
          { type: 'transcript-marker', text: 'Rewound to an earlier prompt' },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'two' }] },
    ]);
  });

  it('drops an unknown tuple and leaves its turn whole', () => {
    for (const [namespace, type] of [
      ['codex-rollout', 'context-compacted-v2'],
      ['_x.ai', 'context-compacted'],
      ['_kiro.dev', 'compaction/status'],
      ['grok', 'conversation-rewound'],
    ]) {
      const messages = projectRuntimeEventsToMessages(
        turnAround(
          ev({
            method: 'extension.notification',
            turnId: 't1',
            namespace,
            type,
            payload: { message: 'Context compacted' },
          } as Partial<CanonicalRuntimeEvent> & { method: string }),
        ),
      );
      expect(shape(messages), `${namespace}/${type}`).toEqual([
        { role: 'user', parts: [{ type: 'text', text: 'question' }] },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'before. after.' }],
        },
      ]);
    }
  });

  it('matches only the exact listed tuples', () => {
    expect(
      EXTENSION_TRANSCRIPT_MARKERS.map(({ namespace, type, marker }) => [
        namespace,
        type,
        marker,
      ]),
    ).toEqual([
      ['codex-rollout', 'context-compacted', 'context-compacted'],
      ['grok-session', 'context-compacted', 'context-compacted'],
      ['grok-session', 'conversation-rewound', 'conversation-rewound'],
    ]);
    expect(
      extensionTranscriptMarker('codex-rollout', 'Context-Compacted'),
    ).toBeUndefined();
    expect(
      extensionTranscriptMarker('codex-rollout ', 'context-compacted'),
    ).toBeUndefined();
  });
});
