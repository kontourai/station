import type { InstallResult } from '@kontourai/station-contracts/catalog';
import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import type { LayoutComponentRef } from '@kontourai/station-contracts/layout';
import { _getApiBase } from '../api';
import type { RegistryCatalogTab } from './catalog';

type CatalogResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

/**
 * The portable Kit endpoint is intentionally projection-only. These are
 * Station's client-side transport types, rather than imports of a server
 * service, so the SDK remains usable by any Station client.
 */
export interface KitStandardView {
  id: string;
  kind: 'standard-view';
  projection: string;
  schemaRef: string;
  readOnly: true;
}

export interface KitExperience {
  status: string;
  diagnostics: Array<{ code: string; message: string }>;
  standardViews: KitStandardView[];
  mcpComponent?: Extract<LayoutComponentRef, { kind: 'mcp-tool-ui' }>;
  provenance?: Record<string, unknown>;
}

export interface KitRegistryEntry {
  contributionRef: string;
  lifecycle: 'installed' | 'disabled' | 'uninstalled';
  incarnation: number;
  experience: KitExperience;
}

export interface KitLayoutProjection {
  component?: Extract<LayoutComponentRef, { kind: 'mcp-tool-ui' }>;
  standardViews: KitStandardView[];
}

async function fetchCatalogResponse<T>(
  path: string,
  init?: RequestInit,
): Promise<CatalogResponse<T>> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}${path}`, init);
  return (await response.json()) as CatalogResponse<T>;
}

async function requestCatalog<T>(
  path: string,
  init?: RequestInit,
  fallbackError?: string,
): Promise<T> {
  const result = await fetchCatalogResponse<T>(path, init);
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, fallbackError ?? 'The catalog request failed.'),
    );
  }
  return result.data as T;
}

export async function fetchRegistryItems<T>(
  tab: RegistryCatalogTab,
  installed: boolean,
): Promise<T[]> {
  const suffix = installed ? '/installed' : '';
  const result = await fetchCatalogResponse<T[]>(
    `/api/registry/${tab}${suffix}`,
  );
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, `Failed to fetch ${tab} registry items`),
    );
  }
  return (result.data || []) as T[];
}

/** Lists host-discovered Kit contributions without executing or installing one. */
export async function fetchKitRegistry(): Promise<KitRegistryEntry[]> {
  return requestCatalog<KitRegistryEntry[]>(
    '/api/registry/kits',
    undefined,
    'Failed to fetch Kit registry items',
  );
}

/** Resolves the read-only layout projection for an already discovered Kit. */
export async function fetchKitLayout(
  contributionRef: string,
): Promise<KitLayoutProjection> {
  return requestCatalog<KitLayoutProjection>(
    `/api/registry/kits/${encodeURIComponent(contributionRef)}/layout`,
    undefined,
    'Could not load this Kit’s layout view',
  );
}

export async function requestIntegration<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return requestCatalog<T>(
    `/integrations${path}`,
    init,
    'Integration request failed',
  );
}

export async function requestRegistryIntegrationAction({
  id,
  action,
}: {
  id: string;
  action: 'install' | 'uninstall';
}): Promise<InstallResult> {
  return requestRegistryCatalogAction('integrations', { id, action });
}

export async function requestRegistryCatalogAction(
  tab: RegistryCatalogTab,
  {
    id,
    action,
    consent,
    skip,
  }: {
    id: string;
    action: 'install' | 'uninstall';
    /**
     * Operator pre-install decision for an entry that resolves as a plugin
     * (station#4288); the server ignores it for plain agent installs and
     * refuses a code-contributing plugin without it.
     */
    consent?: {
      permissions: string[];
      contentDigest: string;
      dependencies: string[];
    };
    /** Preview conflict components to skip, as `type:id` keys. */
    skip?: string[];
  },
): Promise<InstallResult> {
  const apiBase = await _getApiBase();
  const response =
    action === 'install'
      ? await authenticatedFetch(`${apiBase}/api/registry/${tab}/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            ...(consent ? { consent } : {}),
            ...(skip ? { skip } : {}),
          }),
        })
      : await authenticatedFetch(
          `${apiBase}/api/registry/${tab}/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
  const result = (await response.json()) as InstallResult & {
    error?: string;
    message?: string;
  };
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, result.message || `${action} failed`),
    );
  }
  return result as InstallResult;
}

export async function requestRegistryLayoutAction({
  id,
  action,
}: {
  id: string;
  action: 'install' | 'remove' | 'enable' | 'disable';
}): Promise<LayoutCatalogItem> {
  const encodedId = encodeURIComponent(id);
  const path =
    action === 'remove'
      ? `/api/registry/layouts/${encodedId}`
      : `/api/registry/layouts/${encodedId}/${action}`;
  return requestCatalog<LayoutCatalogItem>(
    path,
    action === 'remove' ? { method: 'DELETE' } : { method: 'POST' },
    `Layout ${action} failed`,
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
