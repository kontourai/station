import { AnswerBasisAffordance } from '@kontourai/station-basis-pane/answer-basis-affordance';
import { createSessionInventoryBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { useProjectQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';
import { openSessionInventoryOccurrence } from '../chat-dock/sessionInventoryOccurrence';

export function ConnectedAnswerBasisAffordance({
  projectSlug,
  chatStoreId,
  sessionId,
  turnId,
}: {
  projectSlug?: string;
  chatStoreId?: string;
  sessionId: string;
  turnId: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<HTMLElement | null>(
    null,
  );
  const authority = useHostRequestAuthorityScope();
  const projectQuery = useProjectQuery(projectSlug ?? '', {
    enabled: enabled && Boolean(projectSlug),
  }) as {
    data?: { id?: string };
    isFetching?: boolean;
    isLoading?: boolean;
  };
  const { data: project } = projectQuery;
  const projectId =
    typeof project?.id === 'string' && project.id.length > 0
      ? project.id
      : undefined;
  const { openBasis, fallback } = useBasisPaneLauncher();
  const launch = useCallback(
    (trigger: HTMLElement, resolvedProjectId?: string) => {
      const admitted = openSessionInventoryOccurrence({
        authorityKey: authority?.authorityKey,
        requestedScope: { kind: 'current-answer', sessionId, turnId },
        activeSessionId: chatStoreId ?? sessionId,
        projectId: resolvedProjectId,
        executionRead: 'present',
        trigger,
      });
      if (!admitted)
        openBasis(
          resolvedProjectId
            ? createSessionInventoryBasisPaneInstance(
                resolvedProjectId,
                sessionId,
              )
            : null,
          {
            kind: 'session-inventory',
            sessionId,
            initialScope: { kind: 'current-answer', sessionId, turnId },
          },
          trigger,
        );
    },
    [authority?.authorityKey, chatStoreId, openBasis, sessionId, turnId],
  );
  useEffect(() => {
    if (!pendingTrigger || !enabled) return;
    // The Project lookup is intentionally click-initiated. Once that lookup
    // settles without a canonical Project, launch the local full fallback
    // without asking the person to press Basis a second time.
    if (
      projectSlug &&
      !projectId &&
      (projectQuery.isLoading || projectQuery.isFetching)
    )
      return;
    launch(pendingTrigger, projectId);
    setPendingTrigger(null);
  }, [
    enabled,
    launch,
    pendingTrigger,
    projectId,
    projectQuery.isFetching,
    projectQuery.isLoading,
    projectSlug,
  ]);
  return (
    <>
      <span>
        <AnswerBasisAffordance
          sessionId={sessionId}
          turnId={turnId}
          enabled
          onOpen={(trigger) => {
            setEnabled(true);
            if (projectId || !projectSlug) launch(trigger, projectId);
            else setPendingTrigger(trigger);
          }}
        />
      </span>
      {fallback}
    </>
  );
}
