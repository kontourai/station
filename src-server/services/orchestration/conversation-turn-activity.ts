import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type {
  ConversationTurnActivity,
  OrchestrationConversationStreamBinding,
  TurnProgressObservation,
} from '@kontourai/station-contracts/orchestration';
import {
  type CanonicalRuntimeEvent,
  isProviderTriggeredTurn,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { orchestrationConversationActivityStuckChildTurns } from '../../telemetry/metrics.js';
import type {
  EventStore,
  EventStoreCommitObserver,
  PersistedRuntimeEvent,
  TurnActivitySeed,
} from './event-store.js';
import {
  activeTurnIdForEvents,
  advanceOpenTurnId,
} from './session-lifecycle-service.js';

/**
 * #2309: the one server projection of what a conversation is doing now
 * (`ConversationTurnActivity`), shared by the snapshot rows, the SSE stream
 * binding, the conversation list and the open resolution so that no two of
 * them — and no client — derive liveness independently.
 *
 * Substrate: an in-memory fold fed by the event store's post-commit observer,
 * so it sees every writer (the service's publish path, attached-follow, fork
 * provenance, boot recovery), not only `publishCanonicalEvent`. A thread is
 * seeded lazily, once per process, from bounded durable reads; after that a
 * read is map lookups only. Nothing here is persisted, and nothing here is
 * forgotten when the service forgets a thread's live state — only a durable
 * delete or a lineage change invalidates it.
 *
 * The open-turn fold is `advanceOpenTurnId`, the step of the fold
 * `hasOpenTurn` runs — never a local copy of its rules.
 */

/** Methods whose frames always carry the activity they produced. */
const ACTIVITY_FRAME_METHODS: ReadonlySet<string> = new Set([
  'child-work.updated',
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'tool.started',
  'tool.completed',
  'runtime.error',
  'session.exited',
]);

function immediateActivityFrame(event: {
  method?: string;
  namespace?: string;
  type?: string;
}): boolean {
  return (
    (event.method !== undefined && ACTIVITY_FRAME_METHODS.has(event.method)) ||
    (event.method === 'extension.notification' &&
      event.namespace === 'claude-code' &&
      (event.type === 'task/registry' ||
        event.type === 'task/settled' ||
        event.type === 'provider/follow-up-pending'))
  );
}

/**
 * Any other committed event moves only `lastActivityAt`; its frame carries
 * the activity at most this often per execution child (thread).
 */
const COALESCED_FRAME_INTERVAL_MS = 1_000;

type ActivityStore = Pick<
  EventStore,
  | 'observeCommits'
  | 'listSessionProjectionEvents'
  | 'readTurnActivitySeed'
  | 'readOpenTurnActivitySeed'
  | 'latestToolTerminalsForThreads'
  | 'conversationLineageForThreads'
  | 'conversationForSession'
  | 'conversationSessions'
>;

interface ThreadActivity {
  /** #2324: `trigger` comes from the turn's first `turn.started`. */
  openTurn?: { turnId: string; startedAt: string; trigger?: 'provider' };
  /** Insertion order is start order: the most recently started is last. */
  runningTools: Map<string, { name: string; startedAt: string }>;
  lastTool?: NonNullable<ConversationTurnActivity['lastTool']>;
  lastActivityAt?: string;
  asOfSequence: number;
}

export interface ConversationTurnActivityProjectionDeps {
  eventStore: ActivityStore;
  readTurnProgress: (
    threadId: string,
  ) => (TurnProgressObservation & { turnId: string }) | undefined;
  readRunningChildWork: (threadId: string) => ChildWorkItem[];
  publishProjectionChange?: (threadId: string) => void;
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
}

/** `undefined` for a status outside the contract: no outcome is claimed. */
function toolOutcome(
  status: unknown,
): NonNullable<ConversationTurnActivity['lastTool']>['outcome'] | undefined {
  return status === 'error' ||
    status === 'cancelled' ||
    status === 'unresolved' ||
    status === 'success'
    ? status
    : undefined;
}

function lastToolOf(input: {
  name: string;
  callId: string;
  status: unknown;
  completedAt: string;
}): ThreadActivity['lastTool'] {
  const outcome = toolOutcome(input.status);
  return outcome
    ? {
        name: input.name,
        callId: input.callId,
        outcome,
        completedAt: input.completedAt,
      }
    : undefined;
}

function later(left: string | undefined, right: string): string {
  return left !== undefined && left > right ? left : right;
}

export class ConversationTurnActivityProjection {
  private readonly threads = new Map<string, ThreadActivity>();
  /** `null` caches "no lineage"; a lineage change for the session clears it. */
  private readonly conversationOfThread = new Map<string, string | null>();
  private readonly childrenOfConversation = new Map<string, string[]>();
  /** Per thread: the coalesced event last chosen to carry activity. */
  private readonly coalescedFrame = new Map<
    string,
    { globalSequence: number; at: number }
  >();
  /**
   * `threadId\u0000turnId` of stuck non-current children already counted, so
   * the metric counts each breach once rather than once per read or frame.
   */
  private readonly countedStuckChildren = new Set<string>();
  private readonly pendingFollowUps = new Map<
    string,
    { expiresAt: number; timeout: ReturnType<typeof setTimeout> }
  >();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly deps: ConversationTurnActivityProjectionDeps) {
    this.now = deps.now ?? Date.now;
    const observer: EventStoreCommitObserver = {
      eventCommitted: (input) => {
        try {
          this.observeCommitted(input);
        } catch (error) {
          // Drop the thread rather than keep a fold that missed an event:
          // the next read re-seeds from durable state.
          this.threads.delete(input.event.threadId);
          this.deps.logger.warn('Conversation activity fold failed', {
            threadId: input.event.threadId,
            method: input.event.method,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      threadDeleted: (threadId) => {
        this.clearFollowUp(threadId);
        this.threads.delete(threadId);
        this.coalescedFrame.delete(threadId);
        const prefix = `${threadId}\u0000`;
        for (const key of this.countedStuckChildren)
          if (key.startsWith(prefix)) this.countedStuckChildren.delete(key);
        const conversationId = this.conversationOfThread.get(threadId);
        this.conversationOfThread.delete(threadId);
        if (conversationId) this.childrenOfConversation.delete(conversationId);
      },
      lineageChanged: ({ conversationId, sessionId }) => {
        this.conversationOfThread.delete(sessionId);
        this.childrenOfConversation.delete(conversationId);
      },
    };
    this.unsubscribe = deps.eventStore.observeCommits(observer);
  }

  dispose(): void {
    this.unsubscribe();
    for (const threadId of this.pendingFollowUps.keys())
      this.clearFollowUp(threadId);
  }

  private clearFollowUp(threadId: string): void {
    const pending = this.pendingFollowUps.get(threadId);
    if (pending) clearTimeout(pending.timeout);
    this.pendingFollowUps.delete(threadId);
  }

  private observeFollowUp(event: CanonicalRuntimeEvent): void {
    if (event.method === 'session.exited' || event.method === 'turn.started') {
      this.clearFollowUp(event.threadId);
      return;
    }
    if (
      event.method !== 'extension.notification' ||
      event.namespace !== 'claude-code' ||
      event.type !== 'provider/follow-up-pending'
    )
      return;
    this.clearFollowUp(event.threadId);
    if (
      !event.payload ||
      typeof event.payload !== 'object' ||
      (event.payload as { pending?: unknown }).pending !== true
    )
      return;
    const expiresAt = this.now() + 5_000;
    const timeout = setTimeout(() => {
      const current = this.pendingFollowUps.get(event.threadId);
      if (current?.expiresAt !== expiresAt) return;
      this.pendingFollowUps.delete(event.threadId);
      this.deps.publishProjectionChange?.(event.threadId);
    }, 5_000);
    timeout.unref?.();
    this.pendingFollowUps.set(event.threadId, { expiresAt, timeout });
  }

  /**
   * Seed every unseeded thread in one batch from the projection events a
   * caller already read (the session snapshot's batched read): lineage and
   * last tool terminal are one statement per chunk, the head comes from the
   * projection events themselves (they carry each thread's latest event),
   * and only threads with an OPEN turn pay a per-thread read for its start
   * and tools. A thread already seeded is left alone: its live fold is at
   * least as new.
   */
  primeThreads(eventsByThread: ReadonlyMap<string, PersistedRuntimeEvent[]>) {
    const unseeded = [...eventsByThread.keys()].filter(
      (threadId) => !this.threads.has(threadId),
    );
    if (unseeded.length === 0) return;
    const store = this.deps.eventStore;
    const unresolved = unseeded.filter(
      (threadId) => !this.conversationOfThread.has(threadId),
    );
    if (unresolved.length > 0) {
      const lineage = store.conversationLineageForThreads(unresolved);
      for (const threadId of unresolved) {
        const entry = lineage.get(threadId);
        this.conversationOfThread.set(threadId, entry?.conversationId ?? null);
        if (entry && !this.childrenOfConversation.has(entry.conversationId))
          this.childrenOfConversation.set(
            entry.conversationId,
            entry.sessionIds.length > 0
              ? entry.sessionIds
              : [entry.conversationId],
          );
      }
    }
    const lastTools = store.latestToolTerminalsForThreads(unseeded);
    for (const threadId of unseeded) {
      const events = eventsByThread.get(threadId) ?? [];
      const openTurnId = activeTurnIdForEvents(
        events.map((event) => event.payload),
      );
      let head: TurnActivitySeed['head'];
      for (const event of events)
        if (!head || event.globalSequence > head.globalSequence)
          head = {
            globalSequence: event.globalSequence,
            createdAt: event.createdAt,
          };
      const open = openTurnId
        ? store.readOpenTurnActivitySeed(threadId, openTurnId)
        : { tools: [], toolsTruncated: false };
      const lastTool = lastTools.get(threadId);
      this.installSeed(threadId, openTurnId, events, {
        ...(head ? { head } : {}),
        ...open,
        ...(lastTool ? { lastTool } : {}),
      });
    }
  }

  /** The conversation `threadId` belongs to, or `undefined` without lineage. */
  conversationIdForThread(threadId: string): string | undefined {
    let conversationId = this.conversationOfThread.get(threadId);
    if (conversationId === undefined) {
      conversationId =
        this.deps.eventStore.conversationForSession(threadId)?.conversationId ??
        null;
      this.conversationOfThread.set(threadId, conversationId);
    }
    return conversationId ?? undefined;
  }

  readForThread(threadId: string): ConversationTurnActivity | undefined {
    const conversationId = this.conversationIdForThread(threadId);
    return conversationId ? this.readConversation(conversationId) : undefined;
  }

  readConversation(conversationId: string): ConversationTurnActivity {
    const children = this.children(conversationId);
    const currentThreadId = children.at(-1) ?? conversationId;
    let asOfSequence = 0;
    let lastActivityAt: string | undefined;
    let lastTool: ThreadActivity['lastTool'];
    let current: ThreadActivity | undefined;
    const runningChildren: ChildWorkItem[] = [];
    let followUpPending = false;
    for (const threadId of children) {
      const state = this.thread(threadId);
      runningChildren.push(...this.deps.readRunningChildWork(threadId));
      const pending = this.pendingFollowUps.get(threadId);
      if (pending && pending.expiresAt > this.now()) followUpPending = true;
      if (threadId === currentThreadId) current = state;
      else if (state.openTurn) this.countStuckChild(threadId, state.openTurn);
      asOfSequence = Math.max(asOfSequence, state.asOfSequence);
      if (state.lastActivityAt)
        lastActivityAt = later(lastActivityAt, state.lastActivityAt);
      if (
        state.lastTool &&
        (!lastTool || state.lastTool.completedAt > lastTool.completedAt)
      )
        lastTool = state.lastTool;
    }
    const activity: ConversationTurnActivity = {
      conversationId,
      currentThreadId,
      asOfSequence,
    };
    if (runningChildren.length > 0 || followUpPending) {
      const oldestStartedAt = runningChildren.reduce(
        (oldest, item) =>
          item.startedAt && (!oldest || item.startedAt < oldest)
            ? item.startedAt
            : oldest,
        undefined as string | undefined,
      );
      activity.runningChildWork = {
        count: runningChildren.length,
        producers: [...new Set(runningChildren.map((item) => item.producer))],
        ...(oldestStartedAt ? { oldestStartedAt } : {}),
        ...(followUpPending ? { followUpPending: true } : {}),
      };
    }
    if (current?.openTurn) {
      const { turnId, startedAt, trigger } = current.openTurn;
      activity.openTurn = {
        turnId,
        threadId: currentThreadId,
        startedAt,
        ...(trigger ? { trigger } : {}),
      };
      if (current.runningTools.size > 0) {
        activity.runningTools = [...current.runningTools].map(
          ([callId, tool]) => ({
            name: tool.name,
            callId,
            startedAt: tool.startedAt,
          }),
        );
      }
      const progress = this.deps.readTurnProgress(currentThreadId);
      if (progress?.turnId === turnId && progress.progressSilence)
        activity.progressSilence = progress.progressSilence;
    }
    if (lastActivityAt) activity.lastActivityAt = lastActivityAt;
    if (lastTool) activity.lastTool = lastTool;
    return activity;
  }

  /**
   * The activity-bearing stream binding for one delivered frame, or
   * `undefined` when this frame carries none. Map reads only once the
   * conversation's threads are seeded — this runs per frame per subscriber.
   *
   * A coalesced frame (a delta, `tool.progress`, …) carries activity only if
   * its event is the one the fold selected at commit time. That decision is
   * made once per event, not per call, so every subscriber gets the same
   * answer for the same frame.
   */
  streamBinding(event: {
    threadId: string;
    method?: string;
    namespace?: string;
    type?: string;
  }): OrchestrationConversationStreamBinding | undefined {
    if (!event.method) return undefined;
    if (!immediateActivityFrame(event)) {
      // Decided before any lookup: the per-token path costs two map reads.
      const chosen = this.coalescedFrame.get(event.threadId);
      if (
        !chosen ||
        chosen.globalSequence !== this.threads.get(event.threadId)?.asOfSequence
      )
        return undefined;
    }
    const conversationId = this.conversationIdForThread(event.threadId);
    if (!conversationId) return undefined;
    return {
      conversationId,
      currentSessionId: this.currentSessionId(conversationId),
      activity: this.readConversation(conversationId),
    };
  }

  /**
   * An open turn on a child that is no longer the conversation's current one.
   * Continuation, handoff and context boundaries all refuse while the
   * predecessor has an active turn, so on the product's own paths this is a
   * stuck turn (typically a retired child whose crash left no boundary row
   * to recover). It is not guaranteed stuck: nothing refuses a `sendTurn`
   * addressed directly to a retired child's thread, so an API caller can
   * run a real turn there. Either way it must not make the conversation
   * read as running. Counted once per (thread, turn).
   */
  private countStuckChild(threadId: string, openTurn: { turnId: string }) {
    const key = `${threadId}\u0000${openTurn.turnId}`;
    if (this.countedStuckChildren.has(key)) return;
    this.countedStuckChildren.add(key);
    orchestrationConversationActivityStuckChildTurns.add(1);
    this.deps.logger.warn(
      'Conversation activity ignored an open turn on a non-current child',
      { threadId, turnId: openTurn.turnId },
    );
  }

  /** Same answer as `ConversationLineage.currentConversationSessionId`. */
  currentSessionId(conversationId: string): string {
    return this.children(conversationId).at(-1) ?? conversationId;
  }

  private children(conversationId: string): string[] {
    let children = this.childrenOfConversation.get(conversationId);
    if (!children) {
      const lineage = this.deps.eventStore
        .conversationSessions(conversationId)
        .map((entry) => entry.sessionId);
      children = lineage.length > 0 ? lineage : [conversationId];
      this.childrenOfConversation.set(conversationId, children);
    }
    return children;
  }

  private thread(threadId: string): ThreadActivity {
    return this.threads.get(threadId) ?? this.seedThread(threadId);
  }

  private seedThread(threadId: string): ThreadActivity {
    const events = this.deps.eventStore.listSessionProjectionEvents(threadId);
    const openTurnId = activeTurnIdForEvents(
      events.map((event) => event.payload),
    );
    return this.installSeed(
      threadId,
      openTurnId,
      events,
      this.deps.eventStore.readTurnActivitySeed(threadId, openTurnId),
    );
  }

  private installSeed(
    threadId: string,
    openTurnId: string | undefined,
    events: readonly PersistedRuntimeEvent[],
    seed: TurnActivitySeed,
  ): ThreadActivity {
    const lastTool = seed.lastTool
      ? lastToolOf({
          name: seed.lastTool.name,
          callId: seed.lastTool.callId,
          status: seed.lastTool.status,
          completedAt: seed.lastTool.createdAt,
        })
      : undefined;
    const state: ThreadActivity = {
      runningTools: new Map(),
      asOfSequence: seed.head?.globalSequence ?? 0,
      ...(seed.head ? { lastActivityAt: seed.head.createdAt } : {}),
      ...(lastTool ? { lastTool } : {}),
    };
    if (openTurnId && seed.openTurn) {
      state.openTurn = {
        turnId: openTurnId,
        startedAt: seed.openTurn.startedAt,
        ...(seed.openTurn.trigger ? { trigger: seed.openTurn.trigger } : {}),
      };
      for (const tool of seed.tools) {
        if (tool.method === 'tool.started')
          state.runningTools.set(tool.callId, {
            name: tool.name,
            startedAt: tool.createdAt,
          });
        else state.runningTools.delete(tool.callId);
      }
      if (seed.toolsTruncated)
        this.deps.logger.warn(
          'Conversation activity seed read a bounded tool window',
          { threadId, turnId: openTurnId },
        );
    } else if (openTurnId) {
      // The fold only names a turn from a `turn.started` it read, so that
      // event is in hand even when the store's start read found none. Its
      // time and marker are real, not invented.
      const started = events.find(
        (event) =>
          event.payload.method === 'turn.started' &&
          event.payload.turnId === openTurnId,
      );
      if (started) {
        state.openTurn = {
          turnId: openTurnId,
          startedAt: started.createdAt,
          ...(isProviderTriggeredTurn(started.payload)
            ? { trigger: PROVIDER_TURN_TRIGGER }
            : {}),
        };
      }
    }
    this.threads.set(threadId, state);
    return state;
  }

  private observeCommitted(input: {
    event: CanonicalRuntimeEvent;
    globalSequence: number;
    deferred: boolean;
  }): void {
    const { event, globalSequence } = input;
    if (input.deferred) {
      // A caller's outer transaction may still roll this row back.
      this.threads.delete(event.threadId);
      return;
    }
    this.observeFollowUp(event);
    const state = this.threads.get(event.threadId);
    // Unseeded: the seed will read this row durably when first needed.
    if (!state || globalSequence <= state.asOfSequence) return;
    const previous = state.openTurn?.turnId;
    const next = advanceOpenTurnId(previous, event);
    if (next !== previous) {
      // A new turn or a closed one: calls started in the previous turn are
      // no longer this turn's, and a call left open at close is dropped —
      // settling it is the adapter's report to make, not this fold's.
      state.runningTools.clear();
      // The turn opens on its first `turn.started` (a steer never changes
      // the open id), which is the event that carries its trigger.
      state.openTurn =
        next === undefined
          ? undefined
          : {
              turnId: next,
              startedAt: event.createdAt,
              ...(isProviderTriggeredTurn(event)
                ? { trigger: PROVIDER_TURN_TRIGGER }
                : {}),
            };
    }
    if (event.method === 'tool.started' && state.openTurn) {
      state.runningTools.delete(event.toolCallId);
      state.runningTools.set(event.toolCallId, {
        name: event.toolName,
        startedAt: event.createdAt,
      });
    } else if (event.method === 'tool.completed') {
      state.runningTools.delete(event.toolCallId);
      const lastTool = lastToolOf({
        name: event.toolName,
        callId: event.toolCallId,
        status: event.status,
        completedAt: event.createdAt,
      });
      if (lastTool) state.lastTool = lastTool;
    }
    state.lastActivityAt = later(state.lastActivityAt, event.createdAt);
    state.asOfSequence = globalSequence;
    if (!immediateActivityFrame(event)) {
      const now = this.now();
      const chosen = this.coalescedFrame.get(event.threadId);
      if (!chosen || now - chosen.at >= COALESCED_FRAME_INTERVAL_MS)
        this.coalescedFrame.set(event.threadId, { globalSequence, at: now });
    }
  }
}
