import type { ReactNode } from 'react';
import { LazyBoundary } from '../LazyBoundary';
import { useBrowserActivityScope } from './BrowserActivityContext';
import {
  browserCallSessionId,
  stationBrowserTool,
} from './browser-activity-calls';
import type { ToolCallLike, ToolCallRun } from './tool-call-runs';

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
  const rows = run.calls.map(({ part, index }) => renderCall(part, index));
  return (
    <LazyBoundary
      load={loadBrowserActivityContent}
      componentProps={{
        scope,
        browserSessionId: known[0] ?? null,
        run,
        active,
        renderRow: (index: number) => {
          const call = run.calls.find((item) => item.index === index);
          return call ? renderCall(call.part, index) : null;
        },
      }}
      pending={rows}
      unavailable={() => rows}
      shareAcrossMounts
    />
  );
}
