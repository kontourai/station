/**
 * What the model is offered: Station's real station-control `tools/list`,
 * read from this checkout's source over an in-memory MCP connection, plus a
 * few small harness tools standing in for the engine's own.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  composeStationInstructions,
  effectiveStationControlTools,
} from '../../../src-server/runtime/agents/station-orchestration-instructions.js';
import {
  createSelectedStationControlMcpServer,
  stationControlToolCatalog,
} from '../../../src-server/tools/station-control-mcp-server.js';
import { STATION_CONTROL_PREFIX } from './grade.js';

export type Assurance = 'bound' | 'delegated-custody';

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** station-control's `tools/list` at an assurance, exactly as an engine reads it. */
export async function listStationControlTools(
  assurance: Assurance,
): Promise<ListedTool[]> {
  const server = createSelectedStationControlMcpServer(
    undefined,
    undefined,
    'station-control',
    assurance,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'station-control-tool-use', version: '1' });
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as Record<string, unknown>,
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

/** The bytes one tool adds to `tools/list` (name, description, schema). */
export function toolJsonBytes(tool: ListedTool): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
    'utf8',
  );
}

/**
 * The engine's own tools, reduced to what the cases need. They are the
 * eval's text, not Station's: Station does not ship them.
 */
export const HARNESS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'Bash',
    description: 'Run a shell command in the working directory.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Task',
    description:
      'Start a subagent on your own engine in this checkout for a self-contained piece of work; it returns its result.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['description', 'prompt'],
    },
  },
];

/** Station's tools under the names Claude Code gives MCP tools. */
export function asAnthropicTools(
  tools: readonly ListedTool[],
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: `${STATION_CONTROL_PREFIX}${tool.name}`,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** The eval's system prompt; with `instructions`, Station's composed text too. */
export function systemPrompt(
  assurance: Assurance,
  instructions: boolean,
): string {
  const base = [
    'You are a coding agent working in /home/user/app, a checkout of acme/app on branch fix/reconnect.',
    'This session runs inside Station, in the Project acme-app.',
    'Use the tools you are given. Act; do not ask the user to confirm.',
  ].join('\n');
  if (!instructions) return base;
  const catalog = stationControlToolCatalog().map((t) => t.name);
  const composed = composeStationInstructions({
    controlTools: effectiveStationControlTools({}, catalog, assurance),
    browser: false,
    devices: assurance === 'bound',
    delegated: false,
    harness: assurance === 'bound' ? 'claude' : 'codex',
    toolSearch: false,
    progressiveFamilies: false,
  });
  return composed ? `${base}\n\n${composed.text}` : base;
}
