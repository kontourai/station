import { orchestrationLifecycleLabel } from '../../utils/session-state';

type LiveWorkSession = Parameters<typeof orchestrationLifecycleLabel>[0] & {
  readonly controlMode?: string;
};

/**
 * The sessions Live work counts: running or needing attention, excluding a
 * read-only attachment, classified by the canonical lifecycle label. Shared by
 * the footer's presence tray and the phone overflow's Live work row, so the
 * two cannot disagree about what "active" means.
 */
export function activeLiveWorkSessions<T extends LiveWorkSession>(
  sessions: readonly T[],
): { session: T; state: 'Running' | 'Needs attention' }[] {
  return sessions.flatMap((session) => {
    if (session.controlMode === 'read-only-attached') return [];
    const state = orchestrationLifecycleLabel(session);
    return state === 'Running' || state === 'Needs attention'
      ? [{ session, state }]
      : [];
  });
}
