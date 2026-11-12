import type { ReactNode } from 'react';
import type { BrowserActivityScope } from '../chat/BrowserActivityContext';
import { classifyToolCallRun } from '../chat/tool-call-groups';
import { isToolCallAwaitingApproval } from '../chat/tool-call-labels';
import type { ToolCallLike, ToolCallRun } from '../chat/tool-call-runs';
import { InlineBrowserActivity } from './InlineBrowserActivity';

export default function BrowserActivityContent({
  scope,
  browserSessionId,
  run,
  active,
  renderRow,
}: {
  scope: BrowserActivityScope;
  browserSessionId: string | null;
  run: ToolCallRun<ToolCallLike>;
  active: boolean;
  renderRow: (index: number) => ReactNode;
}) {
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
  const children = active ? (
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
      toolCount={run.calls.length}
      status={[active ? 'In progress' : 'Past activity', ...outcomes].join(
        ' · ',
      )}
    >
      {children}
    </InlineBrowserActivity>
  );
}
