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

class WorkObservation {
  private revision = 0;
  private clock = 0;
  private sequences = new Map<string, number>();
  private failures = new Map<Scope, number>();
  private successes = new Map<Scope, number>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Set<string>();
  private batching = false;
  subscribe = (conversationId: string, listener: () => void) => {
    let listeners = this.listeners.get(conversationId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(conversationId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(conversationId);
        this.sequences.delete(conversationId);
        this.failures.delete(conversationId);
        this.successes.delete(conversationId);
      }
    };
  };
  snapshot = () => this.revision;
  begin = () => ++this.clock;
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
  failed(conversationId: string, started = this.begin()) {
    // A stream observation received while this request was pending wins.
    if ((this.successes.get(conversationId) ?? -1) > started) return;
    this.failures.set(conversationId, ++this.clock);
    this.notify(conversationId);
  }
  observed(conversationId: string, sequence?: number) {
    const wasUnavailable = this.unavailable(conversationId);
    if (sequence !== undefined)
      this.sequences.set(
        conversationId,
        Math.max(sequence, this.sequences.get(conversationId) ?? -1),
      );
    this.failures.delete(conversationId);
    this.successes.set(conversationId, ++this.clock);
    if (wasUnavailable !== false) this.notify(conversationId);
  }
  streamObserved(activity: ConversationTurnActivity) {
    if (
      activity.asOfSequence <=
      (this.sequences.get(activity.conversationId) ?? -1)
    )
      return;
    this.observed(activity.conversationId, activity.asOfSequence);
  }
  unavailable(conversationId: string) {
    const failure = Math.max(
      this.failures.get(conversationId) ?? -1,
      this.failures.get(INBOX) ?? -1,
    );
    const success = this.successes.get(conversationId) ?? -1;
    if (failure === -1 && success === -1) return undefined;
    return failure > success;
  }
  constructor(client: QueryClient) {
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
      this.failures.set(INBOX, Math.max(...failedLists.values()));
    client.getQueryCache().subscribe((event) => {
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
        this.failures.set(INBOX, Math.max(...failedLists.values()));
        this.notify();
      } else if (event.action.type === 'success' && !event.action.manual) {
        this.batching = true;
        // Appending history does not re-read the inventory pages already cached.
        if (!pageDirection) {
          failedLists.delete(root);
          if (failedLists.size === 0) this.failures.delete(INBOX);
          else this.failures.set(INBOX, Math.max(...failedLists.values()));
        }
        if (root === 'orchestration-sessions') {
          const sessions = client.getQueryData<OrchestrationSessionSummary[]>(
            event.query.queryKey,
          );
          for (const session of sessions ?? []) {
            if (session.conversationActivity)
              this.observed(
                session.conversationActivity.conversationId,
                session.conversationActivity.asOfSequence,
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
          for (const page of observedPages)
            for (const conversation of page.items) {
              if (conversation.activity)
                this.observed(
                  conversation.id,
                  conversation.activity.asOfSequence,
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
export function useWorkObservation(conversationId?: string) {
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
