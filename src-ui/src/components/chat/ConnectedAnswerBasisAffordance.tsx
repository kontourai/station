import { createSessionInventoryBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { useCallback, useEffect, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectQuery } from '../../contexts/ProjectsContext';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';
import { openSessionInventoryOccurrence } from '../chat-dock/sessionInventoryOccurrence';

/**
 * The answer's Basis chip: one tap from a settled answer's own action row to
 * that exact answer's Basis (`current-answer` scope for this session and
 * turn), through the same session-inventory host or Basis Pane launcher every
 * other Basis entry uses.
 */
export function ConnectedAnswerBasisAffordance({
  projectSlug,
  chatStoreId,
  sessionId,
  turnId,
  label = 'Basis for this answer',
}: {
  projectSlug?: string;
  chatStoreId?: string;
  sessionId: string;
  turnId: string;
  /** Accessible name naming which answer this chip opens; starts "Basis". */
  label?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<HTMLElement | null>(
    null,
  );
  const authority = useHostRequestAuthorityScope();
  const projectQuery = useScopedProjectQuery(projectSlug ?? '', {
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
      {/* The chip states no standing, source count or gap count: nothing on
          the row computes one, and reading Basis per rendered answer would
          fire one request per message. The opened Basis states all three. */}
      <button
        type="button"
        className="answer-basis-chip"
        title="Open the basis for this answer"
        aria-label={label}
        aria-busy={pendingTrigger ? true : undefined}
        onClick={(event) => {
          const trigger = event.currentTarget;
          setEnabled(true);
          if (projectId || !projectSlug) launch(trigger, projectId);
          else setPendingTrigger(trigger);
        }}
      >
        Basis
      </button>
      {fallback}
    </>
  );
}
