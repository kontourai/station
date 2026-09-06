import {
  createDirectAnswerBasisMcpPaneOccurrence,
  createTaskAnswerBasisMcpPaneOccurrence,
  createWholeTaskBasisMcpPaneOccurrence,
  type WorkspaceBasisMcpPaneOccurrence,
} from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import { isCanonicalBasisWorkspacePaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { lazy, Suspense, useState } from 'react';
import { SkeletonBlock } from '../components/state';
import type { BasisPaneHostScope } from './BasisPaneLauncher';
import type { BuiltinWorkspacePaneProps } from './builtinWorkspacePaneRegistry';
import { ConnectedStationBasisPane } from './ConnectedStationBasisPane';
import { useWorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import { describeWorkspacePaneOpenRefusal } from './workspacePaneHostOpenOutcome';

const LazyConnectedSessionInventory = lazy(() =>
  import('./ConnectedSessionInventory').then(
    ({ ConnectedSessionInventory }) => ({
      default: ConnectedSessionInventory,
    }),
  ),
);

export function BasisWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const host = useWorkspacePaneHostOpenAction();
  /**
   * The sentence for the reason the host gave, not one covering every reason
   * (#1596). "cannot open here" was wrong for `no-lease`, which clears on its
   * own when the other tab lets go.
   */
  const [portableError, setPortableError] = useState<string | null>(null);
  if (!isCanonicalBasisWorkspacePaneInstance(instance))
    return <section role="alert">Basis pane identity is unavailable.</section>;
  const context = instance.boundContext;
  let scope: BasisPaneHostScope | null = null;
  let portable: WorkspaceBasisMcpPaneOccurrence | null = null;
  if (context?.projectId && context.sessionId && context.turnId) {
    scope = {
      kind: 'direct-answer',
      sessionId: context.sessionId,
      turnId: context.turnId,
    };
    portable = createDirectAnswerBasisMcpPaneOccurrence(
      context.projectId,
      context.sessionId,
      context.turnId,
    );
  } else if (
    context?.projectId &&
    context.taskId &&
    context.answerReferenceId
  ) {
    scope = {
      kind: 'task-answer',
      taskId: context.taskId,
      answerReferenceId: context.answerReferenceId,
    };
    portable = createTaskAnswerBasisMcpPaneOccurrence(
      context.projectId,
      context.taskId,
      context.answerReferenceId,
    );
  } else if (context?.taskId) {
    scope = { kind: 'whole-task', taskId: context.taskId };
    portable = context.projectId
      ? createWholeTaskBasisMcpPaneOccurrence(context.projectId, context.taskId)
      : null;
  } else if (context?.sessionId) {
    scope = { kind: 'session-inventory', sessionId: context.sessionId };
  }
  if (!scope)
    return <section role="alert">Basis pane identity is unavailable.</section>;
  return (
    <>
      {portable ? (
        <div className="basis-pane-portable-action">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => {
              // No host at all is not a refusal to report: the button belongs
              // to a pane already mounted inside one, so `host` is null only
              // while this pane is itself unmounting.
              const outcome = host?.open(portable.instance);
              setPortableError(
                !outcome || outcome.ok
                  ? null
                  : describeWorkspacePaneOpenRefusal(outcome.reason),
              );
            }}
          >
            Open portable MCP App
          </button>
          {portableError ? <span role="alert">{portableError}</span> : null}
        </div>
      ) : null}
      {scope.kind === 'session-inventory' ? (
        <Suspense
          fallback={
            <SkeletonBlock count={3} label="Loading Session inventory" />
          }
        >
          <LazyConnectedSessionInventory
            sessionId={scope.sessionId}
            currentProjectId={context?.projectId}
          />
        </Suspense>
      ) : (
        <ConnectedStationBasisPane
          scope={scope}
          currentProjectId={context?.projectId}
        />
      )}
    </>
  );
}
