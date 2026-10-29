import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { lazy, Suspense, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { SkeletonBlock } from '../components/state';

const Picker = lazy(() =>
  import('./BasisAnswerTaskPicker').then(({ BasisAnswerTaskPicker }) => ({
    default: BasisAnswerTaskPicker,
  })),
);

/** Opening the chooser captures the answer and connection; it never follows the active chat. */
export function KeepAnswerInTask({
  sessionId,
  turnId,
  currentProjectId,
  requestScope,
}: {
  sessionId: string;
  turnId: string;
  currentProjectId?: string;
  requestScope: ApiRequestScope;
}) {
  const [target, setTarget] = useState<{
    sessionId: string;
    turnId: string;
    requestScope: ApiRequestScope;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [keptTask, setKeptTask] = useState<string | null>(null);
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        aria-label="Keep in Task: this answer"
        onClick={() => setTarget({ sessionId, turnId, requestScope })}
      >
        Keep in Task
      </Button>
      {keptTask ? (
        <span role="status">Answer kept in Task “{keptTask}”.</span>
      ) : null}
      {target ? (
        <Suspense fallback={<SkeletonBlock count={1} label="Loading Tasks" />}>
          <Picker
            target={target}
            currentProjectId={currentProjectId}
            returnFocusTarget={trigger.current}
            onClose={() => setTarget(null)}
            onKept={setKeptTask}
          />
        </Suspense>
      ) : null}
    </>
  );
}
