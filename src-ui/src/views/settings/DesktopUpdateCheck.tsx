import {
  DESKTOP_UPDATE_DOWNLOAD_POLICIES,
  type DesktopUpdateDownloadPolicy,
  type DesktopUpdateState,
} from '@kontourai/station-contracts/desktop-update';
import { useId, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { DesktopUpdateRestartDialog } from '../../components/desktop-update/DesktopUpdateRestartDialog';
import { downloadPercent } from '../../components/desktop-update/desktopUpdatePresentation';
import { useDesktopUpdateState } from '../../components/desktop-update/useDesktopUpdateState';
import { SkeletonBlock } from '../../components/state';
import {
  checkForDesktopUpdate,
  downloadDesktopUpdate,
  setDesktopUpdatePolicy,
} from '../../platform/native/desktopUpdate';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { formatBytes } from '../../utils/formatBytes';
import { TechnicalDetails } from './coreUpdatePresentation';
import '../../components/desktop-update/DesktopUpdate.css';

const POLICY_LABELS: Record<DesktopUpdateDownloadPolicy, string> = {
  never: 'Never',
  'after-24h': 'After 24 hours',
  immediately: 'Immediately',
};

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function StatusLine({ state }: { state: DesktopUpdateState }) {
  const { phase, currentVersion } = state;
  switch (phase.status) {
    case 'disabled':
      return (
        <p role="status">
          This build of Station {currentVersion} has no desktop update channel,
          so it does not check for updates.
        </p>
      );
    case 'idle':
      return (
        <p role="status">
          Station {currentVersion}. It checks for updates while it runs.
        </p>
      );
    case 'checking':
      return (
        <SkeletonBlock count={1} label="Checking for desktop app updates" />
      );
    case 'up-to-date':
      return (
        <p role="status">
          Station {currentVersion} is up to date. Last checked{' '}
          {formatTime(phase.checkedAt)}.
        </p>
      );
    case 'available':
      return (
        <p role="status">
          Station {phase.version} is available (you have {currentVersion}).{' '}
          {state.autoDownloadAt === null
            ? 'It downloads when you choose.'
            : state.autoDownloadAt <= Date.now()
              ? 'It downloads automatically at the next check.'
              : `It downloads automatically after ${formatTime(state.autoDownloadAt)}.`}
        </p>
      );
    case 'downloading': {
      const percent = downloadPercent(phase.downloadedBytes, phase.totalBytes);
      return (
        <div className="desktop-update-settings__progress">
          <progress
            aria-label={`Downloading Station ${phase.version}`}
            max={100}
            value={percent ?? undefined}
          />
          <span role="status">
            Downloading Station {phase.version}:{' '}
            {phase.totalBytes === null
              ? formatBytes(phase.downloadedBytes)
              : `${formatBytes(phase.downloadedBytes)} of ${formatBytes(phase.totalBytes)}`}
          </span>
        </div>
      );
    }
    case 'ready':
      return (
        <p role="status">
          Station {phase.version} is downloaded. Restart Station to install it.
        </p>
      );
    case 'installing':
      return <p role="status">Installing Station {phase.version}…</p>;
  }
}

const ERROR_LEADS = {
  check: 'Could not check for desktop app updates.',
  download: 'The download did not complete.',
  install: 'The update did not install, and Station did not restart.',
} as const;

/**
 * The Settings card for the desktop app's own updates (#3851): the native
 * state, its progress, the automatic-download policy and a manual check.
 * Unlike the chrome control, check failures are shown here.
 */
export function DesktopUpdateCheck() {
  const { target, isDesktop } = usePlatformProfile();
  const state = useDesktopUpdateState(isDesktop);
  const [confirming, setConfirming] = useState(false);
  const [requestError, setRequestError] = useState<{
    lead: string;
    detail: string;
  } | null>(null);
  const policyId = useId();
  const restartRef = useRef<HTMLButtonElement>(null);

  if (!state) {
    return (
      <div className="settings__update-check">
        <SkeletonBlock count={1} label="Reading desktop app update state" />
      </div>
    );
  }

  const { phase, error } = state;
  const request = (lead: string, action: () => Promise<void>) => {
    setRequestError(null);
    action().catch((cause: unknown) =>
      setRequestError({
        lead,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };
  const canCheck =
    phase.status === 'idle' ||
    phase.status === 'up-to-date' ||
    phase.status === 'available';

  return (
    <div className="settings__update-check">
      <StatusLine state={state} />
      {phase.status === 'available' && phase.notes && (
        <details>
          <summary>What’s new in {phase.version}</summary>
          <p className="settings__field-hint">{phase.notes}</p>
        </details>
      )}
      {error && (
        <>
          {/* The updater's text is disclosed verbatim, never classified. */}
          <p role="alert">{ERROR_LEADS[error.context]}</p>
          <TechnicalDetails detail={error.message} />
        </>
      )}
      {requestError && (
        <>
          <p role="alert">{requestError.lead}</p>
          <TechnicalDetails detail={requestError.detail} />
        </>
      )}
      {phase.status !== 'disabled' && (
        <ActionRow
          overflowLabel="More desktop update actions"
          primary={
            phase.status === 'available' ? (
              <Button
                variant="primary"
                onClick={() =>
                  request(
                    'Station could not start the download.',
                    downloadDesktopUpdate,
                  )
                }
              >
                {error?.context === 'download'
                  ? 'Retry download'
                  : 'Download update'}
              </Button>
            ) : phase.status === 'ready' || phase.status === 'installing' ? (
              <Button
                ref={restartRef}
                variant="primary"
                pending={phase.status === 'installing'}
                aria-haspopup="dialog"
                onClick={() => setConfirming(true)}
              >
                Restart to update…
              </Button>
            ) : undefined
          }
          secondary={
            canCheck || phase.status === 'checking' ? (
              <Button
                disabled={!canCheck}
                pending={phase.status === 'checking'}
                onClick={() =>
                  request(
                    'Station could not start a desktop update check.',
                    checkForDesktopUpdate,
                  )
                }
              >
                Check for desktop app updates
              </Button>
            ) : undefined
          }
        />
      )}
      {phase.status !== 'disabled' && (
        <div className="settings__field">
          <label className="settings__field-label" htmlFor={policyId}>
            Automatic download
          </label>
          <select
            id={policyId}
            value={state.policy}
            onChange={(event) =>
              request(
                'Station could not save the automatic download setting.',
                () =>
                  setDesktopUpdatePolicy(
                    event.target.value as DesktopUpdateDownloadPolicy,
                  ),
              )
            }
          >
            {DESKTOP_UPDATE_DOWNLOAD_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {POLICY_LABELS[policy]}
              </option>
            ))}
          </select>
          <span className="settings__field-hint">
            When an available update downloads without a click. Downloading
            never restarts Station.
          </span>
        </div>
      )}
      <span className="settings__field-hint">
        Updates Station on this {target === 'macos' ? 'Mac' : 'computer'},
        including its built-in server. Station restarts only when you confirm.
      </span>
      {confirming && (
        <DesktopUpdateRestartDialog
          state={state}
          onClose={() => setConfirming(false)}
          returnFocusTarget={restartRef.current}
        />
      )}
    </div>
  );
}
