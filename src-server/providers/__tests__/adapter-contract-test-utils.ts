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
  claude: 'adapters/claude-adapter.ts#ClaudeAdapter',
  codex: 'adapters/codex-adapter.ts#CodexAdapter',
  acp: 'adapters/acp-adapter.ts#AcpAdapter',
  muse: 'adapters/muse-adapter.ts#MuseAdapter',
  'station-agent': 'adapters/station-agent-adapter.ts#StationAgentAdapter',
  bedrock: 'adapters/bedrock-adapter.ts#BedrockAdapter',
  ollama: 'adapters/ollama-adapter.ts#OllamaAdapter',
} as const;
export type AdapterName = keyof typeof ADAPTER_IMPLEMENTATIONS;
export const ADAPTERS = Object.keys(ADAPTER_IMPLEMENTATIONS) as AdapterName[];
