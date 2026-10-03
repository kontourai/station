import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '../../components/Button';
import {
  type NativeRelayGrantAdapter,
  nativeRelayGrantAdapter,
} from './nativeRelayGrantAdapter';
import { publishNativeRelaySetupChange } from './nativeRelaySetupState';

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
    onSettled: () => publishNativeRelaySetupChange(selection.profileName),
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
          Review saved connections
        </Button>
      ) : !result ? (
        <>
          <h3>Remove saved connections?</h3>
          <p>
            Remove the saved connections shown below to use this invitation.
            We’ll also try to turn off any that still work. This won’t change
            your Station confirmation or shared Project access.
          </p>
          <p>Saved connections: {preview.data.state.grants.length}.</p>
          <details>
            <summary>Technical details</summary>
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
            Remove saved connections
          </Button>
        </>
      ) : (
        <p role="status">
          {pending
            ? 'Some saved connections could not be removed yet. Keep this screen open and ask the Station owner for help before continuing.'
            : 'Saved connections removed. Continue to device approval; account sign-in and shared Project access are separate steps.'}
        </p>
      )}
      {result && result.outcomes.length > 0 ? (
        <details>
          <summary>Cleanup status details</summary>
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
          Station couldn’t confirm that saved connections were removed. Ask the
          Station owner for help before continuing.
        </p>
      ) : null}
    </section>
  );
}
