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

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    'adapter.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * Every name an adapter uses in CODE: identifiers (declarations, references,
 * and object-literal property names) and exact string-literal values. Comments
 * are trivia and produce no nodes, so nothing here can be satisfied by prose.
 *
 * This exists because the absence half of this tripwire was already parsed
 * while its presence half was a raw `toContain` over the adapter's source
 * text. `claude-adapter.ts` names `canUseTool` in seven comments and
 * `PreToolUse` in two, so deleting the real wiring at the `canUseTool:` and
 * `PreToolUse:` property assignments left the tripwire green -- it would have
 * reported a delivered tool policy for an adapter that delivers none.
 * Matching is exact, so a comment-like string (`'canUseTool is unsupported'`)
 * is not a match either.
 */
function codeNames(source: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    )
      names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return names;
}

/**
 * Finds real calls to a Station-owned pre-tool seam, including optional-chain
 * and non-null invocation syntax. Parsing avoids a source-text regex silently
 * missing another valid TypeScript call form.
 */
function managedPreToolSeamCalls(source: string): string[] {
  const sourceFile = parse(source);
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
        const names = codeNames(source);
        expect(
          names,
          `${delivery.adapterModule} wires ${delivery.permissionHook} in code`,
        ).toContain(delivery.permissionHook);
        expect(
          names,
          `${delivery.adapterModule} wires isAutoApprovedExternalTool in code`,
        ).toContain('isAutoApprovedExternalTool');
        if (delivery.preToolHook) {
          expect(
            names,
            `${delivery.adapterModule} wires ${delivery.preToolHook} in code`,
          ).toContain(delivery.preToolHook);
        }
      }
    }
  });
});
