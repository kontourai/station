import { classifyManagedModelBinding } from '@kontourai/station-contracts/managed-model-binding';
import { describe, expect, test } from 'vitest';
import { resolveStationModelBinding } from '../views/agent-editor/agentsViewUtils';

/**
 * The runtime and the agent editor, asked the same question from ONE fixture.
 *
 * archive#3743's fix expressed the binding rule a second time in the editor,
 * and the copy drifted on the case that decides whether an agent can run at
 * all: the editor chose "the sole READY candidate" where the runtime counts
 * every ENABLED one and calls two of them ambiguous. One
 * ready connection beside one enabled-but-degraded connection, no app default,
 * made Create pressable and persisted no explicit binding — for an agent the
 * runtime then refused to run.
 *
 * Both sides now import `classifyManagedModelBinding`, and each side is held
 * to it over the SAME case table: this file for the editor, the
 * "agrees with the shared managed-model rule" block in
 * `src-server/runtime/plugins/__tests__/runtime-provider-resolution.test.ts`
 * for the runtime. Neither imports the other — the two trees typecheck as
 * separate TS projects and a cross-tree import drags one project's files into
 * the other's compiler options — so agreement is proven transitively, through
 * the rule they now share. Re-introduce a local rule on either side and that
 * side's block reddens.
 *
 * MANAGED_MODEL_BINDING_CASES is duplicated verbatim in that sibling file; the
 * last case is the one the drifting mirror got wrong, and both files assert it.
 */

interface Fixture {
  id: string;
  kind: 'model';
  type: 'openai-compat';
  name: string;
  enabled: boolean;
  status: string;
  capabilities: string[];
  config: Record<string, unknown>;
}

function connection(overrides: Partial<Fixture> & { id: string }): Fixture {
  return {
    kind: 'model',
    type: 'openai-compat',
    name: overrides.id,
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    config: {},
    ...overrides,
  };
}

/** The one comparable answer: which connection will serve, if any. */
interface Verdict {
  resolved: boolean;
  connectionId: string | null;
}

/** The shared rule's own answer, in the comparable shape. */
function ruleVerdict(
  connections: Fixture[],
  appDefault?: string,
  declared?: string,
): Verdict {
  const binding = classifyManagedModelBinding({
    declaredConnectionId: declared,
    appDefaultConnectionId: appDefault,
    connections,
  });
  return {
    resolved: binding.kind === 'resolved',
    connectionId: binding.kind === 'resolved' ? binding.connectionId : null,
  };
}

function editorVerdict(
  connections: Fixture[],
  appDefault?: string,
  declared = '',
): Verdict {
  const binding = resolveStationModelBinding({
    modelConnectionId: declared,
    modelConnections: connections as never,
    appConfig: { defaultLLMProvider: appDefault },
  });
  return {
    resolved: binding.kind === 'resolved',
    connectionId: binding.kind === 'resolved' ? binding.connection.id : null,
  };
}

describe('the editor agrees with the shared managed-model rule', () => {
  // THE decisive case, and the one the drifting mirror got wrong.
  test('one ready plus one enabled-but-degraded, no default, is ambiguous to both', () => {
    const connections = [
      connection({ id: 'ready-llm' }),
      connection({ id: 'degraded-llm', status: 'degraded' }),
    ];

    expect(classifyManagedModelBinding({ connections })).toEqual({
      kind: 'ambiguous',
    });

    const rule = ruleVerdict(connections);
    const editor = editorVerdict(connections);
    expect(rule).toEqual({ resolved: false, connectionId: null });
    expect(editor).toEqual(rule);
  });

  test('a single candidate resolves to the same connection on both sides', () => {
    const connections = [connection({ id: 'only-llm' })];
    expect(ruleVerdict(connections)).toEqual({
      resolved: true,
      connectionId: 'only-llm',
    });
    expect(editorVerdict(connections)).toEqual(ruleVerdict(connections));
  });

  test('a disabled sibling is not a candidate on either side', () => {
    const connections = [
      connection({ id: 'ready-llm' }),
      connection({ id: 'off-llm', enabled: false, status: 'disabled' }),
    ];
    expect(ruleVerdict(connections)).toEqual({
      resolved: true,
      connectionId: 'ready-llm',
    });
    expect(editorVerdict(connections)).toEqual(ruleVerdict(connections));
  });

  test('a vector store is not a candidate on either side', () => {
    const connections = [
      connection({ id: 'ready-llm' }),
      connection({ id: 'vectors', capabilities: ['vectordb'] }),
    ];
    expect(ruleVerdict(connections)).toEqual({
      resolved: true,
      connectionId: 'ready-llm',
    });
    expect(editorVerdict(connections)).toEqual(ruleVerdict(connections));
  });

  test('an app default breaks the tie identically on both sides', () => {
    const connections = [
      connection({ id: 'first-llm' }),
      connection({ id: 'second-llm' }),
    ];
    expect(ruleVerdict(connections, 'second-llm')).toEqual({
      resolved: true,
      connectionId: 'second-llm',
    });
    expect(editorVerdict(connections, 'second-llm')).toEqual(
      ruleVerdict(connections, 'second-llm'),
    );
  });

  test('an explicit binding to a connection that is not a candidate is invalid to both', () => {
    const connections = [
      connection({ id: 'ready-llm' }),
      connection({ id: 'off-llm', enabled: false, status: 'disabled' }),
    ];
    expect(ruleVerdict(connections, undefined, 'off-llm')).toEqual({
      resolved: false,
      connectionId: null,
    });
    expect(editorVerdict(connections, undefined, 'off-llm')).toEqual(
      ruleVerdict(connections, undefined, 'off-llm'),
    );
  });

  /**
   * The ONE deliberate asymmetry, pinned so it stays deliberate.
   *
   * Readiness is not part of WHICH connection is bound — both sides name the
   * same one. The editor then asks a second question about that connection,
   * because its gate exists so that pressing Create is never how someone
   * learns the engine cannot answer. So the editor can be stricter, and when
   * it is, it says why.
   */
  test('readiness is a second question the editor asks about the same connection', () => {
    const connections = [connection({ id: 'only-llm', status: 'degraded' })];

    // Same binding as the rule (and therefore as the runtime).
    expect(classifyManagedModelBinding({ connections })).toEqual({
      kind: 'resolved',
      connectionId: 'only-llm',
      source: 'only-candidate',
    });
    expect(ruleVerdict(connections)).toEqual({
      resolved: true,
      connectionId: 'only-llm',
    });

    // The editor refuses it, and names it.
    const binding = resolveStationModelBinding({
      modelConnectionId: '',
      modelConnections: connections as never,
      appConfig: null,
    });
    expect(binding.kind).toBe('unresolved');
    expect(binding.kind === 'unresolved' ? binding.reason : '').toContain(
      'only-llm',
    );
  });
});
