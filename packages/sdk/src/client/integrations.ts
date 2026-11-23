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
import type {
  ToolServerEventCatalog,
  ToolServerEventPollInput,
  ToolServerEventPollPage,
  ToolServerEventStreamFrame,
  ToolServerEventStreamInput,
} from '@kontourai/station-contracts/tool';
import { z } from 'zod';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  consumeSseResponse,
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

export async function discoverIntegrationEvents(
  id: string,
  requestScope: ApiRequestScope,
): Promise<ToolServerEventCatalog> {
  const response = await mutateJson(
    `${requestScope.apiBase}/integrations/${encodeURIComponent(id)}/events/discover`,
    'POST',
    { requestScope, readOnly: true },
  );
  const catalog = await readEnvelopeOrThrow<ToolServerEventCatalog>(response);
  if (!catalog) throw new Error('Event catalog missing from response');
  return catalog;
}

export async function pollIntegrationEvents(
  id: string,
  input: ToolServerEventPollInput,
  requestScope: ApiRequestScope,
): Promise<ToolServerEventPollPage> {
  const response = await mutateJson(
    `${requestScope.apiBase}/integrations/${encodeURIComponent(id)}/events/poll`,
    'POST',
    { requestScope, readOnly: true, maxResponseBytes: 512 * 1024 },
    input,
  );
  const page = await readEnvelopeOrThrow<ToolServerEventPollPage>(response);
  if (!page) throw new Error('Event page missing from response');
  return page;
}

const eventStreamFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('active'),
    cursor: z.string().min(1).max(4096),
    truncated: z.boolean(),
    heartbeatMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('event'),
    cursor: z.string().min(1).max(4096),
    eventId: z.string().min(1).max(256),
    timestamp: z.iso.datetime({ offset: true }),
    data: z.json(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    cursor: z.string().min(1).max(4096),
  }),
  z.object({
    type: z.literal('ended'),
    reason: z.enum(['complete', 'unavailable']),
  }),
]);

export async function streamIntegrationEvents(
  id: string,
  input: ToolServerEventStreamInput,
  requestScope: ApiRequestScope,
  signal: AbortSignal,
  receive: (frame: ToolServerEventStreamFrame) => void,
): Promise<void> {
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  try {
    const response = await mutateJson(
      `${requestScope.apiBase}/integrations/${encodeURIComponent(id)}/events/stream`,
      'POST',
      {
        requestScope,
        signal: lifetime,
        readOnly: true,
        maxResponseBytes: 3 * 1024 * 1024,
      },
      input,
    );
    if (
      response.ok &&
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('text/event-stream')
    )
      throw new Error('Event stream response is invalid.');
    let ended = false;
    await consumeSseResponse(response, lifetime, ({ data }) => {
      lifetime.throwIfAborted();
      if (ended) throw new Error('Event stream sent data after ending.');
      const frame = eventStreamFrame.parse(JSON.parse(data));
      receive(frame);
      ended = frame.type === 'ended';
    });
    lifetime.throwIfAborted();
    if (!ended)
      throw new Error('Live events closed without a completion frame.');
  } finally {
    controller.abort();
  }
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
