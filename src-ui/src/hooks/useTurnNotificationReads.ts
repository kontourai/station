import type { Notification } from '@kontourai/station-contracts/notification';
import {
  LIVE_NOTIFICATION_STATUSES,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import { startOpenedNotificationCapture } from './orchestration/openedNotificationRead';
import type { TurnNotificationReader } from './orchestration/turnNotificationReads';

/**
 * Mount once, in App: marks a turn-completion record read while the person
 * attends to its chat — on screen in a focused window with recent input
 * (`turnNotificationReads.ts`). Shares the live-notification query the
 * OS-alert hook reads; the marking logic loads on mount, outside the entry
 * chunk. An opened alert's record id is captured (and dropped from the URL)
 * on mount, before that chunk loads.
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
    // An opened alert's record id is taken off the URL now, on mount, and
    // held until the reader below has loaded.
    const opened: string[] = [];
    let markOpened: ((id: string) => void) | undefined;
    const stopCapture = startOpenedNotificationCapture((id) => {
      if (markOpened) markOpened(id);
      else opened.push(id);
    });
    void import('./orchestration/turnNotificationReads')
      .then((module) => {
        if (unmounted) return;
        const started = module.startTurnNotificationReads();
        reader.current = started;
        stop = started.stop;
        markOpened = started.markOpened;
        for (const id of opened.splice(0)) started.markOpened(id);
        started.update(latest.current);
      })
      .catch(() => {
        /* Read marks are advisory; a failed chunk load changes nothing else. */
      });
    return () => {
      unmounted = true;
      reader.current = undefined;
      stopCapture();
      stop?.();
    };
  }, []);
  useEffect(() => {
    reader.current?.update(data ?? []);
  }, [data]);
}
