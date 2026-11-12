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
        Download and verify the signed companion archive into this Station's
        private storage. This doesn't start services or turn on sending.
      </p>
      {!state.data.supported ? (
        <p>
          This Station can't prepare the archive. Use a Station running on macOS
          or Linux.
        </p>
      ) : !state.data.mayPrepare ? (
        <p>
          Ask a Station operator to grant “Manage telemetry companion” to this
          device in device access settings.
        </p>
      ) : !artifactReady ? (
        <p>
          Preparation needs a verified companion release and the Station
          prerequisites above.
        </p>
      ) : null}
      {prepare.isPending ? <p role="status">Preparing archive…</p> : null}
      {receipt ? (
        <p role="status">
          {receipt.phase === 'authenticated'
            ? `Archive bytes verified for ${receipt.version}. Installation is still unavailable.`
            : receipt.phase === 'failed'
              ? 'Preparation failed; downloaded files were kept. Prepare again to retry.'
              : "Preparation started. Station hasn't confirmed it's still running."}
        </p>
      ) : null}
      {receipt?.payloadPrepared ? (
        <p>Companion files prepared and verified in private storage.</p>
      ) : null}
      {unconfirmed ? (
        <p role="alert">
          Station didn't confirm the result. Check status before retrying.
        </p>
      ) : null}
      {state.data.hasOperationLock && !prepare.isPending ? (
        <p>
          Another operation may still be running. Check status before
          continuing.
        </p>
      ) : null}
      {state.data.latestOperationId && !state.data.latest ? (
        <p>
          The last operation's result can't be read. Check status before
          continuing.
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
