import { activeChatsStore } from '../../contexts/active-chats-store';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import type { OrchestrationEvent } from './types';

export const SEMANTIC_DELIVERY_SPILL_CHARS = 24_000;
const SEMANTIC_DELIVERY_MAX_EVENTS = 4_096;
const SEMANTIC_DELIVERY_MAX_THREADS = 64;
const SEMANTIC_DELIVERY_TOTAL_CHARS = 96_000;

type DeltaEvent = Extract<
  OrchestrationEvent,
  { method: 'content.text-delta' | 'content.reasoning-delta' }
>;

interface Segment {
  event: DeltaEvent;
  chunks: string[];
  apiBase: string;
  provenance?: unknown;
}

export function createDeviceSemanticDeliveryBuffer(
  dispatch: (
    apiBase: string,
    event: OrchestrationEvent,
    provenance?: unknown,
  ) => void,
): SemanticDeliveryBuffer {
  const enabled = () =>
    deviceSettingsStore.get('featureSettings').bufferedDelivery === true;
  const buffer = new SemanticDeliveryBuffer(
    (event, apiBase, provenance) => dispatch(apiBase, event, provenance),
    enabled,
    deviceOwnerOf,
  );
  let unsubscribeChat: (() => void) | undefined = buffer.bindChatOwnership();
  deviceSettingsStore.subscribe(() => {
    if (enabled()) unsubscribeChat ??= buffer.bindChatOwnership();
    else {
      buffer.flushAll();
      unsubscribeChat?.();
      unsubscribeChat = undefined;
    }
  });
  return buffer;
}

interface PendingThread {
  apiBase: string;
  owner: string;
  segments: Segment[];
  chars: number;
  events: number;
}

function isDelta(event: OrchestrationEvent): event is DeltaEvent {
  return (
    event.method === 'content.text-delta' ||
    event.method === 'content.reasoning-delta'
  );
}

function deviceOwnerOf(threadId: string): string {
  const key = activeChatsStore.getChatKeyForExecutionSession(threadId);
  const chat = key ? activeChatsStore.getSnapshot()[key] : undefined;
  return chat
    ? `${key}\u0000${chat.conversationId ?? ''}\u0000${chat.currentSessionId ?? ''}`
    : '';
}

function sameSegment(a: DeltaEvent, b: DeltaEvent): boolean {
  return (
    a.method === b.method && a.turnId === b.turnId && a.itemId === b.itemId
  );
}

/**
 * Device-local projection buffer for #585.
 *
 * The canonical event stream is still captured and persisted event by event;
 * this class only controls when one browser applies deltas to its active-chat
 * projection. A non-delta is a semantic boundary and can never overtake text
 * produced before it. Arrays keep accumulation linear; joining happens once
 * when a bounded buffer is flushed.
 */
export class SemanticDeliveryBuffer {
  private readonly pending = new Map<string, PendingThread>();
  private readonly interruptions = new Map<string, number>();
  private totalChars = 0;

  constructor(
    private readonly dispatch: (
      event: OrchestrationEvent,
      apiBase: string,
      provenance?: unknown,
    ) => void,
    private readonly buffered: () => boolean,
    private readonly ownerOf: (threadId: string) => string = () => 'owner',
  ) {}
  offer(event: OrchestrationEvent, apiBase = '', provenance?: unknown): void {
    if (!this.ownerOf(event.threadId)) {
      this.dispatch(event, apiBase, provenance);
      return;
    }
    const key = this.key(apiBase, event.threadId);
    if (!isDelta(event)) {
      this.flushKey(key);
      this.dispatch(event, apiBase, provenance);
      return;
    }

    if (!this.buffered()) {
      // A setting change must reveal already-held text before the first event
      // delivered under the newly selected mode.
      this.flushKey(key);
      this.dispatch(event, apiBase, provenance);
      return;
    }

    let held = this.pending.get(key);
    if (!held) {
      if (this.pending.size >= SEMANTIC_DELIVERY_MAX_THREADS) this.flushAll();
      held = {
        apiBase,
        owner: this.ownerOf(event.threadId),
        segments: [],
        chars: 0,
        events: 0,
      };
      this.pending.set(key, held);
    }

    if (
      this.totalChars > 0 &&
      this.totalChars + event.delta.length > SEMANTIC_DELIVERY_TOTAL_CHARS
    ) {
      this.flushAll();
      held = {
        apiBase,
        owner: this.ownerOf(event.threadId),
        segments: [],
        chars: 0,
        events: 0,
      };
      this.pending.set(key, held);
    }

    // Spill before accepting an event that would cross the advertised bound.
    // A canonical delta larger than the bound is dispatched directly; it
    // cannot be made smaller here without inventing new event boundaries.
    if (
      held.events > 0 &&
      (held.chars + event.delta.length > SEMANTIC_DELIVERY_SPILL_CHARS ||
        held.events >= SEMANTIC_DELIVERY_MAX_EVENTS)
    ) {
      this.flushKey(key);
      held = {
        apiBase,
        owner: this.ownerOf(event.threadId),
        segments: [],
        chars: 0,
        events: 0,
      };
      this.pending.set(key, held);
    }
    if (event.delta.length > SEMANTIC_DELIVERY_SPILL_CHARS) {
      this.pending.delete(key);
      this.dispatch(event, apiBase, provenance);
      return;
    }

    const last = held.segments.at(-1);
    if (last && sameSegment(last.event, event)) {
      last.chunks.push(event.delta);
    } else {
      held.segments.push({ event, chunks: [event.delta], apiBase, provenance });
    }
    held.chars += event.delta.length;
    this.totalChars += event.delta.length;
    held.events += 1;
  }

  flushApiBase(apiBase: string): void {
    for (const [key, held] of [...this.pending.entries()]) {
      if (held.apiBase === apiBase) this.flushKey(key);
    }
  }

  dropApiBase(apiBase: string): void {
    for (const [key, held] of [...this.pending.entries()]) {
      if (held.apiBase === apiBase) this.dropKey(key);
    }
  }

  interruptApiBase(apiBase: string, terminal: boolean): void {
    const generation = (this.interruptions.get(apiBase) ?? 0) + 1;
    this.interruptions.set(apiBase, generation);
    if (terminal) {
      this.dropApiBase(apiBase);
      return;
    }
    queueMicrotask(() => {
      if (this.interruptions.get(apiBase) === generation)
        this.flushApiBase(apiBase);
    });
  }

  dropChangedOwners(): void {
    for (const [key, held] of [...this.pending.entries()]) {
      const threadId = held.segments[0]?.event.threadId;
      if (threadId !== undefined && held.owner !== this.ownerOf(threadId))
        this.dropKey(key);
    }
  }

  private dropKey(key: string): void {
    const held = this.pending.get(key);
    if (!held) return;
    this.pending.delete(key);
    this.totalChars -= held.chars;
  }

  private flushKey(key: string): void {
    const held = this.pending.get(key);
    if (!held) return;
    this.pending.delete(key);
    this.totalChars -= held.chars;
    for (const segment of held.segments) {
      this.dispatch(
        {
          ...segment.event,
          delta: segment.chunks.join(''),
        } as OrchestrationEvent,
        segment.apiBase,
        segment.provenance,
      );
    }
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flushKey(key);
  }

  pendingThreadCount(): number {
    return this.pending.size;
  }

  bindChatOwnership(): () => void {
    return activeChatsStore.subscribe(() => {
      this.dropChangedOwners();
    });
  }

  private key(apiBase: string, threadId: string): string {
    return `${apiBase}\u0000${threadId}`;
  }
}
