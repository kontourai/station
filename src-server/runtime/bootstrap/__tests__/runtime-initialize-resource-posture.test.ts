import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const FACTORY = 'createEnvironmentRuntimeResourcePostureProbe';
const INITIALIZER = 'src-server/runtime/bootstrap/runtime-initialize.ts';

function composition() {
  const source = ts.createSourceFile(
    INITIALIZER,
    readFileSync(resolve(process.cwd(), INITIALIZER), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let importsEnvironmentProbe = false;
  let bindsEnvironmentProbe = false;
  let injectsBoundProbe = false;

  const visit = (node: ts.Node): void => {
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
      node.name.text === 'resourcePosture' &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === FACTORY
    ) {
      bindsEnvironmentProbe = true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'OrchestrationService' &&
      node.arguments?.[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      injectsBoundProbe = node.arguments[0].properties.some(
        (property) =>
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === 'resourcePosture',
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { importsEnvironmentProbe, bindsEnvironmentProbe, injectsBoundProbe };
}

describe('runtime initialization resource-posture composition', () => {
  test('gives foreground orchestration the environment-aware posture probe', () => {
    // The clean-install runner authorizes one isolated probe only for its own
    // temporary instance. This AST guard proves the production composition
    // supplies that probe to OrchestrationService; a raw host probe here makes
    // real foreground dispatch disagree with status and scheduler admission.
    expect(composition()).toEqual({
      importsEnvironmentProbe: true,
      bindsEnvironmentProbe: true,
      injectsBoundProbe: true,
    });
  });
});
