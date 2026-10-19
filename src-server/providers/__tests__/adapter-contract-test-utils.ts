import { expect } from 'vitest';

export function expectCanonicalSessionLifecycle(methods: string[]): void {
  expect(methods.slice(0, 2)).toEqual([
    'session.started',
    'session.configured',
  ]);
  expect(methods).toContain('turn.started');
}

/** Each concrete implementation must have a deterministic conformance driver. */
export const ADAPTER_IMPLEMENTATIONS = {
  claude: 'providers/adapters/claude-adapter.ts#ClaudeAdapter',
  codex: 'providers/adapters/codex-adapter.ts#CodexAdapter',
  acp: 'providers/adapters/acp-adapter.ts#AcpAdapter',
  muse: 'providers/adapters/muse-adapter.ts#MuseAdapter',
  'station-agent':
    'providers/adapters/station-agent-adapter.ts#StationAgentAdapter',
  bedrock: 'providers/adapters/bedrock-adapter.ts#BedrockAdapter',
  ollama: 'providers/adapters/ollama-adapter.ts#OllamaAdapter',
} as const;
export type AdapterName = keyof typeof ADAPTER_IMPLEMENTATIONS;
export const ADAPTERS = Object.keys(ADAPTER_IMPLEMENTATIONS) as AdapterName[];
