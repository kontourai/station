import { CONVERSATION_STORE_ADAPTER_ID } from './adapters/conversation-store.js';
import type { KnowledgeStoreProvider } from './knowledge-store-provider.js';

/**
 * Whether a knowledge root is backed by Station sessions (the
 * conversation-store adapter), whatever its id. Such a root's records are
 * per-caller: every path that returns its data must re-read each record as
 * the caller, and only the local operator may (re)build its shared index or
 * graph projection. Decided by the root's ADAPTER, never by its id: a root id
 * says nothing about what backs it.
 */
export async function isSessionBackedRoot(
  store: Pick<KnowledgeStoreProvider, 'getRoot'>,
  rootId: string,
): Promise<boolean> {
  return (
    (await store.getRoot(rootId))?.adapterId === CONVERSATION_STORE_ADAPTER_ID
  );
}

export const SESSION_BACKED_BUILD_FORBIDDEN_ERROR =
  "Only this Station's operator may build a conversation-backed knowledge root's index or graph";
