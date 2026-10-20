import { AnswerBasisAffordance } from '@kontourai/station-basis-pane/answer-basis-affordance';
import { createSessionInventoryBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectQuery } from '../../contexts/ProjectsContext';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';
import { openSessionInventoryOccurrence } from '../chat-dock/sessionInventoryOccurrence';

/**
 * Whether `target` is on screen now. Without IntersectionObserver nothing is
 * reported visible, so the chip stays plain "Basis" rather than reading every
 * answer's Basis.
 */
function useOnScreen(target: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
  return onScreen;
}

/**
 * The answer's Basis chip: one tap from a settled answer's own action row to
 * that exact answer's Basis (`current-answer` scope for this session and
 * turn), through the same session-inventory host or Basis Pane launcher every
 * other Basis entry uses. Its face names Surface's standing for this answer
 * only when that standing is notable (`AnswerBasisAffordance`), and it reads
 * that standing only while it is on screen.
 */
export function ConnectedAnswerBasisAffordance({
  projectSlug,
  chatStoreId,
  sessionId,
  turnId,
  answerName = 'this answer',
}: {
  projectSlug?: string;
  chatStoreId?: string;
  sessionId: string;
  turnId: string;
  /** Which answer this chip opens, for its accessible name. */
  answerName?: string;
}) {
  const chip = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(chip);
  // The Project lookup is click-initiated; the Basis read is visibility-led.
  const [projectLookup, setProjectLookup] = useState(false);
  const [pendingTrigger, setPendingTrigger] = useState<HTMLElement | null>(
    null,
  );
  const authority = useHostRequestAuthorityScope();
  const projectQuery = useScopedProjectQuery(projectSlug ?? '', {
    enabled: projectLookup && Boolean(projectSlug),
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
    if (!pendingTrigger || !projectLookup) return;
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
    launch,
    pendingTrigger,
    projectId,
    projectQuery.isFetching,
    projectQuery.isLoading,
    projectSlug,
    projectLookup,
  ]);
  return (
    <>
      <AnswerBasisAffordance
        ref={chip}
        className="answer-basis-chip"
        sessionId={sessionId}
        turnId={turnId}
        enabled={onScreen && Boolean(authority)}
        requestScope={authority ?? undefined}
        answerName={answerName}
        aria-busy={pendingTrigger ? true : undefined}
        onOpen={(trigger) => {
          setProjectLookup(true);
          if (projectId || !projectSlug) launch(trigger, projectId);
          else setPendingTrigger(trigger);
        }}
      />
      {fallback}
    </>
  );
}
