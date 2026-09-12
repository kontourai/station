// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReplayTransport } from '../../../../components/chat/ReplayTransport';
import { activeChatsStore } from '../../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../../contexts/background-tasks-store';
import { handleOrchestrationEvent } from '../../eventHandlers';
import { applyOrchestrationSnapshot } from '../../snapshotHandlers';
import type { OrchestrationEvent } from '../../types';
import { closeActiveReplay, openReplayFromTape } from '../controller';
import { EMPTY_REPLAY_HISTORY, getReplayHistory } from '../history';
import { collectReplayScroll } from '../observe';
import {
  getCapturedTape,
  publishHistoryForCapture,
  recordReplayRuntime,
  startReplayCapture,
  stopReplayCapture,
} from '../recorder';
import { tapeFromSessionEvents } from '../tape';
import { serializeSessionTape } from '../tape-file';

const source = { threadId: 'source-thread', agentSlug: 'codex' };
const event = (method: string, fields = {}): OrchestrationEvent =>
  ({
    method,
    eventId: method,
    threadId: source.threadId,
    provider: 'codex',
    createdAt: '2026-09-12T00:00:00.000Z',
    turnId: 'turn-1',
    ...fields,
  }) as OrchestrationEvent;
const tape = () =>
  tapeFromSessionEvents(source, [
    event('turn.started', { prompt: 'Question' }),
    event('content.text-delta', { itemId: 'text-1', delta: 'Answer' }),
    event('turn.completed', { outputText: 'Answer' }),
  ]);
afterEach(() => {
  closeActiveReplay();
  stopReplayCapture();
  vi.unstubAllGlobals();
});

test('the mounted transport advances its observation on every step and back', async () => {
  const replay = openReplayFromTape(tape(), {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  render(
    <>
      <div
        role="log"
        aria-label="Conversation transcript"
        data-chat-session-id={replay.replayId}
      />
      <ReplayTransport sessionId={replay.replayId} />
    </>,
  );
  fireEvent.click(screen.getByText('Replay controls · 0 / 3'));
  expect(screen.getAllByText(/0 \/ 3/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Step' }));
  await waitFor(() =>
    expect(screen.getAllByText(/1 \/ 3/).length).toBeGreaterThan(0),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Step',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(replay.player.cursor).toBe(-1));
});

test('live snapshots do not demote replay state, and replay snapshots do not touch live chats or background tasks', () => {
  activeChatsStore.initChat('unrelated', {
    agentSlug: 'codex',
    agentName: 'Live',
    title: 'Live',
  });
  const recorded = tape();
  recorded.frames = [
    {
      kind: 'snapshot',
      atMs: 0,
      reconnect: true,
      payload: {
        sessions: [
          {
            provider: 'codex',
            threadId: source.threadId,
            status: 'running',
            hasActiveTurn: true,
          },
        ],
      },
    },
  ];
  const replay = openReplayFromTape(recorded, {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  const background = backgroundTasksStore.getSnapshot();
  const live = activeChatsStore.getSnapshot().unrelated;
  replay.player.step();
  expect(activeChatsStore.getSnapshot().unrelated).toBe(live);
  expect(backgroundTasksStore.getSnapshot()).toBe(background);
  const replayBefore = activeChatsStore.getSnapshot()[replay.replayId];
  applyOrchestrationSnapshot({ sessions: [] });
  expect(activeChatsStore.getSnapshot()[replay.replayId]).toBe(replayBefore);
  activeChatsStore.removeChat('unrelated');
});

test('history frames are reversible and retain their recorded loading/error state without HTTP', () => {
  const recorded = tape();
  recorded.frames = [
    {
      kind: 'history',
      atMs: 0,
      state: { ...EMPTY_REPLAY_HISTORY, loading: true },
    },
    {
      kind: 'history',
      atMs: 1,
      state: {
        ...EMPTY_REPLAY_HISTORY,
        settled: true,
        errorMessage: 'History unavailable',
      },
    },
  ];
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const replay = openReplayFromTape(recorded, {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  replay.player.seek(1);
  expect(getReplayHistory(replay.replayId)?.errorMessage).toBe(
    'History unavailable',
  );
  replay.player.back();
  expect(getReplayHistory(replay.replayId)?.loading).toBe(true);
  expect(getReplayHistory(replay.replayId)?.errorMessage).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test('capture is opt-in, host-scoped, and includes the initial history state', () => {
  publishHistoryForCapture('host-a', source.threadId, {
    ...EMPTY_REPLAY_HISTORY,
    settled: true,
  });
  startReplayCapture('host-a', source);
  recordReplayRuntime('host-b', event('turn.started'));
  recordReplayRuntime(
    'host-a',
    event('turn.started', { prompt: 'private prompt' }),
  );
  const capture = stopReplayCapture()!;
  expect(capture.initialHistory?.settled).toBe(true);
  expect(capture.frames).toHaveLength(1);
  recordReplayRuntime('host-a', event('turn.completed'));
  expect(getCapturedTape()?.frames).toHaveLength(1);
  const exported = serializeSessionTape(capture);
  expect(exported).not.toContain('private prompt');
  expect(JSON.parse(exported).redacted).toBe(true);
  expect(serializeSessionTape(capture, true)).toContain('private prompt');
});

test('capture follows the server-bound successor and excludes unrelated execution traffic', () => {
  activeChatsStore.initChat(source.threadId, {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Captured',
    conversationId: source.threadId,
  });
  startReplayCapture('host-a', source);
  handleOrchestrationEvent(
    'host-a',
    event('session.configured', { threadId: 'child', sessionId: 'child' }),
    undefined,
    { conversationId: source.threadId, currentSessionId: 'child' },
  );
  recordReplayRuntime('host-a', event('turn.started', { threadId: 'child' }));
  recordReplayRuntime(
    'host-a',
    event('turn.started', { threadId: 'unrelated' }),
  );
  expect(stopReplayCapture()?.frames).toHaveLength(2);
  activeChatsStore.removeChat(source.threadId);
});

test('pause cancels playback during a recorded gap before another event is applied', async () => {
  const recorded = tape();
  recorded.events[1].createdAt = '2026-09-12T00:10:00.000Z';
  const replay = openReplayFromTape(recorded, {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  const playing = replay.player.play(() => null, { skipGaps: false });
  await waitFor(() => expect(replay.player.cursor).toBe(0));
  replay.player.pause();
  await playing;
  expect(replay.player.cursor).toBe(0);
  expect(replay.player.playing).toBe(false);
});

test('render observation reads the DOM after the fold and excludes offscreen rows', async () => {
  const replay = openReplayFromTape(tape(), {
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
  const row = document.createElement('div');
  row.dataset.chatMessageKey = 'visible';
  row.getBoundingClientRect = () => ({ top: 5, bottom: 40 }) as DOMRect;
  const below = document.createElement('div');
  below.dataset.chatMessageKey = 'below';
  below.getBoundingClientRect = () => ({ top: 105, bottom: 140 }) as DOMRect;
  element.append(row, below);
  expect(collectReplayScroll(element)?.visibleMessageKeys).toEqual(['visible']);
  replay.player.step();
  expect(replay.player.lastObservation?.scroll).toBeUndefined();
  const observed = replay.player.observeRendered(() => element);
  row.textContent = 'Committed after the event';
  const result = await observed;
  expect(result.renderedRows?.[0].textPreview).toBe(
    'Committed after the event',
  );
  expect(result.performance?.render?.phase).toBe('observed');
});
