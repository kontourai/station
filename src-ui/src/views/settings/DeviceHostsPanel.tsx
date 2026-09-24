import {
  DEVICE_SSH_HOST_GUIDANCE,
  type DeviceHostCheckResult,
  type DeviceHostCheckStep,
  type DeviceSshHostFailure,
  type DeviceSshHostView,
} from '@kontourai/station-contracts/mobile-device';
import { DeviceHostRequestError } from '@kontourai/station-sdk/mobile-device';
import {
  useAddDeviceSshHostMutation,
  useCheckDeviceSshHostMutation,
  useDeviceSshHostsQuery,
  useRemoveDeviceSshHostMutation,
  useSetDeviceSshHubMutation,
  useStartDeviceSshHubMutation,
  useUpdateDeviceSshHostMutation,
} from '@kontourai/station-sdk/mobile-devices-query';
import { type FormEvent, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { DeviceShares } from '../../workspace-panes/device/DeviceShares';
import '../../workspace-panes/device/DeviceSetupWizard.css';
import './DeviceHostsPanel.css';

/**
 * Settings › Device hosts (#1973, D11): run simulators and emulators on
 * another Mac or Linux machine reached over SSH, shown in the same Device
 * pane.
 *
 * Adapted in shape from t3code's device host settings
 * (apps/web/src/components/settings/DeviceHostsSettings.tsx and
 * DeviceHostEditor.tsx; MIT License, Copyright (c) 2026 T3 Tools Inc.):
 * a list with add/edit/remove and a per-host "Test connection" that shows
 * each step. Station differs: no key file is ever entered (the operator's
 * own ssh agent and config sign in), an unknown host key is a typed stop the
 * operator resolves in a terminal, and installing the hub there is an
 * explicit consent.
 */

const STEP_LABEL: Record<DeviceHostCheckStep['id'], string> = {
  ssh: 'Reach the host over ssh',
  'host-key': 'Host key is known',
  node: 'Node.js on the host',
  ios: 'Xcode simulators',
  android: 'Android SDK',
  'hub-installed': 'Device hub installed',
  'hub-running': 'Device hub running',
};

const STEP_STATE: Record<DeviceHostCheckStep['state'], string> = {
  pass: 'OK',
  fail: 'Failed',
  warn: 'Not available',
  skipped: 'Not checked',
};

const REFUSAL_COPY: Record<string, string> = {
  'invalid-target':
    'Use user@host, user@host:port, or an alias from your ssh config.',
  'invalid-label': 'Give the host a short name.',
  duplicate: 'That host is already listed.',
  'too-many': 'This Station already has as many device hosts as it allows.',
  'consent-required': 'Installing the hub needs your explicit agreement.',
  'not-found': 'That host is no longer listed.',
};

function refusalText(error: unknown): string {
  if (error instanceof DeviceHostRequestError && error.code)
    return REFUSAL_COPY[error.code] ?? 'The request was refused.';
  return 'The request could not be completed.';
}

function hubText(host: DeviceSshHostView): string {
  if (!host.hubEnabled) return 'Device hub not enabled';
  const install = host.install;
  if (install.state === 'installing') return 'Installing the device hub…';
  if (install.state === 'failed')
    return `Install failed: ${DEVICE_SSH_HOST_GUIDANCE[install.failure]}`;
  const hub = host.hub;
  switch (hub.state) {
    case 'running':
      return 'Device hub running';
    case 'starting':
      return 'Starting the device hub…';
    case 'restarting':
      return `Reconnecting (attempt ${hub.attempt})…`;
    case 'failed':
      return DEVICE_SSH_HOST_GUIDANCE[hub.failure];
    default:
      return 'Device hub enabled; it starts when a device is opened';
  }
}

export function DeviceHostsPanel() {
  const scope = useHostRequestAuthorityScope();
  if (!scope)
    return (
      <p className="device-hosts__intro">
        Device hosts are available once this Station is authorized.
      </p>
    );
  return <DeviceHostsList scope={scope} />;
}

function DeviceHostsList({
  scope,
}: {
  scope: { apiBase: string; authorityKey: string };
}) {
  // Installs and hub starts finish in the background: keep the list fresh
  // while Settings is open (an in-memory read on the server).
  const hosts = useDeviceSshHostsQuery(scope, { refetchInterval: 5_000 });
  const [adding, setAdding] = useState(false);

  // Not the operator, or not a personal Station: the section says nothing.
  if (
    hosts.error instanceof DeviceHostRequestError &&
    (hosts.error.status === 403 || hosts.error.status === 404)
  )
    return (
      <p className="device-hosts__intro">
        Device hosts are managed by the Station operator on a personal Station.
      </p>
    );

  return (
    <div className="device-hosts">
      <p className="device-hosts__intro">
        Run simulators and emulators on another Mac or Linux machine. Station
        signs in with your own ssh agent and config and never stores a key.
        Confirm a new host&rsquo;s key once from a terminal (
        <code>ssh user@host</code>) before adding it here.
      </p>
      {hosts.isLoading ? <Skeleton variant="line" /> : null}
      {hosts.isError ? (
        <ErrorState
          variant="compact"
          title="Device hosts could not be listed"
          description={refusalText(hosts.error)}
          action={
            <Button size="sm" onClick={() => void hosts.refetch()}>
              Retry
            </Button>
          }
        />
      ) : null}
      {hosts.data?.length === 0 && !adding ? (
        <Empty
          variant="compact"
          label="Add a machine to get started"
          description="Add a machine to run its simulators and emulators from the Device pane."
        />
      ) : null}
      {hosts.data && hosts.data.length > 0 ? (
        <ul className="device-hosts__list">
          {hosts.data.map((host) => (
            <DeviceHostRow host={host} key={host.hostId} scope={scope} />
          ))}
        </ul>
      ) : null}
      {adding ? (
        <DeviceHostForm
          onDone={() => setAdding(false)}
          scope={scope}
          submitLabel="Add host"
        />
      ) : (
        <div className="device-hosts__actions">
          <Button onClick={() => setAdding(true)} variant="primary">
            Add device host
          </Button>
        </div>
      )}
    </div>
  );
}

function DeviceHostForm({
  scope,
  host,
  submitLabel,
  onDone,
}: {
  scope: { apiBase: string; authorityKey: string };
  host?: DeviceSshHostView;
  submitLabel: string;
  onDone: () => void;
}) {
  const add = useAddDeviceSshHostMutation(scope);
  const update = useUpdateDeviceSshHostMutation(scope);
  const [label, setLabel] = useState(host?.label ?? '');
  const [sshTarget, setSshTarget] = useState(host?.sshTarget ?? '');
  const mutation = host ? update : add;
  const idPrefix = host ? `device-host-${host.hostId}` : 'device-host-new';

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (host && label === host.label && sshTarget === host.sshTarget) {
        onDone();
        return;
      }
      if (host)
        await update.mutateAsync({
          hostId: host.hostId,
          ...(label !== host.label ? { label } : {}),
          ...(sshTarget !== host.sshTarget ? { sshTarget } : {}),
        });
      else await add.mutateAsync({ label, sshTarget });
      onDone();
    } catch {
      // Shown below from the mutation's own error.
    }
  }

  return (
    <form
      className="device-hosts__form"
      onSubmit={(event) => void submit(event)}
    >
      <label className="device-hosts__field" htmlFor={`${idPrefix}-label`}>
        Name
        <input
          autoComplete="off"
          id={`${idPrefix}-label`}
          maxLength={80}
          onChange={(event) => setLabel(event.currentTarget.value)}
          required
          value={label}
        />
      </label>
      <label className="device-hosts__field" htmlFor={`${idPrefix}-target`}>
        SSH target
        <input
          autoCapitalize="off"
          autoComplete="off"
          id={`${idPrefix}-target`}
          maxLength={255}
          onChange={(event) => setSshTarget(event.currentTarget.value)}
          placeholder="me@mac-mini.local or an ssh config alias"
          required
          spellCheck={false}
          value={sshTarget}
        />
      </label>
      {host && sshTarget !== host.sshTarget && host.hubEnabled ? (
        <p className="device-hosts__note">
          Changing the target turns the device hub off for this host until you
          enable it again on the new machine.
        </p>
      ) : null}
      {mutation.isError ? (
        <p className="device-hosts__error" role="alert">
          {refusalText(mutation.error)}
        </p>
      ) : null}
      <div className="device-hosts__actions">
        <Button
          pending={mutation.isPending}
          pendingLabel="Saving…"
          type="submit"
          variant="primary"
        >
          {submitLabel}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function DeviceHostRow({
  scope,
  host,
}: {
  scope: { apiBase: string; authorityKey: string };
  host: DeviceSshHostView;
}) {
  const check = useCheckDeviceSshHostMutation(scope);
  const remove = useRemoveDeviceSshHostMutation(scope);
  const setHub = useSetDeviceSshHubMutation(scope);
  const startHub = useStartDeviceSshHubMutation(scope);
  const [mode, setMode] = useState<'idle' | 'edit' | 'remove' | 'consent'>(
    'idle',
  );
  const [result, setResult] = useState<DeviceHostCheckResult | null>(null);
  // D12 on this host: which Projects may use which of its devices.
  const [sharing, setSharing] = useState(false);
  const busy =
    check.isPending ||
    remove.isPending ||
    setHub.isPending ||
    startHub.isPending;

  async function test() {
    setResult(null);
    try {
      setResult(await check.mutateAsync(host.hostId));
    } catch {
      // Shown from the mutation's error.
    }
  }

  if (mode === 'edit')
    return (
      <li className="device-hosts__row">
        <DeviceHostForm
          host={host}
          onDone={() => setMode('idle')}
          scope={scope}
          submitLabel="Save host"
        />
      </li>
    );

  return (
    <li className="device-hosts__row">
      <div className="device-hosts__body">
        <span className="device-hosts__name">{host.label}</span>
        <span className="device-hosts__meta">
          <code>{host.sshTarget}</code>
        </span>
        <span className="device-hosts__meta" role="status">
          {hubText(host)}
        </span>
      </div>
      {mode === 'consent' ? (
        <div className="device-hosts__confirm">
          <p>
            Station will copy the device hub it verified on this Station to{' '}
            {host.label} (into <code>~/.station-device-host</code>) and run it
            there, on that machine&rsquo;s loopback only, whenever a device on
            it is opened.
          </p>
          <div className="device-hosts__actions">
            <Button
              onClick={() => {
                setMode('idle');
                setHub.mutate({
                  hostId: host.hostId,
                  enabled: true,
                  consent: true,
                });
              }}
              variant="primary"
            >
              Install and enable
            </Button>
            <Button onClick={() => setMode('idle')}>Cancel</Button>
          </div>
        </div>
      ) : mode === 'remove' ? (
        <div className="device-hosts__confirm">
          <p>Remove {host.label}? Its device sessions end and its hub stops.</p>
          <div className="device-hosts__actions">
            <Button
              onClick={() => remove.mutate(host.hostId)}
              pending={remove.isPending}
              pendingLabel="Removing…"
              variant="danger"
            >
              Remove host
            </Button>
            <Button disabled={remove.isPending} onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="device-hosts__actions">
          <Button
            onClick={() => void test()}
            pending={check.isPending}
            pendingLabel="Testing…"
          >
            Test connection
          </Button>
          {host.hubEnabled ? (
            <>
              {host.hub.state === 'failed' || host.hub.state === 'stopped' ? (
                <Button
                  disabled={busy}
                  onClick={() => startHub.mutate(host.hostId)}
                  pending={startHub.isPending}
                  pendingLabel={
                    host.hub.state === 'failed' &&
                    host.hub.failure === 'hub-not-installed'
                      ? 'Reinstalling…'
                      : 'Starting…'
                  }
                >
                  {host.hub.state === 'failed' &&
                  host.hub.failure === 'hub-not-installed'
                    ? 'Reinstall hub'
                    : host.hub.state === 'failed'
                      ? 'Retry hub'
                      : 'Start hub'}
                </Button>
              ) : null}
              <Button
                disabled={busy}
                onClick={() =>
                  setHub.mutate({ hostId: host.hostId, enabled: false })
                }
              >
                Disable hub
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => setMode('consent')}>
              Enable device hub
            </Button>
          )}
          {host.hubEnabled ? (
            <Button
              aria-expanded={sharing}
              onClick={() => setSharing((open) => !open)}
            >
              {sharing ? 'Hide sharing' : 'Share devices…'}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={() => setMode('edit')}>
            Edit
          </Button>
          <Button
            disabled={busy}
            onClick={() => setMode('remove')}
            variant="danger-outline"
          >
            Remove
          </Button>
        </div>
      )}
      {check.isError || setHub.isError || startHub.isError || remove.isError ? (
        <p className="device-hosts__error" role="alert">
          {refusalText(
            check.error ?? setHub.error ?? startHub.error ?? remove.error,
          )}
        </p>
      ) : null}
      {result ? <CheckSteps result={result} /> : null}
      {sharing && host.hubEnabled ? (
        <DeviceShares hostId={host.hostId} requestScope={scope} />
      ) : null}
    </li>
  );
}

function CheckSteps({ result }: { result: DeviceHostCheckResult }) {
  const failure: DeviceSshHostFailure | undefined = result.failure;
  return (
    <div className="device-hosts__check">
      <ol aria-label="Connection test" className="device-hosts__steps">
        {result.steps.map((step) => (
          <li
            className={`device-hosts__step device-hosts__step--${step.state}`}
            key={step.id}
          >
            <span className="device-hosts__step-label">
              {STEP_LABEL[step.id]}
            </span>
            <span className="device-hosts__step-state">
              {STEP_STATE[step.state]}
            </span>
            {step.detail ? (
              <span className="device-hosts__step-detail">{step.detail}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="device-hosts__note" role="status">
        {result.ok
          ? 'This host is ready for devices.'
          : failure
            ? DEVICE_SSH_HOST_GUIDANCE[failure]
            : 'This host is not ready for devices yet.'}
      </p>
    </div>
  );
}
