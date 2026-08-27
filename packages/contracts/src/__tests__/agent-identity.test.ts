import { describe, expect, it } from 'vitest';
import {
  agentId,
  assertCleanIdentity,
  type EngineConnectionId,
  type EngineId,
  type EngineRuntimeId,
  engineConnectionId,
  engineId,
  engineRuntimeId,
  parseEngineId,
  parseEngineRuntimeId,
} from '../agent-identity.js';
import type { EnrichedAgentProjection } from '../enriched-agent.js';

function needsEngineId(_value: EngineId): void {}
function needsRuntimeId(_value: EngineRuntimeId): void {}
function needsConnectionId(_value: EngineConnectionId): void {}

describe('clean agent identities', () => {
  it('uses the same validated text grammar for distinct branded identities', () => {
    expect(agentId('codex')).toBe('codex');
    expect(engineConnectionId('codex')).toBe('codex');
    expect(engineId('codex')).toBe('codex');
    expect(engineRuntimeId('codex-runtime')).toBe('codex-runtime');
  });

  it('prevents the three engine namespaces from crossing Interfaces', () => {
    const engine = engineId('codex');
    const runtime = engineRuntimeId('codex-runtime');
    const connection = engineConnectionId('codex-connection');
    needsEngineId(engine);
    needsRuntimeId(runtime);
    needsConnectionId(connection);
    // @ts-expect-error Adapter-private runtime IDs are not engine IDs.
    needsEngineId(runtime);
    // @ts-expect-error Public connection IDs are not runtime selectors.
    needsRuntimeId(connection);
    // @ts-expect-error Capability engine IDs are not navigable connections.
    needsConnectionId(engine);
  });

  it('keeps enriched Agent capability identity non-navigable', () => {
    const agent: EnrichedAgentProjection = {
      slug: agentId('reviewer'),
      name: 'Reviewer',
      engineId: engineId('claude-code'),
      execution: { agentConnectionId: engineConnectionId('claude') },
    };
    needsEngineId(agent.engineId!);
    // Optional since station#3662 (absent = Station's own engine); this
    // fixture states one, so the non-null assertion is the fixture's own fact.
    needsConnectionId(agent.execution!.agentConnectionId!);
    // @ts-expect-error The enriched capability id is not a connection target.
    needsConnectionId(agent.engineId!);
  });

  it('validates untyped plugin identity values at the boundary', () => {
    expect(parseEngineId('custom-engine')).toBe('custom-engine');
    expect(parseEngineRuntimeId('custom-runtime')).toBe('custom-runtime');
    expect(parseEngineId('__engine:custom')).toBeUndefined();
    expect(parseEngineRuntimeId('custom_runtime')).toBeUndefined();
  });

  it('rejects synthetic and malformed identities', () => {
    for (const value of [
      '',
      '1codex',
      'codex-',
      'a'.repeat(65),
      'codex.plugin',
      'codex_engine',
      '__agent:codex',
      'a0000000-0000-4000-8000-000000000000',
    ]) {
      expect(() => assertCleanIdentity(value)).toThrow(
        'Invalid clean identity',
      );
    }
  });

  it('accepts grammar boundaries and hyphenated plugin IDs', () => {
    expect(agentId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(engineConnectionId('plugin-engine')).toBe('plugin-engine');
  });
});
