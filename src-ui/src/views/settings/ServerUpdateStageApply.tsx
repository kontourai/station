import type { ServerUpdateState } from '@kontourai/station-contracts/system-status';
import {
  useServerUpdateActionMutation,
  useServerUpdateRunningTurnsQuery,
} from '@kontourai/station-sdk';
import { compareStationReleaseVersions } from '@kontourai/station-shared/release-version-order';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SkeletonBlock } from '../../components/state';

export function ServerUpdateStageApply({
  active = true,
  apiBase,
  state,
  latestVersion,
  canDownload,
  onRequested,
}: {
  active?: boolean;
  apiBase: string;
  state: ServerUpdateState;
  /** The newer version the current check offers, if any. */
  latestVersion: string | null;
  /** Whether the check allows a download now (CoreUpdateCheck's gate). */
  canDownload: boolean;
  /** A restart the server accepted, so the caller can follow it. */
  onRequested: (requestId: string) => void;
}) {
  const [confirmingVersion, setConfirmingVersion] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!active) setConfirmingVersion(null);
  }, [active]);
  const action = useServerUpdateActionMutation(apiBase);
  const progress = state.progress;
  const staged = progress.state === 'staged' ? progress : null;
  // A release newer than the staged one is offered again (review F7).
  const newerThanStaged =
    !!latestVersion &&
    (!staged ||
      compareStationReleaseVersions(latestVersion, staged.version) === 1);
  const idle = state.applyWhenIdle;
  const run = (
    request: Parameters<typeof action.mutate>[0],
    after?: () => void,
  ) =>
    action.mutate(request, {
      onSuccess: ({ requestId }) => {
        // A restart is followed through the disconnect by the caller; a
        // download's progress arrives as pushed state.
        if (requestId && request.action === 'apply') onRequested(requestId);
        after?.();
      },
    });

  return (
    <div className="settings__update-stage-apply">
      <div className="settings__update-row">
        {staged && !idle && (
          <button
            type="button"
            className="settings__update-btn settings__update-btn--apply"
            onClick={() => setConfirmingVersion(staged.version)}
            disabled={action.isPending}
          >
            Restart server to update to {staged.version}
          </button>
        )}
        {staged && idle && (
          <button
            type="button"
            className="settings__update-btn settings__update-btn--check"
            onClick={() => run({ action: 'cancel-apply-when-idle' })}
            disabled={action.isPending}
          >
            Cancel update when idle
          </button>
        )}
        {newerThanStaged &&
          canDownload &&
          latestVersion &&
          !idle &&
          progress.state !== 'queued' &&
          progress.state !== 'staging' && (
            <button
              type="button"
              className="settings__update-btn settings__update-btn--apply"
              onClick={() => run({ action: 'stage' })}
              disabled={action.isPending}
            >
              {action.isPending ? 'Requesting…' : `Download ${latestVersion}`}
            </button>
          )}
      </div>
      {staged && idle && (
        <div className="settings__update-msg" role="status">
          The server restarts into {idle.version} once no agent turn is running.
        </div>
      )}
      {!staged && state.autoDownloadAt && (
        <span className="settings__field-hint">
          Downloads by itself after{' '}
          {new Date(state.autoDownloadAt).toLocaleString()} (Automatic server
          download).
        </span>
      )}
      {action.error && (
        <div className="settings__update-msg settings__update-msg--error">
          {(action.error as Error).message}
        </div>
      )}
      {active && staged && confirmingVersion === staged.version && (
        <ServerUpdateRestartConfirmation
          apiBase={apiBase}
          version={staged.version}
          pending={action.isPending}
          onLater={() => setConfirmingVersion(null)}
          onWhenIdle={() =>
            run({ action: 'apply-when-idle', version: staged.version }, () =>
              setConfirmingVersion(null),
            )
          }
          onRestartNow={() =>
            run({ action: 'apply', version: staged.version }, () =>
              setConfirmingVersion(null),
            )
          }
        />
      )}
    </div>
  );
}

/**
 * Names the agent turns the restart interrupts, as far as this client may
 * read them. Nothing here says a turn resumes: nothing computes that yet.
 */
export function ServerUpdateRestartConfirmation({
  apiBase,
  version,
  pending,
  onLater,
  onWhenIdle,
  onRestartNow,
  mode = 'staged',
}: {
  apiBase: string;
  version: string;
  pending: boolean;
  onLater: () => void;
  onWhenIdle?: () => void;
  onRestartNow: () => void;
  mode?: 'staged' | 'checkout' | 'service-update';
}) {
  const turns = useServerUpdateRunningTurnsQuery(apiBase, { enabled: true });
  const awaitingTurns = turns.isPending || turns.isFetching;
  const listed = turns.data?.turns ?? [];
  const hidden = turns.data?.hiddenCount ?? 0;
  const total = listed.length + hidden;
  return createPortal(
    <Dialog
      title={
        mode === 'staged'
          ? `Restart the server into ${version}?`
          : 'Update and restart the server?'
      }
      // "Later" is the dialog's own dismissal (its close control and
      // Escape): a row holds at most two labelled actions (#3045).
      closeLabel="Later"
      onClose={onLater}
      role="alertdialog"
      size="sm"
      historyMode="none"
      footer={
        <ActionRow
          overflowLabel="More restart choices"
          secondary={
            onWhenIdle ? (
              <Button
                variant="secondary"
                onClick={onWhenIdle}
                disabled={pending || awaitingTurns}
              >
                When idle
              </Button>
            ) : undefined
          }
          primary={
            <Button
              variant="primary"
              onClick={onRestartNow}
              pending={pending}
              disabled={awaitingTurns}
            >
              {mode === 'staged' ? 'Restart now' : 'Update and restart'}
            </Button>
          }
        />
      }
    >
      <p className="station-dialog__message">
        {mode === 'checkout'
          ? 'The connected server updates its source checkout and restarts. This disconnects every client using it.'
          : `The server stops, tries ${version}, and returns to the current version if it does not start.`}{' '}
        To decide later, close this dialog: nothing restarts until you choose.
      </p>
      {awaitingTurns && (
        <SkeletonBlock count={1} label="Checking for running agent turns" />
      )}
      {turns.isError && (
        <p className="station-dialog__message" role="alert">
          Could not list the running agent turns. A restart interrupts any that
          are running.
        </p>
      )}
      {!awaitingTurns && turns.isSuccess && total === 0 && (
        <p className="station-dialog__message">Nothing is running right now.</p>
      )}
      {!awaitingTurns && turns.isSuccess && total > 0 && (
        <>
          <p className="station-dialog__message">
            {total === 1
              ? 'This agent turn will be interrupted:'
              : `These ${total} agent turns will be interrupted:`}
          </p>
          <ul className="station-dialog__message settings__update-running-turns">
            {listed.map((turn) => (
              <li key={turn.sessionId}>
                {turn.title ?? 'Untitled conversation'} ({turn.engine})
              </li>
            ))}
            {hidden > 0 && (
              <li>
                {hidden === 1
                  ? '1 turn you cannot see'
                  : `${hidden} turns you cannot see`}
              </li>
            )}
          </ul>
        </>
      )}
    </Dialog>,
    document.body,
  );
}
