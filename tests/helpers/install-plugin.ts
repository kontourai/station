import { authenticatedE2EFetch } from './authenticated-request';

/**
 * Installs a plugin the way Station's own client installs one (archive#4288):
 * preview first, then install carrying the decision that preview produced.
 *
 * `POST /api/plugins/install` refuses a request with no `consent` — before it
 * stages anything, let alone writes. Every spec here used to send
 * `{ source }` alone, which is the shape the route now answers with a 400. So
 * the sequence lives in one place rather than six, and a spec that installs a
 * plugin exercises the real client's order: derive from a staged copy, answer
 * about THOSE bytes, install.
 *
 * The values sent back are the server's own derivation, echoed verbatim. That
 * is exactly what the browser client does and exactly what the gate can and
 * cannot prove: it establishes that the install carries a decision taken on a
 * preview, not that a human took it. In a test there is no human, and this
 * helper does not pretend otherwise.
 */
export interface PluginPreviewPayload {
  valid: boolean;
  error?: string;
  manifest?: { name?: string; version?: string };
  dependencies?: Array<{ id: string }>;
  contentDigest?: string;
  permissions?: {
    required: string[];
    autoGranted: string[];
    pendingConsent: Array<{ permission: string; tier: string }>;
  };
}

export async function previewPluginForInstall(
  apiBase: string,
  source: string,
): Promise<PluginPreviewPayload> {
  const response = await authenticatedE2EFetch(
    `${apiBase}/api/plugins/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    },
  );
  const preview = (await response.json()) as PluginPreviewPayload;
  if (!preview.valid) {
    throw new Error(
      `Plugin preview refused ${source}: ${preview.error ?? 'no reason given'}`,
    );
  }
  if (!preview.contentDigest || !preview.permissions) {
    throw new Error(
      `Plugin preview for ${source} reported no basis to approve, so there is nothing to install with.`,
    );
  }
  return preview;
}

/** Preview the exact source resolved by the plugin Registry for one item id. */
export async function previewRegistryPluginForInstall(
  apiBase: string,
  registryId: string,
): Promise<PluginPreviewPayload> {
  const response = await authenticatedE2EFetch(
    `${apiBase}/api/plugins/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registryId }),
    },
  );
  const preview = (await response.json()) as PluginPreviewPayload;
  if (!preview.valid) {
    throw new Error(
      `Plugin Registry preview refused ${registryId}: ${preview.error ?? 'no reason given'}`,
    );
  }
  if (!preview.contentDigest || !preview.permissions) {
    throw new Error(
      `Plugin Registry preview for ${registryId} reported no basis to approve, so there is nothing to install with.`,
    );
  }
  return preview;
}

export async function installPluginWithConsent(
  apiBase: string,
  source: string,
  options: { skip?: string[] } = {},
): Promise<any> {
  const preview = await previewPluginForInstall(apiBase, source);
  const response = await authenticatedE2EFetch(
    `${apiBase}/api/plugins/install`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        ...(options.skip ? { skip: options.skip } : {}),
        consent: {
          permissions: preview.permissions?.required ?? [],
          contentDigest: preview.contentDigest,
          dependencies: (preview.dependencies ?? []).map((entry) => entry.id),
        },
      }),
    },
  );
  return response.json();
}

/** Preview and install through the same Registry identity and consent basis. */
export async function installRegistryPluginWithConsent(
  apiBase: string,
  registryId: string,
  options: { skip?: string[] } = {},
): Promise<any> {
  const preview = await previewRegistryPluginForInstall(apiBase, registryId);
  const response = await authenticatedE2EFetch(
    `${apiBase}/api/registry/plugins/install`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: registryId,
        ...(options.skip ? { skip: options.skip } : {}),
        consent: {
          permissions: preview.permissions?.required ?? [],
          contentDigest: preview.contentDigest,
          dependencies: (preview.dependencies ?? []).map((entry) => entry.id),
        },
      }),
    },
  );
  return response.json();
}
