/**
 * The optimistic half of marking a conversation read (#3075), shared by the
 * SDK's mark mutations. Internal: not part of the public barrel.
 */
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { conversationQueries } from './queryFactories';

type InventoryPage = {
  items: ConversationListItem[];
  hasMore: boolean;
  nextCursor?: string;
};

/** The cached inventory pages before an optimistic mark, for rollback. */
export type InventorySnapshot = { snapshot: [readonly unknown[], unknown][] };

/**
 * Applies the server's own rule (`seen = max(seen, version)`, never past the
 * item's version) to the cached inventory, so a row reads as read the moment
 * it is opened rather than after the round trip. A refetch already in flight
 * is cancelled first: answering with the old marker after this update, it
 * would re-bold the row for one round trip. The server's answer, or the
 * refetch that follows, replaces it either way.
 */
export async function markInventoryRead(
  client: QueryClient,
  conversationId: string,
  version: number,
): Promise<InventorySnapshot | undefined> {
  if (!Number.isFinite(version)) return undefined;
  const queryKey = conversationQueries.inventory().queryKey;
  await client.cancelQueries({ queryKey });
  const snapshot = client.getQueriesData({ queryKey });
  client.setQueriesData<InfiniteData<InventoryPage>>({ queryKey }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
              const state = item.readState;
              // An unknown read state stays unknown: the server answers it.
              if (
                item.id !== conversationId ||
                !state ||
                'unavailable' in state
              )
                return item;
              const seenVersion = Math.min(
                Math.max(state.seenVersion, version),
                state.version,
              );
              return {
                ...item,
                readState: {
                  ...state,
                  seenVersion,
                  unread: state.version > seenVersion,
                },
              };
            }),
          })),
        }
      : data,
  );
  return { snapshot };
}

/** Puts back the inventory a refused mark optimistically changed. */
export function restoreInventory(
  client: QueryClient,
  snapshot: InventorySnapshot | undefined,
): void {
  for (const [key, data] of snapshot?.snapshot ?? [])
    client.setQueryData(key, data);
}
