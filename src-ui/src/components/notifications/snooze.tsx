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
import type { RowMenuItem } from './RowMenu';

/** The server Feature Preview every snooze control is gated on. */
export const ATTENTION_SNOOZE_PREVIEW = 'attention-snooze';

export interface SnoozePreset {
  label: string;
  until: Date;
}

/**
 * The choices a snooze offers, in local time, nearest first. Each is a real
 * future instant within the server's 30-day bound, so a preset can never be
 * the one the server refuses; "This evening" only appears while there is
 * still an evening left to wait for.
 */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const at = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const presets: SnoozePreset[] = [
    { label: '1 hour', until: new Date(now.getTime() + 60 * 60 * 1000) },
  ];
  if (now.getHours() < 17)
    presets.push({ label: 'This evening', until: at(0, 18) });
  presets.push({ label: 'Tomorrow morning', until: at(1, 9) });
  // Next Monday, a full week out when today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ label: 'Next week', until: at(toMonday, 9) });
  return presets;
}

/** "6:00 PM", "tomorrow 9:00 AM", "Mon 9:00 AM", or a date — local time. */
export function formatSnoozeUntil(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'later';
  const time = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(date) - day(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7)
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
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
                  onClick: () => unsnoozeAttention.mutate(item.id),
                },
              ],
            ),
        },
      ),
    unsnooze: (item: AttentionItem) => unsnoozeAttention.mutate(item.id),
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
    pending: snoozeAttention.isPending || snoozeStored.isPending,
  };
}

export type InboxSnooze = ReturnType<typeof useInboxSnooze>;

/** A row's snooze choices, as items for its ⋯ menu. */
export function snoozeMenuItems(
  onSnooze: (until: Date) => void,
  disabled = false,
): RowMenuItem[] {
  return snoozePresets().map((preset) => ({
    id: `snooze-${preset.label}`,
    group: 'Snooze until',
    label: preset.label,
    hint: formatSnoozeUntil(preset.until.toISOString()),
    disabled,
    onSelect: () => onSnooze(preset.until),
  }));
}
