import type { AgentSpec } from './agent';
import { type EngineId, isStationAgentIdentity } from './agent-identity.js';
import {
  type EngineCapabilityMatrix,
  resolveEngineCapabilityMatrix,
} from './engine-capability-matrix.js';

/**
 * Station#1003 (unification slice 6): matrix-driven replacement for the
 * retired `resolveAgentTypeFromRuntimeConnection(...) === 'managed'` check
 * (equivalence proven in `__tests__/agent-validation.test.ts` before the old
 * resolver was deleted) — a prompt is required exactly when the bound
 * engine's capability matrix delivers the system prompt natively (only
 * Station's own engine today).
 */
export function requiresAgentPromptForRuntime(
  agentConnectionId?: string | null,
): boolean {
  return (
    resolveEngineCapabilityMatrix(agentConnectionId).systemPrompt.state ===
    'native'
  );
}

export function requiresAgentPrompt(
  spec: Pick<AgentSpec, 'execution'>,
): boolean {
  return requiresAgentPromptForRuntime(spec.execution?.agentConnectionId);
}

/**
 * The same requirement, asked of a NAMED Agent — which is the only form that
 * can answer it for the reserved `station` identity (station#3662).
 *
 * The rule exists because Station builds a VoltAgent instance from a
 * Station-engine Agent's own spec, and an instance with no system prompt has
 * no instructions. Station's own default Agent is the one exception in both
 * halves: its instance is built by the runtime
 * (`bootstrapRuntimeDefaultAgent`, under the internal `default` key), not from
 * `agents/station/agent.json`, and the prompt that instance runs with is
 * Station's own — an empty `prompt` on that record is the truth about it, not
 * an omission.
 *
 * Until #3662 this was covered by accident: the seeded record named a
 * `station` engine connection that can never exist, so the capability matrix
 * read Station's own Agent as an unknown EXTERNAL engine and the rule did not
 * apply. Removing that binding makes the record honest, so the exception has
 * to be stated. Both the persistence validator and the editor's form
 * validation call this, so they cannot disagree about whether the Station
 * Agent needs a prompt.
 */
export function requiresAuthoredAgentPrompt(
  slug: string | undefined,
  requiresPromptForRuntime: boolean,
): boolean {
  return !isStationAgentIdentity(slug) && requiresPromptForRuntime;
}

/**
 * Station#975 (unification slice 5) §5 — a capability surface the agent has
 * authored content for, but the bound engine cannot deliver. One pure
 * function shared by the editor's read-only banner and the save-response
 * `validation.findings` array (agents.ts) so the message strings are
 * byte-identical everywhere they render.
 */
export type AgentCapabilitySurface = 'prompt' | 'skills' | 'tools' | 'commands';

export interface AgentEngineValidationFinding {
  capability: AgentCapabilitySurface;
  engineId: EngineId;
  message: string;
}

export interface AuthoredCapabilityFlags {
  prompt: boolean;
  skills: boolean;
  tools: boolean;
  commands: boolean;
}

const SURFACE_ORDER: AgentCapabilitySurface[] = [
  'prompt',
  'skills',
  'tools',
  'commands',
];

const SURFACE_TO_MATRIX_KEY: Record<
  AgentCapabilitySurface,
  keyof Pick<
    EngineCapabilityMatrix,
    'systemPrompt' | 'skills' | 'toolServers' | 'commands'
  >
> = {
  prompt: 'systemPrompt',
  skills: 'skills',
  tools: 'toolServers',
  commands: 'commands',
};

const MESSAGE_BUILDERS: Record<
  AgentCapabilitySurface,
  (engineDisplayName: string) => string
> = {
  prompt: (name) => `${name} can't receive a system prompt from Station`,
  skills: (name) => `${name} can't receive skills from Station`,
  tools: (name) => `${name} can't receive tool servers from Station`,
  commands: (name) => `${name} can't run Station-defined slash commands`,
};

export function agentEngineValidationFindings(
  matrix: EngineCapabilityMatrix,
  authored: AuthoredCapabilityFlags,
  engineDisplayName: string,
): AgentEngineValidationFinding[] {
  const findings: AgentEngineValidationFinding[] = [];
  for (const surface of SURFACE_ORDER) {
    if (!authored[surface]) continue;
    const delivery = matrix[SURFACE_TO_MATRIX_KEY[surface]];
    if (delivery.state === 'unsupported') {
      findings.push({
        capability: surface,
        engineId: matrix.engineId,
        message: MESSAGE_BUILDERS[surface](engineDisplayName),
      });
    }
  }
  return findings;
}
