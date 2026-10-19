export type TelemetryRequestFailureCode =
  | 'request_failed'
  | 'request_timeout'
  | 'request_cancelled'
  | 'http_refused'
  | 'response_invalid'
  | 'response_too_large'
  | 'receipt_invalid'
  | 'endpoint_unconfigured'
  | 'probe_unsupported'
  | 'service_stopped'
  | 'credential_unavailable'
  | 'restart_required';

export interface TelemetryRequestFailure {
  at: string;
  code: TelemetryRequestFailureCode;
  httpStatus?: number;
}

export interface TelemetryConnectionProbeStatus {
  phase: 'never' | 'checking' | 'ready' | 'failed' | 'unsupported';
  checkedAt: string | null;
  /** Product storage query and OTLP HTTP acceptance have different proof scopes. */
  scope: 'postgres-schema-v1' | 'collector-http-acceptance' | null;
  failure: TelemetryRequestFailure | null;
}

export interface ProductTelemetryDeliveryStatus {
  scope: 'current-process';
  observedAt: string;
  phase:
    | 'unconfigured'
    | 'disabled'
    | 'awaiting-disclosure'
    | 'ready'
    | 'acknowledged'
    | 'failed';
  endpointConfigured: boolean;
  keyConfigured: boolean;
  enabled: boolean;
  disclosureAcknowledged: boolean;
  sending: boolean;
  queued: number;
  counts: {
    buffered: number;
    acknowledged: number;
    overflowDropped: number;
    withdrawn: number;
    shutdownDropped: number;
    rejected: number;
    attempts: number;
    failedAttempts: number;
  };
  lastAttemptAt: string | null;
  lastAcknowledged: {
    at: string;
    storedAt: string;
    eventCount: number;
  } | null;
  lastFailure: TelemetryRequestFailure | null;
  probe: TelemetryConnectionProbeStatus;
}

export interface OtelExportDeliveryStatus {
  lastResult: 'never' | 'accepted' | 'failed';
  attempts: number;
  accepted: number;
  failed: number;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  lastFailureAt: string | null;
}

export interface OtelTelemetryDeliveryStatus {
  scope: 'current-process';
  observedAt: string;
  phase:
    | 'unconfigured'
    | 'initializing'
    | 'initialized'
    | 'failed'
    | 'stopped'
    | 'restart-required';
  endpointConfigured: boolean;
  identity: 'unconfigured' | 'pending' | 'ready' | 'failed';
  /** Exporter/collector acceptance does not prove downstream persistence or querying. */
  downstreamDelivery: 'unverified';
  metrics: OtelExportDeliveryStatus;
  traces: OtelExportDeliveryStatus;
  probe: TelemetryConnectionProbeStatus;
}

export interface TelemetryDeliveryStatus {
  protocol: 'station-telemetry-delivery/v1';
  product: ProductTelemetryDeliveryStatus;
  otel: OtelTelemetryDeliveryStatus;
}
