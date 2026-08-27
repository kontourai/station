import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENGINE_CAPABILITY_MATRICES,
  externalToolPolicyAdapters,
  STATION_PRE_TOOL_POLICY_SEAMS,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const adapterSource = (module: string) =>
  readFileSync(
    resolve(process.cwd(), `src-server/providers/adapters/${module}.ts`),
    'utf8',
  );

function unwrappedCallTarget(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Finds real calls to a Station-owned pre-tool seam, including optional-chain
 * and non-null invocation syntax. Parsing avoids a source-text regex silently
 * missing another valid TypeScript call form.
 */
function managedPreToolSeamCalls(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'adapter.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = unwrappedCallTarget(node.expression);
      const name = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : undefined;
      if (
        name &&
        (STATION_PRE_TOOL_POLICY_SEAMS as readonly string[]).includes(name)
      ) {
        calls.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...calls];
}

describe('tool-policy delivery declaration tripwire (station#2245)', () => {
  test('declares the actual pre-tool delivery boundary, fail-closed for unknown engines', () => {
    expect(ENGINE_CAPABILITY_MATRICES.station.toolPolicy).toMatchObject({
      state: 'native',
      evidence: 'beforeToolCall',
    });
    expect(ENGINE_CAPABILITY_MATRICES.claude.toolPolicy).toMatchObject({
      state: 'partial',
      permissionHook: 'canUseTool',
      preToolHook: 'PreToolUse',
      evidence: 'sharedStagedPolicy',
    });
    expect(ENGINE_CAPABILITY_MATRICES.acp.toolPolicy).toMatchObject({
      state: 'partial',
      permissionHook: 'requestPermission',
      evidence: 'sharedStagedPolicy',
      toolIdentity: 'self-reported',
      coverageLimit: expect.stringContaining('report a tool name'),
    });
    expect(ENGINE_CAPABILITY_MATRICES.codex.toolPolicy).toMatchObject({
      state: 'unsupported',
      adapterModule: 'codex-adapter',
    });
    expect(UNKNOWN_EXTERNAL_ENGINE_MATRIX.toolPolicy.state).toBe('unsupported');
  });

  test.each([
    ['beforeToolCall direct', 'beforeToolCall();', 'beforeToolCall'],
    ['beforeToolCall optional', 'beforeToolCall?.();', 'beforeToolCall'],
    ['beforeToolCall non-null', 'beforeToolCall!();', 'beforeToolCall'],
    ['checkToolCall direct', 'hooks.checkToolCall();', 'checkToolCall'],
    ['checkToolCall optional', 'hooks.checkToolCall?.();', 'checkToolCall'],
    ['checkToolCall non-null', 'hooks.checkToolCall!();', 'checkToolCall'],
  ])(
    'detects the managed pre-tool seam for %s',
    (_description, source, expectedSeam) => {
      expect(managedPreToolSeamCalls(source)).toEqual([expectedSeam]);
    },
  );

  test('derives every declared external adapter tripwire from the matrix declaration', () => {
    const adapters = externalToolPolicyAdapters();
    expect(adapters.length).toBeGreaterThan(0);

    for (const { delivery } of adapters) {
      const source = adapterSource(delivery.adapterModule);
      expect(managedPreToolSeamCalls(source)).toEqual([]);
      if (delivery.state === 'partial') {
        expect(source).toContain(delivery.permissionHook);
        expect(source).toContain('isAutoApprovedExternalTool');
        if (delivery.preToolHook) {
          expect(source).toContain(delivery.preToolHook);
        }
      }
    }
  });
});
