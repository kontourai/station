export const TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL =
  'station-companion-archive-preparation/v1';

export function isTelemetryCompanionOperationId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

/** Pending records intent, not process liveness. No state grants installation authority. */
export interface TelemetryCompanionArchivePreparation {
  protocol: typeof TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL;
  operationId: string;
  phase: 'pending' | 'authenticated' | 'failed';
  version: string;
  source: string;
  artifactSha256: string;
  expectedBytes: number;
  receivedBytes: number;
  createdAt: string;
  installationAuthority: false;
}

/** A signed parent envelope and local byte inventory are not install authority. */
export type TelemetryCompanionArtifactEvidence =
  | {
      kind: 'unavailable';
      reason:
        | 'archive-install-required'
        | 'release-envelope-missing'
        | 'release-envelope-invalid'
        | 'companion-payload-invalid';
    }
  | {
      kind: 'parent-envelope-verified';
      version: string;
      source: string;
      artifactSha256: string;
      qualification: 'build-only';
      installationAuthority: false;
    };

/** A request-local host probe, never installation or release authority. */
export type TelemetryCompanionPrerequisites = {
  checkedAt: string;
} & (
  | {
      kind: 'available';
      containerHost: 'local';
      architecture: 'amd64' | 'arm64';
      dockerVersion: string;
      composeVersion: string;
      /** Optional for compatibility with prerequisite-only servers. */
      artifact?: TelemetryCompanionArtifactEvidence;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'container-runtime-missing'
        | 'container-daemon-unavailable'
        | 'remote-container-context'
        | 'container-host-unsupported'
        | 'compose-unavailable';
    }
);

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
