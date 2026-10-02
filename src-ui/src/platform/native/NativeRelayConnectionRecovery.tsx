import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '../../components/Button';
import {
  type NativeRelayGrantAdapter,
  nativeRelayGrantAdapter,
} from './nativeRelayGrantAdapter';

export function NativeRelayConnectionRecovery({
  selection,
  onBusyChange,
  onPendingChange,
}: {
  selection: Parameters<NativeRelayGrantAdapter['recoveryPreview']>[0];
  onBusyChange: (busy: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const preview = useMutation({
    mutationFn: () => nativeRelayGrantAdapter.recoveryPreview(selection),
  });
  const reset = useMutation({
    mutationFn: () => {
      if (!preview.data) throw new Error('Recovery preview is unavailable.');
      return nativeRelayGrantAdapter.resetConnectionInvitation({
        ...selection,
        expectedProfileRevision: preview.data.state.profileRevision,
      });
    },
  });
  const busy = preview.isPending || reset.isPending;
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  const result = reset.data;
  const pending = Boolean(
    result &&
      (result.state.grants.length > 0 ||
        result.state.cleanups.some((entry) => !entry.localCleanupComplete) ||
        result.outcomes.some((entry) => !entry.localCleanupComplete)),
  );
  useEffect(() => {
    if (result) onPendingChange(pending);
    else if (reset.isError) onPendingChange(true);
  }, [result, pending, reset.isError, onPendingChange]);
  return (
    <section aria-label="Connection invitation recovery">
      {!preview.data ? (
        <Button pending={preview.isPending} onClick={() => preview.mutate()}>
          Reset connection invitation
        </Button>
      ) : !result ? (
        <>
          <h3>Remove saved routing access?</h3>
          <p>
            This removes connection invitations saved for this Station on this
            device. Review the saved invitations before confirming.
          </p>
          <p>
            Saved invitations: {preview.data.state.grants.length}. Pending
            cleanup: {preview.data.state.cleanups.length}.
          </p>
          <details>
            <summary>Saved invitation details</summary>
            <ul>
              {preview.data.state.grants.map(({ metadata, expired }) => (
                <li
                  key={`${metadata.route.routingGeneration}:${metadata.route.grantId}`}
                >
                  Routing generation {metadata.route.routingGeneration} ·{' '}
                  {expired ? 'Expired' : 'Not expired'}
                </li>
              ))}
            </ul>
          </details>
          <Button
            pending={reset.isPending}
            disabled={busy}
            onClick={() => reset.mutate()}
          >
            Reset connection invitation
          </Button>
        </>
      ) : (
        <p role="status">
          {pending
            ? 'Connection cleanup is still pending. Ask the Station owner for help before continuing.'
            : 'Saved routing invitations removed. Device approval and sign-in are separate steps.'}
        </p>
      )}
      {result && result.outcomes.length > 0 ? (
        <details>
          <summary>Cleanup details</summary>
          <ul>
            {result.outcomes.map((entry) => (
              <li
                key={`${entry.route.routingGeneration}:${entry.route.grantId}`}
              >
                Routing generation {entry.route.routingGeneration} ·{' '}
                {entry.remoteBasis?.kind === 'superseded-generation-observed'
                  ? 'Earlier generation unavailable'
                  : entry.remoteBasis?.kind === 'individual-grant-retired'
                    ? 'Individual invitation retired'
                    : 'Remote cleanup unconfirmed'}
                {' · '}
                {entry.localCleanupComplete
                  ? 'Local cleanup complete'
                  : 'Local cleanup pending'}
                {entry.failure ? ` · Cleanup error: ${entry.failure}` : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {preview.isError || reset.isError ? (
        <p role="alert">
          Station could not verify connection cleanup. Ask the Station owner for
          help before continuing.
        </p>
      ) : null}
    </section>
  );
}
