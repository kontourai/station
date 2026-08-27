import { AnswerBasisAffordance } from '@kontourai/station-basis-pane/answer-basis-affordance';
import { createDirectAnswerBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { useProjectQuery } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';

export function ConnectedAnswerBasisAffordance({
  projectSlug,
  sessionId,
  turnId,
}: {
  projectSlug?: string;
  sessionId: string;
  turnId: string;
}) {
  const root = useRef<HTMLSpanElement | null>(null);
  const [enabled, setEnabled] = useState(false);
  const { data: project } = useProjectQuery(projectSlug ?? '', {
    enabled: enabled && Boolean(projectSlug),
  }) as { data?: { id?: string } };
  const projectId =
    typeof project?.id === 'string' && project.id.length > 0
      ? project.id
      : undefined;
  const { openBasis, fallback } = useBasisPaneLauncher();
  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setEnabled(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEnabled(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <span ref={root}>
        <AnswerBasisAffordance
          sessionId={sessionId}
          turnId={turnId}
          enabled={enabled}
          onOpen={(trigger) => {
            setEnabled(true);
            openBasis(
              projectId
                ? createDirectAnswerBasisPaneInstance(
                    projectId,
                    sessionId,
                    turnId,
                  )
                : null,
              { kind: 'direct-answer', sessionId, turnId },
              trigger,
            );
          }}
        />
      </span>
      {fallback}
    </>
  );
}
