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

let active: ActiveReplay | null = null;

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
    const page = await getOrchestrationSessionEventPage<
      import('@kontourai/station-contracts/orchestration').OrchestrationSessionEventPage
    >(
      input.apiBase,
      input.sourceThreadId,
      { afterSequence, limit: 100 },
      { maxResponseBytes: 8 * 1024 * 1024, timeoutMs: 10_000 },
    );
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

  return openReplayFromTape(tape, input);
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
  if (!active) return;
  const { replayId, player } = active;
  player.dispose();
  unregisterReplayThread(replayId);
  activeChatsStore.removeChat(replayId);
  if (navigationStore.getSnapshot().activeChat === replayId) {
    navigationStore.setActiveChat(null);
  }
  active = null;
  publishReplayApi();
}
