import { MANAGED_POLICY_CAPABILITY_DISABLED_CODE } from '@kontourai/station-contracts/managed-policy-controls';
import type {
  TelemetryConnectionProbeStatus,
  TelemetryRequestFailureCode,
} from '@kontourai/station-contracts/telemetry-delivery';
import {
  useCheckTelemetryConnectionMutation,
  useTelemetryDeliveryStatusQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { formatDateTime } from '../../utils/relativeTime';
import { settingsRow } from './settings-catalog';

const failures: Record<TelemetryRequestFailureCode, string> = {
  request_failed: 'The request failed.',
  request_timeout: 'The request timed out.',
  request_cancelled: 'The request was cancelled.',
  http_refused: 'The destination refused the request.',
  response_invalid: 'The destination returned an unsupported response.',
  response_too_large: 'The destination response exceeded its limit.',
  receipt_invalid:
    'The receiver did not acknowledge the requested observations.',
  endpoint_unconfigured: 'No destination is configured.',
  probe_unsupported: 'This destination does not support the connection check.',
  service_stopped: 'Station is stopping.',
  credential_unavailable:
    'The destination key is unavailable or no longer authorized.',
  restart_required: 'Restart Station to apply the new collector settings.',
};

function checked(probe: TelemetryConnectionProbeStatus): string {
  if (probe.phase === 'never') return 'Connection has not been checked.';
  if (probe.phase !== 'ready')
    return probe.failure
      ? failures[probe.failure.code]
      : 'Connection check failed.';
  return probe.scope === 'postgres-schema-v1'
    ? 'Connection and storage check passed.'
    : 'The collector accepted a test request. Storage beyond it is unverified.';
}

const when = (value: string) => formatDateTime(value, value);

function ConnectionStatus({
  probe,
  error,
}: {
  probe: TelemetryConnectionProbeStatus;
  error: string | null;
}) {
  if (!error && probe.phase === 'checking')
    return <SkeletonBlock count={1} label="Checking connection" />;
  return (
    <p
      role={error || probe.phase === 'failed' ? 'alert' : 'status'}
      className="settings__field-hint"
    >
      {error ?? checked(probe)}
    </p>
  );
}

export function TelemetryDelivery() {
  const authority = useHostRequestAuthorityScope();
  return authority ? (
    <DeliveryForAuthority
      key={`${authority.apiBase}:${authority.authorityKey}`}
      authority={authority}
    />
  ) : (
    <>
      <p role="status" className="settings__field-hint">
        Connect to this Station to see delivery status.
      </p>
      <PageRow {...settingsRow('product-telemetry-delivery')} />
      <PageRow {...settingsRow('otel-delivery')} />
    </>
  );
}

function DeliveryForAuthority({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const query = useTelemetryDeliveryStatusQuery(authority.apiBase, {
    requestScope: authority,
    keepPreviousData: false,
  });
  const productCheck = useCheckTelemetryConnectionMutation(
    authority.apiBase,
    'product',
    { requestScope: authority },
  );
  const otelCheck = useCheckTelemetryConnectionMutation(
    authority.apiBase,
    'otel',
    { requestScope: authority },
  );
  if (query.isError) {
    return (
      <p role="alert" className="settings__field-hint">
        {query.error instanceof StationHttpError && query.error.status === 404
          ? "This Station doesn't report delivery status yet. Update Station to see it."
          : 'Delivery status unavailable.'}{' '}
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Refresh status
        </Button>
      </p>
    );
  }
  if (!query.data || query.isFetching)
    return <SkeletonBlock count={2} label="Refreshing delivery status" />;
  const { product, otel } = query.data;
  const productSummary = {
    unconfigured: 'No product destination is configured.',
    disabled: 'Product telemetry is off.',
    'awaiting-disclosure':
      'Review and acknowledge the disclosure before sending observations.',
    ready: 'Ready to send; no receiver acknowledgement yet.',
    acknowledged: product.lastAcknowledged
      ? `Receiver acknowledged ${product.lastAcknowledged.eventCount} observations at ${when(product.lastAcknowledged.at)}.`
      : 'No receiver acknowledgement yet.',
    failed: product.lastFailure
      ? failures[product.lastFailure.code]
      : 'The latest delivery attempt failed.',
  }[product.phase];
  const checkError = (check: typeof productCheck) =>
    !check.isError
      ? null
      : check.error instanceof StationHttpError &&
          check.error.code === MANAGED_POLICY_CAPABILITY_DISABLED_CODE
        ? check.error.message
        : check.error instanceof StationHttpError && check.error.status === 403
          ? 'Only the Station operator can check this connection.'
          : 'Connection check is unavailable.';
  const productError = checkError(productCheck);
  const otelError = checkError(otelCheck);
  return (
    <>
      <PageRow
        {...settingsRow('product-telemetry-delivery')}
        description="Delivery status for this process. Check connection sends no usage data."
        status={
          <span>
            {product.managedDenial
              ? 'Off: managed policy.'
              : product.sending
                ? 'Sending observations…'
                : productSummary}
          </span>
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            disabled={
              !!product.managedDenial ||
              !product.endpointConfigured ||
              productCheck.isPending
            }
            onClick={() => productCheck.mutate()}
          >
            {productCheck.isPending ? 'Checking…' : 'Check connection'}
          </Button>
        }
      >
        {product.managedDenial && (
          <p className="settings__field-hint">{product.managedDenial}</p>
        )}
        <p className="settings__field-hint">
          Queued: {product.queued}. Acknowledged: {product.counts.acknowledged}.
          Dropped on overflow: {product.counts.overflowDropped}. Discarded on
          withdrawal or shutdown:{' '}
          {product.counts.withdrawn + product.counts.shutdownDropped}. Counts
          are for this process.
        </p>
        {product.lastAttemptAt && (
          <p className="settings__field-hint">
            Last delivery attempt: {when(product.lastAttemptAt)}.
          </p>
        )}
        <ConnectionStatus probe={product.probe} error={productError} />
      </PageRow>
      <PageRow
        {...settingsRow('otel-delivery')}
        description="Metrics and traces sent to the Station operator’s collector."
        status={
          <span>
            {otel.managedDenial
              ? 'Off: managed policy.'
              : otel.phase === 'restart-required'
                ? 'Restart Station to apply the new collector settings.'
                : otel.phase === 'failed'
                  ? 'Exporter initialization failed.'
                  : !otel.endpointConfigured
                    ? 'No collector is configured.'
                    : otel.phase === 'stopped'
                      ? 'Exporter stopped.'
                      : otel.identity !== 'ready'
                        ? 'Waiting for installation identity.'
                        : 'Exporter initialized; downstream delivery unverified.'}
          </span>
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            disabled={
              !!otel.managedDenial ||
              !otel.endpointConfigured ||
              otel.phase === 'restart-required' ||
              otelCheck.isPending
            }
            onClick={() => otelCheck.mutate()}
          >
            {otelCheck.isPending ? 'Checking…' : 'Check connection'}
          </Button>
        }
      >
        {otel.managedDenial && (
          <p className="settings__field-hint">{otel.managedDenial}</p>
        )}
        <p className="settings__field-hint">
          Metrics: {otel.metrics.accepted} accepted exports,{' '}
          {otel.metrics.failed} failed. Traces: {otel.traces.accepted} accepted
          exports, {otel.traces.failed} failed. Counts are for this process.
        </p>
        {otel.metrics.lastAcceptedAt && (
          <p className="settings__field-hint">
            Last accepted metrics export: {when(otel.metrics.lastAcceptedAt)}.
          </p>
        )}
        {otel.traces.lastAcceptedAt && (
          <p className="settings__field-hint">
            Last accepted trace export: {when(otel.traces.lastAcceptedAt)}.
          </p>
        )}
        {(otel.metrics.lastResult === 'failed' ||
          otel.traces.lastResult === 'failed') && (
          <p role="alert" className="settings__field-hint">
            The latest metrics or trace export failed.
          </p>
        )}
        <ConnectionStatus probe={otel.probe} error={otelError} />
      </PageRow>
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
        Refresh status
      </Button>
    </>
  );
}
