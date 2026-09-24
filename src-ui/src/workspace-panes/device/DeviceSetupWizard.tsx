import type {
  DevicePlatformReadiness,
  DeviceToolchainStatus,
  DeviceToolState,
} from '@kontourai/station-contracts/device-toolchain';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SkeletonBlock } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { DeviceShares } from './DeviceShares';
import { DeviceToolVersions } from './DeviceToolVersions';
import {
  type DeviceToolchainAction,
  DeviceToolchainRequestError,
  useDeviceToolchainAction,
  useDeviceToolchainStatus,
} from './deviceToolchainApi';
import './DeviceSetupWizard.css';

/**
 * Three-step device setup (#1970, D11): the device hub, simulator/emulator
 * readiness, and agent access. Each switch is the consent for what its step
 * says it installs; nothing is fetched until a switch is turned on. Every
 * status line is the server's derived state, polled while it moves.
 *
 * Adapted from t3code's `DeviceSetup.tsx` (MIT, © 2026 T3 Tools Inc.).
 */

const STEPS = ['Device hub', 'Simulators', 'Agent access'] as const;

const PHASE_LABEL = {
  preparing: 'preparing',
  downloading: 'downloading',
  verifying: 'verifying',
  publishing: 'finishing',
} as const;

const PLATFORM_COPY: Record<
  DevicePlatformReadiness['platform'],
  Record<DevicePlatformReadiness['reason'], string>
> = {
  ios: {
    ready: 'Xcode and iOS Simulator are available.',
    'requires-macos': 'iOS Simulators need macOS with Xcode.',
    'xcode-missing':
      'Xcode command line tools were not found. Install Xcode, then check again.',
    'android-sdk-missing': 'iOS support was not detected.',
    'adb-missing': 'iOS support was not detected.',
    'emulator-missing': 'iOS support was not detected.',
  },
  android: {
    ready: 'The Android SDK and Emulator are available.',
    'requires-macos': 'Android support was not detected.',
    'xcode-missing': 'Android support was not detected.',
    'android-sdk-missing':
      'The Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.',
    'adb-missing':
      "Android SDK Platform-Tools are missing. Install them in Android Studio's SDK Manager.",
    'emulator-missing':
      "The Android Emulator is missing. Install it in Android Studio's SDK Manager.",
  },
};

type Line = {
  tone: 'progress' | 'ready' | 'problem';
  text: string;
  action?: { label: string; run: DeviceToolchainAction };
};

function installLine(
  tool: DeviceToolState,
  name: string,
  retry: DeviceToolchainAction,
): Line | undefined {
  switch (tool.state) {
    case 'installing':
      return {
        tone: 'progress',
        text: `Installing ${name}… (step ${tool.step} of ${tool.totalSteps}: ${PHASE_LABEL[tool.phase]})`,
      };
    case 'failed':
      return {
        tone: 'problem',
        text: `Installing ${name} failed: ${tool.detail}`,
        ...(tool.retryable ? { action: { label: 'Retry', run: retry } } : {}),
      };
    case 'update-available':
      return {
        tone: 'problem',
        text: `${name} ${tool.installedVersion} is installed; Station now requires ${tool.requiredVersion}.`,
        action: {
          label: 'Update',
          run: { kind: 'update', tool: tool.tool },
        },
      };
    default:
      return undefined;
  }
}

function hubStatusLine(status: DeviceToolchainStatus): Line | undefined {
  if (status.hubSource === 'configured')
    return {
      tone: 'ready',
      text: 'Using the device hub configured with STATION_MOBILE_DEVICE_HUB_URL.',
    };
  if (!status.hubEnabled && status.hub.state !== 'installing') return undefined;
  const install = installLine(status.hub, 'the device hub', {
    kind: 'hub',
    enabled: true,
    consent: true,
  });
  if (install) return install;
  if (status.hub.state !== 'installed') return undefined;
  switch (status.hubProcess.state) {
    case 'starting':
      return { tone: 'progress', text: 'Starting the device hub…' };
    case 'restarting':
      return {
        tone: 'progress',
        text: 'The device hub stopped; Station is restarting it…',
      };
    case 'crashed':
      return {
        tone: 'problem',
        text: `The device hub stopped after repeated failures. ${status.hubProcess.detail}`,
        action: { label: 'Start again', run: { kind: 'start-hub' } },
      };
    case 'running':
      return { tone: 'ready', text: 'The device hub is ready.' };
    case 'stopped':
      return {
        tone: 'ready',
        text: 'The device hub is installed and starts when a device view needs it.',
      };
  }
}

function hubReady(status: DeviceToolchainStatus): boolean {
  return (
    status.hubSource === 'configured' ||
    (status.hubEnabled &&
      status.hub.state === 'installed' &&
      status.hubProcess.state !== 'crashed')
  );
}

function StatusLine({
  line,
  pending,
  onRun,
}: {
  line: Line | undefined;
  pending: boolean;
  onRun: (action: DeviceToolchainAction) => void;
}) {
  if (!line) return null;
  return (
    <div
      className={`device-setup__status device-setup__status--${line.tone}`}
      role={line.tone === 'problem' ? 'alert' : 'status'}
    >
      <p>{line.text}</p>
      {line.action ? (
        <Button
          size="sm"
          pending={pending}
          onClick={() => line.action && onRun(line.action.run)}
        >
          {line.action.label}
        </Button>
      ) : null}
    </div>
  );
}

function Choice({
  title,
  description,
  label,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string;
  description: ReactNode;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <section className="device-setup__step">
      <h3 className="device-setup__step-title">{title}</h3>
      <div className="device-setup__choice">
        <div id={descriptionId} className="device-setup__muted">
          {description}
        </div>
        <span className="device-setup__toggle">
          <Toggle
            checked={checked}
            disabled={disabled}
            label={label}
            describedBy={descriptionId}
            onChange={onChange}
          />
        </span>
      </div>
      {children}
    </section>
  );
}

export default function DeviceSetupWizard({
  requestScope,
  onClose,
}: {
  requestScope: ApiRequestScope;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const status = useDeviceToolchainStatus(requestScope);
  const action = useDeviceToolchainAction(requestScope);
  const run = (next: DeviceToolchainAction) => action.mutate(next);
  const refused =
    (status.error instanceof DeviceToolchainRequestError &&
      status.error.status === 403) ||
    (action.error instanceof DeviceToolchainRequestError &&
      action.error.status === 403);

  let body: ReactNode;
  if (refused || status.data?.canManage === false) {
    body = <p role="alert">Ask the Station operator to set up devices.</p>;
  } else if (status.isPending) {
    body = (
      <SkeletonBlock count={2} label="Checking this Station's device setup" />
    );
  } else if (status.isError) {
    body = (
      <div role="alert" className="device-setup__status">
        <p>The device setup could not be read.</p>
        <Button size="sm" onClick={() => void status.refetch()}>
          Check again
        </Button>
      </div>
    );
  } else {
    const data = status.data;
    const busy =
      action.isPending ||
      data.hub.state === 'installing' ||
      data.agentDevice.state === 'installing';
    if (step === 0) {
      body = (
        <Choice
          title="Enable the device hub"
          label="Enable device hub"
          checked={data.hubEnabled || data.hubSource === 'configured'}
          disabled={busy || data.hubSource === 'configured'}
          description={
            <>
              <p>
                Station installs expo-device-hub{' '}
                {data.hub.state === 'installed'
                  ? data.hub.version
                  : data.hub.requiredVersion}{' '}
                from npm into its own home. Station runs the device hub locally
                and only answers requests from Station itself. It lets you open
                simulators and emulators here.
              </p>
              <p>Turning this on is your consent to that download.</p>
            </>
          }
          onChange={(checked) =>
            run(
              checked
                ? { kind: 'hub', enabled: true, consent: true }
                : { kind: 'hub', enabled: false },
            )
          }
        >
          <StatusLine
            line={hubStatusLine(data)}
            pending={action.isPending}
            onRun={run}
          />
        </Choice>
      );
    } else if (step === 1) {
      body = (
        <section className="device-setup__step">
          <h3 className="device-setup__step-title">Check simulator support</h3>
          <ul className="device-setup__platforms">
            {data.platforms.map((platform) => (
              <li
                key={platform.platform}
                className={`device-setup__platform${platform.ready ? ' device-setup__platform--ready' : ''}`}
              >
                <strong>
                  {platform.platform === 'ios' ? 'iOS' : 'Android'}
                </strong>
                <span>{PLATFORM_COPY[platform.platform][platform.reason]}</span>
              </li>
            ))}
          </ul>
          <p className="device-setup__muted">
            You can use either platform. A missing one does not block the other.
          </p>
          <Button
            size="sm"
            pending={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Check again
          </Button>
          {hubReady(data) ? (
            <>
              <h3 className="device-setup__step-title">Share with Projects</h3>
              <p className="device-setup__muted">
                Devices are yours. Admins of a Project can view and control only
                the devices you share with it.
              </p>
              <DeviceShares requestScope={requestScope} />
            </>
          ) : null}
        </section>
      );
    } else {
      body = (
        <Choice
          title="Allow agent control"
          label="Allow agents to control devices"
          checked={data.agentAccess}
          disabled={busy}
          description={
            <>
              <p>
                Lets agent sessions on this Station control simulators and
                emulators. Station installs agent-device{' '}
                {data.agentDevice.state === 'installed'
                  ? data.agentDevice.version
                  : data.agentDevice.requiredVersion}{' '}
                from npm when you turn this on.
              </p>
              <p>
                Leave this off to keep manual device controls without giving
                agents access.
              </p>
            </>
          }
          onChange={(checked) =>
            run(
              checked
                ? { kind: 'agent-access', enabled: true, consent: true }
                : { kind: 'agent-access', enabled: false },
            )
          }
        >
          <StatusLine
            line={
              data.agentAccess && data.agentDevice.state === 'installed'
                ? { tone: 'ready', text: 'Agent tools are ready.' }
                : data.agentAccess || data.agentDevice.state === 'installing'
                  ? installLine(data.agentDevice, 'agent tools', {
                      kind: 'agent-access',
                      enabled: true,
                      consent: true,
                    })
                  : undefined
            }
            pending={action.isPending}
            onRun={run}
          />
        </Choice>
      );
    }
  }

  const canContinue =
    !refused &&
    status.data !== undefined &&
    status.data.canManage !== false &&
    hubReady(status.data);
  return (
    <Dialog
      title="Set up devices"
      subtitle="Review what runs on this Station before using simulators and emulators."
      closeLabel="Close device setup"
      onClose={onClose}
      footer={
        <>
          {step === 0 ? (
            <Button onClick={onClose}>Cancel</Button>
          ) : (
            <Button onClick={() => setStep(step - 1)}>Back</Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button
              variant="primary"
              disabled={!canContinue}
              onClick={() => setStep(step + 1)}
            >
              Continue
            </Button>
          ) : (
            <Button variant="primary" disabled={!canContinue} onClick={onClose}>
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="device-setup">
        <ol className="device-setup__steps" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? 'step' : undefined}
              className={
                index === step
                  ? 'device-setup__step-label device-setup__step-label--current'
                  : 'device-setup__step-label'
              }
            >
              {label}
            </li>
          ))}
        </ol>
        {body}
        {action.isError && !refused ? (
          <p role="alert" className="device-setup__status--problem">
            That change did not go through. Try again.
          </p>
        ) : null}
        <DeviceToolVersions requestScope={requestScope} />
      </div>
    </Dialog>
  );
}
