import { type ReactNode, useMemo } from 'react';
import type { BrowserActivityScope } from '../chat/BrowserActivityContext';
import { classifyToolCallRun } from '../chat/tool-call-groups';
import { isToolCallAwaitingApproval } from '../chat/tool-call-labels';
import type { ToolCallLike, ToolCallRun } from '../chat/tool-call-runs';
import { useRunWithObservedRunningCalls } from '../chat/useObservedRunningToolCalls';
import { InlineBrowserActivity } from './InlineBrowserActivity';

export default function BrowserActivityContent({
  scope,
  browserSessionId,
  run,
  active,
  summaryCalls,
  renderRow,
}: {
  scope: BrowserActivityScope;
  browserSessionId: string | null;
  run: ToolCallRun<ToolCallLike>;
  active: boolean;
  summaryCalls: ToolCallLike[];
  renderRow: (index: number) => ReactNode;
}) {
  const summaryRun = useMemo(
    () => ({
      ...run,
      calls: summaryCalls.map((part, index) => ({ part, index })),
    }),
    [run, summaryCalls],
  );
  // A call still running in the background is counted as running, not as
  // "no result", exactly as the tool batch counts it.
  const group = classifyToolCallRun(useRunWithObservedRunningCalls(summaryRun));
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
  const children = !run.calls.length ? null : active ? (
    run.calls.map(({ index }) => renderRow(index))
  ) : (
    <>
      {run.calls
        .filter(({ part }) => isToolCallAwaitingApproval(part))
        .map(({ index }) => renderRow(index))}
      {run.calls.some(({ part }) => !isToolCallAwaitingApproval(part)) && (
        <details>
          <summary>Browser actions</summary>
          {run.calls
            .filter(({ part }) => !isToolCallAwaitingApproval(part))
            .map(({ index }) => renderRow(index))}
        </details>
      )}
    </>
  );
  return (
    <InlineBrowserActivity
      scope={scope}
      browserSessionId={browserSessionId}
      active={active}
      toolCount={summaryCalls.length}
      steps={summaryCalls}
      status={outcomes.join(' · ')}
    >
      {children}
    </InlineBrowserActivity>
  );
}
