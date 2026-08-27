import type { SecretBindingView } from '@kontourai/station-contracts/secret-binding';
import { apiErrorMessage } from './api-error-message';
import { authenticatedFetch } from './http';

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
  init?: RequestInit,
): Promise<T> {
  const response = await authenticatedFetch(
    `${apiBase}/api/secret-bindings${path}`,
    init,
  );
  const result = (await response.json()) as Envelope<T>;
  if (!response.ok || !result.success || result.data === undefined)
    throw new Error(apiErrorMessage(result, 'Secret binding request failed.'));
  return result.data;
}

export const listSecretBindings = (apiBase: string) =>
  request<SecretBindingView[]>(apiBase, '');
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
