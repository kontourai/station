/**
 * Walkthroughs and local speech exist only on personal (non-hosted) Station
 * hosts. Their previews are bound only there, so the media routes and the
 * Walkthrough service are reachable only through that binding.
 *
 * A STRUCTURAL rule, proven structurally like the Browser pane's gate beside
 * this file: `localMediaPreviews` must be derived from exactly
 * `isPersonalHost`, bound once, and every media mount and the Walkthrough
 * service must sit inside `if (localMediaPreviews)` or `if (isPersonalHost)`.
 * Making the binding unconditional or moving a mount out turns this red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-api';
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

function isInsideMediaGate(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === child &&
      ['localMediaPreviews', 'isPersonalHost'].includes(
        parent.expression.getText(source),
      )
    )
      return true;
    child = parent;
  }
  return false;
}

describe('runtime routes: local media personal-host gate', () => {
  test('the preview binding is derived from exactly the personal-host gate, once', () => {
    const declarations: ts.VariableDeclaration[] = [];
    walk(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'localMediaPreviews'
      )
        declarations.push(node);
    });
    expect(declarations).toHaveLength(1);
    expect(
      declarations[0]?.initializer?.getText(source).replace(/\s+/g, ' '),
    ).toBe(
      'isPersonalHost ? bindLocalMediaPreviews(context.featurePreviews) : undefined',
    );
    expect(callsWith('bindLocalMediaPreviews')).toHaveLength(1);
  });

  test('every media mount and the Walkthrough service are inside the gate', () => {
    const constructions: ts.Node[] = [];
    walk(source, (node) => {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === 'WalkthroughService'
      )
        constructions.push(node);
    });
    const mediaTools = callsWith('context.app.route', '/api/media-tools');
    const transcription = callsWith('context.app.route', '/api/transcription');
    const walkthroughRoutes = callsWith(
      'context.app.route',
      '/api/projects/:projectSlug/walkthroughs',
    );
    // Each exists exactly once (a rename must not make this vacuous).
    expect(mediaTools).toHaveLength(1);
    expect(transcription).toHaveLength(1);
    expect(walkthroughRoutes).toHaveLength(1);
    expect(constructions).toHaveLength(1);
    const mounts = [...mediaTools, ...transcription, ...walkthroughRoutes];
    const outside = [...mounts, ...constructions]
      .filter((node) => !isInsideMediaGate(node))
      .map((node) => {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        return `${node.getText(source).slice(0, 60)} at runtime-routes.ts:${line + 1}`;
      });
    expect(outside).toEqual([]);
  });
});
