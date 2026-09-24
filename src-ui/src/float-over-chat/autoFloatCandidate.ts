import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { browserFloatSourceKey } from './floatSource';

/**
 * The newest live session whose last driver (`activity.lastDriver`, over
 * its whole history — not the recent-driving window the pill shows) is an
 * agent, opened from THIS
 * conversation (its `threadId`) under THIS viewer's own principal (D7: one
 * profile per (Project, principal); another principal's session is never
 * floated to this viewer even where the list shows it), among those not
 * excluded (dismissed here, or already shown in a pane). A session with no
 * `threadId` belongs to no conversation and never auto-floats.
 */
export function pickAutoFloatCandidate(
  sessions: readonly BrowserSessionView[],
  scope: {
    projectSlug: string;
    threadIds: readonly string[];
    principalKey: string;
  },
  excluded: (sourceKey: string) => boolean,
): BrowserSessionView | null {
  let best: BrowserSessionView | null = null;
  for (const session of sessions) {
    if (
      session.projectSlug !== scope.projectSlug ||
      session.threadId === undefined ||
      !scope.threadIds.includes(session.threadId) ||
      session.principalKey !== scope.principalKey ||
      session.state !== 'live' ||
      !session.surfaceId ||
      session.activity?.lastDriver?.kind !== 'agent' ||
      excluded(browserFloatSourceKey(session.browserSessionId))
    )
      continue;
    if (!best || session.updatedAt > best.updatedAt) best = session;
  }
  return best;
}
