import type { OrchestrationConversationEventWindow } from '@kontourai/station-contracts/orchestration';
import type { ApiRequestScope } from '@kontourai/station-sdk';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { navigationStore } from '../../../contexts/navigation-store';
import {
  MAX_TAPE_BYTES,
  MAX_TAPE_FRAMES,
  TAPE_METADATA_RESERVE,
} from './limits';
import { SessionTapePlayer } from './player';
import {
  registerReplayThread,
  unregisterReplayThread,
} from './replay-registry';
import { isSessionTape, type SessionTape, tapeFromSessionEvents } from './tape';

export interface ActiveReplay {
  replayId: string;
  player: SessionTapePlayer;
}

export interface ConversationTimelineContext {
  sourceChatId: string;
  sourceConversationId: string;
  sourceThreadId: string;
  sourceScrollTop: number;
  sourceReaderAnchor?: { key: string; offset: number };
  sourceProjectSlug?: string;
  sourceProjectName?: string;
  apiBase: string;
  title?: string;
  executions: Array<{
    sessionId: string;
    agentSlug?: string;
    agentName?: string;
  }>;
  selectedExecutionId: string;
  requestScope: ApiRequestScope;
  isAuthorityCurrent: () => boolean;
  isChatCurrent: (id: string) => boolean;
  selectChat: (storeId: string, routeId: string) => void;
}

let active: ActiveReplay | null = null;
let timelineContext: ConversationTimelineContext | null = null;
let timelineGeneration = 0;
let timelineRequest: AbortController | null = null;

export function getConversationTimelineContext(): ConversationTimelineContext | null {
  return timelineContext;
}

export function getActiveReplay(): ActiveReplay | null {
  return active;
}

export function setActiveReplay(next: ActiveReplay | null): void {
  active = next;
  if (active && !active.player.lastObservation) active.player.observe();
  publishReplayApi();
}

function publishReplayApi(): void {
  if (typeof window === 'undefined') return;
  const host = window as Window & {
    __stationReplay?: {
      replayId: string;
      step: () => unknown;
      back: () => unknown;
      seek: (index: number) => unknown;
      observe: () => unknown;
      observeState: () => unknown;
      play: (speed?: number) => unknown;
      pause: () => unknown;
      runUntilIssue: () => unknown;
    };
  };
  if (!active) {
    delete host.__stationReplay;
    return;
  }
  const { replayId, player } = active;
  host.__stationReplay = {
    replayId,
    step: () => {
      player.pause();
      return player.stepRendered(transcriptElement);
    },
    back: () => {
      player.pause();
      player.back();
      return player.observeRendered(transcriptElement);
    },
    seek: (index: number) => {
      player.pause();
      player.seek(index);
      return player.observeRendered(transcriptElement);
    },
    observe: () => player.observeRendered(transcriptElement),
    observeState: () => player.observe(),
    play: (speed = 1) => player.play(transcriptElement, { speed }),
    pause: () => player.pause(),
    runUntilIssue: () => player.play(transcriptElement, { untilIssue: true }),
  };
}

function transcriptElement(): HTMLElement | null {
  return (
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="log"][aria-label="Conversation transcript"]',
      ),
    ].find((element) => element.dataset.chatSessionId === active?.replayId) ??
    null
  );
}

export async function openReplayFromThread(input: {
  apiBase: string;
  sourceThreadId: string;
  agentSlug: string;
  agentName: string;
  title?: string;
  provider?: string;
  projectSlug?: string;
  projectName?: string;
  signal?: AbortSignal;
  beforeOpen?: () => boolean;
  requestScope?: ApiRequestScope;
}): Promise<ActiveReplay> {
  const { getOrchestrationSessionEventPage } = await import(
    '@kontourai/station-sdk/client'
  );
  const tape = tapeFromSessionEvents(
    {
      threadId: input.sourceThreadId,
      agentSlug: input.agentSlug,
      provider: input.provider,
    },
    [],
  );
  let afterSequence = 0;
  let bytes = new TextEncoder().encode(JSON.stringify(tape)).length;
  for (;;) {
    if (input.beforeOpen && !input.beforeOpen())
      throw new DOMException('Timeline request was superseded', 'AbortError');
    const page = await getOrchestrationSessionEventPage<
      import('@kontourai/station-contracts/orchestration').OrchestrationSessionEventPage
    >(
      input.apiBase,
      input.sourceThreadId,
      { afterSequence, limit: 100 },
      {
        maxResponseBytes: 8 * 1024 * 1024,
        timeoutMs: 10_000,
        signal: input.signal,
        requestScope: input.requestScope,
      },
    );
    if (input.beforeOpen && !input.beforeOpen())
      throw new DOMException('Timeline request was superseded', 'AbortError');
    if (
      !Array.isArray(page.events) ||
      page.events.length > 100 ||
      typeof page.hasMore !== 'boolean' ||
      !Number.isSafeInteger(page.nextSequence) ||
      (page.hasMore &&
        (!page.events.length || page.nextSequence <= afterSequence))
    )
      throw new Error('The server returned an invalid archive page.');
    if (
      typeof page.session?.model === 'string' &&
      page.session.model.length <= 512
    )
      tape.source.model = page.session.model;
    let last = afterSequence;
    for (const entry of page.events) {
      if (
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence <= last ||
        entry.event?.threadId !== input.sourceThreadId
      )
        throw new Error(
          'The archive page has invalid event ordering or identity.',
        );
      last = entry.sequence;
      const size =
        new TextEncoder().encode(JSON.stringify(entry.event)).length + 1;
      if (
        tape.events.length >= MAX_TAPE_FRAMES ||
        bytes + size > MAX_TAPE_BYTES - TAPE_METADATA_RESERVE
      ) {
        tape.stoppedReason =
          'Archive stopped at its 16 MiB / 20,000 event limit; later activity is not included.';
        if (input.beforeOpen && !input.beforeOpen())
          throw new DOMException(
            'Timeline request was superseded',
            'AbortError',
          );
        return openReplayFromTape(tape, input);
      }
      tape.events.push(entry.event);
      bytes += size;
    }
    if (page.nextSequence !== last)
      throw new Error('The archive cursor does not match the delivered page.');
    if (!page.hasMore) break;
    afterSequence = page.nextSequence;
  }

  if (input.beforeOpen && !input.beforeOpen())
    throw new DOMException('Timeline request was superseded', 'AbortError');
  return openReplayFromTape(tape, input);
}

export async function openConversationTimeline(input: {
  apiBase: string;
  sourceChatId: string;
  sourceConversationId: string;
  sourceThreadId: string;
  agentSlug: string;
  agentName: string;
  title?: string;
  provider?: string;
  projectSlug?: string;
  projectName?: string;
  requestScope: ApiRequestScope;
  isAuthorityCurrent: () => boolean;
  isChatCurrent: (id: string) => boolean;
  selectChat: (storeId: string, routeId: string) => void;
}): Promise<ActiveReplay> {
  if (
    input.requestScope.apiBase !== input.apiBase ||
    !input.isAuthorityCurrent()
  )
    throw new DOMException(
      'Conversation history authorization changed',
      'AbortError',
    );
  const generation = ++timelineGeneration;
  timelineRequest?.abort();
  const request = new AbortController();
  timelineRequest = request;
  const transcript = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="log"][aria-label="Conversation transcript"]',
    ),
  ].find((element) => element.dataset.chatSessionId === input.sourceChatId);
  const transcriptBox = transcript?.getBoundingClientRect();
  const sourceReaderAnchor = transcriptBox
    ? [...transcript!.querySelectorAll<HTMLElement>('[data-chat-message-key]')]
        .map((row) => ({ row, box: row.getBoundingClientRect() }))
        .filter(
          ({ box }) =>
            box.bottom > transcriptBox.top && box.top < transcriptBox.bottom,
        )
        .sort(
          (left, right) =>
            Math.abs(left.box.top - transcriptBox.top) -
            Math.abs(right.box.top - transcriptBox.top),
        )
        .map(({ row, box }) => ({
          key: row.dataset.chatMessageKey ?? '',
          offset: box.top - transcriptBox.top,
        }))[0]
    : undefined;
  const { getOrchestrationConversationEventWindow } = await import(
    '@kontourai/station-sdk/client'
  );
  const conversation =
    await getOrchestrationConversationEventWindow<OrchestrationConversationEventWindow>(
      input.apiBase,
      input.sourceConversationId,
      { direction: 'newest', turnLimit: 1 },
      {
        maxResponseBytes: 1024 * 1024,
        timeoutMs: 10_000,
        signal: request.signal,
        requestScope: input.requestScope,
      },
    );
  const executions = conversation.sessionLineage?.length
    ? conversation.sessionLineage.map((entry) => ({
        sessionId: entry.sessionId,
        agentSlug: entry.agentSlug,
        agentName: entry.agentDisplayName,
      }))
    : [
        {
          sessionId: input.sourceThreadId,
          agentSlug: input.agentSlug,
          agentName: input.agentName,
        },
      ];
  const candidate: ConversationTimelineContext = {
    sourceChatId: input.sourceChatId,
    sourceConversationId: input.sourceConversationId,
    sourceThreadId: input.sourceThreadId,
    sourceScrollTop: transcript?.scrollTop ?? 0,
    ...(sourceReaderAnchor?.key ? { sourceReaderAnchor } : {}),
    sourceProjectSlug: input.projectSlug,
    sourceProjectName: input.projectName,
    apiBase: input.apiBase,
    title: input.title,
    executions,
    selectedExecutionId: conversation.currentSessionId,
    requestScope: input.requestScope,
    isAuthorityCurrent: input.isAuthorityCurrent,
    isChatCurrent: input.isChatCurrent,
    selectChat: input.selectChat,
  };
  try {
    if (
      generation !== timelineGeneration ||
      !input.isChatCurrent(input.sourceChatId) ||
      !input.isAuthorityCurrent() ||
      activeChatsStore.getSnapshot()[input.sourceChatId]?.conversationId !==
        input.sourceConversationId
    )
      throw new DOMException('Timeline request was superseded', 'AbortError');
    const replay = await openReplayFromThread({
      ...input,
      sourceThreadId: conversation.currentSessionId,
      signal: request.signal,
      requestScope: input.requestScope,
      beforeOpen: () =>
        generation === timelineGeneration &&
        input.isAuthorityCurrent() &&
        input.isChatCurrent(input.sourceChatId) &&
        activeChatsStore.getSnapshot()[input.sourceChatId]?.conversationId ===
          input.sourceConversationId,
    });
    timelineContext = candidate;
    input.selectChat(replay.replayId, replay.replayId);
    const chat = activeChatsStore.getSnapshot()[replay.replayId];
    if (chat?.replay) {
      activeChatsStore.updateChat(replay.replayId, {
        replay: { ...chat.replay, mode: 'timeline' },
      });
    }
    replay.player.seek(replay.player.eventCount - 1);
    return replay;
  } finally {
    if (timelineRequest === request) timelineRequest = null;
  }
}

export async function selectConversationTimelineExecution(
  sessionId: string,
): Promise<ActiveReplay> {
  const context = timelineContext;
  const execution = context?.executions.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!context || !execution)
    throw new Error('That conversation section is unavailable.');
  const generation = ++timelineGeneration;
  const sourceReplayId = active?.replayId;
  timelineRequest?.abort();
  const request = new AbortController();
  timelineRequest = request;
  const retained = { ...context, selectedExecutionId: sessionId };
  let replay: ActiveReplay;
  try {
    replay = await openReplayFromThread({
      apiBase: context.apiBase,
      sourceThreadId: sessionId,
      agentSlug: execution.agentSlug ?? 'unknown-agent',
      agentName: execution.agentName ?? 'Agent',
      title: context.title,
      signal: request.signal,
      requestScope: context.requestScope,
      beforeOpen: () =>
        generation === timelineGeneration &&
        context.isAuthorityCurrent() &&
        getConversationTimelineContext() === context &&
        active?.replayId === sourceReplayId &&
        context.isChatCurrent(sourceReplayId!) &&
        activeChatsStore.getSnapshot()[context.sourceChatId]?.conversationId ===
          context.sourceConversationId,
    });
  } finally {
    if (timelineRequest === request) timelineRequest = null;
  }
  timelineContext = retained;
  context.selectChat(replay.replayId, replay.replayId);
  const chat = activeChatsStore.getSnapshot()[replay.replayId];
  if (chat?.replay)
    activeChatsStore.updateChat(replay.replayId, {
      replay: { ...chat.replay, mode: 'timeline' },
    });
  replay.player.seek(replay.player.eventCount - 1);
  return replay;
}

export function returnToLatestConversation(): void {
  const context = timelineContext;
  if (!context) return;
  timelineGeneration += 1;
  timelineRequest?.abort();
  timelineRequest = null;
  closeActiveReplay();
  context.selectChat(context.sourceChatId, context.sourceConversationId);
  navigationStore.setActiveChat(context.sourceChatId);
  navigationStore.setDockState(true);
  let attempts = 0;
  let settlementFrames = 0;
  let readerIntentRestored = false;
  const restoreReader = () => {
    if (navigationStore.getSnapshot().activeChat !== context.sourceChatId)
      return;
    const transcript = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="log"][aria-label="Conversation transcript"]',
      ),
    ].find((element) => element.dataset.chatSessionId === context.sourceChatId);
    if (transcript) {
      if (!readerIntentRestored && context.sourceReaderAnchor) {
        readerIntentRestored = true;
        // Reapply the captured reader intent before the virtualizer's first
        // follow-tail layout pass; otherwise that pass overwrites the anchor
        // restoration with the newest turn.
        transcript.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      }
      const anchor = context.sourceReaderAnchor;
      const row = anchor
        ? [
            ...transcript.querySelectorAll<HTMLElement>(
              '[data-chat-message-key]',
            ),
          ].find((element) => element.dataset.chatMessageKey === anchor.key)
        : undefined;
      if (row && anchor) {
        const transcriptTop = transcript.getBoundingClientRect().top;
        transcript.scrollTop +=
          row.getBoundingClientRect().top - transcriptTop - anchor.offset;
      } else {
        transcript.scrollTop = context.sourceScrollTop;
      }
      settlementFrames += 1;
      if (settlementFrames < 20) requestAnimationFrame(restoreReader);
      return;
    }
    attempts += 1;
    if (attempts < 20) requestAnimationFrame(restoreReader);
  };
  requestAnimationFrame(restoreReader);
}

export function openReplayFromTape(
  tape: SessionTape,
  identity: {
    agentSlug: string;
    agentName: string;
    title?: string;
    apiBase?: string;
  },
): ActiveReplay {
  if (!isSessionTape(tape))
    throw new Error('This recording contains unsupported replay data.');
  if (active) closeActiveReplay();
  const replayId = registerReplayThread();
  activeChatsStore.initChat(replayId, {
    agentSlug: identity.agentSlug,
    agentName: identity.agentName,
    title: `Event replay · ${identity.title || 'conversation'}`,
    orchestrationSessionStarted: true,
    replay: {
      sourceThreadId: tape.source.threadId,
      tapeEventCount: tape.frames?.length ?? tape.events.length,
    },
  });
  const player = new SessionTapePlayer(tape, replayId, identity.apiBase ?? '');
  player.observe();
  active = { replayId, player };
  navigationStore.setActiveChat(replayId);
  navigationStore.setDockState(true);
  publishReplayApi();
  return active;
}

export function closeActiveReplay(): void {
  timelineGeneration += 1;
  timelineRequest?.abort();
  timelineRequest = null;
  if (!active) return;
  const { replayId, player } = active;
  player.dispose();
  unregisterReplayThread(replayId);
  activeChatsStore.removeChat(replayId);
  if (navigationStore.getSnapshot().activeChat === replayId) {
    navigationStore.setActiveChat(null);
  }
  active = null;
  timelineContext = null;
  publishReplayApi();
}
