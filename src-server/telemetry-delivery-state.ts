import type { AppConfig } from '@kontourai/station-contracts/config';
import type {
  OtelExportDeliveryStatus,
  OtelTelemetryDeliveryStatus,
  TelemetryConnectionProbeStatus,
} from '@kontourai/station-contracts/telemetry-delivery';
import {
  abortableTelemetryOperation,
  readTelemetryJson,
  TelemetryRequestError,
  telemetryRequestFailure,
} from './services/telemetry-response.js';

function exportStatus(): OtelExportDeliveryStatus {
  return {
    lastResult: 'never',
    attempts: 0,
    accepted: 0,
    failed: 0,
    lastAttemptAt: null,
    lastAcceptedAt: null,
    lastFailureAt: null,
  };
}

function initialStatus(): OtelTelemetryDeliveryStatus {
  return {
    scope: 'current-process',
    observedAt: new Date().toISOString(),
    phase: 'unconfigured',
    endpointConfigured: false,
    identity: 'unconfigured',
    downstreamDelivery: 'unverified',
    metrics: exportStatus(),
    traces: exportStatus(),
    probe: { phase: 'never', checkedAt: null, scope: null, failure: null },
  };
}

interface OtelDeliveryOwner {
  status: OtelTelemetryDeliveryStatus;
  endpoint: string | undefined;
  key: string | undefined;
  probing?: Promise<TelemetryConnectionProbeStatus>;
  probeAbort?: AbortController;
  savedConfig: Pick<AppConfig, 'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'>;
  credential?: (
    signal?: AbortSignal,
  ) => Promise<{ key?: string; assertCurrent: () => void }>;
  credentialAbort: AbortController;
}

function savedConfiguration(
  config: OtelDeliveryOwner['savedConfig'],
): OtelDeliveryOwner['savedConfig'] {
  return {
    otelTelemetryEndpoint: config.otelTelemetryEndpoint?.trim() || undefined,
    otelTelemetryKeyRef: config.otelTelemetryKeyRef?.trim() || undefined,
  };
}

let current: OtelDeliveryOwner = {
  status: initialStatus(),
  endpoint: undefined,
  key: undefined,
  savedConfig: {},
  credentialAbort: new AbortController(),
};

/** Each SDK's callbacks retain their owner; an old SDK cannot stamp its replacement healthy. */
export function beginOtelTelemetryDelivery(
  endpoint: string,
  key?: string,
  savedConfig: OtelDeliveryOwner['savedConfig'] = {},
): OtelDeliveryOwner {
  const status = initialStatus();
  status.phase = 'initializing';
  status.endpointConfigured = true;
  status.identity = 'pending';
  current.probeAbort?.abort();
  current.credentialAbort.abort();
  current = {
    status,
    endpoint,
    key,
    savedConfig: savedConfiguration(savedConfig),
    credentialAbort: new AbortController(),
  };
  return current;
}

export function failOtelTelemetryBootstrap(): void {
  current.probeAbort?.abort();
  current.credentialAbort.abort();
  current.status.phase = 'failed';
}

export function beginOtelExport(
  owner: OtelDeliveryOwner,
  kind: 'metrics' | 'traces',
): (accepted: boolean) => void {
  const status = owner.status[kind];
  status.attempts++;
  status.lastAttemptAt = new Date().toISOString();
  return (accepted) => {
    if (owner.status.phase === 'restart-required') return;
    status.lastResult = accepted ? 'accepted' : 'failed';
    if (accepted) {
      status.accepted++;
      status.lastAcceptedAt = new Date().toISOString();
    } else {
      status.failed++;
      status.lastFailureAt = new Date().toISOString();
    }
  };
}

/** Collector changes are restart-activated; saved changes revoke the old process's export authority now. */
export function reconfigureOtelTelemetryDelivery(config: AppConfig): void {
  const observed = savedConfiguration(config);
  if (
    current.savedConfig.otelTelemetryEndpoint ===
      observed.otelTelemetryEndpoint &&
    current.savedConfig.otelTelemetryKeyRef === observed.otelTelemetryKeyRef
  )
    return;
  current.savedConfig = observed;
  current.status.phase = 'restart-required';
  current.credentialAbort.abort();
  current.probeAbort?.abort();
  current.status.metrics = exportStatus();
  current.status.traces = exportStatus();
  current.status.probe = {
    phase: 'never',
    checkedAt: null,
    scope: null,
    failure: null,
  };
}

function probeSnapshot(
  probe: TelemetryConnectionProbeStatus,
): TelemetryConnectionProbeStatus {
  return { ...probe, failure: probe.failure ? { ...probe.failure } : null };
}

export function getOtelTelemetryDeliveryStatus(): OtelTelemetryDeliveryStatus {
  return {
    ...current.status,
    observedAt: new Date().toISOString(),
    metrics: { ...current.status.metrics },
    traces: { ...current.status.traces },
    probe: probeSnapshot(current.status.probe),
  };
}

function validateOtlpProbeResponse(body: unknown, rejectedField: string): void {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'partialSuccess')
  )
    throw new TelemetryRequestError('response_invalid');
  if (!('partialSuccess' in body)) return;
  const partial = body.partialSuccess;
  if (
    !partial ||
    typeof partial !== 'object' ||
    Array.isArray(partial) ||
    Object.keys(partial).some(
      (key) => ![rejectedField, 'errorMessage'].includes(key),
    )
  )
    throw new TelemetryRequestError('response_invalid');
  if (rejectedField in partial) {
    const rejected = partial[rejectedField as keyof typeof partial];
    if (rejected !== 0 && rejected !== '0')
      throw new TelemetryRequestError('response_invalid');
  }
  if ('errorMessage' in partial && partial.errorMessage !== '')
    throw new TelemetryRequestError('response_invalid');
}

/** Empty OTLP requests establish HTTP acceptance only, not downstream storage. */
export async function checkOtelTelemetryConnection(): Promise<TelemetryConnectionProbeStatus> {
  const owner = current;
  if (owner.probing) return owner.probing;
  if (
    owner.status.phase === 'stopped' ||
    owner.status.phase === 'restart-required'
  ) {
    owner.status.probe = {
      phase: 'failed',
      checkedAt: new Date().toISOString(),
      scope: null,
      failure: {
        at: new Date().toISOString(),
        code:
          owner.status.phase === 'restart-required'
            ? 'restart_required'
            : 'service_stopped',
      },
    };
    return probeSnapshot(owner.status.probe);
  }
  if (!owner.endpoint) {
    owner.status.probe = {
      phase: 'unsupported',
      checkedAt: new Date().toISOString(),
      scope: null,
      failure: { at: new Date().toISOString(), code: 'endpoint_unconfigured' },
    };
    return probeSnapshot(owner.status.probe);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(owner.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new TelemetryRequestError('probe_unsupported');
  } catch {
    owner.status.probe = {
      phase: 'unsupported',
      checkedAt: new Date().toISOString(),
      scope: null,
      failure: { at: new Date().toISOString(), code: 'probe_unsupported' },
    };
    return probeSnapshot(owner.status.probe);
  }
  owner.status.probe = {
    phase: 'checking',
    checkedAt: null,
    scope: null,
    failure: null,
  };
  const controller = new AbortController();
  owner.probeAbort = controller;
  const timeout = setTimeout(() => controller.abort('timeout'), 3_000);
  owner.probing = (async () => {
    try {
      for (const [path, payload, rejected] of [
        ['traces', { resourceSpans: [] }, 'rejectedSpans'],
        ['metrics', { resourceMetrics: [] }, 'rejectedDataPoints'],
      ] as const) {
        const credential = owner.credential
          ? await owner.credential(controller.signal)
          : { key: owner.key, assertCurrent: () => {} };
        credential.assertCurrent();
        const response = await abortableTelemetryOperation(
          fetch(`${owner.endpoint}/v1/${path}`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(credential.key ? { 'x-api-key': credential.key } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }),
          controller.signal,
        );
        if ([404, 405, 426].includes(response.status))
          throw new TelemetryRequestError('probe_unsupported', response.status);
        if (!response.ok)
          throw new TelemetryRequestError('http_refused', response.status);
        validateOtlpProbeResponse(
          await readTelemetryJson(response, controller.signal),
          rejected,
        );
        credential.assertCurrent();
      }
      if (
        controller.signal.aborted ||
        owner.status.phase === 'stopped' ||
        owner.status.phase === 'restart-required'
      )
        throw new TelemetryRequestError('service_stopped');
      owner.status.probe = {
        phase: 'ready',
        checkedAt: new Date().toISOString(),
        scope: 'collector-http-acceptance',
        failure: null,
      };
    } catch (error) {
      const failure = telemetryRequestFailure(error, controller.signal);
      owner.status.probe = {
        phase: failure.code === 'probe_unsupported' ? 'unsupported' : 'failed',
        checkedAt: failure.at,
        scope: null,
        failure,
      };
    } finally {
      clearTimeout(timeout);
      if (owner.probeAbort === controller) owner.probeAbort = undefined;
      owner.probing = undefined;
    }
    return probeSnapshot(owner.status.probe);
  })();
  return owner.probing;
}
