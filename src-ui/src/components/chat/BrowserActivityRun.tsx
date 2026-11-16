import { type ReactNode, useContext } from 'react';
import { LazyBoundary } from '../LazyBoundary';
import { useBrowserActivityScope } from './BrowserActivityContext';
import {
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
  const ownedRows = rows.map((row, index) =>
    group.owners.get(run.calls[index]!.part.toolCallId!) === turn.browserOwner
      ? row
      : null,
  );
  const last =
    group.owner === turn.browserOwner
      ? run.calls.findIndex(({ part }) => part.toolCallId === group.lastId)
      : -1;
  if (last < 0) return <>{ownedRows}</>;
  const item = run.calls[last]!;
  const ownRun = { ...run, calls: [item] };
  return (
    <>
      {ownedRows.slice(0, last)}
      <LazyBoundary
        load={loadBrowserActivityContent}
        componentProps={{
          scope,
          browserSessionId: session ?? null,
          run: ownRun,
          summaryCalls: group.calls,
          active: group.active,
          renderRow: () => renderCall(item.part, item.index),
        }}
        pending={rows[last]}
        unavailable={() => rows[last]}
        shareAcrossMounts
      />
      {ownedRows.slice(last + 1)}
    </>
  );
}
