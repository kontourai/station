import { CONVERSATION_STORE_ADAPTER_ID } from './adapters/conversation-store.js';
import type { KnowledgeStoreProvider } from './knowledge-store-provider.js';

/**
 * How a read of a root's projection (Neo4j graph, index partition) may treat
 * its data, decided POSITIVELY:
 *
 * - `shared`: a registered root whose adapter is a registered, non-session
 *   adapter. Its records are not per-caller, so its projection passes
 *   through.
 * - `session-backed`: a registered conversation-store root. Every node or
 *   hit is re-read as the caller before it is shown.
 * - `unavailable`: anything else (an unregistered root, whose projection may
 *   still exist after a deregistration, or a root whose adapter is not
 *   registered). Nothing can decide per-caller readability, so a read fails
 *   closed: it returns nothing.
 */
export type KnowledgeRootReadKind = 'shared' | 'session-backed' | 'unavailable';

export async function knowledgeRootReadKind(
  store: Pick<KnowledgeStoreProvider, 'getRoot' | 'listAdapters'>,
  rootId: string,
): Promise<KnowledgeRootReadKind> {
  const root = await store.getRoot(rootId);
  if (!root) return 'unavailable';
  // Adapter registration first: a stored conversation-store root whose
  // adapter was never registered (a hosted tenant's boot skips it) cannot
  // re-read anything as the caller either.
  if (!store.listAdapters().some((adapter) => adapter.id === root.adapterId))
    return 'unavailable';
  return root.adapterId === CONVERSATION_STORE_ADAPTER_ID
    ? 'session-backed'
    : 'shared';
}

export const KNOWLEDGE_ROOT_NOT_FOUND_ERROR = 'Knowledge root not found';

export const RUNTIME_ROOT_DELETE_FORBIDDEN_ERROR =
  'The built-in conversation root is registered by Station and cannot be removed';

export const SESSION_BACKED_BUILD_FORBIDDEN_ERROR =
  "Only this Station's operator may build a conversation-backed knowledge root's index or graph";

/** A non-operator's graph sync of any root that is not `shared`. */
export const UNSHARED_GRAPH_SYNC_FORBIDDEN_ERROR =
  "Only this Station's operator may sync the graph of a knowledge root that is conversation-backed or unavailable";
