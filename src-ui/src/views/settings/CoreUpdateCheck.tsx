import {
  type CoreUpdateRestartExpectation,
  useApplyCoreUpdateMutation,
  useCoreUpdateStatusQuery,
} from '@kontourai/station-sdk';
import { requestCoreUpdateRestartStatus } from '@kontourai/station-sdk/core-update-restart-status';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckGlyph } from '../../components/icons/Glyph';
import { SkeletonBlock } from '../../components/state';

export const RESTART_STATUS_POLL_INTERVAL_MS = 1_500;

type RestartVerificationState = 'idle' | 'verifying' | 'failed';

export function CoreUpdateCheck({ apiBase }: { apiBase: string }) {
  const [restartVerification, setRestartVerification] =
    useState<RestartVerificationState>('idle');
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
  // Update during render so a response from the old target cannot reach state
  // in the window before the apiBase effect aborts its request.
  const renderedApiBaseRef = useRef(apiBase);
  renderedApiBaseRef.current = apiBase;

  const {
    data: status,
    isFetching: checking,
    error: checkError,
    refetch: check,
  } = useCoreUpdateStatusQuery(apiBase, {
    // Auto-check on mount so freshness shows without a click (#1624). This
    // deliberately applies to EVERY install kind — the kind isn't knowable
    // before the first check — so a source checkout also fetches its remote
    // on Settings mount, bounded to once per staleTime window. The button
    // stays the explicit re-check.
    enabled: true,
    staleTime: 5 * 60 * 1000,
  });

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

  useEffect(() => {
    if (restartTargetApiBaseRef.current !== apiBase) {
      // The render-time guard in `poll` rejects a response before this effect
      // runs; this effect also aborts the old network request promptly.
      cancelRestartVerification();
      restartTargetApiBaseRef.current = apiBase;
      setRestartVerification('idle');
    }
  }, [apiBase, cancelRestartVerification]);

  const verifyRestart = useCallback(
    (expected: CoreUpdateRestartExpectation) => {
      cancelRestartVerification();
      const attempt = restartAttemptRef.current;
      restartTargetApiBaseRef.current = apiBase;
      const deadline = Date.parse(expected.deadlineAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        setRestartVerification('failed');
        return;
      }
      setRestartVerification('verifying');

      const failVerification = () => {
        if (
          restartAttemptRef.current !== attempt ||
          restartTargetApiBaseRef.current !== apiBase
        ) {
          return;
        }
        clearRestartTimer();
        clearRestartDeadlineTimer();
        restartAbortRef.current?.abort();
        restartAbortRef.current = undefined;
        setRestartVerification('failed');
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
          renderedApiBaseRef.current !== apiBase
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
          setRestartVerification('idle');
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
    ],
  );

  const updateMutation = useApplyCoreUpdateMutation(apiBase, {
    onSuccess: (data) => {
      if (data.success && data.updating) {
        // Git-based self-update: the installer rebuilds from source in the
        // background and relaunches the app when done. This process keeps
        // serving the OLD build until that relaunch, so there is nothing to
        // poll here — just say what is happening.
        setSelfUpdating(true);
      } else if (data.success && data.restarting) {
        if (data.restart) {
          verifyRestart(data.restart);
        } else {
          setRestartVerification('failed');
        }
      } else if (data.success) {
        check();
      }
    },
  });

  const restartStateMatchesApiBase =
    restartTargetApiBaseRef.current === apiBase;
  const restarting =
    restartVerification === 'verifying' && restartStateMatchesApiBase;
  const restartFailed =
    restartVerification === 'failed' && restartStateMatchesApiBase;
  const message = selfUpdating
    ? 'Updating — Station is rebuilding from source and will restart when complete.'
    : restarting
      ? // station#1903 review finding 3: the backend response no longer
        // claims the update succeeded before a healthy new server is
        // observed — this local copy must not either. `restarting` only
        // means the restart was initiated; only the detached server watchdog's
        // correlated durable verdict can confirm the new server.
        'Restarting — verifying the new server…'
      : restartFailed
        ? 'Station could not verify the expected restarted server. Check the server logs, then retry the update check.'
        : updateMutation.error
          ? (updateMutation.error as Error).message
          : checkError
            ? (checkError as Error).message
            : status?.message
              ? status.message
              : null;

  // The apply button needs a workable apply path: git pull for a source
  // checkout, or the verified-checkout self-update for a bundle. Plain
  // 'reinstall' bundles get guidance instead of a button that would 409
  // (station#1624).
  const canApply =
    status?.updateAvailable && status.applyMethod !== 'reinstall';
  const isSelfUpdate = status?.applyMethod === 'self-update';

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
            cancelRestartVerification();
            setRestartVerification('idle');
            setSelfUpdating(false);
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
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending || restarting || selfUpdating}
          >
            {restarting || selfUpdating
              ? 'Updating…'
              : updateMutation.isPending
                ? 'Updating…'
                : isSelfUpdate
                  ? `Update & restart (${status.currentHash} → ${status.remoteHash})`
                  : `Update (${status.behind} commit${status.behind !== 1 ? 's' : ''} behind)`}
          </button>
        )}
      </div>
      {/*
        6-OPS-44: a re-check must not delete what is already known. A `git
        ls-remote` against a cold remote took ~30 s in the audit, and for that
        whole window the card replaced Channel/Branch/Current/Latest with one
        disabled "Checking…" — so the user lost the answer they already had in
        order to be told an answer was coming. `isFetching` covers both the
        first read and every refresh; only the first has nothing to preserve.
      */}
      {checking && !status && (
        <SkeletonBlock count={1} label="Checking for updates" />
      )}
      {checking && status && (
        <div className="settings__update-meta">
          <span>Re-checking against the remote — showing the last result.</span>
        </div>
      )}
      {status && (status.channel || status.branch || status.currentHash) && (
        <div className="settings__update-meta">
          {status.channel && (
            <>
              <span>Channel: {status.channel}</span>
              <span>·</span>
            </>
          )}
          {status.branch && <span>Branch: {status.branch}</span>}
          {status.branch && status.currentHash && <span>·</span>}
          {status.currentHash && <span>Current: {status.currentHash}</span>}
          {status.updateAvailable && (
            <>
              <span>·</span>
              <span className="settings__update-text--success">
                Latest: {status.remoteHash}
              </span>
            </>
          )}
          {!status.updateAvailable && (status.ahead ?? 0) > 0 && (
            <>
              <span>·</span>
              <span className="settings__update-text--warning">
                {status.ahead} commit{status.ahead !== 1 ? 's' : ''} ahead
              </span>
            </>
          )}
          {!status.updateAvailable &&
            !status.ahead &&
            status.currentHash &&
            !status.remoteUnreachable && (
              <>
                <span>·</span>
                <span
                  className={`settings__update-text--${status.noUpstream ? 'muted' : 'success'}`}
                >
                  {status.noUpstream ? (
                    'No upstream configured'
                  ) : (
                    <>
                      Up to date <CheckGlyph />
                    </>
                  )}
                </span>
              </>
            )}
        </div>
      )}
      {status?.updateAvailable && status.applyMethod === 'reinstall' && (
        <div className="settings__update-msg settings__update-msg--warning">
          Update available on the {status.channel ?? 'install'} channel (
          {status.currentHash} → {status.remoteHash}). Update by reinstalling
          from that channel — one-click updates are coming.
        </div>
      )}
      {message && (
        <div
          className={`settings__update-msg settings__update-msg--${
            restarting || selfUpdating
              ? 'warning'
              : message.includes('Updated')
                ? 'success'
                : status?.remoteUnreachable || status?.installKind === 'unknown'
                  ? 'warning'
                  : 'error'
          }`}
        >
          {message}
        </div>
      )}
      <span className="settings__field-hint">
        {status?.applyMethod === 'self-update'
          ? 'Rebuilds from this machine’s source checkout and restarts the app.'
          : status?.applyMethod === 'reinstall'
            ? `Compares this install's build stamp against the latest on its channel.`
            : 'Pull latest changes from the git remote. Server restarts automatically after update.'}
      </span>
    </div>
  );
}
