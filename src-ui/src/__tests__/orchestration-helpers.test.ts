import { describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/active-chats-store', () => ({
  activeChatsStore: {
    getSnapshot: () => ({}),
    updateChat: () => undefined,
  },
}));

// station#1225: `snapshotHandlers.ts` now imports `rehydrateChatSession.ts`
// for its reconnect-fallback refetch, which transitively reaches
// `contexts/conversations-store.ts` -> `utils/logger.ts`'s module-level
// `localStorage` read — undefined in this file's test environment. This
// suite only exercises the pure `buildOrchestrationSnapshotSyncPlan` (never
// the refetch path), so a bare mock is enough to keep the import graph out
// of this environment's way; `rehydrateChatSession`'s own behavior is
// covered by `hooks/orchestration/__tests__/rehydrateChatSession.test.ts`
// and `snapshotHandlers.test.ts`.
vi.mock('../hooks/orchestration/rehydrateChatSession', () => ({
  rehydrateChatSession: vi.fn().mockResolvedValue(undefined),
}));

import type { ChatContentPart } from '../contexts/active-chats-state';
import {
  buildAssistantTurnContent,
  upsertTextPart,
  upsertToolPart,
} from '../hooks/orchestration/messageParts';
import { buildOrchestrationSnapshotSyncPlan } from '../hooks/orchestration/snapshotHandlers';

describe('orchestration helpers', () => {
  test('snapshot rehydration prefers a runtime-reported model over a legacy requested selector', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-fable',
            status: 'ready',
            effectiveModel: 'claude-fable-5[1m]',
            reportedModel: 'claude-fable-5',
          },
        ],
        exitedThreadIds: [],
      } as any,
      { 'thread-fable': {} } as any,
    );

    expect(plan.sessionUpdates).toEqual([
      {
        threadId: 'thread-fable',
        updates: expect.objectContaining({
          model: 'claude-fable-5',
          orchestrationModel: 'claude-fable-5',
        }),
      },
    ]);
  });

  test('snapshot updates the reported model without eroding a pending picker request', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-live',
            status: 'ready',
            reportedModel: 'reported-model',
          },
        ],
      } as any,
      {
        'thread-live': {
          requestedModel: 'picker-model',
          providerOptions: { effort: 'high' },
        },
      } as any,
    );

    expect(plan.sessionUpdates[0]?.updates).toMatchObject({
      model: 'reported-model',
    });
    expect(plan.sessionUpdates[0]?.updates.requestedModel).toBeUndefined();
    // The plan does not write requestedModel at all until the report matches.
    expect('requestedModel' in (plan.sessionUpdates[0]?.updates ?? {})).toBe(
      false,
    );
  });

  test('matching reported model collapses the acknowledged picker request', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-live',
            status: 'ready',
            reportedModel: 'picker-model',
          },
        ],
      } as any,
      { 'thread-live': { requestedModel: 'picker-model' } } as any,
    );
    expect(plan.sessionUpdates[0]?.updates).toMatchObject({
      model: 'picker-model',
      requestedModel: undefined,
      requestedModelSource: undefined,
    });
  });

  test('upsertTextPart appends without mutating the original array', () => {
    const parts: ChatContentPart[] = [{ type: 'text', content: 'Hello' }];

    const next = upsertTextPart(parts, 'text', ' world');

    expect(next).toEqual([{ type: 'text', content: 'Hello world' }]);
    expect(parts).toEqual([{ type: 'text', content: 'Hello' }]);
  });

  // station#3690: text streamed AFTER a tool call must not be folded back into
  // the text part that preceded it. Appending to the first same-type part
  // rewrites the turn's reading order — and only on the live path, so the same
  // turn reordered itself on reload once durable replay rebuilt it correctly.
  test('upsertTextPart starts a new segment when a tool part is the tail', () => {
    const beforeTool = upsertTextPart(undefined, 'text', 'Before');
    const withTool = upsertToolPart(beforeTool, 'tool-1', {
      toolName: 'run_command',
      state: 'running',
    });

    const afterTool = upsertTextPart(withTool, 'text', 'After');

    expect(afterTool.map((part) => part.type)).toEqual([
      'text',
      'tool-invocation',
      'text',
    ]);
    expect(afterTool[0].content).toBe('Before');
    expect(afterTool[2].content).toBe('After');
  });

  // The same divergence for reasoning, which streams through the identical
  // helper and interleaves with tool calls the same way.
  test('upsertTextPart keeps reasoning after a tool call in reading order', () => {
    const parts = upsertToolPart(
      upsertTextPart(undefined, 'reasoning', 'Thinking first'),
      'tool-2',
      { toolName: 'read_file', state: 'running' },
    );

    const next = upsertTextPart(parts, 'reasoning', 'Thinking again');

    expect(next.map((part) => part.type)).toEqual([
      'reasoning',
      'tool-invocation',
      'reasoning',
    ]);
    expect(next[0].content).toBe('Thinking first');
    expect(next[2].content).toBe('Thinking again');
  });

  // Consecutive deltas with nothing between them still coalesce — segmenting
  // is driven by what the tail IS, not by how many deltas arrive.
  test('upsertTextPart still coalesces consecutive deltas into one part', () => {
    const next = upsertTextPart(
      upsertTextPart(upsertTextPart(undefined, 'text', 'a'), 'text', 'b'),
      'text',
      'c',
    );

    expect(next).toEqual([{ type: 'text', content: 'abc' }]);
  });

  test('upsertToolPart creates and updates the matching tool part', () => {
    const created = upsertToolPart(undefined, 'tool-1', {
      toolName: 'Search',
      args: { query: 'alpha' },
      state: 'running',
    });

    expect(created).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolName: 'Search',
        args: { query: 'alpha' },
        state: 'running',
      },
    ]);

    const updated = upsertToolPart(created, 'tool-1', {
      state: 'completed',
      result: { ok: true },
    });

    expect(updated).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolName: 'Search',
        args: { query: 'alpha' },
        state: 'completed',
        result: { ok: true },
      },
    ]);
  });

  test('buildAssistantTurnContent prefers explicit content, then parts, then fallback text', () => {
    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: 'Direct content',
          contentParts: [{ type: 'text', content: 'ignored' }],
        },
        'fallback',
      ),
    ).toBe('Direct content');

    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: '',
          contentParts: [
            { type: 'text', content: 'First line' },
            { type: 'reasoning', content: 'Second line' },
          ],
        },
        'fallback',
      ),
    ).toBe('First line\nSecond line');

    expect(
      buildAssistantTurnContent(
        {
          role: 'assistant',
          content: '',
          contentParts: [],
        },
        'fallback',
      ),
    ).toBe('fallback');
  });

  test('snapshot running status with no open turn does not re-strand the chat (#1034)', () => {
    const chats = {
      'thread-a': {
        provider: 'claude',
        orchestrationSessionStarted: true,
        orchestrationStatus: 'idle',
      },
      'thread-b': {
        provider: 'claude',
        orchestrationSessionStarted: true,
        orchestrationStatus: 'idle',
      },
      'thread-c': {
        provider: 'claude',
        orchestrationSessionStarted: true,
        orchestrationStatus: 'idle',
      },
    } as any;
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          // Process alive, turn finished — the reconnect case that used to
          // reintroduce the stuck "Working…" shell (#1005's second channel).
          {
            provider: 'claude',
            threadId: 'thread-a',
            status: 'running',
            hasActiveTurn: false,
          },
          // Genuinely mid-turn: unchanged behavior.
          {
            provider: 'claude',
            threadId: 'thread-b',
            status: 'running',
            hasActiveTurn: true,
          },
          // Legacy payload without the fold: unchanged behavior.
          { provider: 'claude', threadId: 'thread-c', status: 'running' },
        ],
      },
      chats,
    );

    const byThread = Object.fromEntries(
      plan.sessionUpdates.map((entry) => [entry.threadId, entry.updates]),
    );
    expect(byThread['thread-a']).toMatchObject({
      orchestrationStatus: 'idle',
      status: 'idle',
      orchestrationTurnOpen: false,
    });
    expect(byThread['thread-b']).toMatchObject({
      orchestrationStatus: 'running',
      status: 'sending',
      orchestrationTurnOpen: true,
    });
    expect(byThread['thread-c']).toMatchObject({
      orchestrationStatus: 'running',
      status: 'sending',
    });
    // Legacy payload without hasActiveTurn: the display fields keep the
    // conservative #1034 defaults, but the long-lived fold is NOT seeded —
    // persisting the assumption would let an attach-only 'running' re-engage
    // the shell with nothing ever clearing it (#1076 closure round).
    expect('orchestrationTurnOpen' in (byThread['thread-c'] ?? {})).toBe(false);
  });

  // #1076: the snapshot reseeds the client turn fold even when the provider
  // process status is NOT 'running' — a reconnect during an in-turn approval
  // projects status 'ready' with hasActiveTurn true, and the next live
  // 'running' state-change must be able to re-engage the shell.
  test('snapshot reseeds orchestrationTurnOpen during an in-turn approval reconnect (#1076)', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-approval',
            status: 'ready',
            hasActiveTurn: true,
          },
        ],
      },
      {
        'thread-approval': {
          provider: 'claude',
          orchestrationSessionStarted: true,
          orchestrationStatus: 'awaiting-approval',
        },
      } as any,
    );
    expect(plan.sessionUpdates[0]?.updates).toMatchObject({
      orchestrationTurnOpen: true,
    });
  });

  test('buildOrchestrationSnapshotSyncPlan keeps live sessions and flags exited orchestration chats', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-live',
            status: 'running',
            model: 'sonnet',
            effectiveModel: 'opus',
            effectiveModelOptions: { effort: 'high' },
          },
        ],
      },
      {
        'thread-live': {
          provider: 'claude',
          orchestrationSessionStarted: true,
          orchestrationStatus: 'running',
        },
        'thread-exited': {
          provider: 'claude',
          orchestrationSessionStarted: true,
          orchestrationStatus: 'running',
        },
        'thread-bedrock': {
          provider: 'bedrock',
          orchestrationSessionStarted: true,
          orchestrationStatus: 'running',
        },
      },
    );

    expect(plan).toEqual({
      sessionUpdates: [
        {
          threadId: 'thread-live',
          updates: {
            provider: 'claude',
            model: 'opus',
            providerOptions: { effort: 'high' },
            orchestrationProvider: 'claude',
            orchestrationModel: 'opus',
            orchestrationSessionStarted: true,
            orchestrationStatus: 'running',
            status: 'sending',
          },
        },
      ],
      exitedThreadIds: ['thread-exited'],
    });
  });

  test('snapshot model reset replaces stale controls while preserving approval state', () => {
    const plan = buildOrchestrationSnapshotSyncPlan(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'thread-reset',
            status: 'ready',
            model: 'opus',
            effectiveModel: 'opus',
            effectiveModelOptions: {},
          },
        ],
      },
      {
        'thread-reset': {
          provider: 'claude',
          providerOptions: {
            approvalMode: 'never',
            effort: 'high',
            fastMode: true,
          },
          orchestrationSessionStarted: true,
          orchestrationStatus: 'ready',
        },
      },
    );

    expect(plan.sessionUpdates[0]?.updates.providerOptions).toEqual({
      approvalMode: 'never',
    });
  });
});
