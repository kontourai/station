import type {
  ConversationListItem,
  ConversationTurnActivity,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore } from 'react';

// Query clients belong to verified Station/principal/grant namespaces. Never persist these observations
// or share them with another principal using the same Station endpoint.
const authorities = new WeakMap<QueryClient, WorkObservation>();
const INBOX = Symbol('inbox');
type Scope = string | typeof INBOX;
type Source =
  | 'history'
  | 'older-history'
  | 'open'
  | 'stream'
  | 'inventory'
  | 'sessions';

class WorkObservation {
  private revision = 0;
  private clock = 0;
  private epochGeneration = 0;
  private records = new Map<string, object>();
  private streamWatermarks = new Map<string, number>();
  private streamSuccesses = new Map<string, number>();
  private sequences = new Map<string, number>();
  private failures = new Map<
    Scope,
    Map<Source, { at: number; sequence: number }>
  >();
  private successes = new Map<string, number>();
  private listeners = new Map<string, Set<() => void>>();
  private inventoryIds?: Set<string>;
  private pending = new Set<string>();
  private batching = false;
  subscribe = (conversationId: string, listener: () => void) => {
    this.ensureLifecycle();
    let listeners = this.listeners.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(conversationId, listeners);
    }
    this.record(conversationId);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(conversationId);
        if (this.inventoryIds && !this.inventoryIds.has(conversationId))
          this.drop(conversationId);
      }
    };
  };
  snapshot = () => this.revision;
  // Imperative opens survive record pruning, but never a stream epoch replacement.
  streamEpochGeneration = () => this.epochGeneration;
  begin = () => {
    this.ensureLifecycle();
    return ++this.clock;
  };
  read(
    conversationId: string,
    source: Source,
    isCurrent = () => true,
    sequence = this.sequences.get(conversationId) ?? -1,
  ) {
    if (!isCurrent()) return;
    const started = this.begin();
    const watermark = Math.max(
      sequence,
      this.sequences.get(conversationId) ?? -1,
    );
    const record = this.record(conversationId);
    const epochGeneration = this.epochGeneration;
    const current = () =>
      this.epochGeneration === epochGeneration &&
      this.records.get(conversationId) === record &&
      isCurrent();
    return {
      current,
      failed: () => {
        if (current()) this.failed(conversationId, started, source, watermark);
      },
      observed: (resultSequence?: number) => {
        if (current()) this.observed(conversationId, resultSequence, source);
      },
    };
  }
  resetStreamEpoch() {
    this.epochGeneration += 1;
    this.streamWatermarks.clear();
    this.streamSuccesses.clear();
    this.sequences.clear();
    // Sequence fences belong to one stream epoch. Retain unresolved failures,
    // but let new-epoch observations supersede them without the old fences.
    for (const failures of this.failures.values())
      for (const failure of failures.values()) failure.sequence = -1;
    // Cancel logical query publication as well as clearing retained old-epoch pages.
    // resetQueries also refetches mounted lists in the replacement epoch.
    void this.client.resetQueries({
      predicate: (query) =>
        query.queryKey[0] === 'conversation-inventory' ||
        query.queryKey[0] === 'orchestration-sessions',
    });
    this.notify();
  }
  private record(conversationId: string) {
    let record = this.records.get(conversationId);
    if (!record) {
      record = {};
      this.records.set(conversationId, record);
      this.successes.set(conversationId, -1);
    }
    return record;
  }
  private notify(conversationId?: string) {
    if (conversationId !== undefined) this.pending.add(conversationId);
    else for (const id of this.listeners.keys()) this.pending.add(id);
    if (this.batching) return;
    this.revision += 1;
    const pending = [...this.pending];
    this.pending.clear();
    for (const id of pending)
      for (const listener of this.listeners.get(id) ?? []) listener();
  }
  // Failures belong to their read source. Only that source's successful read clears
  // them. A stream observation supersedes each failure whose watermark it exceeds:
  // it proves current status, not recovery of that reader. A history pane keeps
  // its own error UI until its history read succeeds.
  // Every read captures its watermark at START, for either settlement. Stream
  // watermarks are retained even below another source's fence: a failure started
  // below the highest stream sequence is obsolete regardless of completion order.
  // Within one stream epoch, equality is replay, not supersession. Successes and newer failures apply normally.
  // Readers supply a generation/token predicate invalidated on release/unmount;
  // record tokens also retire outstanding publishers on pruning or cache clear. Imperative
  // opens may create observations, but retired readers may never recreate them.
  // Unsubscribe preserves evidence unless inventory also no longer references it.
  failed(
    conversationId: string,
    started = this.begin(),
    source: Source = 'history',
    sequence?: number,
  ) {
    const watermark = sequence ?? this.sequences.get(conversationId) ?? -1;
    if (watermark < (this.streamWatermarks.get(conversationId) ?? -1)) return;
    if (sequence !== undefined)
      this.sequences.set(
        conversationId,
        Math.max(sequence, this.sequences.get(conversationId) ?? -1),
      );
    this.record(conversationId);
    let failures = this.failures.get(conversationId);
    if (!failures) {
      failures = new Map();
      this.failures.set(conversationId, failures);
    }
    failures.set(source, {
      at: started,
      sequence: watermark,
    });
    this.notify(conversationId);
  }
  observed(
    conversationId: string,
    sequence?: number,
    source: Source = 'history',
  ) {
    this.ensureLifecycle();
    this.record(conversationId);
    const wasUnavailable = this.unavailable(conversationId);
    if (sequence !== undefined)
      this.sequences.set(
        conversationId,
        Math.max(sequence, this.sequences.get(conversationId) ?? -1),
      );
    this.failures.get(conversationId)?.delete(source);
    this.successes.set(conversationId, ++this.clock);
    if (wasUnavailable !== this.unavailable(conversationId))
      this.notify(conversationId);
  }
  streamObserved(activity: ConversationTurnActivity) {
    const id = activity.conversationId;
    if (!this.successes.has(id) && !this.failures.has(id)) return;
    this.streamWatermarks.set(
      id,
      Math.max(activity.asOfSequence, this.streamWatermarks.get(id) ?? -1),
    );
    const wasUnavailable = this.unavailable(id);
    for (const [source, failure] of this.failures.get(id) ?? [])
      if (activity.asOfSequence > failure.sequence)
        this.failures.get(id)?.delete(source);
    if (activity.asOfSequence <= (this.sequences.get(id) ?? -1)) {
      if (wasUnavailable !== this.unavailable(id)) this.notify(id);
      return;
    }
    this.streamSuccesses.set(id, ++this.clock);
    this.observed(id, activity.asOfSequence, 'stream');
    this.notify(id);
  }
  unavailable(conversationId: string) {
    const success = this.successes.get(conversationId) ?? -1;
    const failures = this.failures.get(conversationId);
    if (failures?.size) return true;
    const inboxFailure = Math.max(
      -1,
      ...Array.from(
        this.failures.get(INBOX)?.values() ?? [],
        (value) => value.at,
      ),
    );
    if (inboxFailure > (this.streamSuccesses.get(conversationId) ?? -1))
      return true;
    return success === -1 ? undefined : false;
  }
  private drop(conversationId: string) {
    this.records.delete(conversationId);
    this.streamWatermarks.delete(conversationId);
    this.streamSuccesses.delete(conversationId);
    this.sequences.delete(conversationId);
    this.failures.delete(conversationId);
    this.successes.delete(conversationId);
  }
  private ensureLifecycle() {
    this.client
      .getQueryCache()
      .build(this.client, { queryKey: ['work-observation'], gcTime: Infinity });
  }
  constructor(private readonly client: QueryClient) {
    // A cache-owned lifecycle entry makes clear() observable even with no remote queries.
    this.ensureLifecycle();
    // Both reads supply the inbox. Keep each read's failure until that read
    // recovers; a healthy inventory must not hide a failed sessions read.
    const failedLists = new Map<string, number>();
    const startedLists = new Map<string, number>();
    for (const query of client.getQueryCache().getAll()) {
      const root = query.queryKey[0];
      if (
        (root === 'conversation-inventory' ||
          root === 'orchestration-sessions') &&
        query.state.status === 'error'
      ) {
        failedLists.set(root, this.begin());
      }
    }
    if (failedLists.size > 0)
      this.failures.set(
        INBOX,
        new Map(
          Array.from(failedLists, ([source, at]) => [
            source === 'conversation-inventory' ? 'inventory' : 'sessions',
            { at, sequence: -1 },
          ]),
        ),
      );
    client.getQueryCache().subscribe((event) => {
      if (
        event.type === 'removed' &&
        event.query.queryKey[0] === 'work-observation'
      ) {
        this.records.clear();
        this.streamWatermarks.clear();
        this.streamSuccesses.clear();
        this.sequences.clear();
        this.failures.clear();
        this.successes.clear();
        this.inventoryIds = undefined;
        failedLists.clear();
        startedLists.clear();
        this.notify();
        return;
      }
      if (event.type !== 'updated') return;
      const root = event.query.queryKey[0];
      if (
        root !== 'conversation-inventory' &&
        root !== 'orchestration-sessions'
      )
        return;
      const pageDirection =
        root === 'conversation-inventory'
          ? event.query.state.fetchMeta?.fetchMore?.direction
          : undefined;
      if (event.action.type === 'fetch' && !pageDirection)
        startedLists.set(root, this.begin());
      if (event.action.type === 'error' && !pageDirection) {
        failedLists.set(root, startedLists.get(root) ?? this.begin());
        this.failures.set(
          INBOX,
          new Map(
            Array.from(failedLists, ([source, at]) => [
              source === 'conversation-inventory' ? 'inventory' : 'sessions',
              { at, sequence: -1 },
            ]),
          ),
        );
        this.notify();
      } else if (event.action.type === 'success' && !event.action.manual) {
        this.batching = true;
        // Appending history does not re-read the inventory pages already cached.
        if (!pageDirection) {
          failedLists.delete(root);
          if (failedLists.size === 0) this.failures.delete(INBOX);
          else
            this.failures.set(
              INBOX,
              new Map(
                Array.from(failedLists, ([source, at]) => [
                  source === 'conversation-inventory'
                    ? 'inventory'
                    : 'sessions',
                  { at, sequence: -1 },
                ]),
              ),
            );
        }
        if (root === 'orchestration-sessions') {
          const sessions = client.getQueryData<OrchestrationSessionSummary[]>(
            event.query.queryKey,
          );
          for (const session of sessions ?? []) {
            if (
              session.conversationActivity &&
              this.successes.has(session.conversationActivity.conversationId)
            )
              this.observed(
                session.conversationActivity.conversationId,
                session.conversationActivity.asOfSequence,
                'sessions',
              );
          }
        } else {
          const inventory = client.getQueryData<{
            pages: { items: ConversationListItem[] }[];
          }>(event.query.queryKey);
          const pages = inventory?.pages ?? [];
          const observedPages =
            pageDirection === 'forward'
              ? pages.slice(-1)
              : pageDirection === 'backward'
                ? pages.slice(0, 1)
                : pages;
          const ids = new Set(
            pages.flatMap((page) => page.items.map((item) => item.id)),
          );
          this.inventoryIds = ids;
          if (!pageDirection) {
            for (const id of this.successes.keys())
              if (!ids.has(id) && !this.listeners.has(id)) this.drop(id);
          }
          for (const page of observedPages)
            for (const conversation of page.items) {
              if (conversation.activity && this.successes.has(conversation.id))
                this.observed(
                  conversation.id,
                  conversation.activity.asOfSequence,
                  'inventory',
                );
            }
        }
        this.batching = false;
        this.notify();
      }
    });
  }
}

export function workObservation(client: QueryClient) {
  let observation = authorities.get(client);
  if (!observation) {
    observation = new WorkObservation(client);
    authorities.set(client, observation);
  }
  return observation;
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => 0;
export function useWorkObservation(conversationId?: string | null) {
  const client = useContext(QueryClientContext);
  const observation = client ? workObservation(client) : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      observation && conversationId
        ? observation.subscribe(conversationId, listener)
        : noopSubscribe(),
    [observation, conversationId],
  );
  useSyncExternalStore(
    subscribe,
    observation?.snapshot ?? emptySnapshot,
    observation?.snapshot ?? emptySnapshot,
  );
  return observation;
}
