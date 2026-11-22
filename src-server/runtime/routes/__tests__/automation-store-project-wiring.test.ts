/**
 * Every Automation store the runtime builds reads the Project service, so a
 * rule or grant naming its Project by slug resolves (and a missing Project
 * is refused) the same way through each instance: the runtime's and the one
 * agent automation proposals confirm through. The proposals instance lives
 * inside `configureRuntimeRoutes`, which no behavioral test composes, so this
 * is structural, like the personal-host gates beside it. The runtime's
 * instance is also exercised behaviorally in
 * `runtime-route-support-task-follow-ups.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-api';
import { expect, test } from 'vitest';

function storeConstructions(file: string) {
  const path = join(import.meta.dirname, '..', file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[][] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'AutomationStore'
    )
      found.push((node.arguments ?? []).map((arg) => arg.getText(source)));
    node.forEachChild(walk);
  };
  walk(source);
  return found;
}

test('each runtime Automation store is built with the Project service', () => {
  const constructions = [
    ...storeConstructions('runtime-routes.ts'),
    ...storeConstructions('runtime-route-support.ts'),
  ];
  // Both exist, so a rename cannot make this vacuous.
  expect(constructions).toHaveLength(2);
  for (const args of constructions)
    expect(args[2]).toBe('context.projectService');
});
