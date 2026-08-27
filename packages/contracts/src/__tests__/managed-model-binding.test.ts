import { describe, expect, test } from 'vitest';
import {
  classifyManagedModelBinding,
  isManagedModelCandidate,
} from '../managed-model-binding.js';

const llm = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  capabilities: ['llm'],
  ...overrides,
});

describe('managed model candidacy', () => {
  test('an enabled LLM connection is a candidate; nothing else is', () => {
    expect(isManagedModelCandidate(llm('a'))).toBe(true);
    expect(isManagedModelCandidate(llm('b', { enabled: false }))).toBe(false);
    expect(
      isManagedModelCandidate({
        id: 'c',
        enabled: true,
        capabilities: ['vectordb'],
      }),
    ).toBe(false);
  });

  // Readiness deliberately plays no part in WHICH connection is bound: a
  // candidate filter that consulted it is what let the editor resolve a
  // binding the runtime calls ambiguous.
  test('status is not consulted', () => {
    expect(isManagedModelCandidate(llm('a', { status: 'degraded' }))).toBe(
      true,
    );
  });
});

describe('classifyManagedModelBinding', () => {
  test('the agent’s own choice wins, and must be a candidate', () => {
    expect(
      classifyManagedModelBinding({
        declaredConnectionId: '  named  ',
        appDefaultConnectionId: 'other',
        connections: [llm('named'), llm('other')],
      }),
    ).toEqual({ kind: 'resolved', connectionId: 'named', source: 'explicit' });

    expect(
      classifyManagedModelBinding({
        declaredConnectionId: 'named',
        connections: [llm('named', { enabled: false })],
      }),
    ).toEqual({
      kind: 'invalid',
      declaredConnectionId: 'named',
      source: 'explicit',
    });
  });

  test('then the app default, then the only candidate', () => {
    expect(
      classifyManagedModelBinding({
        appDefaultConnectionId: 'preferred',
        connections: [llm('preferred'), llm('other')],
      }),
    ).toEqual({
      kind: 'resolved',
      connectionId: 'preferred',
      source: 'app-default',
    });

    expect(
      classifyManagedModelBinding({
        appDefaultConnectionId: 'gone',
        connections: [llm('other')],
      }),
    ).toEqual({
      kind: 'invalid',
      declaredConnectionId: 'gone',
      source: 'app-default',
    });

    expect(classifyManagedModelBinding({ connections: [llm('only')] })).toEqual(
      { kind: 'resolved', connectionId: 'only', source: 'only-candidate' },
    );
  });

  test('no candidate is `none`; several with no default is `ambiguous`', () => {
    expect(classifyManagedModelBinding({ connections: [] })).toEqual({
      kind: 'none',
    });
    expect(
      classifyManagedModelBinding({
        connections: [llm('a', { enabled: false })],
      }),
    ).toEqual({ kind: 'none' });
    expect(
      classifyManagedModelBinding({
        connections: [llm('a'), llm('b', { status: 'degraded' })],
      }),
    ).toEqual({ kind: 'ambiguous' });
  });

  test('blank declarations are absent declarations, not lookups', () => {
    expect(
      classifyManagedModelBinding({
        declaredConnectionId: '   ',
        appDefaultConnectionId: null,
        connections: [llm('only')],
      }),
    ).toEqual({
      kind: 'resolved',
      connectionId: 'only',
      source: 'only-candidate',
    });
  });
});
