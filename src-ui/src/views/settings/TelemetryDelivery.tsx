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
  restart_required:
    'Restart Station to activate the saved collector configuration.',
};

function checked(probe: TelemetryConnectionProbeStatus): string {
  if (probe.phase === 'never') return 'Connection has not been checked.';
  if (probe.phase !== 'ready')
    return probe.failure
      ? failures[probe.failure.code]
      : 'Connection check failed.';
  return probe.scope === 'postgres-schema-v1'
    ? 'Receiver source authority and storage query passed.'
    : 'Collector accepted the empty metrics and trace requests; downstream storage is unverified.';
}

const when = (value: string) => new Date(value).toLocaleString();

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
        Connect to this Station to see its delivery status.
      </p>
      <PageRow
        {...settingsRow('product-telemetry-delivery')}
        description="Product delivery status is unavailable until this Station connection has authority."
      />
      <PageRow
        {...settingsRow('otel-delivery')}
        description="Collector status is unavailable until this Station connection has authority."
      />
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
          ? 'This Station does not provide delivery status yet. Update it to see receiver acknowledgements.'
          : 'Delivery status is unavailable. Cached success cannot establish current delivery.'}{' '}
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
  const productError = productCheck.isError
    ? productCheck.error instanceof StationHttpError &&
      productCheck.error.status === 403
      ? 'An operator must check this connection.'
      : 'Connection check is unavailable.'
    : null;
  const otelError = otelCheck.isError
    ? otelCheck.error instanceof StationHttpError &&
      otelCheck.error.status === 403
      ? 'An operator must check this connection.'
      : 'Connection check is unavailable.'
    : null;
  return (
    <>
      <PageRow
        {...settingsRow('product-telemetry-delivery')}
        description="Receiver acknowledgements and the current process’s queue. An explicit connection check sends no usage observation and does not acknowledge disclosure."
        status={
          <span>
            {product.sending ? 'Sending observations…' : productSummary}
          </span>
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            disabled={!product.endpointConfigured || productCheck.isPending}
            onClick={() => productCheck.mutate()}
          >
            {productCheck.isPending ? 'Checking…' : 'Check connection'}
          </Button>
        }
      >
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
        description="Metrics and traces sent to the operator’s collector. Initialization and HTTP acceptance do not establish downstream persistence or querying."
        status={
          <span>
            {otel.phase === 'restart-required'
              ? 'Saved collector settings require a Station restart; exports from the previous configuration are fenced.'
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
