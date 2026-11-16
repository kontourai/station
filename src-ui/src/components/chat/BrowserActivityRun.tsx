import { type ReactNode, useContext } from 'react';
import { LazyBoundary } from '../LazyBoundary';
import { useBrowserActivityScope } from './BrowserActivityContext';
import {
  browserCallIdentity,
  browserTurnKey,
  useBrowserTurnActivities,
} from './BrowserTurnActivity';
import {
  browserCallSessionId,
  stationBrowserTool,
} from './browser-activity-calls';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';
import { TranscriptTurnContext } from './transcript-child-work';

const loadBrowserActivityContent = () =>
  import('../browser-activity/BrowserActivityContent');

export function isBrowserActivityRun<P extends ToolCallLike>(
  run: ToolCallRun<P>,
): boolean {
  if (
    run.interludes?.length ||
    !run.calls.length ||
    run.calls.some(({ part }) => !stationBrowserTool(part))
  )
    return false;
  const ids = run.calls.map(({ part }) => browserCallSessionId(part));
  return new Set(ids).size <= 1;
}

/** Render a browser-only run as one activity; mixed runs retain their normal renderer. */
export function BrowserActivityRun<P extends ToolCallLike>({
  run,
  renderCall,
}: {
  run: ToolCallRun<P>;
  renderCall: (part: P, index: number) => ReactNode;
}) {
  const scope = useBrowserActivityScope();
  const activities = useBrowserTurnActivities();
  const turn = useContext(TranscriptTurnContext);
  const rows = run.calls.map(({ part, index }) => renderCall(part, index));
  if (
    !scope ||
    !activities ||
    !turn?.threadId ||
    !turn.turnId ||
    !isBrowserActivityRun(run)
  )
    return <>{rows}</>;
  const session = browserCallSessionId(run.calls[0]!.part);
  const group =
    session &&
    activities.get(browserTurnKey(turn.threadId, turn.turnId, session));
  if (
    !group ||
    !turn.browserOwner ||
    run.calls.some(({ part }) => !part.toolCallId)
  )
    return <>{rows}</>;
  const ownedRows = rows.map((row, index) => {
    const identity = browserCallIdentity(run.calls[index]!.part);
    return group.ambiguous ||
      !identity ||
      group.owners.get(identity) === turn.browserOwner
      ? row
      : null;
  });
  if (group.active) return <>{ownedRows}</>;
  const first =
    group.owner === turn.browserOwner
      ? run.calls.findIndex(
          ({ part }) => browserCallIdentity(part) === group.firstId,
        )
      : -1;
  if (first < 0) return <>{ownedRows}</>;
  return (
    <>
      {ownedRows.slice(0, first + 1)}
      <LazyBoundary
        load={loadBrowserActivityContent}
        componentProps={{
          scope,
          browserSessionId: session ?? null,
          run: { type: 'tool-call-run' as const, key: run.key, calls: [] },
          summaryCalls: group.calls,
          active: false,
          renderRow: () => null,
        }}
        pending={null}
        unavailable={() => null}
        shareAcrossMounts
      />
      {ownedRows.slice(first + 1)}
    </>
  );
}
