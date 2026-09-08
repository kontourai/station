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
 * The three syntactic forms in which an adapter can actually WIRE a name,
 * kept apart so each expectation can demand the one that carries its meaning.
 *
 * - `propertyNames`: the name of an object-literal property (or a method), i.e.
 *   `canUseTool: ...` and `PreToolUse: [...]`. This is where an SDK option or
 *   hook is attached. A string-literal property KEY counts; a string-literal
 *   property VALUE does not.
 * - `calledNames`: the unwrapped callee identifier of a call, i.e.
 *   `isAutoApprovedExternalTool(...)` -- reusing `unwrappedCallTarget` so an
 *   optional-chain or non-null call form still counts.
 * - `assignmentTargets`: the left side of an `=`, i.e.
 *   `client.requestPermission = ...`, which is how ACP overrides its handler.
 *   Deliberately NOT variable declarations: `const canUseTool = 1;` is a dead
 *   local, not a wiring.
 *
 * What is excluded is the point. Comments are trivia and produce no nodes, so
 * `claude-adapter.ts`'s seven `canUseTool` and two `PreToolUse` mentions in
 * prose cannot satisfy anything -- that was the raw-`toContain` defect this
 * replaced. Bare identifiers and string-literal VALUES are excluded too,
 * because they were the second defect: an unused
 * `import { isAutoApprovedExternalTool }` survives deleting the only call, and
 * `hookEventName: 'PreToolUse' as const` (the hook's own OUTPUT envelope,
 * :756/:766) survives deleting the entire `hooks: { PreToolUse: [...] }`
 * spread that is the only attachment of that hook to the SDK options.
 */
interface AdapterWiring {
  propertyNames: Set<string>;
  calledNames: Set<string>;
  assignmentTargets: Set<string>;
}

function adapterWiring(source: string): AdapterWiring {
  const propertyNames = new Set<string>();
  const calledNames = new Set<string>();
  const assignmentTargets = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const name = node.name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        propertyNames.add(name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const target = unwrappedCallTarget(node.expression);
      const called = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : undefined;
      if (called) calledNames.add(called);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      if (ts.isIdentifier(left)) assignmentTargets.add(left.text);
      else if (ts.isPropertyAccessExpression(left)) {
        assignmentTargets.add(left.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return { propertyNames, calledNames, assignmentTargets };
}

/**
 * A hook name wired in ANY of the three forms. The matrix declares the hook's
 * NAME, not the syntax that attaches it, and the two declared adapters attach
 * their permission hook differently -- Claude as an SDK option property
 * (`canUseTool:`), ACP by overriding the client handler
 * (`client.requestPermission =`). So this accepts property-name, call, or
 * assignment-target, and nothing weaker. If the matrix ever declares the form,
 * demand that one instead of this union.
 */
function isWiredAnyForm(wiring: AdapterWiring, name: string): boolean {
  return (
    wiring.propertyNames.has(name) ||
    wiring.calledNames.has(name) ||
    wiring.assignmentTargets.has(name)
  );
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
        const wiring = adapterWiring(source);
        expect(
          isWiredAnyForm(wiring, delivery.permissionHook),
          `${delivery.adapterModule}.ts must WIRE the declared permission hook ` +
            `'${delivery.permissionHook}' -- as an object-literal property name, ` +
            'a call, or the left side of an assignment. A mention in a comment, ' +
            'a bare identifier such as an unused import, a dead ' +
            `\`const ${delivery.permissionHook} = ...\`, or a string-literal ` +
            'VALUE does not deliver a tool policy.',
        ).toBe(true);
        expect(
          wiring.calledNames.has('isAutoApprovedExternalTool'),
          `${delivery.adapterModule}.ts must CALL isAutoApprovedExternalTool. ` +
            'Importing it is not calling it: the import outlives the call site, ' +
            'so a guard replaced by `if (false)` leaves external auto-approve ' +
            'parity silently undelivered.',
        ).toBe(true);
        if (delivery.preToolHook) {
          expect(
            wiring.propertyNames.has(delivery.preToolHook),
            `${delivery.adapterModule}.ts must ATTACH the declared pre-tool hook ` +
              `'${delivery.preToolHook}' as an object-literal property name -- ` +
              'that property IS the attachment to the engine SDK. The same ' +
              "string appearing as a property VALUE (the hook's own output " +
              'envelope) is emitted by the callback and survives deleting the ' +
              'wiring entirely.',
          ).toBe(true);
        }
      }
    }
  });
});
