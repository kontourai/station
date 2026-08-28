import {
  useAttentionQuery,
  useClearNotificationActivityMutation,
  useDismissNotificationMutation,
  useNotificationsQuery,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';
import { sortNotifications } from '../utils/notifications';

export function useAttentionInbox() {
  const { apiBase } = useApiBase();
  const attentionQuery = useAttentionQuery(apiBase);
  const notificationsQuery = useNotificationsQuery();
  const clearMutation = useClearNotificationActivityMutation();
  const dismissMutation = useDismissNotificationMutation();
  const queryClient = useQueryClient();
  const items = attentionQuery.data?.items ?? [];
  const projectedNotificationIds = new Set(
    items.flatMap((item) =>
      item.kind === 'approval' ? [item.source.notificationId] : [],
    ),
  );
  const notifications = sortNotifications(notificationsQuery.data ?? []).filter(
    (notification) => !projectedNotificationIds.has(notification.id),
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
     * (`HeaderActions.tsx` → `surface-registry.ts`'s `attentionCount`) from
     * the same `['attention', apiBase]` cache entry, so any consumer of this
     * hook shows the badge's number by construction — not because a local
     * `!acknowledgedAt` filter happens to agree with the server's.
     */
    pendingCount: attentionQuery.data?.pendingCount ?? 0,
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
