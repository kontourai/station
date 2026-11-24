import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type AttentionItem,
  useFeaturePreviewsQuery,
  useSnoozeAttentionItemMutation,
  useSnoozeNotificationMutation,
  useUnsnoozeAttentionItemMutation,
} from '@kontourai/station-sdk';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { toastStore } from '../../contexts/ToastContext';
import { errorText } from '../../utils/errorText';
import { wakeTime } from '../../utils/relativeTime';
import { snoozeChoices } from '../inbox-row/snooze-presets';
import type { RowMenuItem } from './RowMenu';

/** The server Feature Preview every snooze control is gated on. */
export const ATTENTION_SNOOZE_PREVIEW = 'attention-snooze';

/** When a snooze ends, in the snooze list's own form (`wakeTime`). */
export function formatSnoozeUntil(iso: string, now = new Date()): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 'later' : wakeTime(at, now.getTime());
}

/**
 * A stored notification hidden by a snooze (or not yet delivered): status
 * `pending` with a delivery time still ahead. It is not activity yet, so the
 * activity lists leave it out and the page's Snoozed section lists it.
 */
export function isDeferredNotification(
  notification: Notification,
  now = Date.now(),
): boolean {
  if (notification.status !== 'pending' || !notification.scheduledAt)
    return false;
  const at = Date.parse(notification.scheduledAt);
  return Number.isFinite(at) && at > now;
}

/**
 * Everything a list needs to offer snooze: whether the preview is on, and the
 * two snooze paths — attention items through the attention snooze, stored
 * notifications through their own. Each success says when the row comes
 * back; an attention snooze offers Undo, which removes the snooze.
 */
export function useInboxSnooze() {
  const { apiBase } = useApiBase();
  const previews = useFeaturePreviewsQuery();
  const enabled = Boolean(
    previews.data?.some(
      (preview) => preview.id === ATTENTION_SNOOZE_PREVIEW && preview.enabled,
    ),
  );
  const snoozeAttention = useSnoozeAttentionItemMutation(apiBase);
  const unsnoozeAttention = useUnsnoozeAttentionItemMutation(apiBase);
  const snoozeStored = useSnoozeNotificationMutation();
  const failed = (error: unknown) =>
    toastStore.show(
      `Couldn't snooze: ${errorText(error)}`,
      undefined,
      6000,
      undefined,
      undefined,
      'error',
    );
  return {
    enabled,
    attention: (item: AttentionItem, until: Date) =>
      snoozeAttention.mutate(
        { itemId: item.id, until: until.toISOString() },
        {
          onError: failed,
          onSuccess: (result) =>
            toastStore.show(
              `Snoozed until ${formatSnoozeUntil(result?.snoozedUntil ?? until.toISOString())}`,
              undefined,
              6000,
              [
                {
                  label: 'Undo',
                  onClick: () => unsnoozeAttention.mutateAsync(item.id),
                },
              ],
            ),
        },
      ),
    unsnooze: (item: AttentionItem) =>
      unsnoozeAttention.mutate(item.id, {
        onError: (error) =>
          toastStore.show(
            `Couldn't wake it: ${errorText(error)}`,
            undefined,
            6000,
            undefined,
            undefined,
            'error',
          ),
      }),
    unsnoozePending: unsnoozeAttention.isPending,
    unsnoozingItemId: unsnoozeAttention.isPending
      ? unsnoozeAttention.variables
      : undefined,
    notification: (notification: Notification, until: Date) =>
      snoozeStored.mutate(
        { id: notification.id, until: until.toISOString() },
        {
          onError: failed,
          onSuccess: () =>
            toastStore.show(
              `Snoozed until ${formatSnoozeUntil(until.toISOString())}`,
            ),
        },
      ),
    pending:
      snoozeAttention.isPending ||
      snoozeStored.isPending ||
      unsnoozeAttention.isPending,
  };
}

/** A row's snooze choices, as items for its ⋯ menu. */
export function snoozeMenuItems(
  onSnooze: (until: Date) => void,
  disabled = false,
): RowMenuItem[] {
  return snoozeChoices(Date.now()).map((choice) => ({
    id: `snooze-${choice.label}`,
    group: 'Snooze until',
    label: choice.label,
    hint: choice.hint,
    disabled,
    onSelect: () => onSnooze(new Date(choice.wakeAt)),
  }));
}
