import { describe, expect, it } from 'vitest';
import {
  agentId,
  assertCleanIdentity,
  type EngineConnectionId,
  type EngineId,
  engineConnectionId,
  engineId,
  parseEngineId,
} from '../agent-identity.js';
import type { EnrichedAgentProjection } from '../enriched-agent.js';

function needsEngineId(_value: EngineId): void {}
function needsConnectionId(_value: EngineConnectionId): void {}

describe('clean agent identities', () => {
  it('uses the same validated text grammar for distinct branded identities', () => {
    expect(agentId('codex')).toBe('codex');
    expect(engineConnectionId('codex')).toBe('codex');
    expect(engineId('codex')).toBe('codex');
  });

  it('keeps connection instances branded while engines use canonical strings', () => {
    const engine = engineId('codex');
    const connection = engineConnectionId('codex-connection');
    needsEngineId(engine);
    needsConnectionId(connection);
    // @ts-expect-error Capability engine IDs are not navigable connections.
    needsConnectionId(engine);
    needsEngineId(connection);
  });

  it('keeps enriched Agent capability identity non-navigable', () => {
    const agent: EnrichedAgentProjection = {
      slug: agentId('reviewer'),
      name: 'Reviewer',
      engineId: engineId('claude'),
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
    expect(parseEngineId('__engine:custom')).toBeUndefined();
    expect(parseEngineId('custom_engine')).toBeUndefined();
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
