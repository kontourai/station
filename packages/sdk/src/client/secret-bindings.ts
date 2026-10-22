import type {
  SecretBindingView,
  TelemetryDestinationGrant,
} from '@kontourai/station-contracts/secret-binding';
import { envelopeError } from './api-error-message';
import {
  type AuthenticatedFetchInit,
  authenticatedFetch,
  type ClientRequestOptions,
  getJson,
  mutateJson,
} from './http';
import { rethrowDeadline } from './request-deadline';

export interface SecretBindingConsumerInput {
  integrationId: string;
  envName: string;
  expectedRevision: number;
}

export interface SecretBindingConsumerOutcome {
  outcome: 'complete' | 'safe-partial';
  binding: SecretBindingView;
  integrationId: string;
  envName: string;
  configurationError?: string;
}

export interface StoredEnvMigrationOutcome {
  outcome: 'migrated';
  migratedEnvNames: string[];
}

/** Metadata-only projection of the integration's persisted binding choices. */
export interface IntegrationSecretBindingProjection {
  integrationId: string;
  secretEnvBindingIds: Record<string, string>;
}

type Envelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: { formErrors?: unknown; fieldErrors?: unknown };
};

/**
 * Every fetcher here takes `apiBase` explicitly, per the contract in
 * `client/http.ts`: nothing under `client/**` reads the module-level base,
 * because that is what lets this entry run in a CLI process and a browser
 * alike. Reaching for `_getApiBase` from `../api` broke that (station#4011) —
 * the caller decides its own base and passes it in.
 */
async function request<T>(
  apiBase: string,
  path: string,
  init?: AuthenticatedFetchInit,
): Promise<T> {
  const response = await authenticatedFetch(
    `${apiBase}/api/secret-bindings${path}`,
    init,
  );
  return bindingResponse<T>(response);
}

async function bindingResponse<T>(response: Response): Promise<T> {
  let result: Envelope<T>;
  try {
    result = (await response.json()) as Envelope<T>;
  } catch (error) {
    rethrowDeadline(error);
    // A non-JSON failure (a proxy's HTML 502) keeps its status (#2708); an
    // unreadable 2xx is a protocol failure and rethrows the parse error.
    if (!response.ok)
      throw envelopeError(
        response,
        undefined,
        'Secret binding request failed.',
      );
    throw error;
  }
  // #2708: a refusal keeps its status, `code` and validation `details`, so the
  // UI can show the server's reason rather than the schema's field names.
  if (!response.ok || !result.success || result.data === undefined)
    throw envelopeError(response, result, 'Secret binding request failed.');
  return result.data;
}

export const listSecretBindings = (apiBase: string) =>
  request<SecretBindingView[]>(apiBase, '');

/** Captured authority for operator telemetry grants; never materializes a key. */
export async function listTelemetrySecretBindings(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<SecretBindingView[]> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(`${base}/api/secret-bindings`, {
    ...options,
    maxResponseBytes: 65_536,
  });
  const bindings = await bindingResponse<SecretBindingView[]>(response);
  if (
    !Array.isArray(bindings) ||
    !bindings.every(telemetryBindingMetadataValid)
  )
    throw new Error('Telemetry key references returned invalid metadata.');
  return bindings;
}

function telemetryBindingMetadataValid(binding: SecretBindingView): boolean {
  return Boolean(
    binding &&
      typeof binding.id === 'string' &&
      typeof binding.name === 'string' &&
      Number.isSafeInteger(binding.revision) &&
      binding.revision > 0 &&
      (!binding.owner ||
        ['instance', 'principal', 'principal-project'].includes(
          binding.owner.kind,
        )) &&
      (binding.telemetryDestinationGrants === undefined ||
        (Array.isArray(binding.telemetryDestinationGrants) &&
          binding.telemetryDestinationGrants.every(telemetryGrantValid))),
  );
}

function telemetryGrantValid(grant: TelemetryDestinationGrant): boolean {
  if (
    grant?.kind !== 'instance-telemetry-destination' ||
    !['product', 'otel'].includes(grant.transport) ||
    typeof grant.destination !== 'string' ||
    grant.destination.length > 2048 ||
    grant.destination !== grant.destination.trim()
  )
    return false;
  try {
    const address = new URL(grant.destination);
    return (
      ['http:', 'https:'].includes(address.protocol) &&
      !address.username &&
      !address.password &&
      !address.search &&
      !address.hash
    );
  } catch {
    return false;
  }
}

export interface TelemetrySecretBindingInput extends TelemetryDestinationGrant {
  expectedRevision: number;
}

export async function updateTelemetrySecretBindingGrant(
  apiBase: string,
  id: string,
  operation: 'bind' | 'unbind',
  input: TelemetrySecretBindingInput,
  options?: ClientRequestOptions,
): Promise<SecretBindingView> {
  if (
    !telemetryGrantValid(input) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw new Error(
      'Choose an exact HTTP or HTTPS destination without credentials, query or fragment.',
    );
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await mutateJson(
    `${base}/api/secret-bindings/${encodeURIComponent(id)}/${operation}`,
    'POST',
    {
      ...options,
      maxResponseBytes: 32_768,
      ...(operation === 'unbind'
        ? { offlinePolicy: 'always-attempt' as const }
        : {}),
    },
    input,
  );
  const binding = await bindingResponse<SecretBindingView>(response);
  if (
    !telemetryBindingMetadataValid(binding) ||
    binding.id !== id ||
    binding.revision !== input.expectedRevision + 1
  )
    throw new Error(
      'Telemetry destination grant returned invalid metadata. Refresh before retrying.',
    );
  const granted = (binding.telemetryDestinationGrants ?? []).some(
    (grant) =>
      grant.transport === input.transport &&
      new URL(grant.destination).href === new URL(input.destination).href,
  );
  if (granted !== (operation === 'bind'))
    throw new Error(
      'Telemetry destination grant was not confirmed. Refresh before retrying.',
    );
  return binding;
}
export const getSecretBinding = (apiBase: string, id: string) =>
  request<SecretBindingView>(apiBase, `/${encodeURIComponent(id)}`);
export const getIntegrationSecretBindings = (
  apiBase: string,
  integrationId: string,
) =>
  request<IntegrationSecretBindingProjection>(
    apiBase,
    `/integrations/${encodeURIComponent(integrationId)}`,
  );
export const createSecretBinding = (
  apiBase: string,
  data: {
    id: string;
    name: string;
    authRef: unknown;
  },
) =>
  request<SecretBindingView>(apiBase, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
export const replaceSecretBinding = (
  apiBase: string,
  id: string,
  data: { name: string; authRef: unknown; expectedRevision: number },
) =>
  request<SecretBindingView>(apiBase, `/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
export const revokeSecretBinding = (
  apiBase: string,
  id: string,
  expectedRevision: number,
) =>
  request<SecretBindingView>(apiBase, `/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    offlinePolicy: 'always-attempt',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision }),
  });
export const bindSecretBinding = (
  apiBase: string,
  id: string,
  data: SecretBindingConsumerInput,
) =>
  request<SecretBindingConsumerOutcome>(
    apiBase,
    `/${encodeURIComponent(id)}/bind`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
export const unbindSecretBinding = (
  apiBase: string,
  id: string,
  data: SecretBindingConsumerInput,
) =>
  request<SecretBindingConsumerOutcome>(
    apiBase,
    `/${encodeURIComponent(id)}/unbind`,
    {
      method: 'POST',
      offlinePolicy: 'always-attempt',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
/** Endpoint contract owned by the resolver/migration lane; never reads material in the SDK. */
export const migrateStoredSecretEnv = (
  apiBase: string,
  integrationId: string,
  data: Record<string, unknown>,
) =>
  request<StoredEnvMigrationOutcome>(
    apiBase,
    `/integrations/${encodeURIComponent(integrationId)}/migrate-stored-env`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
