/**
 * #1970 (D2/D11): the managed device toolchain exists only on personal
 * (non-hosted) Station hosts, so a hosted deployment never constructs the
 * service, never supervises a hub, and never mounts its routes or proxy.
 *
 * A STRUCTURAL rule about where `configureRuntimeRoutes` builds and mounts
 * them, proven structurally, like the Browser pane's gate beside this file:
 * every construction and mount must sit inside `if (isPersonalHost)`.
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

function where(node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${node.getText(source).slice(0, 60)} at runtime-routes.ts:${line + 1}`;
}

describe('runtime routes: device toolchain personal-host gate', () => {
  test('the service, its routes, their principal priming and every device mount are inside the gate', () => {
    const constructions: ts.Node[] = [];
    const routeFactories: ts.Node[] = [];
    const deviceMounts: ts.Node[] = [];
    walk(source, (node) => {
      if (
        ts.isNewExpression(node) &&
        ['DeviceToolchainService', 'DeviceShareStore'].includes(
          node.expression.getText(source),
        )
      )
        constructions.push(node);
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression.getText(source);
      if (callee === 'createDeviceToolchainRoutes') routeFactories.push(node);
      const arg = node.arguments[0];
      if (
        (callee === 'context.app.route' || callee === 'context.app.use') &&
        arg &&
        ts.isStringLiteralLike(arg) &&
        arg.text.startsWith('/api/mobile-devices')
      )
        deviceMounts.push(node);
    });
    // Each exists (a rename must not make this vacuous).
    expect(constructions).toHaveLength(2);
    expect(routeFactories).toHaveLength(1);
    expect(
      deviceMounts.map((node) => node.getText(source).split('(')[0]),
    ).toEqual([
      // D12 principal priming runs before every device route.
      'context.app.use',
      // Devices and sessions, SSH device hosts (#1973), the Tools drawer
      // (#1971), and the toolchain/shares/hub proxy (#1970).
      'context.app.route',
      'context.app.route',
      'context.app.route',
      'context.app.route',
    ]);
    const outside = [...constructions, ...routeFactories, ...deviceMounts]
      .filter((node) => !isInsidePersonalHostGate(node))
      .map(where);
    expect(outside).toEqual([]);
  });
});
