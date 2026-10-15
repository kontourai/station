import type {
  ConversationListItem,
  ConversationTurnActivity,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext, useSyncExternalStore } from 'react';

// Query clients belong to verified authorities. Never persist these observations
// or share them with another principal using the same Station endpoint.
const authorities = new WeakMap<QueryClient, Map<string, WorkObservation>>();
const INBOX = Symbol('inbox');
type Scope = string | typeof INBOX;

class WorkObservation {
  private revision = 0;
  private clock = 0;
  private sequences = new Map<string, number>();
  private failures = new Map<Scope, number>();
  private successes = new Map<Scope, number>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  begin = () => ++this.clock;
  private notify() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
  failed(conversationId: string, started = this.begin()) {
    // A stream observation received while this request was pending wins.
    if ((this.successes.get(conversationId) ?? -1) > started) return;
    this.failures.set(conversationId, ++this.clock);
    this.notify();
  }
  observed(conversationId: string, sequence?: number) {
    if (sequence !== undefined)
      this.sequences.set(
        conversationId,
        Math.max(sequence, this.sequences.get(conversationId) ?? -1),
      );
    this.failures.delete(conversationId);
    this.successes.set(conversationId, ++this.clock);
    this.notify();
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
      if (event.action.type === 'fetch') startedLists.set(root, this.begin());
      if (event.action.type === 'error') {
        failedLists.set(root, startedLists.get(root) ?? this.begin());
        this.failures.set(INBOX, Math.max(...failedLists.values()));
        this.notify();
      } else if (event.action.type === 'success' && !event.action.manual) {
        failedLists.delete(root);
        if (failedLists.size === 0) this.failures.delete(INBOX);
        else this.failures.set(INBOX, Math.max(...failedLists.values()));
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
          for (const page of inventory?.pages ?? [])
            for (const conversation of page.items) {
              if (conversation.activity)
                this.observed(
                  conversation.id,
                  conversation.activity.asOfSequence,
                );
            }
        }
        this.notify();
      }
    });
  }
}

export function workObservation(client: QueryClient, apiBase: string) {
  let stations = authorities.get(client);
  if (!stations) {
    stations = new Map();
    authorities.set(client, stations);
  }
  let observation = stations.get(apiBase);
  if (!observation) {
    observation = new WorkObservation(client);
    stations.set(apiBase, observation);
  }
  return observation;
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => 0;
export function useWorkObservation(apiBase: string) {
  const client = useContext(QueryClientContext);
  const observation = client ? workObservation(client, apiBase) : undefined;
  useSyncExternalStore(
    observation?.subscribe ?? noopSubscribe,
    observation?.snapshot ?? emptySnapshot,
    observation?.snapshot ?? emptySnapshot,
  );
  return observation;
}
