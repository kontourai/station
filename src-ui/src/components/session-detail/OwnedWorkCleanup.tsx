import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { ownedWorkUnknownReasons } from '@kontourai/station-contracts/session-attention';
import { isSessionLifecycleStateAtRest } from '@kontourai/station-contracts/session-lifecycle';
import { dispatchOrchestrationCommand } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../Button';
import { ConfirmModal } from '../modals/ConfirmModal';
import './OwnedWorkCleanup.css';

export function OwnedWorkCleanup({
  session,
  apiBase,
  onRemoved,
}: {
  session: OrchestrationSessionSummary;
  apiBase: string;
  onRemoved(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const release = useMutation({
    mutationFn: () =>
      dispatchOrchestrationCommand(
        {
          type: 'releaseUnknownOwnedWork',
          threadId: session.threadId,
          confirmation: 'child-process-may-still-be-running',
        },
        apiBase,
      ),
    onSuccess: () => {
      setConfirm(false);
      onRemoved();
    },
  });
  if (session.ownedWork?.state !== 'unknown') return null;
  const canRelease = isSessionLifecycleStateAtRest(
    session.ownedWork.ownLifecycleState,
  );
  return (
    <section className="owned-work-cleanup" aria-label="Owned child cleanup">
      <h3>Unknown child custody</h3>
      <ul>
        {ownedWorkUnknownReasons(session.ownedWork).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <Button
        variant="secondary"
        disabled={!canRelease}
        onClick={() => setConfirm(true)}
      >
        Release and remove
      </Button>
      {!canRelease && <p>Stop this session before releasing child cleanup.</p>}
      <ConfirmModal
        isOpen={confirm}
        title="Release and remove this session?"
        message="Child processes may still be running and will no longer be tracked by this session. Release the cleanup and remove this session?"
        confirmLabel="Release and remove"
        cancelLabel="Keep tracking"
        variant="danger"
        role="alertdialog"
        confirmDisabled={!canRelease}
        pending={release.isPending}
        error={
          release.error
            ? release.error instanceof Error
              ? release.error.message
              : 'Child cleanup could not be released.'
            : null
        }
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          if (canRelease) release.mutate();
        }}
      />
    </section>
  );
}
