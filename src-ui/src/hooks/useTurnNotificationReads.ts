import type { Notification } from '@kontourai/station-contracts/notification';
import {
  LIVE_NOTIFICATION_STATUSES,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import type { TurnNotificationReader } from './orchestration/turnNotificationReads';

/**
 * Mount once, in App: marks a turn-completion record read while the person
 * attends to its chat — on screen in a focused window with recent input
 * (`turnNotificationReads.ts`). Shares the live-notification query the
 * OS-alert hook reads; the marking logic loads on mount, outside the entry
 * chunk.
 */
export function useTurnNotificationReads(): void {
  const { data } = useNotificationsQuery({
    status: LIVE_NOTIFICATION_STATUSES,
  });
  const reader = useRef<TurnNotificationReader | undefined>(undefined);
  const latest = useRef<readonly Notification[]>([]);
  latest.current = data ?? [];
  useEffect(() => {
    let stop: (() => void) | undefined;
    let unmounted = false;
    void import('./orchestration/turnNotificationReads')
      .then((module) => {
        if (unmounted) return;
        const started = module.startTurnNotificationReads();
        reader.current = started;
        stop = started.stop;
        started.update(latest.current);
      })
      .catch(() => {
        /* Read marks are advisory; a failed chunk load changes nothing else. */
      });
    return () => {
      unmounted = true;
      reader.current = undefined;
      stop?.();
    };
  }, []);
  useEffect(() => {
    reader.current?.update(data ?? []);
  }, [data]);
}
