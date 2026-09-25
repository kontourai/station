import type { Notification } from '@kontourai/station-contracts/notification';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { toastStore } from '../contexts/ToastContext';
import {
  activateNotification,
  agentAttributionLabel,
  notificationOpenTarget,
} from './notification-activation';

/**
 * The in-app toast for a delivered enveloped notification (#2587): the same
 * text as any other delivery, plus who sent it and an Open that goes to its
 * target and records the read. Loaded lazily so the envelope reader stays
 * out of the entry chunk; an invalid envelope falls back to the plain toast.
 *
 * Mute is not offered here: the toast handler runs outside any connection
 * context, and the inbox rows (which have one) carry it.
 */
export function showEnvelopeNotificationToast(
  data: Record<string, unknown>,
  duration: number,
): void {
  const title = data.title as string;
  const body = data.body as string | undefined;
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const notification = data as unknown as Pick<Notification, 'id' | 'metadata'>;
  const envelope =
    typeof data.id === 'string'
      ? readNotificationEnvelope(notification)
      : undefined;
  const source = envelope?.source.kind === 'agent' ? envelope.source : null;
  toastStore.show(
    title + (body ? ` — ${body}` : ''),
    undefined,
    duration,
    envelope && notificationOpenTarget(envelope)
      ? [
          {
            label: 'Open',
            variant: 'primary',
            onClick: () => void activateNotification(notification),
          },
        ]
      : undefined,
    source ? { ...metadata, detail: agentAttributionLabel(source) } : metadata,
  );
}
