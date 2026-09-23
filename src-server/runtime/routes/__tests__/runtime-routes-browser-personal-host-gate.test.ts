/**
 * #90 D2: the Browser pane exists only on personal (non-hosted) Station hosts.
 *
 * This is a STRUCTURAL rule about where `configureRuntimeRoutes` mounts the
 * routes, so it is proven structurally: every `/api/browser` mount, its
 * principal-priming middleware and the construction of the Chromium service
 * must sit inside `if (isPersonalHost)`, and `isPersonalHost` must be exactly
 * the device routes' hosted-deployment gate. Moving any of them outside the
 * gate turns this red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const SOURCE_PATH = join(import.meta.dirname, '..', 'runtime-routes.ts');
const source = ts.createSourceFile(
  SOURCE_PATH,
  readFileSync(SOURCE_PATH, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Calls whose callee text matches and whose first argument is the literal. */
function callsWith(callee: string, firstArg?: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (node.expression.getText(source) !== callee) return;
    if (firstArg !== undefined) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg) || arg.text !== firstArg) return;
    }
    found.push(node);
  });
  return found;
}

function isInsidePersonalHostGate(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === child &&
      parent.expression.getText(source) === 'isPersonalHost'
    )
      return true;
    child = parent;
  }
  return false;
}

describe('runtime routes: Browser pane personal-host gate', () => {
  test('isPersonalHost is exactly the hosted-deployment gate', () => {
    const declarations: ts.VariableDeclaration[] = [];
    walk(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'isPersonalHost'
      )
        declarations.push(node);
    });
    expect(declarations).toHaveLength(1);
    expect(
      declarations[0]?.initializer?.getText(source).replace(/\s+/g, ' '),
    ).toBe('!hostedTenantRegistry && !isHostedTenantExecutionRequired()');
  });

  test('every /api/browser mount, its middleware and the Chromium service are inside the gate', () => {
    const guarded = [
      ...callsWith('context.app.route', '/api/browser'),
      ...callsWith('context.app.use', '/api/browser/*'),
      ...callsWith('createBrowserService'),
      ...callsWith('createBrowserRoutes'),
    ];
    // All four exist (a rename must not make this vacuous).
    expect(callsWith('context.app.route', '/api/browser')).toHaveLength(1);
    expect(callsWith('context.app.use', '/api/browser/*')).toHaveLength(1);
    expect(callsWith('createBrowserService')).toHaveLength(1);
    expect(callsWith('createBrowserRoutes')).toHaveLength(1);
    const outside = guarded
      .filter((call) => !isInsidePersonalHostGate(call))
      .map((call) => {
        const { line } = source.getLineAndCharacterOfPosition(
          call.getStart(source),
        );
        return `${call.expression.getText(source)} at runtime-routes.ts:${line + 1}`;
      });
    expect(outside).toEqual([]);
  });

  test('no other /api/browser path is mounted anywhere', () => {
    const mounts: string[] = [];
    walk(source, (node) => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith('/api/browser'))
        mounts.push(node.text);
    });
    expect([...new Set(mounts)].sort()).toEqual([
      '/api/browser',
      '/api/browser/*',
    ]);
  });
});
