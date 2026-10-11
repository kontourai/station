/**
 * #3284: MCP server prompts as an agent's slash commands.
 *
 * Scope is the agent's tool view: a prompt is offered only from a server the
 * agent attaches (`tools.mcpServers`), and only when the agent's
 * `tools.available` restriction admits `<serverId>_<promptName>` — the same
 * pattern grammar and the same identity shape its tools use — so an agent
 * narrowed to specific tools is not handed a server's prompts by default.
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  AgentMcpPrompt,
  AgentMcpPromptListing,
  AgentMcpPromptRun,
} from '@kontourai/station-contracts/mcp-prompts';
import type { GetPromptResult, Prompt } from '@modelcontextprotocol/client';
import { isRuntimeManagedIntegrationId } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { matchesToolPattern } from '../../runtime/tools/mcp-tool-names.js';
import { MCPServerDisabledError } from './mcp-service.js';

export interface McpPromptSource {
  listMCPPrompts(serverId: string): Promise<Prompt[]>;
  getMCPPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<GetPromptResult>;
}

/** A refused prompt request; `status` is the HTTP answer the route gives. */
export class McpPromptRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 422 | 502,
  ) {
    super(message);
  }
}

const MCP_PROMPT_MAX_ARGUMENT_CHARS = 12000;
/** Bound on the text a prompt may insert; larger output is refused. */
const MCP_PROMPT_MAX_TEXT_CHARS = 100_000;

function promptServerIds(spec: AgentSpec): string[] {
  return [...new Set(spec.tools?.mcpServers ?? [])].filter(
    (id) => !isRuntimeManagedIntegrationId(id),
  );
}

function offered(spec: AgentSpec, serverId: string, name: string): boolean {
  const available = spec.tools?.available ?? ['*'];
  return (
    available.includes('*') ||
    matchesToolPattern(`${serverId}_${name}`, available, new Map())
  );
}

function toAgentPrompt(serverId: string, prompt: Prompt): AgentMcpPrompt {
  return {
    command: `${serverId}:${prompt.name}`,
    serverId,
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    arguments: (prompt.arguments ?? []).map((argument) => ({
      name: argument.name,
      ...(argument.description ? { description: argument.description } : {}),
      required: argument.required === true,
    })),
  };
}

export async function listAgentMcpPrompts(
  spec: AgentSpec,
  source: Pick<McpPromptSource, 'listMCPPrompts'>,
): Promise<AgentMcpPromptListing> {
  const listing: AgentMcpPromptListing = { prompts: [], unavailable: [] };
  const results = await Promise.allSettled(
    promptServerIds(spec).map(async (serverId) => ({
      serverId,
      prompts: await source.listMCPPrompts(serverId),
    })),
  );
  for (const [index, result] of results.entries()) {
    const serverId = promptServerIds(spec)[index];
    if (result.status === 'rejected') {
      // A disabled server is not part of the tool view; anything else is a
      // server the agent has but whose prompts cannot be read right now.
      if (!(result.reason instanceof MCPServerDisabledError))
        listing.unavailable.push({
          serverId,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : 'MCP prompt read failed',
        });
      continue;
    }
    for (const prompt of result.value.prompts)
      if (offered(spec, serverId, prompt.name))
        listing.prompts.push(toAgentPrompt(serverId, prompt));
  }
  return listing;
}

function renderPromptText(result: GetPromptResult): string {
  const messages = result.messages ?? [];
  if (!messages.length)
    throw new McpPromptRefusal('The prompt returned no messages.', 502);
  const labelled = messages.some((message) => message.role !== 'user');
  const parts = messages.map((message) => {
    const content = message.content as { type?: string } & Record<
      string,
      unknown
    >;
    let text: string;
    if (content.type === 'text' && typeof content.text === 'string')
      text = content.text;
    else if (
      content.type === 'resource' &&
      content.resource &&
      typeof (content.resource as { text?: unknown }).text === 'string'
    ) {
      const resource = content.resource as { uri?: string; text: string };
      text = `Resource ${resource.uri ?? ''}:\n${resource.text}`.trim();
    } else
      throw new McpPromptRefusal(
        `The prompt includes ${content.type ?? 'unknown'} content, which Station cannot insert into a message yet. Nothing was sent.`,
        422,
      );
    return labelled ? `${message.role}:\n${text}` : text;
  });
  const text = parts.join('\n\n');
  if (text.length > MCP_PROMPT_MAX_TEXT_CHARS)
    throw new McpPromptRefusal(
      `The prompt produced ${text.length} characters; Station inserts at most ${MCP_PROMPT_MAX_TEXT_CHARS}. Nothing was sent.`,
      422,
    );
  return text;
}

/**
 * Read one offered prompt with typed arguments and return the text to insert
 * into the turn. Refuses — never drops, coerces or truncates — an unknown or
 * missing argument, an oversize value, or content Station cannot insert.
 */
export async function runAgentMcpPrompt(
  spec: AgentSpec,
  source: McpPromptSource,
  input: { serverId: string; name: string; arguments: unknown },
): Promise<AgentMcpPromptRun> {
  const { serverId, name } = input;
  if (
    !promptServerIds(spec).includes(serverId) ||
    !offered(spec, serverId, name)
  )
    throw new McpPromptRefusal(
      `/${serverId}:${name} is not offered to this agent.`,
      404,
    );
  const prompt = (await source.listMCPPrompts(serverId)).find(
    (candidate) => candidate.name === name,
  );
  if (!prompt)
    throw new McpPromptRefusal(
      `${serverId} does not offer a prompt named ${name}.`,
      404,
    );
  const args = input.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new McpPromptRefusal('Prompt arguments must be named values.', 400);
  const declared = prompt.arguments ?? [];
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!declared.some((argument) => argument.name === key))
      throw new McpPromptRefusal(
        `/${serverId}:${name} has no argument named ${key}.`,
        400,
      );
    if (typeof value !== 'string')
      throw new McpPromptRefusal(`${key} must be text.`, 400);
    if (value.length > MCP_PROMPT_MAX_ARGUMENT_CHARS)
      throw new McpPromptRefusal(
        `${key} is longer than ${MCP_PROMPT_MAX_ARGUMENT_CHARS} characters.`,
        400,
      );
    if (value.trim() !== '') values[key] = value;
  }
  const missing = declared
    .filter((argument) => argument.required && !(argument.name in values))
    .map((argument) => argument.name);
  if (missing.length)
    throw new McpPromptRefusal(
      `/${serverId}:${name} needs ${missing.join(', ')}. Nothing was sent.`,
      400,
    );
  const result = await source.getMCPPrompt(serverId, name, values);
  return { serverId, name, text: renderPromptText(result) };
}
