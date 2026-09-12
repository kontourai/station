import { activeChatsStore } from '../../../contexts/active-chats-store';
import { handleOrchestrationEvent } from '../eventHandlers';
import type { OrchestrationEvent } from '../types';
import { collectReplayObservation, type ReplayObservation } from './observe';
import { isReplayThread } from './replay-registry';
import { rewriteEventThreadId } from './rewrite';
import type { SessionTape } from './tape';

export class SessionTapePlayer {
  cursor = -1;
  lastObservation: ReplayObservation | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly tape: SessionTape,
    readonly replayId: string,
    private readonly apiBase = '',
  ) {
    if (!isReplayThread(replayId)) {
      throw new Error('SessionTapePlayer requires a registered replay thread');
    }
  }

  get eventCount(): number {
    return this.tape.events.length;
  }

  currentEvent(): OrchestrationEvent | undefined {
    return this.tape.events[this.cursor];
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
    });
    this.lastObservation = observation;
    return observation;
  }

  step(transcriptElement?: HTMLElement | null): ReplayObservation {
    if (this.cursor >= this.eventCount - 1)
      return this.observe(transcriptElement);
    this.cursor += 1;
    this.applyCurrent();
    return this.notify(transcriptElement);
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
    const clamped = Math.max(-1, Math.min(index, this.eventCount - 1));
    this.refoldTo(clamped);
    return this.notify(transcriptElement);
  }

  private applyCurrent(): void {
    const event = this.currentEvent();
    if (!event) return;
    handleOrchestrationEvent(
      this.apiBase,
      rewriteEventThreadId(event, this.replayId),
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
    while (this.cursor < index) {
      this.cursor += 1;
      this.applyCurrent();
    }
  }

  private notify(transcriptElement?: HTMLElement | null): ReplayObservation {
    const observation = this.observe(transcriptElement);
    this.listeners.forEach((listener) => listener());
    return observation;
  }
}
