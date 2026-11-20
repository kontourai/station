import { isDeepStrictEqual } from 'node:util';
import {
  type AgentSpec,
  BUILTIN_STATION_AGENT_MCP_SERVER_IDS,
} from '@kontourai/station-contracts/agent';
import {
  STATION_AGENT_DISPLAY_NAME,
  STATION_AGENT_ID,
} from '@kontourai/station-contracts/agent-identity';
import type { ResolvedAgentDefinition } from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
  builtinStationDocsServerPath,
} from '../runtime/bootstrap/station-control-runtime-env.js';

const runtimeDefinitions = new WeakSet<ToolDef>();
const sessionDefinitions = new WeakSet<ResolvedAgentDefinition>();

export function markRuntimeStationDocs(definition: ToolDef, stored: ToolDef) {
  if (
    stored.id === BUILTIN_STATION_DOCS_TOOL_SERVER_ID &&
    stored.kind === 'mcp' &&
    stored.transport === 'stdio' &&
    stored.command === undefined &&
    stored.args === undefined &&
    stored.endpoint === undefined &&
    stored.env === undefined &&
    stored.cwd === undefined &&
    stored.headers === undefined &&
    stored.permissions === undefined &&
    stored.timeouts === undefined &&
    stored.exposedTools === undefined &&
    stored.credentialOwnership === undefined
  )
    runtimeDefinitions.add(definition);
}

export function markCanonicalStationDocsDelivery(
  definition: ResolvedAgentDefinition,
  tool: ToolDef,
  spec: AgentSpec | null,
) {
  if (definition.slug !== STATION_AGENT_ID || !runtimeDefinitions.has(tool))
    return;
  if (spec) {
    const { provenance, ...configuration } = spec;
    // The runtime also materializes the reserved Agent for the New Chat
    // picker. Preserve stdio for a personalized or otherwise authored record.
    if (
      provenance?.origin !== 'engine-detection' ||
      provenance.engineId !== STATION_AGENT_ID ||
      !isDeepStrictEqual(configuration, {
        name: STATION_AGENT_DISPLAY_NAME,
        prompt: '',
        tools: { mcpServers: [...BUILTIN_STATION_AGENT_MCP_SERVER_IDS] },
      })
    )
      return;
  }
  sessionDefinitions.add(definition);
}

export function isCanonicalStationDocsDelivery(
  definition: ResolvedAgentDefinition,
) {
  if (!sessionDefinitions.has(definition)) return false;
  const tool = definition.toolServers?.find(
    (entry) => entry.id === BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
  );
  return (
    tool?.transport === 'stdio' &&
    tool.command === process.execPath &&
    tool.args?.length === 1 &&
    tool.args[0] === builtinStationDocsServerPath() &&
    tool.endpoint === undefined &&
    tool.allowedTools === undefined &&
    tool.disabledTools === undefined
  );
}
