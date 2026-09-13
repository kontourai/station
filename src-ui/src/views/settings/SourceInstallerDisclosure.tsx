import {
  useApplyCoreUpdateMutation,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import { SkeletonBlock } from '../../components/state';
import {
  type ConnectedServerUpdateContext,
  coreUpdateScopeFromContext,
} from '../../hooks/useConnectedServerUpdateContext';
import {
  ComparisonMessage,
  comparisonMetadata,
  deriveComparisonView,
  serverIdentityMatchesView,
  TechnicalDetails,
} from './coreUpdatePresentation';

/**
 * A1 — "Source installation details": the advanced disclosure that preserves
 * the existing checkout-backed bundle installer (A2) without making it the
 * normal desktop update path, and without placing it under an "Update server"
 * label. The server-side eligibility revalidation on POST remains
 * authoritative; this UI only decides what is worth offering.
 *
 * The disclosure's source query mounts ONLY while it is open, so the default
 * card — including an established built-in server, whose ordinary source
 * check never mounts — requests source details only when a person asks for
 * them.
 */
export function SourceInstallerDisclosure({
  context,
}: {
  context: ConnectedServerUpdateContext;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="settings__update-technical"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Source installation details</summary>
      {open && <SourceInstallationFacts context={context} />}
    </details>
  );
}

function SourceInstallationFacts({
  context,
}: {
  context: ConnectedServerUpdateContext;
}) {
  const scopeKey = coreUpdateScopeFromContext(context);
  const applyScopeRef = useRef(scopeKey);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  const {
    data: status,
    isFetching: checking,
    error: checkError,
    refetch: check,
  } = useCoreUpdateStatusQuery(
    context.apiBase,
    {
      // Mount-gated by the disclosure (see above); still fail-closed on the
      // correlation inputs, exactly like the ordinary source check.
      enabled:
        context.identityReady &&
        !context.nativeObservationPending &&
        context.reachability === 'connected',
      staleTime: 5 * 60 * 1000,
    },
    { scopeKey, assertCurrent: context.isCurrent },
  );

  const [rebuildStarted, setRebuildStarted] = useState(false);
  const rebuildMutation = useApplyCoreUpdateMutation(context.apiBase, {
    onSuccess: (data) => {
      if (applyScopeRef.current !== scopeRef.current) return;
      if (data.success) {
        // A4: accepted is a start. The rebuild's completion surfaces through
        // the app relaunch itself, never as a fabricated success here.
        setRebuildStarted(true);
        void check();
      }
    },
  });

  const scopeStale =
    !context.isCurrent() || context.reachability !== 'connected';
  const view = status ? deriveComparisonView(status, checkError) : null;
  const identityMatches = status
    ? serverIdentityMatchesView(status, context.identity)
    : false;
  const canRebuild =
    !!status &&
    !scopeStale &&
    identityMatches &&
    status.applyMethod === 'self-update' &&
    status.updateAvailable &&
    !status.selfUpdateUnavailableReason;

  return (
    <div className="settings__source-facts">
      <p className="settings__field-hint">
        Affected server: {context.identity?.instanceId ?? 'unknown'} ·{' '}
        {context.apiBase}
      </p>
      {checking && !status && (
        <SkeletonBlock count={1} label="Checking for updates" />
      )}
      {status && comparisonMetadata(status).length > 0 && (
        <div className="settings__update-meta">
          {comparisonMetadata(status).map(({ label, value }, index) => (
            <span key={`${label}-${value}`}>
              {index > 0 && '· '}
              {label}: {value}
            </span>
          ))}
        </div>
      )}
      {status?.selfUpdateUnavailableReason && (
        <div className="settings__update-msg settings__update-msg--warning">
          Source update cannot be applied here:{' '}
          {status.selfUpdateUnavailableReason}.
        </div>
      )}
      {canRebuild && (
        <button
          type="button"
          className="settings__update-btn settings__update-btn--apply"
          onClick={() => {
            applyScopeRef.current = scopeRef.current;
            rebuildMutation.mutate();
          }}
          disabled={rebuildMutation.isPending}
        >
          {rebuildMutation.isPending
            ? 'Rebuilding…'
            : 'Rebuild and reinstall desktop app from source…'}
        </button>
      )}
      {rebuildStarted && !rebuildMutation.isPending && (
        <div className="settings__update-msg" role="status">
          Desktop app rebuild started.
        </div>
      )}
      {rebuildMutation.error && (
        <div className="settings__update-msg settings__update-msg--error">
          {(rebuildMutation.error as Error).message}
        </div>
      )}
      {view && <ComparisonMessage view={view} />}
      {view && (view.kind === 'refusal' || view.kind === 'failed-check') && (
        <TechnicalDetails
          message={checkError ? null : status?.message}
          detail={
            checkError
              ? (checkError as Error).message
              : (status?.technicalDetail ?? null)
          }
        />
      )}
    </div>
  );
}
