import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { describe, expect, test } from 'vitest';

const FACTORY = 'createEnvironmentRuntimeResourcePostureProbe';
const INITIALIZER = 'src-server/runtime/bootstrap/runtime-initialize.ts';

/** The identifier an object literal's `resourcePosture` property reads. */
function resourcePostureBinding(
  literal: ts.ObjectLiteralExpression,
): string | undefined {
  for (const property of literal.properties) {
    if (property.name?.getText() !== 'resourcePosture') continue;
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.initializer)
    ) {
      return property.initializer.text;
    }
    return undefined;
  }
  return undefined;
}

function composition() {
  const source = ts.createSourceFile(
    INITIALIZER,
    readFileSync(resolve(process.cwd(), INITIALIZER), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let importsEnvironmentProbe = false;
  const factoryBindings = new Set<string>();
  const orchestrationBindings: Array<string | undefined> = [];
  const returnedBindings: Array<string | undefined> = [];

  const visit = (node: ts.Node, inInitializeRuntime: boolean): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith('/resource-posture.js') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      importsEnvironmentProbe = node.importClause.namedBindings.elements.some(
        (element) =>
          element.name.text === FACTORY &&
          (!element.propertyName || element.propertyName.text === FACTORY),
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === FACTORY
    ) {
      factoryBindings.add(node.name.text);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'OrchestrationService' &&
      node.arguments?.[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      orchestrationBindings.push(resourcePostureBinding(node.arguments[0]));
    }
    if (
      inInitializeRuntime &&
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      returnedBindings.push(resourcePostureBinding(node.expression));
    }
    // Only initializeRuntime's own returns, not those of callbacks nested in it.
    const bodyOwner = ts.isFunctionLike(node)
      ? ts.isFunctionDeclaration(node) &&
        node.name?.text === 'initializeRuntime'
      : inInitializeRuntime;
    ts.forEachChild(node, (child) => visit(child, bodyOwner));
  };
  visit(source, false);
  return {
    importsEnvironmentProbe,
    factoryBindings,
    orchestrationBindings,
    returnedBindings,
  };
}

describe('runtime initialization resource-posture composition', () => {
  test('gives foreground orchestration the same environment-aware probe the runtime returns for status and scheduling', () => {
    // The clean-install runner authorizes one isolated probe only for its own
    // temporary instance. This AST guard proves the production composition
    // supplies that probe to OrchestrationService, and that it is the same
    // binding initializeRuntime returns for status and scheduler admission; a
    // separate probe here makes real foreground dispatch disagree with them.
    // It follows the binding, so renaming the local survives.
    const {
      importsEnvironmentProbe,
      factoryBindings,
      orchestrationBindings,
      returnedBindings,
    } = composition();
    expect(importsEnvironmentProbe).toBe(true);
    expect(orchestrationBindings).toHaveLength(1);
    expect(returnedBindings.length).toBeGreaterThan(0);
    const [shared] = orchestrationBindings;
    expect(shared).toBeDefined();
    expect(factoryBindings.has(shared!)).toBe(true);
    expect(new Set(returnedBindings)).toEqual(new Set([shared]));
  });
});
