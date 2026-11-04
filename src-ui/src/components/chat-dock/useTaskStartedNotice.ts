import type { DelegatedTaskHandle } from '@kontourai/station-sdk';
import { useCallback } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { useShowSurface } from '../../contexts/useShowSurface';

/**
 * The confirmation a remote start ends with. The start composer (Home's and
 * the dock's) closes once the task is accepted, so this toast is what names
 * the Station it went to, with the same "Open task" route into Activity as
 * the dock's own delegation toast.
 */
export function useTaskStartedNotice(beforeNavigate: () => void) {
  const { showToast } = useToast();
  const showSurface = useShowSurface();
  return useCallback(
    (task: Pick<DelegatedTaskHandle, 'sessionId'>, stationName: string) => {
      showToast(`Task started on ${stationName}.`, task.sessionId, 10_000, [
        {
          label: 'Open task',
          variant: 'primary',
          onClick: () => {
            beforeNavigate();
            showSurface('activity', { session: task.sessionId });
          },
        },
      ]);
    },
    [beforeNavigate, showSurface, showToast],
  );
}
