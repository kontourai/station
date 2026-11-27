import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import { ENGINE_MCP_SERVER_NAME_MAX_CHARS } from '@kontourai/station-contracts/runtime-events';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, mutateJson, readJsonBody } from './http';

function readOutcome(value: unknown): EngineCommandOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const outcome = value as Record<string, unknown>;
  switch (outcome.kind) {
    case 'answered':
      if (
        (outcome.text !== undefined && typeof outcome.text !== 'string') ||
        (outcome.success !== undefined && typeof outcome.success !== 'boolean')
      )
        return null;
      return {
        kind: 'answered',
        ...(typeof outcome.text === 'string' ? { text: outcome.text } : {}),
        ...(typeof outcome.success === 'boolean'
          ? { success: outcome.success }
          : {}),
      };
    case 'failed':
      return typeof outcome.message === 'string'
        ? { kind: 'failed', message: outcome.message }
        : null;
    case 'unsupported':
    case 'not-declared':
      return { kind: outcome.kind };
    default:
      return null;
  }
}

/**
 * `POST /api/orchestration/sessions/:threadId/mcp-servers/:serverName/reconnect`:
 * ask the Session's engine to restart one MCP server it runs, or with
 * `startOAuth` to begin that server's sign-in (the consent link arrives as a
 * URL input request). Answers the engine's outcome as it gave it.
 *
 * A host that predates the route answers 404, as it does for a Session the
 * caller does not own; both read as `unsupported` (nothing here can do it).
 */
export async function reconnectEngineMcpServer(
  apiBase: string,
  threadId: string,
  serverName: string,
  options: { startOAuth: boolean },
  opts?: ClientRequestOptions,
): Promise<EngineCommandOutcome> {
  if (!threadId || threadId.length > 512)
    throw Error('An exact Session is required.');
  if (!serverName || serverName.length > ENGINE_MCP_SERVER_NAME_MAX_CHARS)
    throw Error('An MCP server name is required.');
  const response = await mutateJson(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}/mcp-servers/${encodeURIComponent(serverName)}/reconnect`,
    'POST',
    opts,
    options.startOAuth ? { startOAuth: true } : {},
  );
  if (response.status === 404) return { kind: 'unsupported' };
  const body = await readJsonBody(response);
  if (!response.ok)
    throw envelopeError(response, body, 'The engine could not be asked');
  const outcome =
    body && typeof body === 'object' && 'data' in body
      ? readOutcome((body as { data: unknown }).data)
      : null;
  if (!outcome) throw Error('Invalid MCP reconnect response');
  return outcome;
}
