// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isDurableActiveChat } from '../../../../contexts/active-chats-state';
import { activeChatsStore } from '../../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../../contexts/background-tasks-store';
import { toastStore } from '../../../../contexts/ToastContext';
import { handleOrchestrationEvent } from '../../eventHandlers';
import type { OrchestrationEvent } from '../../types';
import { detectReplayIssues } from '../observe';
import { SessionTapePlayer } from '../player';
import {
  _resetReplayRegistry,
  isReplayThread,
  registerReplayThread,
  unregisterReplayThread,
} from '../replay-registry';
import { rewriteEventThreadId } from '../rewrite';
import { tapeFromSessionEvents } from '../tape';

const SOURCE = 'live-thread-1';

function event(
  method: string,
  overrides: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    eventId: `evt-${method}-${overrides.turnId ?? 't'}`,
    provider: 'claude',
    threadId: SOURCE,
    createdAt: '2026-09-11T00:00:00.000Z',
    method,
    ...overrides,
  } as unknown as OrchestrationEvent;
}

function seedReplayChat(replayId: string) {
  activeChatsStore.initChat(replayId, {
    agentSlug: 'dev-agent',
    agentName: 'Dev Agent',
    title: 'Event replay · fixture',
    orchestrationSessionStarted: true,
    replay: { sourceThreadId: SOURCE, tapeEventCount: 4 },
  });
}

describe('session tape player', () => {
  const liveId = 'unrelated-live-chat';

  beforeEach(() => {
    _resetReplayRegistry();
    backgroundTasksStore.reset();
    activeChatsStore.initChat(liveId, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Live',
      conversationId: liveId,
    });
  });

  afterEach(() => {
    for (const id of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(id);
    }
    _resetReplayRegistry();
  });

  test('folds under a synthetic id without touching a live chat or leaking lineage', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    const liveBefore = activeChatsStore.getSnapshot()[liveId];
    const tape = tapeFromSessionEvents(
      { threadId: SOURCE, agentSlug: 'dev-agent' },
      [
        event('turn.started', { turnId: 'turn-1' }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'Hi',
        }),
        event('turn.completed', { turnId: 'turn-1', outputText: 'Hi' }),
      ],
    );
    const player = new SessionTapePlayer(tape, replayId);
    player.step();
    player.step();
    const mid = player.observe();
    expect(mid.streaming.present).toBe(true);
    expect(mid.streaming.textLength).toBeGreaterThan(0);
    expect(mid.issues).toEqual([]);
    player.step();
    const done = player.observe();
    expect(done.streaming.present).toBe(false);
    expect(done.history.messageCount).toBeGreaterThan(0);
    expect(done.issues).toEqual([]);
    const replayChat = activeChatsStore.getSnapshot()[replayId];
    expect(replayChat.conversationId).toBeUndefined();
    expect(replayChat.currentSessionId).toBeUndefined();
    expect(activeChatsStore.getSnapshot()[liveId]).toEqual(liveBefore);
    expect(isDurableActiveChat(replayChat)).toBe(false);
  });

  test('scrubbing backward refolds the prefix instead of inverting a delta', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    const tape = tapeFromSessionEvents(
      { threadId: SOURCE, agentSlug: 'dev-agent' },
      [
        event('turn.started', { turnId: 'turn-1' }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'A',
        }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'B',
        }),
      ],
    );
    const player = new SessionTapePlayer(tape, replayId);
    player.seek(2);
    expect(player.observe().streaming.textLength).toBe(2);
    player.back();
    expect(player.observe().streaming.textLength).toBe(1);
    expect(player.observe().cursor.method).toBe('content.text-delta');
  });

  test('rewritten events do not fuzzy-match a live chat that shares the source thread id', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    activeChatsStore.updateChat(liveId, { currentSessionId: SOURCE });
    const rewritten = rewriteEventThreadId(
      event('content.text-delta', {
        turnId: 'turn-1',
        itemId: 'i',
        delta: 'nope',
      }),
      replayId,
    );
    handleOrchestrationEvent('', rewritten);
    const live = activeChatsStore.getSnapshot()[liveId];
    expect(live.streamingMessage?.content ?? '').not.toContain('nope');
    expect(
      activeChatsStore.getSnapshot()[replayId].streamingMessage?.content,
    ).toContain('nope');
  });

  test('detects a duplicate streaming shell plus settled row for the same turn', () => {
    const issues = detectReplayIssues(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        orchestrationSessionStarted: true,
        orchestrationTurnOpen: true,
        openTurnId: 'turn-1',
        streamingMessage: {
          role: 'assistant',
          content: 'Hi',
          contentParts: [],
        },
        messages: [
          {
            role: 'assistant',
            content: 'Hi',
            turnId: 'turn-1',
          },
        ],
      },
      event('content.text-delta', { turnId: 'turn-1', delta: 'Hi' }),
      SOURCE,
    );
    expect(issues.map((issue) => issue.code)).toContain(
      'duplicate-streaming-and-settled',
    );
  });

  test('folding a tape fires no toasts, notifications, ingest, or queue drain', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    const ingest = vi.spyOn(backgroundTasksStore, 'ingest');
    const show = vi.spyOn(toastStore, 'show');
    const showTool = vi.spyOn(toastStore, 'showToolActivity');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tape = tapeFromSessionEvents(
      { threadId: SOURCE, agentSlug: 'dev-agent' },
      [
        event('turn.started', { turnId: 'turn-1' }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'Hi',
        }),
        event('tool.completed', {
          turnId: 'turn-1',
          itemId: 'tool-1',
          toolCallId: 'tool-1',
          toolName: 'bash',
          status: 'success',
        }),
        event('runtime.warning', { message: 'nope', code: 'x' }),
        event('turn.completed', { turnId: 'turn-1', outputText: 'Hi' }),
      ],
    );
    const player = new SessionTapePlayer(tape, replayId, 'http://example.test');
    player.seek(tape.events.length - 1);
    expect(ingest).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(showTool).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    ingest.mockRestore();
    show.mockRestore();
    showTool.mockRestore();
    fetchSpy.mockRestore();
    unregisterReplayThread(replayId);
    expect(isReplayThread(replayId)).toBe(false);
  });
});

describe('engine-shaped tapes through the live fold', () => {
  afterEach(() => {
    for (const id of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(id);
    }
    _resetReplayRegistry();
  });

  test('a Claude-shaped turn that exits without turn.completed drops in-flight text', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    const tape = tapeFromSessionEvents(
      { threadId: SOURCE, agentSlug: 'dev-agent', provider: 'claude' },
      [
        event('turn.started', { turnId: 'turn-1', provider: 'claude' }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'TURN ONE OK.',
          provider: 'claude',
        }),
        event('tool.started', {
          turnId: 'turn-1',
          toolCallId: 'toolu_1',
          toolName: 'Bash',
          provider: 'claude',
        }),
        event('tool.completed', {
          turnId: 'turn-1',
          toolCallId: 'toolu_1',
          toolName: 'Bash',
          status: 'success',
          provider: 'claude',
        }),
        event('session.exited', { provider: 'claude', sessionId: SOURCE }),
      ],
    );
    const player = new SessionTapePlayer(tape, replayId);
    player.seek(tape.events.length - 1);
    const observation = player.observe();
    expect(observation.streaming.present).toBe(false);
    expect(observation.history.messageCount).toBe(0);
    expect(observation.issues.map((issue) => issue.code)).toContain(
      'in-flight-content-dropped-on-session-exit',
    );
  });

  test('a Muse-shaped happy path settles without issues', () => {
    const replayId = registerReplayThread();
    seedReplayChat(replayId);
    const tape = tapeFromSessionEvents(
      { threadId: SOURCE, agentSlug: 'dev-agent', provider: 'muse' },
      [
        event('turn.started', { turnId: 'turn-1', provider: 'muse' }),
        event('content.text-delta', {
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'echo: say hello',
          provider: 'muse',
        }),
        event('turn.completed', {
          turnId: 'turn-1',
          outputText: 'echo: say hello',
          provider: 'muse',
        }),
      ],
    );
    const player = new SessionTapePlayer(tape, replayId);
    player.seek(tape.events.length - 1);
    const observation = player.observe();
    expect(observation.streaming.present).toBe(false);
    expect(observation.history.messageCount).toBeGreaterThan(0);
    expect(observation.issues).toEqual([]);
  });

  test('unbound ACP Grok extension notifications are flagged', () => {
    const issues = detectReplayIssues(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        orchestrationSessionStarted: true,
      },
      event('extension.notification', {
        provider: 'acp',
        namespace: '_x.ai',
        type: 'models/update',
      }),
      SOURCE,
    );
    expect(issues.map((issue) => issue.code)).toContain(
      'unbound-extension-notification',
    );
  });

  test('bound Claude thinking tokens are not flagged as unbound', () => {
    const issues = detectReplayIssues(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        orchestrationSessionStarted: true,
      },
      event('extension.notification', {
        provider: 'claude',
        namespace: 'claude-code',
        type: 'thinking/tokens',
        payload: { estimatedTokens: 1200 },
      }),
      SOURCE,
    );
    expect(issues.map((issue) => issue.code)).not.toContain(
      'unbound-extension-notification',
    );
  });

  test('canonical methods the dock does not fold are flagged', () => {
    const issues = detectReplayIssues(
      {
        input: '',
        attachments: [],
        queuedMessages: [],
        inputHistory: [],
        hasUnread: false,
        orchestrationSessionStarted: true,
      },
      event('policy.hooks-attached', {
        cwd: '/workspace',
        profile: 'standard',
        engine: 'native',
      }),
      SOURCE,
    );
    expect(issues.map((issue) => issue.code)).toContain(
      'unhandled-canonical-method',
    );
  });
});
