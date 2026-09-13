import {
  type CoreUpdateRestartExpectation,
  useApplyCoreUpdateMutation,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import { requestCoreUpdateRestartStatus } from '@kontourai/station-sdk/core-update-restart-status';
import { useCallback, useEffect, useRef, useState } from 'react';
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

export const RESTART_STATUS_POLL_INTERVAL_MS = 1_500;

type RestartVerificationState =
  | { state: 'idle' }
  | { state: 'verifying' }
  | { state: 'verified'; build: string }
  | { state: 'failed' };

export function CoreUpdateCheck({
  apiBase,
  enabled = true,
  context,
}: {
  apiBase: string;
  /**
   * Gated by the connected-server correlation (ConnectedServerUpdates):
   * the auto-check waits until the selected server's identity has settled
   * and it is reachable. A manual re-check still refetches.
   */
  enabled?: boolean;
  /**
   * The correlation context this card renders for. Optional only so legacy
   * direct mounts keep compiling: every production mount passes it, and the
   * apply offer is fail-closed without a matching answering identity either
   * way. Its secret-free scope keys the query cache and binds mutation and
   * restart state to the originating selection — including same-URL profile
   * changes, whose scope differs even when `apiBase` does not.
   */
  context?: ConnectedServerUpdateContext | null;
}) {
  const scopeKey = coreUpdateScopeFromContext(context);
  const [restartVerification, setRestartVerification] =
    useState<RestartVerificationState>({ state: 'idle' });
  const [selfUpdating, setSelfUpdating] = useState(false);
  const restartAttemptRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const restartDeadlineTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const restartAbortRef = useRef<AbortController | undefined>(undefined);
  const restartTargetApiBaseRef = useRef(apiBase);
  const restartTargetScopeRef = useRef(scopeKey);
  // Update during render so a response from the old target cannot reach state
  // in the window before the change effect aborts its request.
  const renderedApiBaseRef = useRef(apiBase);
  renderedApiBaseRef.current = apiBase;
  const renderedScopeRef = useRef(scopeKey);
  renderedScopeRef.current = scopeKey;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  // The scope the in-flight POST belongs to; its completion is ignored once
  // the view has moved to another scope.
  const applyScopeRef = useRef(scopeKey);

  const {
    data: status,
    isFetching: checking,
    error: checkError,
    refetch: check,
    dataUpdatedAt,
  } = useCoreUpdateStatusQuery(
    apiBase,
    {
      // Auto-check on mount so freshness shows without a click (#1624). This
      // deliberately applies to EVERY install kind — the kind isn't knowable
      // before the first check — so a source checkout also fetches its remote
      // on Settings mount, bounded to once per staleTime window. The button
      // stays the explicit re-check. The caller may hold the auto-check until
      // server identity correlation has settled (see the `enabled` prop); a
      // held check is still refetchable by the button.
      enabled,
      staleTime: 5 * 60 * 1000,
    },
    context ? { scopeKey, assertCurrent: context.isCurrent } : undefined,
  );

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== undefined) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = undefined;
    }
  }, []);

  const clearRestartDeadlineTimer = useCallback(() => {
    if (restartDeadlineTimerRef.current !== undefined) {
      clearTimeout(restartDeadlineTimerRef.current);
      restartDeadlineTimerRef.current = undefined;
    }
  }, []);

  const cancelRestartVerification = useCallback(() => {
    restartAttemptRef.current += 1;
    clearRestartTimer();
    clearRestartDeadlineTimer();
    restartAbortRef.current?.abort();
    restartAbortRef.current = undefined;
  }, [clearRestartDeadlineTimer, clearRestartTimer]);

  useEffect(
    () => () => {
      // Abort an in-flight request on unmount; a late response must not update
      // an unmounted view.
      cancelRestartVerification();
    },
    [cancelRestartVerification],
  );

  const resetTransientState = useCallback(() => {
    cancelRestartVerification();
    setRestartVerification({ state: 'idle' });
    setSelfUpdating(false);
  }, [cancelRestartVerification]);

  useEffect(() => {
    if (restartTargetApiBaseRef.current !== apiBase) {
      // The render-time guard in `poll` rejects a response before this effect
      // runs; this effect also aborts the old network request promptly.
      resetTransientState();
      restartTargetApiBaseRef.current = apiBase;
    }
  }, [apiBase, resetTransientState]);

  // Scope binding: a selection change resets every displayed action state —
  // including same-URL profile changes, which change the scope without
  // changing `apiBase`. An obsolete completion must never present as the new
  // scope's state.
  useEffect(() => {
    if (restartTargetScopeRef.current !== scopeKey) {
      restartTargetScopeRef.current = scopeKey;
      resetTransientState();
    }
  }, [scopeKey, resetTransientState]);

  const verifyRestart = useCallback(
    (expected: CoreUpdateRestartExpectation) => {
      cancelRestartVerification();
      const attempt = restartAttemptRef.current;
      restartTargetApiBaseRef.current = apiBase;
      restartTargetScopeRef.current = scopeKey;
      const deadline = Date.parse(expected.deadlineAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        setRestartVerification({ state: 'failed' });
        return;
      }
      setRestartVerification({ state: 'verifying' });

      const failVerification = () => {
        if (
          restartAttemptRef.current !== attempt ||
          restartTargetApiBaseRef.current !== apiBase ||
          restartTargetScopeRef.current !== scopeKey
        ) {
          return;
        }
        clearRestartTimer();
        clearRestartDeadlineTimer();
        restartAbortRef.current?.abort();
        restartAbortRef.current = undefined;
        setRestartVerification({ state: 'failed' });
      };

      const schedulePoll = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          failVerification();
          return;
        }
        restartTimerRef.current = setTimeout(
          () => void poll(),
          Math.min(RESTART_STATUS_POLL_INTERVAL_MS, remaining),
        );
      };

      const poll = async (): Promise<void> => {
        if (Date.now() >= deadline) return failVerification();
        const controller = new AbortController();
        restartAbortRef.current = controller;
        let restartStatus: Awaited<
          ReturnType<typeof requestCoreUpdateRestartStatus>
        > | null = null;
        try {
          restartStatus = await requestCoreUpdateRestartStatus(
            apiBase,
            controller.signal,
          );
        } catch {
          // The hand-off makes an unreachable server ordinary. The separate
          // authoritative deadline bounds retry rather than treating it well.
        } finally {
          if (restartAbortRef.current === controller) {
            restartAbortRef.current = undefined;
          }
        }
        if (
          restartAttemptRef.current !== attempt ||
          renderedApiBaseRef.current !== apiBase ||
          renderedScopeRef.current !== scopeKey
        ) {
          return;
        }
        if (Date.now() >= deadline) return failVerification();
        if (!restartStatus) return schedulePoll();
        if (
          restartStatus.status === 'unavailable' ||
          restartStatus.expectedHash !== expected.expectedHash ||
          restartStatus.expectedInstanceId !== expected.expectedInstanceId ||
          restartStatus.deadlineAt !== expected.deadlineAt
        ) {
          return failVerification();
        }
        if (restartStatus.status !== 'pending' && !restartStatus.resolvedAt) {
          return failVerification();
        }
        if (restartStatus.status === 'verified') {
          clearRestartTimer();
          clearRestartDeadlineTimer();
          // S14: only the detached server watchdog's correlated durable
          // verdict can confirm the new server — never the POST acceptance.
          setRestartVerification({
            state: 'verified',
            build: restartStatus.expectedHash,
          });
          void check();
          return;
        }
        if (restartStatus.status === 'failed') return failVerification();
        schedulePoll();
      };

      restartDeadlineTimerRef.current = setTimeout(
        failVerification,
        deadline - Date.now(),
      );
      void poll();
    },
    [
      apiBase,
      cancelRestartVerification,
      check,
      clearRestartDeadlineTimer,
      clearRestartTimer,
      scopeKey,
    ],
  );

  const updateMutation = useApplyCoreUpdateMutation(apiBase, {
    onSuccess: (data) => {
      // A completion from a superseded scope is ignored: the selection this
      // POST was started from no longer owns the view.
      if (applyScopeRef.current !== scopeRef.current) return;
      if (data.success && data.updating) {
        // Git-based self-update accepted: the installer rebuilds from source
        // in the background over minutes and relaunches the app when done.
        // This process keeps serving the OLD build until that relaunch, so
        // the card shows the persistent rebuilding state and marks its cached
        // comparison historical until a person re-checks or the scope moves.
        setSelfUpdating(true);
        void check();
      } else if (data.success && data.restarting) {
        if (data.restart) {
          verifyRestart(data.restart);
        } else {
          setRestartVerification({ state: 'failed' });
        }
      } else if (data.success) {
        // S12 ("Server update started.") is deliberately NOT rendered here.
        // Plain acceptance immediately refetches, and the settled refetch IS
        // the honest answer (fresh comparison facts, S2 during the wait); a
        // "started" line would either never render — hidden behind the
        // in-flight fetch and cleared on settle, the defect the review caught
        // — or linger beside fresh facts as a stale start-claim. A start is
        // only worth a persistent line when nothing observable follows it
        // (the updating rebuild above, the restarting verification below).
        void check();
      }
    },
  });

  const restartStateMatchesTarget =
    restartTargetApiBaseRef.current === apiBase &&
    restartTargetScopeRef.current === scopeKey;
  const restarting =
    restartVerification.state === 'verifying' && restartStateMatchesTarget;
  const restartFailed =
    restartVerification.state === 'failed' && restartStateMatchesTarget;
  const verifiedBuild =
    restartVerification.state === 'verified' && restartStateMatchesTarget
      ? restartVerification.build
      : null;

  // A stale scope (another selection, or a server that stopped answering)
  // turns whatever is cached into history: labeled as such, never actionable.
  // An accepted background rebuild does the same: the server keeps serving
  // the OLD build until its relaunch, so cached facts are history too.
  const scopeStale = context
    ? !context.isCurrent() || context.reachability !== 'connected'
    : false;
  const comparisonSuperseded = scopeStale || selfUpdating;

  const view = status ? deriveComparisonView(status, checkError) : null;

  // Apply-offer gating (plan): current scope, successful comparison, explicit
  // supported method, non-diverged checkout, and the answering server's
  // identity matching the identity this view correlated. Unknown methods and
  // servers that cannot state an identity never render an apply button.
  const identityMatches = status
    ? serverIdentityMatchesView(status, context?.identity)
    : false;
  const behind = status?.behind ?? 0;
  const ahead = status?.ahead ?? 0;
  // A failed refresh must not keep an actionable old offer alive on top of
  // cached facts: `!checkError` (and the failed-check view) closes the gate.
  const canApply =
    !!status &&
    !comparisonSuperseded &&
    !checkError &&
    view?.kind === 'checkout' &&
    identityMatches &&
    status.applyMethod === 'git-pull' &&
    status.updateAvailable &&
    behind > 0 &&
    ahead === 0;

  const technicalDisclosure =
    view && (view.kind === 'refusal' || view.kind === 'failed-check') ? (
      <TechnicalDetails
        message={checkError ? null : status?.message}
        detail={
          checkError
            ? (checkError as Error).message
            : (status?.technicalDetail ?? null)
        }
      />
    ) : null;

  const historicalTime =
    dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  return (
    <div>
      <div className="settings__update-row">
        <button
          type="button"
          className="settings__update-btn settings__update-btn--check"
          onClick={() => {
            // A re-check is also the recovery path out of a failed background
            // self-update: clear the updating state so the fresh result (still
            // behind = the update failed) is visible instead of a frozen
            // "Updating…".
            resetTransientState();
            check();
          }}
          disabled={checking}
        >
          {checking
            ? status
              ? 'Re-checking…'
              : 'Checking…'
            : 'Check for Updates'}
        </button>
        {canApply && (
          <button
            type="button"
            className="settings__update-btn settings__update-btn--apply"
            onClick={() => {
              applyScopeRef.current = scopeRef.current;
              updateMutation.mutate();
            }}
            disabled={updateMutation.isPending || restarting}
          >
            {restarting || updateMutation.isPending
              ? 'Updating…'
              : 'Update server checkout'}
          </button>
        )}
      </div>
      {/*
        6-OPS-44: a re-check must not delete what is already known. A `git
        ls-remote` against a cold remote took ~30 s in the audit, and for that
        whole window the card replaced its facts with one disabled "Checking…"
        — so the user lost the answer they already had in order to be told an
        answer was coming. `isFetching` covers both the first read and every
        refresh; only the first has nothing to preserve.
      */}
      {checking && !status && (
        // The wait's name rides the skeleton's label (state-primitives gate):
        // S1 is the sentence, the skeleton is the region-shaped wait.
        <SkeletonBlock
          count={1}
          label="Checking the connected server’s update source"
        />
      )}
      {checking && status && (
        <div className="settings__update-meta">
          <span>
            Checking again. Showing the result from{' '}
            {historicalTime ?? 'an earlier check'}.
          </span>
        </div>
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
      {restarting && (
        <div className="settings__update-msg settings__update-msg--warning">
          Server restart started. Verifying the expected build…
        </div>
      )}
      {restartFailed && (
        <div className="settings__update-msg settings__update-msg--warning">
          Could not verify the expected server after restart. View update
          details.
        </div>
      )}
      {verifiedBuild && (
        <div className="settings__update-msg settings__update-msg--success">
          Server update verified: {verifiedBuild}.
        </div>
      )}
      {selfUpdating && (
        <div className="settings__update-msg settings__update-msg--warning">
          Updating — Station is rebuilding from source and will restart when
          complete.
        </div>
      )}
      {updateMutation.error && (
        <div className="settings__update-msg settings__update-msg--error">
          {(updateMutation.error as Error).message}
        </div>
      )}
      {comparisonSuperseded && status && historicalTime && (
        <div className="settings__update-msg">
          Last checked {historicalTime}. This result may be outdated.
        </div>
      )}
      {/* A superseded comparison (stale scope or an accepted rebuild serving
        the old build) never speaks with a current voice: the historical line
        above replaces every derived state claim. */}
      {view && !comparisonSuperseded && <ComparisonMessage view={view} />}
      {technicalDisclosure}
      <span className="settings__field-hint">
        {status?.applyMethod === 'self-update'
          ? 'Rebuilds from this machine’s source checkout and restarts the app.'
          : status?.applyMethod === 'reinstall'
            ? 'Compares this install’s build stamp against its configured source ref.'
            : status?.installKind === 'source-checkout'
              ? 'Pull latest changes from the git remote. Server restarts automatically after update.'
              : 'Checks the connected Station server. Desktop release updates use the app’s signed update channel.'}
      </span>
    </div>
  );
}
