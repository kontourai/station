import type {
  Notification,
  NotificationSource,
} from '@kontourai/station-contracts/notification';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  activateNotification,
  agentAttributionLabel,
  notificationOpenTarget,
} from '../../lib/notification-activation';
import {
  createNotificationPreferencesClient,
  type NotificationMuteTarget,
} from '../../lib/notification-preferences-client';

/**
 * Inbox row additions for an enveloped notification (#2587): who sent it,
 * an Open that goes to its target and records the read, and — for agent
 * notifications — Mute. Renders nothing for a legacy record.
 *
 * Mute is feature-detected: it appears only once the preferences route has
 * answered (#2586). On a Station without it the buttons are absent rather
 * than offering an action that cannot work.
 */
export function NotificationEnvelopeControls({
  notification,
  detailClassName,
  actionsClassName,
  actionClassName,
}: {
  notification: Pick<Notification, 'id' | 'metadata'>;
  detailClassName: string;
  actionsClassName: string;
  actionClassName: string;
}) {
  const envelope = readNotificationEnvelope(notification);
  if (!envelope) return null;
  const source = envelope.source.kind === 'agent' ? envelope.source : null;
  const canOpen = notificationOpenTarget(envelope) !== undefined;
  if (!source && !canOpen) return null;
  return (
    <div data-testid="notification-envelope-controls">
      {source && (
        <div className={detailClassName} data-testid="notification-attribution">
          {agentAttributionLabel(source)}
        </div>
      )}
      <div className={actionsClassName}>
        {canOpen && (
          <button
            type="button"
            className={actionClassName}
            onClick={() => void activateNotification(notification)}
          >
            Open
          </button>
        )}
        {source && (
          <MuteActions source={source} actionClassName={actionClassName} />
        )}
      </div>
    </div>
  );
}

function MuteActions({
  source,
  actionClassName,
}: {
  source: Extract<NotificationSource, { kind: 'agent' }>;
  actionClassName: string;
}) {
  const { apiBase } = useApiBase();
  const queryClient = useQueryClient();
  const client = useMemo(
    () => createNotificationPreferencesClient({ apiBase }),
    [apiBase],
  );
  const queryKey = ['notification-preferences', apiBase];
  const preferences = useQuery({
    queryKey,
    queryFn: () => client.read(),
    staleTime: 60_000,
  });
  const mute = useMutation({
    mutationFn: (target: NotificationMuteTarget) => client.mute(target),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  if (preferences.data !== 'ok') return null;
  const targets: Array<{ label: string; target: NotificationMuteTarget }> = [];
  if (source.agent) {
    targets.push({
      label: 'Mute this agent',
      target: { kind: 'agent', agent: source.agent },
    });
  }
  if (source.projectId) {
    targets.push({
      label: 'Mute this project',
      target: { kind: 'project', projectId: source.projectId },
    });
  }
  return (
    <>
      {targets.map(({ label, target }) => (
        <button
          key={label}
          type="button"
          className={actionClassName}
          disabled={mute.isPending}
          onClick={() => mute.mutate(target)}
        >
          {label}
        </button>
      ))}
      {mute.data && (
        <span role="status">
          {mute.data === 'muted' ? 'Muted' : 'Could not mute'}
        </span>
      )}
    </>
  );
}
