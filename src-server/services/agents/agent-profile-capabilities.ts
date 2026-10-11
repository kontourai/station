import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  resolveEngineCapabilityMatrix,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { AgentProfileCapability } from '@kontourai/station-contracts/enriched-agent';

export function agentProfileCapabilities(
  spec: AgentSpec,
  agentId: string,
): AgentProfileCapability[] {
  const required: AgentProfileCapability[] = [];
  const hasTools =
    Boolean(spec.tools?.mcpServers?.length) || agentId === 'station';
  if (spec.prompt?.trim() || agentId === 'station')
    required.push('instructions');
  if (spec.skills?.length) required.push('skills');
  if (hasTools) required.push('toolServers');
  if (hasTools && spec.tools?.available !== undefined)
    required.push('toolSelection');
  return required;
}

export function unsupportedAgentProfileCapabilities(
  connectionId: string | undefined,
  connection: Parameters<typeof resolveEngineCapabilityMatrix>[1],
): AgentProfileCapability[] | undefined {
  const matrix = resolveEngineCapabilityMatrix(connectionId, connection);
  if (matrix === UNKNOWN_EXTERNAL_ENGINE_MATRIX) return undefined;
  const unsupported: AgentProfileCapability[] = [];
  if (
    matrix.systemPrompt.state === 'unsupported' &&
    matrix.instructionsInFirstTurn.state === 'unsupported'
  )
    unsupported.push('instructions');
  if (matrix.skills.state === 'unsupported') unsupported.push('skills');
  if (matrix.toolServers.state === 'unsupported')
    unsupported.push('toolServers');
  if (matrix.engineId === 'acp' || matrix.toolServers.state === 'unsupported')
    unsupported.push('toolSelection');
  return unsupported;
}
