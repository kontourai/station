import {
  useControlTelemetryCompanionMutation,
  useInstallTelemetryCompanionMutation,
  usePrepareTelemetryPrivateUsageMutation,
  useTelemetryCompanionActionQuery,
  useTelemetryCompanionInstallationQuery,
  useTelemetryCompanionManagedStateQuery,
  useTelemetryCompanionPreparationStateQuery,
  useTelemetryPrivateUsagePreparationQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { ErrorState, SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useBackgroundStatusReconciliation } from '../../hooks/useBackgroundStatusReconciliation';
import { describeStationFailure } from '../../utils/stationFailure';
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
  const [preparationInput, setPreparationInput] = useState('');
  const [preparationId, setPreparationId] = useState<string | null>(null);
  const privatePreparation = useTelemetryPrivateUsagePreparationQuery(
    authority.apiBase,
    preparationId,
    { requestScope: authority },
  );
  const preparePrivate = usePrepareTelemetryPrivateUsageMutation(
    authority.apiBase,
    { requestScope: authority },
  );
  const pending = install.isPending || control.isPending;
  const check = async () => {
    const [nextState] = await Promise.all([
      state.refetch(),
      preparation.refetch(),
      ...(install.isError && install.variables
        ? [installationReceipt.refetch()]
        : []),
      ...(control.isError && control.variables
        ? [actionReceipt.refetch()]
        : []),
    ]);
    const latest = nextState.data;
    const latestState = latest?.runtime;
    if (
      latest &&
      !latest.hasOperationLock &&
      latest.installation?.phase !== 'preparing' &&
      (!latest.latestAction || latest.latestAction.phase === 'completed') &&
      latestState !== 'unknown'
    )
      return 'settled' as const;
    return 'pending' as const;
  };
  const current = state.data;
  const installed = current?.installation;
  const prepared = !preparation.isError ? preparation.data : undefined;
  const directInstall =
    !installationReceipt.isError &&
    installationReceipt.data &&
    install.variables &&
    installationReceipt.data.installationId === install.variables.installationId
      ? installationReceipt.data
      : null;
  const directAction =
    !actionReceipt.isError &&
    actionReceipt.data &&
    control.variables &&
    actionReceipt.data.action === control.variables.action
      ? actionReceipt.data
      : null;
  const recoveredInstall =
    current?.installation &&
    install.variables &&
    current.installation.installationId === install.variables.installationId
      ? current.installation
      : directInstall;
  const recoveredAction =
    current?.latestAction &&
    control.variables &&
    current.latestAction.operationId === control.variables.operationId &&
    current.latestAction.installationId === control.variables.installationId &&
    current.latestAction.action === control.variables.action
      ? current.latestAction
      : directAction;
  const installUnknown =
    install.isError &&
    !refused(install.error) &&
    (!recoveredInstall || recoveredInstall.phase === 'preparing');
  const actionUnknown =
    control.isError && !refused(control.error) && !recoveredAction;
  const unknown = installUnknown || actionUnknown;
  const uncertainAction =
    current?.latestAction && current.latestAction.phase !== 'completed';
  const uncertainRecovered =
    control.isError &&
    recoveredAction !== null &&
    recoveredAction.phase !== 'completed';
  const companionState = current?.runtime;
  const needsBackgroundCheck = Boolean(
    current &&
      !pending &&
      (current.hasOperationLock ||
        installed?.phase === 'preparing' ||
        uncertainAction ||
        uncertainRecovered ||
        unknown ||
        companionState === 'unknown' ||
        preparation.isError),
  );
  const reconcile = useBackgroundStatusReconciliation({
    active: Boolean(current && !pending),
    resetKey: `${authority.apiBase}:${authority.authorityKey}:${needsBackgroundCheck ? 'poll' : 'idle'}:${current?.hasOperationLock ? '1' : '0'}:${unknown ? 'u' : 'c'}:${companionState ?? ''}`,
    initialDelayMs: needsBackgroundCheck ? 1_500 : null,
    intervalsMs: [2_500, 5_000, 8_000],
    check,
  });
  const checkButton = (
    <Button
      variant="secondary"
      disabled={
        state.isFetching ||
        preparation.isFetching ||
        installationReceipt.isFetching ||
        actionReceipt.isFetching
      }
      onClick={() => void check()}
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
  if (!current)
    return (
      <section className="companion-managed" aria-label="Managed companion">
        {pendingText}
        <SkeletonBlock count={1} label="Checking managed companion" />
      </section>
    );
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
      <details>
        <summary>Prepare a person's private storage</summary>
        <p>
          Ask the person to confirm their source address and request storage
          preparation, then review their request here. This creates an empty
          private vault that only they control.
        </p>
        <label>
          Storage preparation request ID
          <input
            value={preparationInput}
            onChange={(event) => {
              setPreparationInput(event.target.value);
              setPreparationId(null);
              preparePrivate.reset();
            }}
          />
        </label>
        <Button
          disabled={
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
              preparationInput,
            )
          }
          onClick={() => setPreparationId(preparationInput)}
        >
          Review storage request
        </Button>
        {privatePreparation.isFetching ? (
          <SkeletonBlock count={1} label="Checking private storage request" />
        ) : null}
        {privatePreparation.isError ? (
          <ErrorState
            title="Storage request unavailable"
            description={describeStationFailure(privatePreparation.error).body}
            action={
              <Button onClick={() => void privatePreparation.refetch()}>
                Check request again
              </Button>
            }
          />
        ) : null}
        {!privatePreparation.isFetching &&
        !privatePreparation.isError &&
        privatePreparation.data ? (
          <>
            <dl>
              <dt>Receiving person</dt>
              <dd>{privatePreparation.data.personId}</dd>
              <dt>Receiving slot</dt>
              <dd>{privatePreparation.data.recipientId}</dd>
              <dt>Station</dt>
              <dd>{privatePreparation.data.stationId}</dd>
              <dt>Companion installation</dt>
              <dd>{privatePreparation.data.installationId}</dd>
              <dt>Credential revision</dt>
              <dd>{privatePreparation.data.credentialRevision}</dd>
              <dt>Expires</dt>
              <dd>{privatePreparation.data.expiresAt}</dd>
              <dt>Preparation</dt>
              <dd>{privatePreparation.data.phase}</dd>
            </dl>
            <Button
              disabled={
                preparePrivate.isPending ||
                privatePreparation.data.phase === 'prepared' ||
                Date.parse(privatePreparation.data.expiresAt) <= Date.now()
              }
              onClick={() => {
                if (privatePreparation.data)
                  preparePrivate.mutate({
                    requestId: privatePreparation.data.requestId,
                    fingerprint: privatePreparation.data.fingerprint,
                  });
              }}
            >
              Prepare this person's private storage
            </Button>
          </>
        ) : null}
        {preparePrivate.isError ? (
          <ErrorState
            title="Storage preparation could not be confirmed"
            description="Check the request again before retrying. If it expired, ask the person to request it again."
            action={
              <Button onClick={() => void privatePreparation.refetch()}>
                Check request again
              </Button>
            }
          />
        ) : null}
      </details>
      <h3>Install and run</h3>
      <p>
        These actions run on the selected Station. Installing or starting
        doesn't turn on sending or share any data.
      </p>
      {pendingText}
      {!current.supported ? (
        <p>This Station doesn't support installing the companion.</p>
      ) : null}
      {installed ? (
        <>
          <p>
            Companion {installed.version}:{' '}
            {installed.phase === 'installed'
              ? 'installed'
              : installed.phase === 'preparing'
                ? 'installation started'
                : 'installation state unclear, check status'}
            .
          </p>
          <p role="status">
            {current.runtime === 'running'
              ? current.storage === 'ready'
                ? 'Running. Storage is ready.'
                : 'Running. Storage status is unavailable.'
              : current.runtime === 'stopped'
                ? 'Stopped. Stored data is retained.'
                : current.runtime === 'partial'
                  ? 'Some services are running. Storage is not verified.'
                  : "Can't tell whether the companion is running. Check status."}
          </p>
          {uncertainAction ? (
            <p role="alert">
              Station didn't confirm the last {current.latestAction?.action}.{' '}
              {canStop
                ? 'Check status, or stop the companion to make sure its services are stopped.'
                : 'Check status before trying again.'}
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
            Data stays in that Station's managed volumes and is kept when the
            companion stops.
          </p>
          {!hasProfile ? (
            <p>
              Prepare an archive that supports this Station's architecture
              before installing.
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
          Another operation may still be running. Check status before
          continuing.
        </p>
      ) : null}
      {unknown ? (
        <p role="alert">
          Station didn't confirm the result. Check status before retrying.
          Nothing is retried automatically.
        </p>
      ) : null}
      {install.isError && !unknown ? (
        <p role="alert">
          The install wasn't confirmed. Current status is shown above; nothing
          was retried.
        </p>
      ) : null}
      {control.isError && !unknown ? (
        <p role="alert">
          The request wasn't confirmed. Check status before trying again.
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
        secondary={
          needsBackgroundCheck && reconcile.exhausted ? checkButton : undefined
        }
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
        Checked {new Date(current.observedAt).toLocaleString()}. Healthy
        services don't guarantee every event was delivered.
      </p>
    </section>
  );
}
