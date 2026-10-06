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
const ev = (
  eventId: string,
  e: Record<string, unknown>,
): CanonicalRuntimeEvent =>
  ({ eventId, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

/** The exact shape `codex-rollout-session-source.ts` writes. */
const codexCompacted = (eventId: string, turnId?: string) =>
  ev(eventId, {
    method: 'extension.notification',
    ...(turnId ? { turnId } : {}),
    createdAt: '2026-10-05T00:00:07.000Z',
    namespace: 'codex-rollout',
    type: 'context-compacted',
    payload: { source: 'provider-event' },
  });

const grokRewound = (eventId: string, turnId?: string) =>
  ev(eventId, {
    method: 'extension.notification',
    ...(turnId ? { turnId } : {}),
    createdAt: '2026-10-05T00:00:09.000Z',
    namespace: 'grok-session',
    type: 'conversation-rewound',
    payload: { targetPromptIndex: 0 },
  });

const shape = (messages: ReturnType<typeof projectRuntimeEventsToMessages>) =>
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.parts.map((part) => `${part.type}:${part.text}`).join('|'),
    ...(message.metadata?.answerEligible ? { answerEligible: true } : {}),
  }));

describe('extension transcript markers (station#3415)', () => {
  it('a marker at the end of a turn keeps the turn one canonical, answer-eligible row', () => {
    const messages = projectRuntimeEventsToMessages(
      [
        ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
        ev('e1', {
          method: 'content.text-delta',
          turnId: 't1',
          delta: 'the answer',
        }),
        codexCompacted('e2', 't1'),
        ev('e3', { method: 'turn.completed', turnId: 't1' }),
      ],
      { stableIds: true },
    );
    expect(shape(messages)).toEqual([
      { id: 'e0:user', role: 'user', text: 'text:question' },
      {
        id: 'e0:assistant',
        role: 'assistant',
        text: 'text:the answer',
        answerEligible: true,
      },
      {
        id: 'e2:transcript-marker',
        role: 'system',
        text: 'transcript-marker:Context compacted during this turn',
      },
    ]);
    // A held marker takes its turn's row time, so a reader that merges rows
    // by timestamp (the chat dock) keeps it after the turn, not inside it.
    expect(messages[1]!.metadata?.timestamp).toBe(
      Date.parse('2026-10-05T00:00:00.000Z'),
    );
    expect(messages[2]!.metadata).toEqual({
      timestamp: messages[1]!.metadata?.timestamp,
    });
  });

  it('a mid-turn marker leaves one assistant row and follows it once the turn closes', () => {
    const events = [
      ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
      ev('e1', {
        method: 'content.text-delta',
        turnId: 't1',
        delta: 'before. ',
      }),
      codexCompacted('e2', 't1'),
      ev('e3', { method: 'content.text-delta', turnId: 't1', delta: 'after.' }),
    ];
    // Open: the turn renders as it stands and the marker waits for its close.
    const open = projectRuntimeEventsToMessages(events, { stableIds: true });
    expect(shape(open)).toEqual([
      { id: 'e0:user', role: 'user', text: 'text:question' },
      { id: 'e0:assistant', role: 'assistant', text: 'text:before. after.' },
    ]);
    const closed = projectRuntimeEventsToMessages(
      [...events, ev('e4', { method: 'turn.completed', turnId: 't1' })],
      { stableIds: true },
    );
    expect(shape(closed)).toEqual([
      { id: 'e0:user', role: 'user', text: 'text:question' },
      {
        id: 'e0:assistant',
        role: 'assistant',
        text: 'text:before. after.',
        answerEligible: true,
      },
      {
        id: 'e2:transcript-marker',
        role: 'system',
        text: 'transcript-marker:Context compacted during this turn',
      },
    ]);
  });

  it('the open turn keeps its row id across a live marker', () => {
    const head = [
      ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
      ev('e1', {
        method: 'content.text-delta',
        turnId: 't1',
        delta: 'working',
      }),
    ];
    const before = projectRuntimeEventsToMessages(head, { stableIds: true });
    const after = projectRuntimeEventsToMessages(
      [
        ...head,
        codexCompacted('e2', 't1'),
        ev('e3', { method: 'content.text-delta', turnId: 't1', delta: ' on' }),
      ],
      { stableIds: true },
    );
    expect(after.map((message) => message.id)).toEqual(
      before.map((message) => message.id),
    );
    expect(after.at(-1)!.id).toBe('e0:assistant');
  });

  it('a marker between turns renders in place with the plain label', () => {
    const messages = projectRuntimeEventsToMessages(
      [
        ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'one' }),
        ev('e1', {
          method: 'content.text-delta',
          turnId: 't1',
          delta: 'answer',
        }),
        ev('e2', { method: 'turn.completed', turnId: 't1' }),
        grokRewound('e3'),
        ev('e4', { method: 'turn.started', turnId: 't2', prompt: 'two' }),
      ],
      { stableIds: true },
    );
    expect(shape(messages)).toEqual([
      { id: 'e0:user', role: 'user', text: 'text:one' },
      {
        id: 'e0:assistant',
        role: 'assistant',
        text: 'text:answer',
        answerEligible: true,
      },
      {
        id: 'e3:transcript-marker',
        role: 'system',
        text: 'transcript-marker:Rewound to an earlier prompt',
      },
      { id: 'e4:user', role: 'user', text: 'text:two' },
    ]);
    expect(messages[2]!.metadata).toEqual({
      timestamp: Date.parse('2026-10-05T00:00:09.000Z'),
    });
  });

  it('two markers and a steer in one turn still give unique ids, markers after the turn', () => {
    const messages = projectRuntimeEventsToMessages(
      [
        ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
        ev('e1', { method: 'content.text-delta', turnId: 't1', delta: 'one ' }),
        codexCompacted('e2', 't1'),
        codexCompacted('e3', 't1'),
        ev('e4', {
          method: 'turn.started',
          turnId: 't1',
          inputKind: 'steer',
          prompt: 'also this',
        }),
        ev('e5', { method: 'content.text-delta', turnId: 't1', delta: 'two' }),
        ev('e6', { method: 'turn.completed', turnId: 't1' }),
      ],
      { stableIds: true },
    );
    const ids = messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(shape(messages).map(({ role, text }) => [role, text])).toEqual([
      ['user', 'text:question'],
      ['assistant', 'text:one '],
      ['user', 'text:also this'],
      ['assistant', 'text:two'],
      ['system', 'transcript-marker:Context compacted during this turn'],
      ['system', 'transcript-marker:Context compacted during this turn'],
    ]);
  });

  it('a marker held by a turn that never closes in this window is not shown', () => {
    const messages = projectRuntimeEventsToMessages([
      ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
      codexCompacted('e1', 't1'),
    ]);
    expect(messages.map((message) => message.role)).toEqual(['user']);
  });

  it('a turn the next turn.started closes releases its markers before the new prompt', () => {
    const messages = projectRuntimeEventsToMessages([
      ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'one' }),
      ev('e1', { method: 'content.text-delta', turnId: 't1', delta: 'a' }),
      codexCompacted('e2', 't1'),
      ev('e3', { method: 'turn.started', turnId: 't2', prompt: 'two' }),
    ]);
    expect(shape(messages).map(({ role, text }) => [role, text])).toEqual([
      ['user', 'text:one'],
      ['assistant', 'text:a'],
      ['system', 'transcript-marker:Context compacted during this turn'],
      ['user', 'text:two'],
    ]);
  });

  it('drops an unknown tuple and leaves its turn whole', () => {
    for (const [namespace, type] of [
      ['codex-rollout', 'context-compacted-v2'],
      ['_x.ai', 'context-compacted'],
      ['_kiro.dev', 'compaction/status'],
      ['grok', 'conversation-rewound'],
    ]) {
      const messages = projectRuntimeEventsToMessages([
        ev('e0', { method: 'turn.started', turnId: 't1', prompt: 'question' }),
        ev('e1', {
          method: 'content.text-delta',
          turnId: 't1',
          delta: 'before. ',
        }),
        ev('e2', {
          method: 'extension.notification',
          turnId: 't1',
          namespace,
          type,
          payload: { message: 'Context compacted' },
        }),
        ev('e3', {
          method: 'content.text-delta',
          turnId: 't1',
          delta: 'after.',
        }),
        ev('e4', { method: 'turn.completed', turnId: 't1' }),
        ev('e5', {
          method: 'extension.notification',
          namespace,
          type,
          payload: {},
        }),
      ]);
      expect(
        messages.map((message) => message.role),
        `${namespace}/${type}`,
      ).toEqual(['user', 'assistant']);
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
