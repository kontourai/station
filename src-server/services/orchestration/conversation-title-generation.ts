import { isLowContentPrompt } from '@kontourai/station-contracts/conversation-title';
import { runtimeEventContentText } from '@kontourai/station-contracts/runtime-event-content';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import type { EventBus } from './event-bus.js';
import type { EventStore } from './event-store.js';

/** A first reply's text deltas read for the title prompt, at most. */
const TURN_TEXT_EVENT_LIMIT = 2_000;
/** Conversations remembered as attempted before the memory is reset. */
const ATTEMPTED_LIMIT = 1_024;

export interface ConversationTitleGenerationDeps {
  eventStore: Pick<
    EventStore,
    | 'conversationTitleGenerationCandidate'
    | 'recordGeneratedConversationTitle'
    | 'listTurnEventsByMethods'
    | 'resolveEventContent'
  >;
  /** Whether a title model is configured now (`resolveTitleModel`). */
  enabled(): boolean;
  /**
   * One bounded model call (`generateConversationTitle`): resolves null on
   * timeout, failure or a disabled model, and never throws by contract. A
   * throw is still caught here.
   */
  generate(input: {
    firstUserText: string;
    assistantText: string;
  }): Promise<string | null>;
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Feeds every committed `turn.completed` on the bus to `titles`. The
 * runtime's one wiring of title generation; returns the unsubscribe.
 */
export function subscribeConversationTitleGeneration(
  eventBus: Pick<EventBus, 'subscribe'>,
  titles: Pick<ConversationTitleGeneration, 'observe'>,
): () => void {
  return eventBus.subscribe((serverEvent) => {
    if (serverEvent.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = serverEvent.data?.event as CanonicalRuntimeEvent | undefined;
    if (event?.method === 'turn.completed') titles.observe(event);
  });
}

/**
 * #4266: names a runtime conversation with the title model after its first
 * completed turn, in the background.
 *
 * Best-effort throughout: it runs detached after the `turn.completed` is
 * stored, so it never delays the turn, and any failure (no model, timeout,
 * provider error, an empty or low-content answer) leaves the deterministic
 * first-prompt title in place. The store writes the generated title only
 * while the row's title is still prompt-derived, so a start-supplied title,
 * or one that changed while the model ran, is never overwritten.
 *
 * Each conversation is attempted at most once per process. A conversation
 * whose first prompt is low-content ("Continue") is not sent to the model:
 * there is nothing to name it from, and its next real prompt replaces the
 * title deterministically.
 */
export class ConversationTitleGeneration {
  private readonly attempted = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: ConversationTitleGenerationDeps) {}

  /** Called with every committed event. */
  observe(event: CanonicalRuntimeEvent): void {
    if (event.method !== 'turn.completed') return;
    if (this.attempted.has(event.threadId)) return;
    if (!this.deps.enabled()) return;
    const candidate = this.deps.eventStore.conversationTitleGenerationCandidate(
      event.threadId,
    );
    if (!candidate) return;
    const firstPrompt = candidate.firstPromptedTurn.payload;
    const firstUserText =
      firstPrompt.method === 'turn.started'
        ? runtimeEventContentText(firstPrompt.prompt)
            ?.text.replace(/^\s*\[Timezone:\s*[^\]]*\]\s*/i, '')
            .trim()
        : undefined;
    if (!firstUserText || isLowContentPrompt(firstUserText)) return;
    if (this.attempted.size >= ATTEMPTED_LIMIT) this.attempted.clear();
    this.attempted.add(event.threadId);
    const run = this.title(event, firstUserText).catch((error: unknown) =>
      this.deps.logger.warn('Conversation title generation failed', {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Resolves when every generation started so far has finished. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async title(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }>,
    firstUserText: string,
  ): Promise<void> {
    const title = (
      await this.deps.generate({
        firstUserText,
        assistantText: this.replyText(event),
      })
    )?.trim();
    if (!title || isLowContentPrompt(title)) return;
    this.deps.eventStore.recordGeneratedConversationTitle(
      event.threadId,
      title,
    );
  }

  private replyText(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.completed' }>,
  ): string {
    if (typeof event.outputText === 'string' && event.outputText.trim())
      return event.outputText;
    const store = this.deps.eventStore;
    let text = '';
    for (const stored of store.resolveEventContent(
      store.listTurnEventsByMethods(
        event.threadId,
        event.turnId,
        ['content.text-delta'],
        TURN_TEXT_EVENT_LIMIT,
      ),
    )) {
      if (stored.payload.method === 'content.text-delta')
        text += stored.payload.delta;
    }
    return text;
  }
}
