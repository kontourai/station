import type { Notification } from '@kontourai/station-contracts/notification';
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useCallback, useMemo } from 'react';
import {
  type AnswerabilityView,
  notificationAnswerabilityView,
  sessionsByThreadId,
} from '../utils/answerability';

/**
 * The one join both notification surfaces use (station#1780): an approval
 * notification row against the decorated session summaries the app already
 * fetches. The popover and the full notifications page must not disagree
 * about whether a request can still be answered — a suppression on one
 * surface while the other offers Allow/Deny is precisely the divergence
 * ADR 0012's "consumers annotate, they do not silently filter" exists to
 * end, and it is how the stranded card came back one surface over.
 *
 * `useOrchestrationSessionsQuery` is the same shared query key the sessions
 * views already hold, so this adds no request of its own on a warm cache,
 * and the SDK has already run every element through
 * `withNormalizedAnswerability` — a peer older than ADR 0012 sends no
 * decoration and is read as answerable there, not here.
 */
export function useNotificationAnswerability(): (
  notification: Notification,
) => AnswerabilityView {
  const sessionsQuery = useOrchestrationSessionsQuery();
  const sessionsById = useMemo(
    () => sessionsByThreadId(sessionsQuery.data ?? []),
    [sessionsQuery.data],
  );
  // `isSuccess`, not `data !== undefined`: a failed fetch must not be read as
  // "the Station does not list this session". Only a settled, successful read
  // has standing to call a missing thread an honest gap.
  const sessionsLoaded = sessionsQuery.isSuccess;
  return useCallback(
    (notification: Notification) =>
      notificationAnswerabilityView(notification, sessionsById, sessionsLoaded),
    [sessionsById, sessionsLoaded],
  );
}
