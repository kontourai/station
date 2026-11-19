import type {
  DesktopUpdateError,
  DesktopUpdateState,
} from '@kontourai/station-contracts/desktop-update';
import type { ServerUpdateRunningTurns } from '@kontourai/station-contracts/system-status';
import { useServerUpdateRunningTurnsQuery } from '@kontourai/station-sdk';
import { displayMultilineText } from '@kontourai/station-shared/display-text';
import { useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { installDesktopUpdateAndRestart } from '../../platform/native/desktopUpdate';
import { describeStationFailure } from '../../utils/stationFailure';
import { TechnicalDetails } from '../../views/settings/coreUpdatePresentation';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonList } from '../state';
import { desktopInstallFailureMessage } from './desktopUpdatePresentation';
import type { DesktopRestartServerImpact } from './restartImpact';
import { useDesktopRestartServerImpact } from './useDesktopRestartServerImpact';
import './DesktopUpdate.css';

type TurnsRead =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: ServerUpdateRunningTurns };

interface DesktopUpdateRestartDialogViewProps {
  version: string;
  currentVersion: string;
  impact: DesktopRestartServerImpact;
  turns: TurnsRead;
  installing: boolean;
  /** The last install attempt's failure, when it is the latest outcome. */
  installError: Pick<DesktopUpdateError, 'message' | 'reason'> | null;
  onRestart: () => void;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}

function ImpactCopy({ impact }: { impact: DesktopRestartServerImpact }) {
  switch (impact) {
    case 'sidecar-restarts':
      return <p>Station’s built-in server restarts with the app.</p>;
    case 'service-keeps-running':
      return <p>The Station service and its agents keep running.</p>;
    case 'other-server-keeps-running':
      return <p>The connected Station server and its agents keep running.</p>;
    default:
      return (
        <p>
          Station could not confirm whether its server restarts with the app. If
          it does, running agent turns are interrupted.
        </p>
      );
  }
}

function TurnsCopy({ turns }: { turns: TurnsRead }) {
  if (turns.status === 'pending') {
    return (
      <SkeletonList
        count={2}
        withIcon={false}
        label="Checking for running agent turns"
      />
    );
  }
  if (turns.status === 'unavailable') {
    return (
      <p role="alert">
        Station could not list running agent turns. Any that are running will be
        interrupted.
      </p>
    );
  }
  const { turns: listed, hiddenCount } = turns.data;
  const total = listed.length + hiddenCount;
  if (total === 0) return <p>Nothing is running right now.</p>;
  return (
    <>
      <p>
        {total === 1
          ? 'Restarting will interrupt 1 running agent turn.'
          : `Restarting will interrupt ${total} running agent turns.`}
      </p>
      {listed.length > 0 && (
        <ul className="desktop-update-dialog__turns">
          {listed.map((turn) => (
            <li key={turn.sessionId}>
              {turn.title ?? 'Untitled conversation'}
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <p>
          {hiddenCount} running {hiddenCount === 1 ? 'turn is' : 'turns are'}{' '}
          private.
        </p>
      )}
    </>
  );
}

/** Presentation only; {@link DesktopUpdateRestartDialog} supplies the facts. */
function DesktopUpdateRestartDialogView({
  version,
  currentVersion,
  impact,
  turns,
  installing,
  installError,
  onRestart,
  onClose,
  returnFocusTarget,
}: DesktopUpdateRestartDialogViewProps) {
  const turnsMatter = impact === 'sidecar-restarts';
  // Restart is offered only once the user can see what it interrupts.
  const awaitingTurns = turnsMatter && turns.status === 'pending';
  return (
    <Dialog
      title={
        installing
          ? 'Installing Station update…'
          : installError
            ? 'Station update failed'
            : 'Restart Station to update?'
      }
      closeLabel="Close update dialog"
      onClose={onClose}
      dismissible={!installing}
      hideClose={installing}
      historyMode="none"
      returnFocusTarget={returnFocusTarget}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={installing}>
            Later
          </Button>
          <Button
            variant="primary"
            onClick={onRestart}
            disabled={awaitingTurns}
            pending={installing}
            pendingLabel="Installing…"
          >
            {installError ? 'Retry install' : 'Restart now'}
          </Button>
        </>
      }
    >
      <div className="desktop-update-dialog">
        {installError && (
          <p role="alert">
            {desktopInstallFailureMessage(installError.reason)}
          </p>
        )}
        <p>Installed version {currentVersion}</p>
        <p>Update version {version}</p>
        <ImpactCopy impact={impact} />
        {turnsMatter && <TurnsCopy turns={turns} />}
        {installError && (
          <TechnicalDetails
            detail={displayMultilineText(installError.message)}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * The restart confirmation (#3851): nothing installs or restarts until the
 * user picks Restart now here. Lists the agent turns the restart interrupts
 * when this app's own server restarts with it.
 */
export function DesktopUpdateRestartDialog({
  state,
  onClose,
  returnFocusTarget,
}: {
  state: DesktopUpdateState;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const impact = useDesktopRestartServerImpact();
  const { apiBase } = useApiBase();
  const runningTurns = useServerUpdateRunningTurnsQuery(apiBase, {
    enabled: impact === 'sidecar-restarts',
  });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const phase = state.phase;
  const version =
    phase.status === 'ready' || phase.status === 'installing'
      ? phase.version
      : null;
  const installing = phase.status === 'installing' || requested;
  // A failed install returns to `ready` with an install error; that is the
  // answer to this dialog's request.
  const installError = requested
    ? null
    : requestError
      ? { message: requestError }
      : phase.status === 'ready' && state.error?.context === 'install'
        ? state.error
        : null;

  if (version === null) return null;

  const turns: TurnsRead = runningTurns.isError
    ? { status: 'unavailable' }
    : runningTurns.data === undefined || runningTurns.isFetching
      ? { status: 'pending' }
      : { status: 'ready', data: runningTurns.data };

  return (
    <DesktopUpdateRestartDialogView
      version={version}
      currentVersion={state.currentVersion}
      impact={impact}
      turns={turns}
      installing={installing}
      installError={installError}
      returnFocusTarget={returnFocusTarget}
      onClose={onClose}
      onRestart={() => {
        setRequestError(null);
        setRequested(true);
        installDesktopUpdateAndRestart().then(
          // On success the app restarts before this resolves. Any answer
          // that is not `installing` (a failed install, or a refusal because
          // nothing was ready) ends this request.
          (answer) => {
            if (answer.phase.status !== 'installing') setRequested(false);
          },
          (error: unknown) => {
            setRequested(false);
            setRequestError(describeStationFailure(error).body);
          },
        );
      }}
    />
  );
}
