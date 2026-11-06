import type { ReactNode } from 'react';
import { LazyBoundary } from '../LazyBoundary';
import { useBrowserActivityScope } from './BrowserActivityContext';
import {
  browserCallSessionId,
  stationBrowserTool,
} from './browser-activity-calls';
import { classifyToolCallRun } from './tool-call-groups';
import { isToolCallAwaitingApproval } from './tool-call-labels';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';

const loadInlineBrowserActivity = () =>
  import('../browser-activity/InlineBrowserActivity').then(
    ({ InlineBrowserActivity }) => ({ default: InlineBrowserActivity }),
  );

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
  active,
  renderCall,
}: {
  run: ToolCallRun<P>;
  active: boolean;
  renderCall: (part: P, index: number) => ReactNode;
}) {
  const scope = useBrowserActivityScope();
  if (!scope || !isBrowserActivityRun(run)) return null;
  const ids = run.calls.map(({ part }) => browserCallSessionId(part));
  const known = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (known.length > 1) return null;
  const group = classifyToolCallRun(run);
  const outcomes = [
    group.failedCount > 0 ? `${group.failedCount} failed` : null,
    group.unresolvedCount > 0
      ? `${group.unresolvedCount} with no result`
      : null,
    group.deniedCount > 0 ? `${group.deniedCount} denied` : null,
    group.cancelledCount > 0 ? `${group.cancelledCount} cancelled` : null,
    group.awaitingApprovalCount > 0
      ? `${group.awaitingApprovalCount} awaiting approval`
      : null,
  ].filter(Boolean);
  const rows = run.calls.map(({ part, index }) => renderCall(part, index));
  const children = active ? (
    rows
  ) : (
    <>
      {run.calls
        .filter(({ part }) => isToolCallAwaitingApproval(part))
        .map(({ part, index }) => renderCall(part, index))}
      {run.calls.some(({ part }) => !isToolCallAwaitingApproval(part)) && (
        <details>
          <summary>Browser actions</summary>
          {run.calls
            .filter(({ part }) => !isToolCallAwaitingApproval(part))
            .map(({ part, index }) => renderCall(part, index))}
        </details>
      )}
    </>
  );
  return (
    <LazyBoundary
      load={loadInlineBrowserActivity}
      componentProps={{
        scope,
        browserSessionId: known[0] ?? null,
        active,
        toolCount: run.calls.length,
        status: [active ? 'In progress' : 'Past activity', ...outcomes].join(
          ' · ',
        ),
        children,
      }}
      pending={rows}
      unavailable={() => rows}
      shareAcrossMounts
    />
  );
}
