import {
  useAttentionQuery,
  useClearNotificationActivityMutation,
  useDismissNotificationMutation,
  useNotificationsQuery,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';
import { suppressMirroredNotifications } from '../utils/attention';
import { sortNotifications } from '../utils/notifications';

export function useAttentionInbox() {
  const { apiBase } = useApiBase();
  const attentionQuery = useAttentionQuery(apiBase);
  const notificationsQuery = useNotificationsQuery();
  const clearMutation = useClearNotificationActivityMutation();
  const dismissMutation = useDismissNotificationMutation();
  const queryClient = useQueryClient();
  const items = attentionQuery.data?.items ?? [];
  // #765 D5 / archive#1780: an approval or a pending pairing request projects
  // as an attention item and keeps its stored notification; the activity list
  // shows the decided fact once, not twice. Shared with the bell popover.
  const notifications = suppressMirroredNotifications(
    sortNotifications(notificationsQuery.data ?? []),
    items,
  );

  return {
    attentionQuery,
    clear: () => clearMutation.mutate(undefined),
    dismiss: (id: string) => dismissMutation.mutate(id),
    items,
    /**
     * archive#3214: the number the header bell badge renders, read straight
     * off the projection rather than recomputed from `items`. `HeaderActions`
     * passes this same field to the notifications surface badge
     * (`HeaderActions.tsx` → `destination-registry.ts`'s `attentionCount`) from
     * the same `['attention', apiBase]` cache entry, so any consumer of this
     * hook shows the badge's number by construction — not because a local
     * `!acknowledgedAt` filter happens to agree with the server's.
     */
    pendingCount: attentionQuery.data?.pendingCount ?? 0,
    /**
     * #2064 review (c): sources this attention read could not fully cover.
     * Rendered as a notice beside the list, because a project whose review
     * sessions Station could not read contributes zero items and would
     * otherwise be indistinguishable from a project with nothing pending.
     * Read off the SAME response the items and the count came from.
     */
    unavailableSources: attentionQuery.data?.unavailableSources ?? [],
    notifications,
    notificationsQuery,
    retry: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['attention', apiBase] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
      ]),
  };
}

export type AttentionInboxController = ReturnType<typeof useAttentionInbox>;
