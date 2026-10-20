import type { AgentMcpPromptRun } from '@kontourai/station-contracts/mcp-prompts';
import { _getApiBase } from '../api';
import { envelopeError } from '../client/api-error-message';
import { authenticatedFetch } from '../client/http';
import { unlessDeadline } from '../client/request-deadline';

/**
 * #3284: `POST /agents/:slug/mcp-prompts/run` — read one prompt with its
 * arguments. Returns the text to send as the turn; a refusal (missing or
 * unknown argument, content Station cannot insert) throws the server's
 * reason and nothing is sent.
 */
export async function runAgentMcpPrompt(
  agentSlug: string,
  input: {
    serverId: string;
    name: string;
    arguments: Record<string, string>;
  },
): Promise<AgentMcpPromptRun> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/mcp-prompts/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  // A request deadline is passed on; any other unreadable body becomes the
  // generic failure below.
  const result = await response.json().catch(unlessDeadline(() => ({})));
  if (!response.ok || !result.success)
    throw envelopeError(response, result, 'Failed to run the MCP prompt');
  return result.data as AgentMcpPromptRun;
}
