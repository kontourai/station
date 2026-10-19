/**
 * Download, then a confirmed restart, for a launcher-run server that takes
 * separate requests (#3851 slice 4). Deliberately minimal and self-contained:
 * slice 5 replaces it with the shared update control, the restart
 * confirmation and the reconnect overlay. CoreUpdateCheck renders it in
 * place of its one-click "Update server" button when the server says
 * `stagedUpdates`; the progress line stays CoreUpdateCheck's.
 */
import type { ServerUpdateState } from '@kontourai/station-contracts/system-status';
import {
  useServerUpdateActionMutation,
  useServerUpdateRunningTurnsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';

export function ServerUpdateStageApply({
  apiBase,
  state,
  latestVersion,
  canDownload,
  onRequested,
}: {
  apiBase: string;
  state: ServerUpdateState;
  /** The newer version the current check offers, if any. */
  latestVersion: string | null;
  /** Whether the check allows a download now (CoreUpdateCheck's gate). */
  canDownload: boolean;
  /** A restart the server accepted, so the caller can follow it. */
  onRequested: (requestId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const action = useServerUpdateActionMutation(apiBase);
  const progress = state.progress;
  const staged = progress.state === 'staged' ? progress : null;
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
            onClick={() => setConfirming(true)}
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
        {!staged &&
          canDownload &&
          latestVersion &&
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
      {confirming && staged && (
        <RestartConfirmation
          apiBase={apiBase}
          version={staged.version}
          pending={action.isPending}
          onLater={() => setConfirming(false)}
          onWhenIdle={() =>
            run({ action: 'apply-when-idle', version: staged.version }, () =>
              setConfirming(false),
            )
          }
          onRestartNow={() =>
            run({ action: 'apply', version: staged.version }, () =>
              setConfirming(false),
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
function RestartConfirmation({
  apiBase,
  version,
  pending,
  onLater,
  onWhenIdle,
  onRestartNow,
}: {
  apiBase: string;
  version: string;
  pending: boolean;
  onLater: () => void;
  onWhenIdle: () => void;
  onRestartNow: () => void;
}) {
  const turns = useServerUpdateRunningTurnsQuery(apiBase, { enabled: true });
  const listed = turns.data?.turns ?? [];
  const hidden = turns.data?.hiddenCount ?? 0;
  const total = listed.length + hidden;
  return createPortal(
    <Dialog
      title={`Restart the server into ${version}?`}
      closeLabel="Close the restart confirmation"
      onClose={onLater}
      role="alertdialog"
      size="sm"
      historyMode="none"
      footer={
        <>
          <Button variant="secondary" onClick={onLater}>
            Later
          </Button>
          <Button variant="secondary" onClick={onWhenIdle} disabled={pending}>
            When idle
          </Button>
          <Button variant="primary" onClick={onRestartNow} pending={pending}>
            Restart now
          </Button>
        </>
      }
    >
      <p className="station-dialog__message">
        The server stops, tries {version}, and returns to the current version if
        it does not start.
      </p>
      {turns.isPending && (
        <p className="station-dialog__message">Checking for running turns…</p>
      )}
      {turns.isError && (
        <p className="station-dialog__message" role="alert">
          Could not list the running agent turns. A restart interrupts any that
          are running.
        </p>
      )}
      {turns.isSuccess && total === 0 && (
        <p className="station-dialog__message">No agent turns are running.</p>
      )}
      {turns.isSuccess && total > 0 && (
        <>
          <p className="station-dialog__message">
            {total === 1
              ? 'This agent turn will be interrupted:'
              : `These ${total} agent turns will be interrupted:`}
          </p>
          <ul className="settings__update-running-turns">
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
