/**
 * Canonical MCP-tool-server "integrations" fetchers (#167 Wave 1). No
 * `packages/sdk/src/query-domains/*.ts` file implements these today (the
 * UI's tool-server settings panel is not backed by a shared fetcher layer
 * either) — this module is new, replacing the CLI's `runToolsCommand`
 * (`packages/cli/src/commands/surfaces.ts`) and
 * `station-control-platform-tools.ts`'s inline `api('/integrations'...)`
 * calls.
 *
 * Response handling follows the CLI's ordered error-message precedence via
 * `readEnvelopeOrThrow` (`error || message || 'Request failed with HTTP
 * <status>'`): the CLI's `requestJson`-based dispatcher is the only pre-#167
 * consumer with an established unwrap-or-throw contract for this route
 * family; station-control's raw-forwarding call sites need their own adapter
 * when migrated, Wave 2B.
 */
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

/** `GET /integrations` — list configured MCP tool servers. */
export async function listIntegrations(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(`${apiBase}/integrations`, opts);
  return readEnvelopeOrThrow(response);
}

/** `GET /integrations/:id` — get one integration. */
export async function getIntegration(
  apiBase: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(
    `${apiBase}/integrations/${encodeURIComponent(id)}`,
    opts,
  );
  return readEnvelopeOrThrow(response);
}

/** `POST /integrations` — create an integration. */
export async function createIntegration(
  apiBase: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/integrations`,
    'POST',
    opts,
    body,
  );
  return readEnvelopeOrThrow(response);
}

/** `PUT /integrations/:id` — update an integration. */
export async function updateIntegration(
  apiBase: string,
  id: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/integrations/${encodeURIComponent(id)}`,
    'PUT',
    opts,
    body,
  );
  return readEnvelopeOrThrow(response);
}

/** `DELETE /integrations/:id` — remove an integration. */
export async function deleteIntegration(
  apiBase: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/integrations/${encodeURIComponent(id)}`,
    'DELETE',
    opts,
  );
  return readEnvelopeOrThrow(response);
}

/** `POST /integrations/:id/reconnect` — reconnect an integration. */
export async function reconnectIntegration(
  apiBase: string,
  id: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/integrations/${encodeURIComponent(id)}/reconnect`,
    'POST',
    opts,
  );
  return readEnvelopeOrThrow(response);
}
