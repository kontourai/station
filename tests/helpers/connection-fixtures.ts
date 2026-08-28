import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type {
  AgentConnectionView,
  ModelConnectionConfig,
} from '@kontourai/station-contracts/tool';

/**
 * The shape `/api/connections/agents` actually returns, built once
 * (archive#3390).
 *
 * Fifteen of seventeen e2e fixtures for that endpoint omitted `setup`, which
 * `AgentConnectionView` requires. The SDK's model-picker projection reads
 * `connection.setup.state`, so those fixtures put the app into a state a real
 * Station never serves: the projection threw, BOTH connection lists came back
 * empty, the composer fell back to raw model ids and the picker rendered
 * disabled — specs then quietly assert against a broken app
 * (archive#3345 records one such triage).
 *
 * The mechanism that stops it recurring is the return type, not this comment:
 * these are annotated with the contract types, and `tsconfig.e2e.json`
 * typechecks `tests/`, so a fixture missing a required field fails
 * `npm run typecheck` rather than passing a test against a degraded app. Use
 * these instead of an inline literal whenever a spec mocks a connections
 * endpoint.
 */
export function agentConnectionFixture(
  overrides: Omit<Partial<AgentConnectionView>, 'id'> & { id: string },
): AgentConnectionView {
  const { id, ...rest } = overrides;
  return {
    id: engineConnectionId(id),
    kind: 'agent',
    type: 'claude-runtime',
    name: id,
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
    status: 'ready',
    prerequisites: [],
    // The field the whole class of drift was about. A connection the server
    // returns always carries it; `ready` + detected + configured is what an
    // enabled, usable connection reports.
    setup: { state: 'ready', detected: true, configured: true },
    ...rest,
  };
}

export function modelConnectionFixture(
  overrides: Partial<ModelConnectionConfig> & { id: string },
): ModelConnectionConfig {
  return {
    kind: 'model',
    type: 'ollama',
    name: overrides.id,
    enabled: true,
    capabilities: ['llm'],
    config: {},
    status: 'ready',
    prerequisites: [],
    ...overrides,
  };
}
