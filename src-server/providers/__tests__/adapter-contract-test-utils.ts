import { expect } from 'vitest';

export function expectCanonicalSessionLifecycle(methods: string[]): void {
  expect(methods.slice(0, 2)).toEqual([
    'session.started',
    'session.configured',
  ]);
  expect(methods).toContain('turn.started');
}

/** Built-in implementations required to run the deterministic shape contract. */
export const ADAPTERS = [
  'claude',
  'codex',
  'acp',
  'muse',
  'station-agent',
  'bedrock',
  'ollama',
] as const;
export type AdapterName = (typeof ADAPTERS)[number];
