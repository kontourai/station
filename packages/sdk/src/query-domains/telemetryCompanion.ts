import {
  isProductTelemetryIncidents,
  isProductTelemetryTrends,
  isProductTelemetryTrendWindow,
  type ProductTelemetryIncidentLink,
  type ProductTelemetryIncidentLinkReceipt,
  type ProductTelemetryIncidents,
  type ProductTelemetryTrends,
} from '@kontourai/station-contracts/product-telemetry';
import {
  isTelemetryCompanionOperationId,
  type TelemetryCompanionAction,
  type TelemetryCompanionInstallation,
  type TelemetryCompanionManagedState,
} from '@kontourai/station-contracts/telemetry-delivery';
import { workItemRefFromGitHubIssueUrl } from '@kontourai/station-contracts/work-item-provider';
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

export async function fetchTelemetryCompanionProductTrends(
  apiBase: string,
  window: { from: string; to: string },
  options?: ClientRequestOptions,
): Promise<ProductTelemetryTrends> {
  if (!isProductTelemetryTrendWindow(window.from, window.to))
    throw new Error('Invalid product trend window');
  const query = new URLSearchParams(window);
  const value = await response(
    await getJson(
      `${base(apiBase, options)}/api/operator/telemetry-companion/product-trends?${query}`,
      {
        ...options,
        maxResponseBytes: 512 * 1024,
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
    ),
    z.custom<ProductTelemetryTrends>(isProductTelemetryTrends),
  );
  if (value.window.from !== window.from || value.window.to !== window.to)
    throw new Error('Companion query window mismatch');
  return value;
}

export function useTelemetryCompanionProductTrendsQuery(
  apiBase: string,
  window: { from: string; to: string },
  config?: ScopedConfig<ProductTelemetryTrends>,
) {
  return useApiQuery<ProductTelemetryTrends>(
    [...key(apiBase, config), 'product-trends', window.from, window.to],
    (signal) =>
      fetchTelemetryCompanionProductTrends(apiBase, window, {
        signal,
        requestScope: config?.requestScope,
      }),
    queryOptions(config),
  );
}

export async function fetchTelemetryCompanionProductIncidents(
  apiBase: string,
  window: { from: string; to: string },
  options?: ClientRequestOptions,
): Promise<ProductTelemetryIncidents> {
  if (!isProductTelemetryTrendWindow(window.from, window.to))
    throw new Error('Invalid product trend window');
  const query = new URLSearchParams(window);
  const value = await response(
    await getJson(
      `${base(apiBase, options)}/api/operator/telemetry-companion/product-incidents?${query}`,
      {
        ...options,
        maxResponseBytes: 1024 * 1024,
        timeoutMs: options?.timeoutMs ?? 30_000,
      },
    ),
    z.custom<ProductTelemetryIncidents>(isProductTelemetryIncidents),
  );
  if (value.window.from !== window.from || value.window.to !== window.to)
    throw new Error('Companion query window mismatch');
  return value;
}

export function useTelemetryCompanionProductIncidentsQuery(
  apiBase: string,
  window: { from: string; to: string },
  config?: ScopedConfig<ProductTelemetryIncidents>,
) {
  return useApiQuery<ProductTelemetryIncidents>(
    [...key(apiBase, config), 'product-incidents', window.from, window.to],
    (signal) =>
      fetchTelemetryCompanionProductIncidents(apiBase, window, {
        signal,
        requestScope: config?.requestScope,
      }),
    queryOptions(config),
  );
}

const incidentLinkWindow = z
  .object({ from: z.string(), to: z.string() })
  .strict()
  .refine((w) => isProductTelemetryTrendWindow(w.from, w.to));
const incidentLinkGroup = z.string().regex(/^[a-f0-9]{64}$/);
const incidentLink = z
  .object({
    id,
    groupId: incidentLinkGroup,
    issue: z
      .object({
        provider: z.literal('github'),
        url: z.string().max(2048),
        workItemRef: z.string().max(512),
      })
      .strict(),
    window: incidentLinkWindow,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (row) =>
      workItemRefFromGitHubIssueUrl(row.issue.url) === row.issue.workItemRef,
  );
const incidentLinkReceipt = z
  .object({ id, state: z.enum(['active', 'deleted']) })
  .strict();
function incidentLinkPath(
  apiBase: string,
  groupId: string,
  options?: ClientRequestOptions,
) {
  incidentLinkGroup.parse(groupId);
  return `${base(apiBase, options)}/api/operator/telemetry-companion/product-incidents/${groupId}/links`;
}
export async function fetchTelemetryCompanionIncidentLinks(
  apiBase: string,
  groupId: string,
  window: { from: string; to: string },
  options?: ClientRequestOptions,
): Promise<ProductTelemetryIncidentLink[]> {
  incidentLinkWindow.parse(window);
  const rows = await response(
    await getJson(
      `${incidentLinkPath(apiBase, groupId, options)}?${new URLSearchParams(window)}`,
      {
        ...options,
        maxResponseBytes: 32768,
        timeoutMs: options?.timeoutMs ?? 30000,
      },
    ),
    z.array(incidentLink).max(8),
  );
  if (
    rows.some((row) => row.groupId !== groupId) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error('Incident link identity mismatch');
  return rows;
}
export function useTelemetryCompanionIncidentLinksQuery(
  apiBase: string,
  groupId: string | null,
  window: { from: string; to: string },
  config?: ScopedConfig<ProductTelemetryIncidentLink[]>,
) {
  return useApiQuery(
    [
      ...key(apiBase, config),
      'incident-links',
      groupId,
      window.from,
      window.to,
    ],
    (signal) => {
      if (!groupId) throw new Error('Incident group required');
      return fetchTelemetryCompanionIncidentLinks(apiBase, groupId, window, {
        signal,
        requestScope: config?.requestScope,
      });
    },
    {
      ...queryOptions(config),
      enabled: config?.enabled !== false && groupId !== null,
    },
  );
}
export type TelemetryIncidentLinkMutation = {
  groupId: string;
  window: { from: string; to: string };
} & (
  | { kind: 'link'; operationId: string; issueUrl: string }
  | { kind: 'unlink'; linkId: string }
);
export async function mutateTelemetryCompanionIncidentLink(
  apiBase: string,
  input: TelemetryIncidentLinkMutation,
  options?: ClientRequestOptions,
): Promise<ProductTelemetryIncidentLinkReceipt> {
  incidentLinkWindow.parse(input.window);
  const linkPath = incidentLinkPath(apiBase, input.groupId, options);
  const targetId = input.kind === 'link' ? input.operationId : input.linkId;
  validId(targetId);
  if (input.kind === 'link' && !workItemRefFromGitHubIssueUrl(input.issueUrl))
    throw new Error('Use a canonical GitHub issue URL');
  const value = await response(
    await mutateJson(
      input.kind === 'link' ? linkPath : `${linkPath}/${targetId}`,
      input.kind === 'link' ? 'POST' : 'DELETE',
      {
        ...options,
        maxResponseBytes: 4096,
        timeoutMs: options?.timeoutMs ?? 30000,
      },
      input.kind === 'link'
        ? {
            operationId: input.operationId,
            window: input.window,
            issueUrl: input.issueUrl,
          }
        : { window: input.window },
    ),
    incidentLinkReceipt,
  );
  if (value.id !== targetId) throw new Error('Incident link receipt mismatch');
  return value;
}
export function useTelemetryCompanionIncidentLinkMutation(
  apiBase: string,
  options?: ClientRequestOptions,
) {
  const client = useQueryClient(),
    queryKey = key(apiBase, options);
  return useMutation({
    mutationKey: [...queryKey, 'incident-link-write'],
    gcTime: 0,
    retry: false,
    mutationFn: (input: TelemetryIncidentLinkMutation) =>
      mutateTelemetryCompanionIncidentLink(apiBase, input, options),
    onSettled: (_data, _error, input) =>
      client.invalidateQueries({
        queryKey: [...queryKey, 'incident-links', input.groupId],
      }),
  });
}
