import { orchestrationLifecycleLabel } from '../../utils/session-state';

type LiveWorkSession = Parameters<typeof orchestrationLifecycleLabel>[0] & {
  readonly controlMode?: string;
};

/**
 * The sessions Live work counts: running or needing attention, excluding a
 * read-only attachment, classified by the canonical lifecycle label. The phone
 * overflow's Live work row reads it, so "active" has one definition.
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
