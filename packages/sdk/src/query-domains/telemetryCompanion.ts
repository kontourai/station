import {
  isTelemetryCompanionOperationId,
  type TelemetryCompanionAction,
  type TelemetryCompanionInstallation,
  type TelemetryCompanionManagedState,
} from '@kontourai/station-contracts/telemetry-delivery';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { envelopeError } from '../client/api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import { type QueryConfig, useApiQuery } from '../query-core';

const id = z.string().refine(isTelemetryCompanionOperationId);
const installation = z
  .object({
    protocol: z.literal('station-companion-installation/v1'),
    installationId: id,
    preparationId: id,
    source: z.string().regex(/^[a-f0-9]{40}$/),
    version: z.string().min(1).max(128),
    architecture: z.enum(['amd64', 'arm64']),
    phase: z.enum(['preparing', 'installed', 'failed']),
    createdAt: z.string().datetime(),
    host: z.literal('selected-station'),
    storage: z.literal('managed-docker-volumes'),
    configuresSending: z.literal(false),
  })
  .strict();
const action = z
  .object({
    protocol: z.literal('station-companion-action/v1'),
    operationId: id,
    installationId: id,
    action: z.enum(['start', 'stop']),
    phase: z.enum(['pending', 'completed', 'unconfirmed']),
    createdAt: z.string().datetime(),
    configuresSending: z.literal(false),
  })
  .strict();
const managedState = z
  .object({
    supported: z.boolean(),
    hasOperationLock: z.boolean(),
    installation: installation.nullable(),
    latestAction: action.nullable(),
    runtime: z.enum([
      'not-installed',
      'unavailable',
      'stopped',
      'running',
      'partial',
    ]),
    storage: z.enum(['not-checked', 'ready', 'unavailable']),
    observedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.latestAction ||
        value.latestAction.installationId ===
          value.installation?.installationId) &&
      (value.runtime !== 'not-installed' || value.installation === null) &&
      (!['stopped', 'running', 'partial'].includes(value.runtime) ||
        value.installation?.phase === 'installed') &&
      (value.storage !== 'ready' || value.runtime === 'running'),
  );
type InstallInput = Pick<
  TelemetryCompanionInstallation,
  'installationId' | 'preparationId' | 'host' | 'storage'
>;
type ControlInput = Pick<
  TelemetryCompanionAction,
  'installationId' | 'operationId' | 'action'
>;
type ScopedConfig<T> = QueryConfig<T> & {
  requestScope?: ClientRequestOptions['requestScope'];
};

const base = (apiBase: string, options?: ClientRequestOptions) =>
  options?.requestScope?.apiBase ?? apiBase;
const key = (apiBase: string, options?: ClientRequestOptions) =>
  [
    'telemetry-companion-managed',
    base(apiBase, options),
    options?.requestScope?.authorityKey ?? 'default',
  ] as const;
const path = (apiBase: string, options?: ClientRequestOptions) =>
  `${base(apiBase, options)}/api/operator/telemetry-companion/installations`;
function validId(value: string) {
  if (!isTelemetryCompanionOperationId(value))
    throw new Error('Invalid companion operation identity');
}
async function response<T>(value: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await value.json().catch(unlessDeadline(() => null));
  if (!value.ok)
    throw envelopeError(value, body, 'Companion operation unavailable');
  const parsed = z
    .object({ success: z.literal(true).optional(), data: schema })
    .safeParse(body);
  if (!parsed.success)
    throw new Error('Companion response is invalid or unsupported');
  return parsed.data.data;
}

export async function fetchTelemetryCompanionManagedState(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionManagedState> {
  return response(
    await getJson(path(apiBase, options), {
      ...options,
      maxResponseBytes: 8192,
      timeoutMs: options?.timeoutMs ?? 30_000,
    }),
    managedState,
  );
}
export async function fetchTelemetryCompanionInstallation(
  apiBase: string,
  installationId: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionInstallation> {
  validId(installationId);
  const value = await response(
    await getJson(`${path(apiBase, options)}/${installationId}`, {
      ...options,
      maxResponseBytes: 8192,
    }),
    installation,
  );
  if (value.installationId !== installationId)
    throw new Error('Installation identity changed');
  return value;
}
export async function fetchTelemetryCompanionAction(
  apiBase: string,
  installationId: string,
  operationId: string,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionAction> {
  validId(installationId);
  validId(operationId);
  const value = await response(
    await getJson(
      `${path(apiBase, options)}/${installationId}/actions/${operationId}`,
      { ...options, maxResponseBytes: 8192 },
    ),
    action,
  );
  if (
    value.installationId !== installationId ||
    value.operationId !== operationId
  )
    throw new Error('Companion action identity changed');
  return value;
}
export async function installTelemetryCompanion(
  apiBase: string,
  input: InstallInput,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionInstallation> {
  const intent = installation
    .pick({
      installationId: true,
      preparationId: true,
      host: true,
      storage: true,
    })
    .parse(input);
  const value = await response(
    await mutateJson(
      path(apiBase, options),
      'POST',
      {
        ...options,
        maxResponseBytes: 8192,
        timeoutMs: options?.timeoutMs ?? 650_000,
      },
      intent,
    ),
    installation,
  );
  if (
    value.installationId !== input.installationId ||
    value.preparationId !== input.preparationId
  )
    throw new Error('Installation intent changed');
  return value;
}
export async function controlTelemetryCompanion(
  apiBase: string,
  input: ControlInput,
  options?: ClientRequestOptions,
): Promise<TelemetryCompanionAction> {
  validId(input.installationId);
  const intent = action
    .pick({ operationId: true, action: true })
    .parse({ operationId: input.operationId, action: input.action });
  const value = await response(
    await mutateJson(
      `${path(apiBase, options)}/${input.installationId}/actions`,
      'POST',
      {
        ...options,
        maxResponseBytes: 8192,
        timeoutMs: options?.timeoutMs ?? 200_000,
      },
      intent,
    ),
    action,
  );
  if (
    value.installationId !== input.installationId ||
    value.operationId !== input.operationId ||
    value.action !== input.action
  )
    throw new Error('Companion action intent changed');
  return value;
}
const queryOptions = <T>(config?: ScopedConfig<T>) => ({
  ...config,
  staleTime: 0,
  gcTime: 0,
  refetchOnMount: 'always' as const,
  refetchOnWindowFocus: false,
  retry: false as const,
  keepPreviousData: false,
});

export function useTelemetryCompanionManagedStateQuery(
  apiBase: string,
  config?: ScopedConfig<TelemetryCompanionManagedState>,
) {
  return useApiQuery<TelemetryCompanionManagedState>(
    [...key(apiBase, config), 'state'],
    (signal) =>
      fetchTelemetryCompanionManagedState(apiBase, {
        signal,
        requestScope: config?.requestScope,
      }),
    queryOptions(config),
  );
}
export function useTelemetryCompanionInstallationQuery(
  apiBase: string,
  installationId: string | null,
  config?: ScopedConfig<TelemetryCompanionInstallation>,
) {
  return useApiQuery<TelemetryCompanionInstallation>(
    [...key(apiBase, config), 'installation', installationId],
    (signal) => {
      if (!installationId) throw new Error('Installation identity required');
      return fetchTelemetryCompanionInstallation(apiBase, installationId, {
        signal,
        requestScope: config?.requestScope,
      });
    },
    {
      ...queryOptions(config),
      enabled: config?.enabled !== false && installationId !== null,
    },
  );
}
export function useTelemetryCompanionActionQuery(
  apiBase: string,
  installationId: string | null,
  operationId: string | null,
  config?: ScopedConfig<TelemetryCompanionAction>,
) {
  return useApiQuery<TelemetryCompanionAction>(
    [...key(apiBase, config), 'action', installationId, operationId],
    (signal) => {
      if (!installationId || !operationId)
        throw new Error('Companion action identity required');
      return fetchTelemetryCompanionAction(
        apiBase,
        installationId,
        operationId,
        { signal, requestScope: config?.requestScope },
      );
    },
    {
      ...queryOptions(config),
      enabled:
        config?.enabled !== false &&
        installationId !== null &&
        operationId !== null,
    },
  );
}
export function useInstallTelemetryCompanionMutation(
  apiBase: string,
  options?: ClientRequestOptions,
) {
  const client = useQueryClient();
  const queryKey = key(apiBase, options);
  return useMutation({
    mutationKey: queryKey,
    gcTime: 0,
    retry: false,
    mutationFn: (input: InstallInput) =>
      installTelemetryCompanion(apiBase, input, options),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
}
export function useControlTelemetryCompanionMutation(
  apiBase: string,
  options?: ClientRequestOptions,
) {
  const client = useQueryClient();
  const queryKey = key(apiBase, options);
  return useMutation({
    mutationKey: queryKey,
    gcTime: 0,
    retry: false,
    mutationFn: (input: ControlInput) =>
      controlTelemetryCompanion(apiBase, input, options),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
}
