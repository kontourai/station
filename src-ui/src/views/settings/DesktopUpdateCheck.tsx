import {
  DESKTOP_UPDATE_DOWNLOAD_POLICIES,
  type DesktopUpdateDownloadPolicy,
  type DesktopUpdateState,
} from '@kontourai/station-contracts/desktop-update';
import { Field, Select, type SemanticTone } from '@kontourai/ui/react';
import { useEffect, useId, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { DesktopUpdateRestartDialog } from '../../components/desktop-update/DesktopUpdateRestartDialog';
import { downloadPercent } from '../../components/desktop-update/desktopUpdatePresentation';
import { useDesktopRestartServerImpact } from '../../components/desktop-update/useDesktopRestartServerImpact';
import { useDesktopUpdateState } from '../../components/desktop-update/useDesktopUpdateState';
import { StatusSummary } from '../../components/StatusSummary';
import { SkeletonBlock } from '../../components/state';
import { ReleaseNotes } from '../../components/updates/ReleaseNotes';
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
  const { phase } = state;
  switch (phase.status) {
    case 'disabled':
    case 'idle':
      return null;
    case 'checking':
      return (
        <SkeletonBlock count={1} label="Checking for desktop app updates" />
      );
    case 'up-to-date':
      return null;
    case 'available':
      return (
        <p className="settings__field-hint">
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
        <p className="settings__field-hint">
          Restart to install the downloaded update.
        </p>
      );
    case 'installing':
      return null;
  }
}

const PHASE_BADGES: Record<
  DesktopUpdateState['phase']['status'],
  { label: string; tone: SemanticTone }
> = {
  disabled: { label: 'No update channel', tone: 'neutral' },
  idle: { label: 'Not checked', tone: 'neutral' },
  checking: { label: 'Checking', tone: 'active' },
  'up-to-date': { label: 'Up to date', tone: 'positive' },
  available: { label: 'Update available', tone: 'caution' },
  downloading: { label: 'Downloading', tone: 'active' },
  ready: { label: 'Ready to restart', tone: 'active' },
  installing: { label: 'Installing', tone: 'active' },
};

const ERROR_LEADS = {
  check: 'Could not check for desktop app updates.',
  download: 'The download did not complete.',
  install: 'The update did not install, and Station did not restart.',
} as const;

/**
 * The desktop app's update controls in Settings and Updates (#3851): the native
 * state, its progress, the automatic-download policy and a manual check.
 * Check failures are shown here rather than on the sidebar trigger.
 */
export function DesktopUpdateCheck({
  active = true,
  showPolicy = true,
  showReleaseNotes = false,
  title = 'Desktop app',
  headingId,
}: {
  active?: boolean;
  showPolicy?: boolean;
  showReleaseNotes?: boolean;
  title?: string;
  headingId?: string;
}) {
  const { target, isDesktop } = usePlatformProfile();
  const { state, error: readError, retry } = useDesktopUpdateState(isDesktop);
  const impact = useDesktopRestartServerImpact();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);
  const [requestError, setRequestError] = useState<{
    lead: string;
    detail: string;
  } | null>(null);
  const policyId = useId();
  const restartRef = useRef<HTMLButtonElement>(null);

  if (!state && readError) {
    return (
      <div className="settings__update-check content-stack">
        <StatusSummary
          title={title}
          headingId={headingId}
          badge={{ label: 'Unavailable', tone: 'negative' }}
        />
        <p role="alert">
          Station could not read the desktop app’s update state.
        </p>
        <TechnicalDetails detail={readError} />
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="settings__update-check content-stack">
        <StatusSummary title={title} headingId={headingId} />
        <SkeletonBlock count={1} label="Reading desktop app update state" />
      </div>
    );
  }

  const { phase, error } = state;
  const request = (lead: string, action: () => Promise<unknown>) => {
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
    <div className="settings__update-check content-stack">
      <StatusSummary
        title={title}
        headingId={headingId}
        current={state.currentVersion}
        target={'version' in phase ? phase.version : null}
        checkedAt={phase.status === 'up-to-date' ? phase.checkedAt : null}
        badge={
          error
            ? {
                label:
                  error.context === 'check'
                    ? 'Check failed'
                    : error.context === 'download'
                      ? 'Download failed'
                      : 'Install failed',
                tone: 'negative',
              }
            : PHASE_BADGES[phase.status]
        }
      />
      <StatusLine state={state} />
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
      {showReleaseNotes ? (
        <ReleaseNotes
          version={'version' in phase ? phase.version : state.currentVersion}
          nativeApp
          notes={phase.status === 'available' ? phase.notes : null}
          active={active}
          collapsible={phase.status === 'up-to-date' || phase.status === 'idle'}
        />
      ) : (
        phase.status === 'available' &&
        phase.notes && (
          <details>
            <summary>What’s new in {phase.version}</summary>
            <p className="settings__field-hint">{phase.notes}</p>
          </details>
        )
      )}
      {showPolicy && phase.status !== 'disabled' && (
        <Field
          label="Automatic download"
          htmlFor={policyId}
          hint="When an update downloads without a click. Downloading never restarts Station."
        >
          <Select
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
          </Select>
        </Field>
      )}
      <details className="settings__update-technical server-update__details">
        <summary>Details</summary>
        <p className="settings__field-hint">
          Updates Station on this {target === 'macos' ? 'Mac' : 'computer'}
          {impact === 'sidecar-restarts'
            ? ', including the built-in server this window uses'
            : ''}
          . Station restarts only when you confirm.
        </p>
      </details>
      {active && confirming && (
        <DesktopUpdateRestartDialog
          state={state}
          onClose={() => setConfirming(false)}
          returnFocusTarget={restartRef.current}
        />
      )}
    </div>
  );
}
