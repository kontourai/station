import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { requiresAgentPromptForRuntime as contractRequiresAgentPromptForRuntime } from '@kontourai/station-contracts/agent-validation';

export function requiresAgentPromptForRuntime(
  agentConnectionId?: string | null,
): boolean {
  return contractRequiresAgentPromptForRuntime(agentConnectionId);
}

export function requiresAgentPrompt(
  spec: Pick<AgentSpec, 'execution'>,
): boolean {
  return requiresAgentPromptForRuntime(spec.execution?.agentConnectionId);
}
