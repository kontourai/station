import { activeChatsStore } from '../../../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../eventHandlers';
import { applyOrchestrationSnapshot } from '../snapshotHandlers';
import type { OrchestrationEvent } from '../types';
import {
  EMPTY_REPLAY_HISTORY,
  getReplayHistory,
  type ReplayHistoryState,
  setReplayHistory,
  setReplayHistoryLoader,
} from './history';
import { collectReplayObservation, type ReplayObservation } from './observe';
import {
  type ReplayRenderMeasurement,
  waitForReplayRender,
} from './render-observation';
import { isReplayThread } from './replay-registry';
import { rewriteEventThreadId } from './rewrite';
import { type ReplayFrame, replayFrames, type SessionTape } from './tape';

export class SessionTapePlayer {
  cursor = -1;
  lastObservation: ReplayObservation | null = null;
  private readonly listeners = new Set<() => void>();
  readonly frames: ReplayFrame[];
  playing = false;
  speed = 1;
  private playbackGeneration = 0;
  private foldMs = 0;
  private turnStartedAtMs = 0;
  private connection: import('../streamConnectionState').StreamConnectionPhase =
    'unknown';
  private connectionAtMs = 0;
  private measurement?: ReplayRenderMeasurement;

  constructor(
    readonly tape: SessionTape,
    readonly replayId: string,
    private readonly apiBase = '',
  ) {
    if (!isReplayThread(replayId)) {
      throw new Error('SessionTapePlayer requires a registered replay thread');
    }
    this.frames = replayFrames(tape);
    this.restoreInitialState();
  }

  get eventCount(): number {
    return this.frames.length;
  }

  currentEvent(): OrchestrationEvent | undefined {
    const frame = this.frames[this.cursor];
    return frame?.kind === 'runtime' ? frame.event : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(transcriptElement?: HTMLElement | null): ReplayObservation {
    const chat = activeChatsStore.getSnapshot()[this.replayId];
    if (!chat) {
      throw new Error(`Replay chat ${this.replayId} is not in the store`);
    }
    const observation = collectReplayObservation({
      replayId: this.replayId,
      chat,
      cursorIndex: this.cursor,
      eventCount: this.eventCount,
      event: this.currentEvent(),
      sourceThreadId: this.tape.source.threadId,
      transcriptElement,
      previous: this.lastObservation,
      hasMore: getReplayHistory(this.replayId)?.hasMore,
    });
    const frame = this.frames[this.cursor];
    observation.frame = {
      kind: frame?.kind ?? 'start',
      atMs: frame?.atMs ?? 0,
      coverage: this.tape.coverage ?? 'server-events',
      connection: this.connection,
    };
    observation.playback = { playing: this.playing, speed: this.speed };
    observation.performance = { foldMs: this.foldMs, render: this.measurement };
    if (this.lastObservation?.cursor.index === this.cursor)
      observation.delta = this.lastObservation.delta;
    this.lastObservation = observation;
    return observation;
  }

  step(transcriptElement?: HTMLElement | null): ReplayObservation {
    if (this.cursor >= this.eventCount - 1)
      return this.observe(transcriptElement);
    this.cursor += 1;
    this.measurement = undefined;
    const started = performance.now();
    this.applyCurrent();
    this.foldMs = performance.now() - started;
    // Rendering is asynchronous. Never attach the previous DOM to this event.
    return this.notify();
  }

  back(transcriptElement?: HTMLElement | null): ReplayObservation {
    if (this.cursor < 0) return this.observe(transcriptElement);
    const next = this.cursor - 1;
    this.refoldTo(next);
    return this.notify(transcriptElement);
  }

  seek(
    index: number,
    transcriptElement?: HTMLElement | null,
  ): ReplayObservation {
    if (!Number.isFinite(index))
      throw new Error('Replay position must be finite');
    const clamped = Math.max(
      -1,
      Math.min(Math.trunc(index), this.eventCount - 1),
    );
    this.refoldTo(clamped);
    return this.notify(transcriptElement);
  }

  private applyCurrent(): void {
    const frame = this.frames[this.cursor];
    if (!frame) return;
    if (
      frame.kind === 'runtime' &&
      frame.event.method === 'turn.started' &&
      frame.event.inputKind !== 'steer'
    )
      this.turnStartedAtMs = frame.atMs;
    if (frame.kind === 'connection') {
      this.connection = frame.status;
      this.connectionAtMs = frame.atMs;
    }
    const replay = activeChatsStore.getSnapshot()[this.replayId]?.replay;
    if (replay)
      activeChatsStore.updateChat(this.replayId, {
        replay: {
          ...replay,
          connectionPhase: this.connection,
          connectionElapsedMs: Math.max(0, frame.atMs - this.connectionAtMs),
          elapsedMs: Math.max(0, frame.atMs - this.turnStartedAtMs),
        },
      });
    if (frame.kind === 'clock') return;
    if (frame.kind === 'history') {
      setReplayHistory(this.replayId, this.rewriteHistory(frame.state));
      return;
    }
    if (frame.kind === 'connection') {
      this.connection = frame.status;
      return;
    }
    if (frame.kind === 'snapshot') {
      applyOrchestrationSnapshot(
        {
          ...frame.payload,
          sessions: frame.payload.sessions.map((session) => ({
            ...session,
            threadId: this.replayId,
            delegation: undefined,
          })),
        },
        {
          apiBase: this.apiBase,
          replayThreadId: this.replayId,
          isReconnectFallback: frame.reconnect,
        },
      );
      return;
    }
    const event = this.currentEvent();
    if (!event) return;
    // Live sends insert their user row before turn.started arrives. A tape
    // has no composer send; restore that input before using the same fold.
    // Steering already appends its own user row in the canonical handler.
    if (
      event.method === 'turn.started' &&
      event.inputKind !== 'steer' &&
      event.prompt
    ) {
      const chat = activeChatsStore.getSnapshot()[this.replayId];
      activeChatsStore.updateChat(this.replayId, {
        messages: [
          ...(chat?.messages ?? []),
          {
            id: `replay-input:${event.eventId}`,
            clientId: `replay-input:${event.eventId}`,
            role: 'user',
            content: event.prompt,
            turnId: event.turnId,
            sessionId: this.replayId,
            timestamp: Date.parse(event.createdAt),
          },
        ],
      });
    }
    handleOrchestrationEvent(
      this.apiBase,
      rewriteEventThreadId(event, this.replayId),
      frame.provenance,
    );
  }

  private refoldTo(index: number): void {
    const existing = activeChatsStore.getSnapshot()[this.replayId];
    activeChatsStore.removeChat(this.replayId);
    activeChatsStore.initChat(this.replayId, {
      agentSlug: existing?.agentSlug ?? this.tape.source.agentSlug,
      agentName: existing?.agentName ?? 'Replay',
      title: existing?.title ?? 'Event replay',
      orchestrationSessionStarted: true,
      replay: existing?.replay ?? {
        sourceThreadId: this.tape.source.threadId,
        tapeEventCount: this.eventCount,
      },
    });
    this.cursor = -1;
    this.measurement = undefined;
    this.connection = 'unknown';
    this.turnStartedAtMs = 0;
    this.restoreInitialState();
    while (this.cursor < index) {
      this.cursor += 1;
      this.applyCurrent();
    }
  }

  private rewriteHistory(state: ReplayHistoryState): ReplayHistoryState {
    const alias = (id: string) =>
      id === this.tape.source.threadId
        ? this.replayId
        : `${this.replayId}:history:${id}`;
    return {
      ...state,
      currentSessionId: undefined,
      sessionLineage: state.sessionLineage?.map((entry) => ({
        ...entry,
        sessionId: alias(entry.sessionId),
      })),
      events: state.events.map((item) => ({
        ...item,
        event: {
          ...item.event,
          threadId: alias(item.event.threadId),
        },
      })),
      handoffs: state.handoffs.map((handoff) => ({
        ...handoff,
        sessionId: alias(handoff.sessionId),
        predecessorSessionId: alias(handoff.predecessorSessionId),
      })),
      contextBoundaries: state.contextBoundaries.map((boundary) => ({
        ...boundary,
        successorSessionId: alias(boundary.successorSessionId),
      })),
    };
  }

  private restoreInitialState(): void {
    const initial = this.tape.initialChat;
    if (initial)
      activeChatsStore.updateChat(this.replayId, {
        messages: initial.messages?.map((message) => ({
          ...message,
          sessionId: this.replayId,
        })),
        streamingMessage: initial.streamingMessage,
        status: initial.status,
        orchestrationStatus: initial.orchestrationStatus,
        orchestrationTurnOpen: initial.orchestrationTurnOpen,
        openTurnId: initial.openTurnId,
        openTurnShellSuperseded: initial.openTurnShellSuperseded,
        activityHint: initial.activityHint,
        model: initial.model,
        provider: initial.provider,
      });
    if (
      this.tape.initialHistory ||
      this.frames.some((frame) => frame.kind === 'history')
    ) {
      setReplayHistory(
        this.replayId,
        this.rewriteHistory(this.tape.initialHistory ?? EMPTY_REPLAY_HISTORY),
      );
      setReplayHistoryLoader(this.replayId, async () => {
        const next = this.frames.findIndex(
          (frame, index) =>
            index > this.cursor &&
            frame.kind === 'history' &&
            !frame.state.loading,
        );
        if (next < 0) {
          const state = getReplayHistory(this.replayId)!;
          setReplayHistory(this.replayId, {
            ...state,
            loading: false,
            errorMessage:
              'No subsequent history response was captured. Resume capture on the live conversation to record it.',
          });
          return;
        }
        this.seek(next);
      });
    }
  }

  async observeRendered(
    element: () => HTMLElement | null,
  ): Promise<ReplayObservation> {
    const cursor = this.cursor;
    const delta = this.lastObservation?.delta;
    const measurement = await waitForReplayRender(element);
    if (cursor !== this.cursor || !isReplayThread(this.replayId))
      return this.lastObservation!;
    this.measurement = measurement;
    const observation = this.notify(element());
    observation.delta = delta;
    return observation;
  }

  async stepRendered(
    element: () => HTMLElement | null,
  ): Promise<ReplayObservation> {
    this.step();
    return this.observeRendered(element);
  }

  pause(): void {
    this.playbackGeneration += 1;
    this.playing = false;
    if (isReplayThread(this.replayId)) this.notify();
  }

  async play(
    element: () => HTMLElement | null,
    options: { speed?: number; untilIssue?: boolean; skipGaps?: boolean } = {},
  ): Promise<void> {
    this.pause();
    const speed = options.speed ?? 1;
    if (!Number.isFinite(speed) || speed <= 0 || speed > 32)
      throw new Error('Playback speed must be greater than 0 and at most 32');
    this.speed = speed;
    this.playing = true;
    const generation = this.playbackGeneration;
    this.notify();
    try {
      while (
        generation === this.playbackGeneration &&
        this.cursor < this.eventCount - 1
      ) {
        const previous = this.frames[this.cursor]?.atMs ?? 0;
        const next = this.frames[this.cursor + 1].atMs;
        const delay = options.untilIssue
          ? 0
          : Math.max(0, next - previous) / speed;
        const wait =
          options.skipGaps === false ? delay : Math.min(delay, 2_000);
        const deadline = performance.now() + wait;
        while (
          generation === this.playbackGeneration &&
          performance.now() < deadline
        ) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(50, deadline - performance.now())),
          );
        }
        if (generation !== this.playbackGeneration) break;
        const observation = await this.stepRendered(element);
        if (observation.issues.length > 0) break;
      }
    } finally {
      if (generation === this.playbackGeneration) {
        this.playing = false;
        this.notify(element());
      }
    }
  }

  dispose(): void {
    this.pause();
    setReplayHistory(this.replayId, null);
    this.listeners.clear();
  }

  private notify(transcriptElement?: HTMLElement | null): ReplayObservation {
    const observation = this.observe(transcriptElement);
    this.listeners.forEach((listener) => listener());
    return observation;
  }
}
