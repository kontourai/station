import {
  useControlTelemetryCompanionMutation,
  useInstallTelemetryCompanionMutation,
  useTelemetryCompanionActionQuery,
  useTelemetryCompanionInstallationQuery,
  useTelemetryCompanionManagedStateQuery,
  useTelemetryCompanionPreparationStateQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { CompanionProductTrends } from './CompanionProductTrends';
import { newCompanionOperationId } from './companion-operation-id';
import './CompanionManaged.css';

function refused(error: unknown) {
  return (
    error instanceof StationHttpError &&
    [400, 409, 413, 501].includes(error.status)
  );
}

export function CompanionManaged({
  authority,
  hostReady,
  architecture,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  hostReady: boolean;
  architecture: 'amd64' | 'arm64' | null;
}) {
  const state = useTelemetryCompanionManagedStateQuery(authority.apiBase, {
    requestScope: authority,
    keepPreviousData: false,
  });
  const preparation = useTelemetryCompanionPreparationStateQuery(
    authority.apiBase,
    { requestScope: authority, keepPreviousData: false },
  );
  const install = useInstallTelemetryCompanionMutation(authority.apiBase, {
    requestScope: authority,
  });
  const control = useControlTelemetryCompanionMutation(authority.apiBase, {
    requestScope: authority,
  });
  const installationReceipt = useTelemetryCompanionInstallationQuery(
    authority.apiBase,
    install.variables?.installationId ?? null,
    {
      requestScope: authority,
      keepPreviousData: false,
      enabled: install.isError,
    },
  );
  const actionReceipt = useTelemetryCompanionActionQuery(
    authority.apiBase,
    control.variables?.installationId ?? null,
    control.variables?.operationId ?? null,
    {
      requestScope: authority,
      keepPreviousData: false,
      enabled: control.isError,
    },
  );
  const [storageChosen, setStorageChosen] = useState(false);
  const pending = install.isPending || control.isPending;
  const check = () => {
    void state.refetch();
    void preparation.refetch();
    if (install.isError && install.variables)
      void installationReceipt.refetch();
    if (control.isError && control.variables) void actionReceipt.refetch();
  };
  const checkButton = (
    <Button
      variant="secondary"
      disabled={
        state.isFetching ||
        preparation.isFetching ||
        installationReceipt.isFetching ||
        actionReceipt.isFetching
      }
      onClick={check}
    >
      Check companion status
    </Button>
  );
  const pendingText = pending ? (
    <p role="status">
      {install.isPending
        ? 'Installing companion…'
        : control.variables?.action === 'stop'
          ? 'Stopping companion…'
          : 'Starting companion…'}
    </p>
  ) : null;
  if (state.isError)
    return (
      <section className="companion-managed" aria-label="Managed companion">
        <p role="alert">
          Companion controls are unavailable. Check the selected Station's
          connection, permissions or server version.
        </p>
        {pendingText}
        {checkButton}
      </section>
    );
  if (!state.data || state.isFetching)
    return (
      <section className="companion-managed" aria-label="Managed companion">
        {pendingText}
        <SkeletonBlock count={1} label="Checking managed companion" />
      </section>
    );
  const current = state.data;
  const installed = current.installation;
  const prepared =
    !preparation.isError && !preparation.isFetching
      ? preparation.data
      : undefined;
  const directInstall =
    !installationReceipt.isError &&
    !installationReceipt.isFetching &&
    installationReceipt.data &&
    installationReceipt.data?.installationId ===
      install.variables?.installationId
      ? installationReceipt.data
      : null;
  const directAction =
    !actionReceipt.isError &&
    !actionReceipt.isFetching &&
    actionReceipt.data &&
    actionReceipt.data?.action === control.variables?.action
      ? actionReceipt.data
      : null;
  const recoveredInstall =
    current.installation?.installationId === install.variables?.installationId
      ? current.installation
      : directInstall;
  const recoveredAction =
    current.latestAction?.operationId === control.variables?.operationId &&
    current.latestAction?.installationId ===
      control.variables?.installationId &&
    current.latestAction?.action === control.variables?.action
      ? current.latestAction
      : directAction;
  const installUnknown =
    install.isError &&
    !refused(install.error) &&
    (!recoveredInstall || recoveredInstall.phase === 'preparing');
  const actionUnknown =
    control.isError && !refused(control.error) && !recoveredAction;
  const unknown = installUnknown || actionUnknown;
  const cryptoAvailable =
    typeof globalThis.crypto?.getRandomValues === 'function';
  const hasProfile =
    architecture !== null &&
    prepared?.latest?.qualifiedArchitectures?.includes(architecture) === true;
  const canInstall =
    hostReady &&
    current.supported &&
    !current.hasOperationLock &&
    !installed &&
    current.runtime === 'not-installed' &&
    prepared?.mayPrepare === true &&
    !prepared.hasOperationLock &&
    prepared.latest?.phase === 'authenticated' &&
    prepared.latest.payloadPrepared === true &&
    hasProfile &&
    storageChosen &&
    !pending &&
    !unknown &&
    cryptoAvailable;
  const uncertainAction =
    current.latestAction && current.latestAction.phase !== 'completed';
  const uncertainRecovered =
    control.isError &&
    recoveredAction !== null &&
    recoveredAction.phase !== 'completed';
  const canStart =
    current.supported &&
    installed?.phase === 'installed' &&
    current.runtime === 'stopped' &&
    !current.hasOperationLock &&
    !uncertainAction &&
    !uncertainRecovered &&
    !pending &&
    !unknown &&
    cryptoAvailable;
  const canStop =
    current.supported &&
    installed?.phase === 'installed' &&
    (current.runtime === 'running' ||
      current.runtime === 'partial' ||
      (current.runtime === 'stopped' &&
        (uncertainAction || uncertainRecovered))) &&
    !current.hasOperationLock &&
    !pending &&
    !unknown &&
    cryptoAvailable;
  const stopOffered =
    current.runtime === 'running' ||
    current.runtime === 'partial' ||
    !!uncertainAction ||
    uncertainRecovered;
  const act = (action: 'start' | 'stop') => {
    if (!installed) return;
    control.mutate({
      installationId: installed.installationId,
      operationId: newCompanionOperationId(),
      action,
    });
  };
  return (
    <section className="companion-managed" aria-label="Managed companion">
      <h3>Install and run</h3>
      <p>
        Operations affect the selected Station host. Installing or starting does
        not enable sending or approve disclosure.
      </p>
      {pendingText}
      {!current.supported ? (
        <p>
          This Station host does not support managed companion installation.
        </p>
      ) : null}
      {installed ? (
        <>
          <p>
            Companion {installed.version}:{' '}
            {installed.phase === 'installed'
              ? 'installation recorded'
              : installed.phase === 'preparing'
                ? 'installation intent recorded'
                : 'installation needs reconciliation'}
            .
          </p>
          <p role="status">
            {current.runtime === 'running'
              ? current.storage === 'ready'
                ? 'Running. Receiver storage is ready.'
                : 'Running. Receiver storage readiness is unavailable.'
              : current.runtime === 'stopped'
                ? 'Stopped. Stored data is retained.'
                : current.runtime === 'partial'
                  ? 'Some services are running. Storage is not verified.'
                  : 'Current runtime state is unavailable; recorded installation is not proof of liveness.'}
          </p>
          {uncertainAction ? (
            <p role="alert">
              The last {current.latestAction?.action} outcome needs
              reconciliation. Check status; an explicit stop can confirm owned
              services are stopped when custody is available.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Checkbox
            checked={storageChosen}
            disabled={pending || current.hasOperationLock}
            onChange={setStorageChosen}
          >
            Install on the selected Station using managed Docker volumes
          </Checkbox>
          <p>
            Database and diagnostic data stay in that host's managed volumes.
            Stopping services preserves them.
          </p>
          {!hasProfile ? (
            <p>
              A prepared archive with a qualified profile declaration for this
              host is required. Diagnostic success alone does not qualify an
              artifact.
            </p>
          ) : null}
          {preparation.isError ? (
            <p role="alert">
              Preparation status is unavailable. Check status before installing.
            </p>
          ) : null}
        </>
      )}
      {current.hasOperationLock ? (
        <p>
          An operation lock is recorded. It does not prove a live operation;
          check its retained outcome.
        </p>
      ) : null}
      {unknown ? (
        <p role="alert">
          The request outcome is unconfirmed. Check its receipt before another
          mutation; no request will be repeated automatically.
        </p>
      ) : null}
      {install.isError && !unknown ? (
        <p role="alert">
          The install request was not confirmed. Current state and any retained
          receipt are shown above; no automatic retry was made.
        </p>
      ) : null}
      {control.isError && !unknown ? (
        <p role="alert">
          The control request was not confirmed. Review current state and its
          retained outcome before another action.
        </p>
      ) : null}
      {!cryptoAvailable ? (
        <p>
          This client cannot create operation IDs. Use a current Station client.
        </p>
      ) : null}
      <ActionRow
        label="Companion controls"
        overflowLabel="More companion controls"
        secondary={checkButton}
        primary={
          installed ? (
            <Button
              variant={stopOffered ? 'secondary' : 'primary'}
              disabled={stopOffered ? !canStop : !canStart}
              pending={control.isPending}
              pendingLabel={
                control.variables?.action === 'stop' ? 'Stopping…' : 'Starting…'
              }
              onClick={() => act(stopOffered ? 'stop' : 'start')}
            >
              {stopOffered ? 'Stop companion' : 'Start companion'}
            </Button>
          ) : (
            <Button
              disabled={!canInstall}
              pending={install.isPending}
              pendingLabel="Installing…"
              onClick={() => {
                if (!prepared?.latest) return;
                install.mutate({
                  installationId: newCompanionOperationId(),
                  preparationId: prepared.latest.operationId,
                  host: 'selected-station',
                  storage: 'managed-docker-volumes',
                });
              }}
            >
              Install companion
            </Button>
          )
        }
      />
      {current.runtime === 'running' && current.storage === 'ready' ? (
        <CompanionProductTrends authority={authority} />
      ) : null}
      <p>
        Observed {new Date(current.observedAt).toLocaleString()}. Service and
        storage observations do not prove all telemetry was delivered.
      </p>
    </section>
  );
}
