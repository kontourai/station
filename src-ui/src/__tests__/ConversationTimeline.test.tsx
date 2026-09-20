// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const { page, conversationPage } = vi.hoisted(() => ({
  page: vi.fn(),
  conversationPage: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/client', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/client')>()),
  getOrchestrationSessionEventPage: page,
  getOrchestrationConversationEventWindow: conversationPage,
}));

import { ConversationTimeline } from '../components/chat/ConversationTimeline';
import { activeChatsStore } from '../contexts/active-chats-store';
import { navigationStore } from '../contexts/navigation-store';
import {
  closeActiveReplay,
  getActiveReplay,
  getConversationTimelineContext,
  openConversationTimeline,
  returnToLatestConversation,
  selectConversationTimelineExecution,
} from '../hooks/orchestration/replay/controller';
import { conversationTimelineLandmarks } from '../hooks/orchestration/replay/timeline';
import type { OrchestrationEvent } from '../hooks/orchestration/types';

const currentAuthority = {
  requestScope: {
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  },
  isAuthorityCurrent: () => true,
  isSourceCurrent: () => true,
};

function turn(
  turnId: string,
  prompt: string,
  minute: number,
): OrchestrationEvent[] {
  const createdAt = `2026-09-20T00:0${minute}:00Z`;
  return [
    {
      eventId: `${turnId}-start`,
      threadId: 'durable-session',
      provider: 'codex',
      createdAt,
      method: 'turn.started',
      turnId,
      prompt,
    },
    {
      eventId: `${turnId}-done`,
      threadId: 'durable-session',
      provider: 'codex',
      createdAt,
      method: 'turn.completed',
      turnId,
      outputText: `${prompt} answer`,
    },
  ];
}

afterEach(() => {
  closeActiveReplay();
  activeChatsStore.removeChat('live-chat');
  navigationStore.setActiveChat(null);
  page.mockReset();
  conversationPage.mockReset();
});

test('mounted history controls seek canonical replay turns, fork with durable identity, and return to the untouched live chat', async () => {
  const events = [
    ...turn('turn-1', 'First question', 1),
    ...turn('turn-2', 'Second question', 2),
  ];
  page.mockResolvedValue({
    session: { model: 'gpt-5', provider: 'codex' },
    events: events.map((event, index) => ({ sequence: index + 1, event })),
    nextSequence: events.length,
    hasMore: false,
  });
  conversationPage.mockResolvedValue({
    protocolVersion: 1,
    conversationId: 'conversation-1',
    currentSessionId: 'durable-session',
    session: {},
    events: [],
    hasMore: false,
    watermark: 1,
    handoffs: [],
    contextBoundaries: [],
    sessionLineage: [
      {
        sessionId: 'older-session',
        agentSlug: 'codex',
        agentDisplayName: 'Codex',
      },
      {
        sessionId: 'durable-session',
        agentSlug: 'codex',
        agentDisplayName: 'Codex',
      },
    ],
  });
  activeChatsStore.initChat('live-chat', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Live conversation',
    conversationId: 'conversation-1',
  });
  activeChatsStore.updateChat('live-chat', { input: 'draft survives' });
  navigationStore.setActiveChat('live-chat');
  const liveLog = document.createElement('div');
  liveLog.setAttribute('role', 'log');
  liveLog.setAttribute('aria-label', 'Conversation transcript');
  liveLog.dataset.chatSessionId = 'live-chat';
  liveLog.scrollTop = 246;
  document.body.append(liveLog);

  let replay!: Awaited<ReturnType<typeof openConversationTimeline>>;
  await act(async () => {
    replay = await openConversationTimeline({
      ...currentAuthority,
      apiBase: 'http://station.test',
      sourceChatId: 'live-chat',
      sourceConversationId: 'conversation-1',
      sourceThreadId: 'durable-session',
      agentSlug: 'codex',
      agentName: 'Codex',
      provider: 'codex',
    });
  });
  expect(conversationPage.mock.calls[0]?.[3]?.requestScope).toEqual(
    currentAuthority.requestScope,
  );
  expect(page.mock.calls[0]?.[3]?.requestScope).toEqual(
    currentAuthority.requestScope,
  );
  const onFork = vi.fn();
  render(
    <ConversationTimeline
      sessionId={replay.replayId}
      onForkFromTurn={onFork}
    />,
  );

  expect(screen.getByText('Earlier in this conversation')).toBeTruthy();
  expect(
    screen.getByRole('combobox', { name: 'Conversation section' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Previous turn' }));
  expect(screen.getByText('1 of 2 user turns')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Fork from here…' }));
  expect(onFork).toHaveBeenCalledWith(
    expect.objectContaining({
      turnId: 'turn-1',
      sessionId: 'durable-session',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Return to latest' }));
  expect(navigationStore.getSnapshot().activeChat).toBe('live-chat');
  expect(activeChatsStore.getSnapshot()['live-chat']?.input).toBe(
    'draft survives',
  );
  liveLog.remove();
});

test('indexes the maximum 20,000-frame archive without consulting mounted rows', () => {
  const frames = Array.from({ length: 20_000 }, (_, index) => ({
    kind: 'runtime' as const,
    atMs: index,
    event: turn(`turn-${index}`, `Question ${index}`, 1)[0]!,
  }));
  const started = performance.now();
  const landmarks = conversationTimelineLandmarks({ frames });
  expect(landmarks).toHaveLength(20_000);
  expect(conversationTimelineLandmarks({ frames })).toBe(landmarks);
  expect(landmarks[19_999]?.endFrame).toBe(19_999);
  expect(performance.now() - started).toBeLessThan(250);
});

test('loads an authoritative earlier execution without rebinding it to the current session', async () => {
  activeChatsStore.initChat('live-chat', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Live conversation',
    conversationId: 'conversation-1',
  });
  navigationStore.setActiveChat('live-chat');
  conversationPage.mockResolvedValue({
    protocolVersion: 1,
    conversationId: 'conversation-1',
    currentSessionId: 'new-session',
    session: {},
    events: [],
    hasMore: false,
    watermark: 2,
    handoffs: [],
    contextBoundaries: [],
    sessionLineage: [
      { sessionId: 'old-session', agentSlug: 'codex' },
      { sessionId: 'new-session', agentSlug: 'codex' },
    ],
  });
  page.mockImplementation((_apiBase: string, threadId: string) => {
    const events = turn(
      threadId === 'old-session' ? 'old-turn' : 'new-turn',
      threadId === 'old-session' ? 'Old question' : 'New question',
      1,
    ).map((event) => ({ ...event, threadId }));
    return Promise.resolve({
      session: {},
      events: events.map((event, index) => ({ sequence: index + 1, event })),
      nextSequence: events.length,
      hasMore: false,
    });
  });
  await openConversationTimeline({
    ...currentAuthority,
    apiBase: 'http://station.test',
    sourceChatId: 'live-chat',
    sourceConversationId: 'conversation-1',
    sourceThreadId: 'new-session',
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  await selectConversationTimelineExecution('old-session');
  expect(getConversationTimelineContext()?.selectedExecutionId).toBe(
    'old-session',
  );
  const activeReplay = getActiveReplay();
  expect(activeReplay?.player.tape.source.threadId).toBe('old-session');
  const replayChat = activeReplay
    ? activeChatsStore.getSnapshot()[activeReplay.replayId]
    : undefined;
  expect(replayChat?.messages?.[0]?.content).toBe('Old question');
});

test('a chat switch supersedes a pending history open without replacing the reader view', async () => {
  let resolveConversation!: (value: unknown) => void;
  conversationPage.mockReturnValue(
    new Promise((resolve) => {
      resolveConversation = resolve;
    }),
  );
  activeChatsStore.initChat('live-chat', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Live conversation',
    conversationId: 'conversation-1',
  });
  navigationStore.setActiveChat('live-chat');
  const opening = openConversationTimeline({
    ...currentAuthority,
    isSourceCurrent: () =>
      navigationStore.getSnapshot().activeChat === 'live-chat',
    apiBase: 'http://station.test',
    sourceChatId: 'live-chat',
    sourceConversationId: 'conversation-1',
    sourceThreadId: 'durable-session',
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  navigationStore.setActiveChat('another-chat');
  resolveConversation({
    currentSessionId: 'durable-session',
    sessionLineage: [{ sessionId: 'durable-session' }],
  });
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(getActiveReplay()).toBeNull();
  expect(page).not.toHaveBeenCalled();
  expect(navigationStore.getSnapshot().activeChat).toBe('another-chat');
});

test('authority revocation with unchanged chat ids rejects without committing a synthetic chat', async () => {
  let current = true;
  let resolveConversation!: (value: unknown) => void;
  conversationPage.mockReturnValue(
    new Promise((resolve) => {
      resolveConversation = resolve;
    }),
  );
  activeChatsStore.initChat('live-chat', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Live conversation',
    conversationId: 'conversation-1',
  });
  navigationStore.setActiveChat('live-chat');
  const opening = openConversationTimeline({
    apiBase: 'http://station.test',
    sourceChatId: 'live-chat',
    sourceConversationId: 'conversation-1',
    sourceThreadId: 'durable-session',
    agentSlug: 'codex',
    agentName: 'Codex',
    requestScope: currentAuthority.requestScope,
    isAuthorityCurrent: () => current,
    isSourceCurrent: () => true,
  });
  current = false;
  resolveConversation({
    currentSessionId: 'durable-session',
    sessionLineage: [{ sessionId: 'durable-session' }],
  });
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(getActiveReplay()).toBeNull();
  expect(page).not.toHaveBeenCalled();
  expect(navigationStore.getSnapshot().activeChat).toBe('live-chat');
});

test('return to latest cancels a pending execution switch without reopening history', async () => {
  conversationPage.mockResolvedValue({
    currentSessionId: 'new-session',
    sessionLineage: [
      { sessionId: 'old-session' },
      { sessionId: 'new-session' },
    ],
  });
  activeChatsStore.initChat('live-chat', {
    agentSlug: 'codex',
    agentName: 'Codex',
    title: 'Live conversation',
    conversationId: 'conversation-1',
  });
  navigationStore.setActiveChat('live-chat');
  page.mockResolvedValueOnce({
    session: {},
    events: turn('new-turn', 'New question', 1).map((event, index) => ({
      sequence: index + 1,
      event: { ...event, threadId: 'new-session' },
    })),
    nextSequence: 2,
    hasMore: false,
  });
  await openConversationTimeline({
    ...currentAuthority,
    apiBase: 'http://station.test',
    sourceChatId: 'live-chat',
    sourceConversationId: 'conversation-1',
    sourceThreadId: 'new-session',
    agentSlug: 'codex',
    agentName: 'Codex',
  });
  let resolveOld!: (value: unknown) => void;
  page.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const switching = selectConversationTimelineExecution('old-session');
  returnToLatestConversation();
  resolveOld({
    session: {},
    events: turn('old-turn', 'Old question', 1).map((event, index) => ({
      sequence: index + 1,
      event: { ...event, threadId: 'old-session' },
    })),
    nextSequence: 2,
    hasMore: false,
  });
  await expect(switching).rejects.toMatchObject({ name: 'AbortError' });
  expect(getActiveReplay()).toBeNull();
  expect(navigationStore.getSnapshot().activeChat).toBe('live-chat');
});
