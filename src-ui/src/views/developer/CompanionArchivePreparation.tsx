import {
  usePrepareTelemetryCompanionArchiveMutation,
  useTelemetryCompanionArchivePreparationQuery,
  useTelemetryCompanionPreparationStateQuery,
} from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { newCompanionOperationId } from './companion-operation-id';

export function CompanionArchivePreparation({
  authority,
  artifactReady,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  artifactReady: boolean;
}) {
  const state = useTelemetryCompanionPreparationStateQuery(authority.apiBase, {
    requestScope: authority,
    keepPreviousData: false,
  });
  const prepare = usePrepareTelemetryCompanionArchiveMutation(
    authority.apiBase,
    { requestScope: authority },
  );
  const operationId =
    prepare.variables ?? state.data?.latestOperationId ?? null;
  const recovered = useTelemetryCompanionArchivePreparationQuery(
    authority.apiBase,
    operationId,
    {
      requestScope: authority,
      keepPreviousData: false,
      enabled: prepare.isError,
    },
  );
  if (state.isError)
    return (
      <>
        <p role="alert">
          Archive preparation is unavailable. Check this Station's permissions,
          connection or version.
        </p>
        <Button
          variant="secondary"
          disabled={state.isFetching}
          onClick={() => void state.refetch()}
        >
          Check preparation status
        </Button>
      </>
    );
  if (!state.data || state.isFetching)
    return <SkeletonBlock count={1} label="Checking archive preparation" />;
  const receipt = prepare.isSuccess
    ? prepare.data
    : prepare.isError
      ? !recovered.isError &&
        !recovered.isFetching &&
        recovered.data?.operationId === operationId
        ? recovered.data
        : null
      : state.data.latest?.operationId === operationId
        ? state.data.latest
        : null;
  const unconfirmed =
    prepare.isError && (!receipt || receipt.phase === 'pending');
  const cryptoAvailable =
    typeof globalThis.crypto?.getRandomValues === 'function';
  const canPrepare =
    state.data.supported &&
    state.data.mayPrepare &&
    artifactReady &&
    !state.data.hasOperationLock &&
    !prepare.isPending &&
    !unconfirmed &&
    receipt?.phase !== 'pending' &&
    !(state.data.latestOperationId && !state.data.latest) &&
    cryptoAvailable;
  return (
    <section aria-label="Companion archive preparation">
      <p>
        Prepare the signed parent archive in this Station's private storage.
        This downloads, verifies and prepares companion files; it does not start
        services or enable sending.
      </p>
      {!state.data.supported ? (
        <p>
          This Station host does not support archive preparation. Connect to a
          supported Unix host.
        </p>
      ) : !state.data.mayPrepare ? (
        <p>
          This session lacks companion-management authority. An operator can
          explicitly grant Manage telemetry companion to an eligible operator
          device in device access settings.
        </p>
      ) : !artifactReady ? (
        <p>
          A verified parent release and host prerequisites are required before
          preparation.
        </p>
      ) : null}
      {prepare.isPending ? <p role="status">Preparing archive…</p> : null}
      {receipt ? (
        <p role="status">
          {receipt.phase === 'authenticated'
            ? `Archive bytes verified for ${receipt.version}. Installation is still unavailable.`
            : receipt.phase === 'failed'
              ? 'Preparation failed. Captured files were retained; a new attempt requires another explicit action.'
              : 'Preparation intent recorded. This does not confirm a running operation.'}
        </p>
      ) : null}
      {receipt?.payloadPrepared ? (
        <p>Companion files prepared and verified in private storage.</p>
      ) : null}
      {unconfirmed ? (
        <p role="alert">
          The preparation outcome is unconfirmed. Check its receipt before
          starting another attempt.
        </p>
      ) : null}
      {state.data.hasOperationLock && !prepare.isPending ? (
        <p>
          An operation lock is recorded. Its running state is unknown; reconcile
          it before preparing another archive.
        </p>
      ) : null}
      {state.data.latestOperationId && !state.data.latest ? (
        <p>
          The recorded operation has no readable receipt and needs
          reconciliation.
        </p>
      ) : null}
      {!cryptoAvailable ? (
        <p>
          This browser cannot create preparation IDs. Use a current Station
          client.
        </p>
      ) : null}
      <Button
        variant="secondary"
        disabled={!canPrepare}
        onClick={() => prepare.mutate(newCompanionOperationId())}
      >
        Prepare signed archive
      </Button>
      <Button
        variant="secondary"
        disabled={state.isFetching || recovered.isFetching}
        onClick={() => {
          void state.refetch();
          if (operationId && prepare.isError) void recovered.refetch();
        }}
      >
        Check preparation status
      </Button>
    </section>
  );
}
