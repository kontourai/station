import type { PluginCommandContribution } from '@kontourai/station-contracts/agent-plugin';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { type ClientRequestOptions, getJson } from './http';

export type InstalledPluginRecord = PluginManifest & {
  hasBundle?: boolean;
  /** Parsed, inert Station command declarations from the reserved extension. */
  commandContributions?: PluginCommandContribution[];
  /** Digest of the exact normalized commands and installed plugin identity. */
  commandGeneration?: string;
  /** Server-derived execution facts; clients never infer permission grants. */
  commandCapabilities?: {
    invokeDeclaredOperation: {
      available: boolean;
      reason?: string;
    };
  };
};

export interface PluginCollectionFailure {
  success: false;
  error: string;
  grantsUnavailable?: true;
}

export class PluginCollectionHttpError extends Error {
  readonly status: number;
  readonly envelope: PluginCollectionFailure;

  constructor(status: number, envelope: PluginCollectionFailure) {
    super(envelope.error);
    this.name = 'PluginCollectionHttpError';
    this.status = status;
    this.envelope = envelope;
  }
}

/** Canonical `GET /api/plugins` collection read shared by SDK, UI, CLI, and MCP. */
export async function listPlugins(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<InstalledPluginRecord[]> {
  const response = await getJson(`${apiBase}/api/plugins`, opts);
  const result = (await response.json()) as {
    success?: unknown;
    plugins?: unknown;
    error?: unknown;
    grantsUnavailable?: unknown;
  };
  if (!response.ok) {
    throw new PluginCollectionHttpError(response.status, {
      success: false,
      error:
        typeof result.error === 'string' && result.error.length > 0
          ? result.error
          : `Plugin request failed with HTTP ${response.status}`,
      ...(result.grantsUnavailable === true
        ? { grantsUnavailable: true as const }
        : {}),
    });
  }
  if (result.success === false) {
    throw new PluginCollectionHttpError(200, {
      success: false,
      error:
        typeof result.error === 'string' && result.error.length > 0
          ? result.error
          : 'Plugin collection request was rejected',
    });
  }
  if (
    !Array.isArray(result.plugins) ||
    result.plugins.some(
      (plugin) =>
        !plugin ||
        typeof plugin !== 'object' ||
        Array.isArray(plugin) ||
        typeof (plugin as { name?: unknown }).name !== 'string' ||
        typeof (plugin as { version?: unknown }).version !== 'string',
    )
  ) {
    throw new Error('Plugin collection response is malformed');
  }
  return result.plugins as InstalledPluginRecord[];
}
