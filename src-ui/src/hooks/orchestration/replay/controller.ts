import { activeChatsStore } from '../../../contexts/active-chats-store';
import { navigationStore } from '../../../contexts/navigation-store';
import { SessionTapePlayer } from './player';
import {
  registerReplayThread,
  unregisterReplayThread,
} from './replay-registry';
import { type SessionTape, tapeFromSessionEvents } from './tape';

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
  const { getOrchestrationSession } = await import(
    '@kontourai/station-sdk/client'
  );
  const detail = await getOrchestrationSession<{
    session?: { model?: string };
    events: SessionTape['events'];
  }>(input.apiBase, input.sourceThreadId);
  const tape = tapeFromSessionEvents(
    {
      threadId: input.sourceThreadId,
      agentSlug: input.agentSlug,
      provider: input.provider,
      model:
        typeof detail.session?.model === 'string'
          ? detail.session.model
          : undefined,
    },
    detail.events ?? [],
  );
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
