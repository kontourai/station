import {
  isTelemetryCompanionOperationId,
  TELEMETRY_COMPANION_ARCHIVE_MAX_BYTES,
  TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL,
  type TelemetryCompanionArchivePreparation,
  type TelemetryCompanionPreparationState,
  type TelemetryCompanionPrerequisites,
  type TelemetryConnectionProbeStatus,
  type TelemetryDeliveryStatus,
} from '@kontourai/station-contracts/telemetry-delivery';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { envelopeError } from '../client/api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import { type QueryConfig, useApiQuery } from '../query-core';

const time = z.string().datetime();
const preparationReceipt = z
  .object({
    protocol: z.literal(TELEMETRY_COMPANION_ARCHIVE_PREPARATION_PROTOCOL),
    operationId: z.string().refine(isTelemetryCompanionOperationId),
    phase: z.enum(['pending', 'authenticated', 'failed']),
    version: z.string().min(1).max(128),
    source: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedBytes: z
      .number()
      .int()
      .positive()
      .max(TELEMETRY_COMPANION_ARCHIVE_MAX_BYTES),
    receivedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(TELEMETRY_COMPANION_ARCHIVE_MAX_BYTES),
    createdAt: time,
    installationAuthority: z.literal(false),
    payloadPrepared: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.payloadPrepared || value.phase === 'authenticated') &&
      value.receivedBytes <= value.expectedBytes &&
      (value.phase !== 'authenticated' ||
        value.receivedBytes === value.expectedBytes),
  );
const preparationState = z
  .object({
    supported: z.boolean(),
    mayPrepare: z.boolean(),
    hasOperationLock: z.boolean(),
    latestOperationId: z
      .string()
      .refine(isTelemetryCompanionOperationId)
      .nullable(),
    latest: preparationReceipt.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      !value.latest || value.latest.operationId === value.latestOperationId,
  );

async function companionResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (!response.ok)
    throw envelopeError(response, body, 'Companion preparation unavailable');
  const parsed = z
    .object({ success: z.literal(true).optional(), data: schema })
    .safeParse(body);
  if (!parsed.success)
    throw new Error('Companion preparation response is invalid or unsupported');
  return parsed.data.data;
}

const preparationKey = (apiBase: string, options?: ClientRequestOptions) =>
  [
    'telemetry-companion-preparations',
    options?.requestScope?.apiBase ?? apiBase,
    options?.requestScope?.authorityKey ?? 'default',
  ] as const;

export async function fetchTelemetryCompanionPreparationState(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionPreparationState> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  return companionResponse(
    await getJson(
      `${base}/api/operator/telemetry-companion/archive-preparations`,
      { ...options, maxResponseBytes: 8192 },
    ),
    preparationState,
  );
}

export async function fetchTelemetryCompanionArchivePreparation(
  apiBase: string,
  operationId: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionArchivePreparation> {
  if (!isTelemetryCompanionOperationId(operationId))
    throw new Error('Invalid companion operation');
  const base = options?.requestScope?.apiBase ?? apiBase;
  const result = await companionResponse(
    await getJson(
      `${base}/api/operator/telemetry-companion/archive-preparations/${operationId}`,
      { ...options, maxResponseBytes: 8192 },
    ),
    preparationReceipt,
  );
  if (result.operationId !== operationId)
    throw new Error('Companion preparation identity changed');
  return result;
}

export async function prepareTelemetryCompanionArchive(
  apiBase: string,
  operationId: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionArchivePreparation> {
  if (!isTelemetryCompanionOperationId(operationId))
    throw new Error('Invalid companion operation');
  const base = options?.requestScope?.apiBase ?? apiBase;
  const result = await companionResponse(
    await mutateJson(
      `${base}/api/operator/telemetry-companion/archive-preparations`,
      'POST',
      {
        ...options,
        maxResponseBytes: 8192,
        timeoutMs:
          options?.timeoutMs === undefined ? 130_000 : options.timeoutMs,
      },
      { operationId },
    ),
    preparationReceipt,
  );
  if (result.operationId !== operationId)
    throw new Error('Companion preparation identity changed');
  return result;
}

type PreparationQueryConfig<T> = QueryConfig<T> & {
  requestScope?: ClientRequestOptions['requestScope'];
};

export function useTelemetryCompanionPreparationStateQuery(
  apiBase: string,
  config?: PreparationQueryConfig<TelemetryCompanionPreparationState>,
) {
  return useApiQuery<TelemetryCompanionPreparationState>(
    [...preparationKey(apiBase, config), 'state'],
    (signal) =>
      fetchTelemetryCompanionPreparationState(apiBase, {
        signal,
        requestScope: config?.requestScope,
      }),
    {
      ...config,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      retry: false,
      keepPreviousData: false,
    },
  );
}

export function useTelemetryCompanionArchivePreparationQuery(
  apiBase: string,
  operationId: string | null,
  config?: PreparationQueryConfig<TelemetryCompanionArchivePreparation>,
) {
  return useApiQuery<TelemetryCompanionArchivePreparation>(
    [...preparationKey(apiBase, config), 'receipt', operationId],
    (signal) => {
      if (!operationId) throw new Error('Companion operation required');
      return fetchTelemetryCompanionArchivePreparation(apiBase, operationId, {
        signal,
        requestScope: config?.requestScope,
      });
    },
    {
      ...config,
      enabled: config?.enabled !== false && operationId !== null,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      retry: false,
      keepPreviousData: false,
    },
  );
}

export function usePrepareTelemetryCompanionArchiveMutation(
  apiBase: string,
  options?: ClientRequestOptions,
) {
  const client = useQueryClient();
  const key = preparationKey(apiBase, options);
  return useMutation({
    mutationKey: key,
    gcTime: 0,
    retry: false,
    mutationFn: (operationId: string) =>
      prepareTelemetryCompanionArchive(apiBase, operationId, options),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}
const companionArtifactEvidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('unavailable'),
      reason: z.enum([
        'archive-install-required',
        'release-envelope-missing',
        'release-envelope-invalid',
        'companion-payload-invalid',
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('parent-envelope-verified'),
      version: z.string().min(1).max(128),
      source: z.string().regex(/^[a-f0-9]{40}$/),
      artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
      qualification: z.literal('build-only'),
      installationAuthority: z.literal(false),
    })
    .strict(),
]);
const companionPrerequisites = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      checkedAt: time,
      containerHost: z.literal('local'),
      architecture: z.enum(['amd64', 'arm64']),
      dockerVersion: z.string().min(1).max(64),
      composeVersion: z.string().min(1).max(64),
      artifact: companionArtifactEvidence.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unavailable'),
      checkedAt: time,
      reason: z.enum([
        'container-runtime-missing',
        'container-daemon-unavailable',
        'remote-container-context',
        'container-host-unsupported',
        'compose-unavailable',
      ]),
    })
    .strict(),
]);
const count = z.number().int().nonnegative();
const failure = z.object({
  at: time,
  code: z.enum([
    'request_failed',
    'request_timeout',
    'request_cancelled',
    'http_refused',
    'response_invalid',
    'response_too_large',
    'receipt_invalid',
    'endpoint_unconfigured',
    'probe_unsupported',
    'service_stopped',
    'credential_unavailable',
    'restart_required',
  ]),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
const probe = z
  .object({
    phase: z.enum(['never', 'checking', 'ready', 'failed', 'unsupported']),
    checkedAt: time.nullable(),
    scope: z
      .enum(['postgres-schema-v1', 'collector-http-acceptance'])
      .nullable(),
    failure: failure.nullable(),
  })
  .refine(
    (value) =>
      value.phase !== 'ready' ||
      (value.checkedAt !== null &&
        value.scope !== null &&
        value.failure === null),
  );
const exportStatus = z.object({
  lastResult: z.enum(['never', 'accepted', 'failed']),
  attempts: count,
  accepted: count,
  failed: count,
  lastAttemptAt: time.nullable(),
  lastAcceptedAt: time.nullable(),
  lastFailureAt: time.nullable(),
});
const delivery = z.object({
  protocol: z.literal('station-telemetry-delivery/v1'),
  product: z
    .object({
      scope: z.literal('current-process'),
      observedAt: time,
      phase: z.enum([
        'unconfigured',
        'disabled',
        'awaiting-disclosure',
        'ready',
        'acknowledged',
        'failed',
      ]),
      endpointConfigured: z.boolean(),
      keyConfigured: z.boolean(),
      enabled: z.boolean(),
      disclosureAcknowledged: z.boolean(),
      sending: z.boolean(),
      queued: count,
      counts: z.object({
        buffered: count,
        acknowledged: count,
        overflowDropped: count,
        withdrawn: count,
        shutdownDropped: count,
        rejected: count,
        attempts: count,
        failedAttempts: count,
      }),
      lastAttemptAt: time.nullable(),
      lastAcknowledged: z
        .object({ at: time, storedAt: time, eventCount: count })
        .nullable(),
      lastFailure: failure.nullable(),
      probe,
    })
    .refine(
      (value) =>
        value.phase !== 'acknowledged' ||
        (value.endpointConfigured &&
          value.enabled &&
          value.disclosureAcknowledged &&
          value.lastAcknowledged !== null),
    )
    .refine(
      (value) =>
        value.probe.phase !== 'ready' ||
        value.probe.scope === 'postgres-schema-v1',
    ),
  otel: z
    .object({
      scope: z.literal('current-process'),
      observedAt: time,
      phase: z.enum([
        'unconfigured',
        'initializing',
        'initialized',
        'failed',
        'stopped',
        'restart-required',
      ]),
      endpointConfigured: z.boolean(),
      identity: z.enum(['unconfigured', 'pending', 'ready', 'failed']),
      downstreamDelivery: z.literal('unverified'),
      metrics: exportStatus,
      traces: exportStatus,
      probe,
    })
    .refine(
      (value) =>
        value.probe.phase !== 'ready' ||
        value.probe.scope === 'collector-http-acceptance',
    ),
});

const queryKey = (
  apiBase: string,
  options?: ClientRequestOptions,
): string[] => [
  'telemetry-delivery',
  options?.requestScope?.apiBase ?? apiBase,
  options?.requestScope?.authorityKey ?? 'default',
];

async function responseData(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (!response.ok)
    throw envelopeError(
      response,
      body,
      'Telemetry delivery status unavailable',
    );
  if (
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw new Error('Telemetry returned no verified response');
  return body.data;
}

export async function fetchTelemetryDeliveryStatus(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<TelemetryDeliveryStatus> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(
    `${base}/api/usage-telemetry/delivery-status`,
    { ...options, maxResponseBytes: 32_768 },
  );
  const result = delivery.safeParse(await responseData(response));
  if (!result.success)
    throw new Error('Telemetry delivery status is invalid or unsupported');
  return result.data;
}

export async function fetchTelemetryCompanionPrerequisites(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionPrerequisites> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(
    `${base}/api/operator/telemetry-companion/prerequisites?artifactEvidence=1`,
    { ...options, maxResponseBytes: 8192 },
  );
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (!response.ok)
    throw envelopeError(response, body, 'Companion prerequisites unavailable');
  const parsed = z
    .object({
      success: z.literal(true).optional(),
      data: companionPrerequisites,
    })
    .safeParse(body);
  if (!parsed.success)
    throw new Error(
      'Companion prerequisite response is invalid or unsupported',
    );
  return parsed.data.data;
}

export function useTelemetryCompanionPrerequisitesQuery(
  apiBase: string,
  config?: QueryConfig<TelemetryCompanionPrerequisites> & {
    requestScope?: ClientRequestOptions['requestScope'];
  },
) {
  return useApiQuery<TelemetryCompanionPrerequisites>(
    [
      'telemetry-companion-prerequisites',
      config?.requestScope?.apiBase ?? apiBase,
      config?.requestScope?.authorityKey ?? 'default',
    ],
    (signal) =>
      fetchTelemetryCompanionPrerequisites(apiBase, {
        signal,
        requestScope: config?.requestScope,
      }),
    {
      ...config,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      retry: false,
      keepPreviousData: false,
    },
  );
}

export async function checkTelemetryConnection(
  apiBase: string,
  transport: 'product' | 'otel',
  options?: ClientRequestOptions,
): Promise<TelemetryConnectionProbeStatus> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await mutateJson(
    `${base}/api/usage-telemetry/connection-checks/${transport}`,
    'POST',
    { ...options, maxResponseBytes: 8192, readOnly: true },
  );
  const result = probe.safeParse(await responseData(response));
  if (!result.success)
    throw new Error('Telemetry connection check returned an invalid response');
  if (
    result.data.phase === 'ready' &&
    result.data.scope !==
      (transport === 'product'
        ? 'postgres-schema-v1'
        : 'collector-http-acceptance')
  )
    throw new Error(
      'Telemetry connection check returned the wrong delivery scope',
    );
  return result.data;
}

export function useTelemetryDeliveryStatusQuery(
  apiBase: string,
  config?: QueryConfig<TelemetryDeliveryStatus> & {
    requestScope?: ClientRequestOptions['requestScope'];
  },
) {
  return useApiQuery<TelemetryDeliveryStatus>(
    queryKey(apiBase, config),
    (signal) =>
      fetchTelemetryDeliveryStatus(apiBase, {
        requestScope: config?.requestScope,
        signal,
      }),
    {
      staleTime: 0,
      refetchInterval: 15_000,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      retry: false,
      ...config,
      keepPreviousData: false,
    },
  );
}

export function useCheckTelemetryConnectionMutation(
  apiBase: string,
  transport: 'product' | 'otel',
  options?: ClientRequestOptions,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => checkTelemetryConnection(apiBase, transport, options),
    onSettled: () =>
      client.invalidateQueries({ queryKey: queryKey(apiBase, options) }),
  });
}
