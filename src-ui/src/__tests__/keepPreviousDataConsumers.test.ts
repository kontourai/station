import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/**
 * archive#3169. `packages/sdk/src/query-core.ts`'s docblock declares the
 * real invariant: a hook that surfaces `keepPreviousData` (defaults it on,
 * or merely accepts a caller's `true`) is a defect UNLESS the component
 * calling it either branches on `isPlaceholderData` to mark the held render,
 * or explicitly opts out at the call site (`keepPreviousData: false`).
 *
 * `keyedQueryDefaults.test.ts` pins the *producer* side — which
 * query-domain files opt in — which cannot see whether the *consumer*
 * marks the render. This is exactly the gap that shipped once:
 * `CodingInspectorPanel` consumed two opted-in hooks with no marking and no
 * opt-out, rendering the outgoing project's attention dot under the
 * incoming project (fixed by opting both calls out here).
 *
 * This test enforces the consumer half. It is deliberately grep/AST-shaped
 * against SYNTAX, not semantics: it proves `isPlaceholderData` is
 * destructured (or the call opts out) at each call site of an opted-in
 * hook — not that the component's render logic actually branches on it
 * correctly, or that a value assigned but never read would be caught. That
 * is strictly more than the producer-only pin gave us, not a complete proof.
 */

const SDK_QUERY_DOMAINS_ROOT = join(
  __dirname,
  '../../../packages/sdk/src/query-domains',
);
const UI_SRC = join(__dirname, '..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Every exported hook in the SDK's query-domains that surfaces
 * `keepPreviousData` to `useApiQuery` at all — as a hardcoded/defaulted
 * `true`, or as a caller passthrough (`config?.keepPreviousData`). Scoped
 * per FUNCTION, not per file, so a second hook added to an
 * already-known-opted-in file is still caught individually.
 */
function optedInHookNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(SDK_QUERY_DOMAINS_ROOT)) {
    const sourceFile = parse(file);
    for (const node of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const body = node.getText(sourceFile);
        if (/keepPreviousData\s*:/.test(body)) {
          names.add(node.name.text);
        }
      }
    }
  }
  return [...names].sort();
}

interface CallSite {
  file: string;
  hook: string;
  /** True if this call site marks the hold via `isPlaceholderData`, or
   * explicitly opts out via `keepPreviousData: false`. */
  covered: boolean;
}

function objectLiteralOptsOut(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'keepPreviousData' &&
      prop.initializer.kind === ts.SyntaxKind.FalseKeyword,
  );
}

function bindingMarksPlaceholder(pattern: ts.BindingName): boolean {
  if (!ts.isObjectBindingPattern(pattern)) return false;
  return pattern.elements.some((el) => {
    if (!ts.isBindingElement(el)) return false;
    const name =
      el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : ts.isIdentifier(el.name)
          ? el.name.text
          : undefined;
    return name === 'isPlaceholderData';
  });
}

function findCallSites(file: string, hookNames: Set<string>): CallSite[] {
  const sourceFile = parse(file);
  const text = sourceFile.getFullText();
  const sites: CallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      hookNames.has(node.expression.text)
    ) {
      const hook = node.expression.text;
      let covered = false;

      // 1. Explicit opt-out: `keepPreviousData: false` in the config arg.
      const lastArg = node.arguments[node.arguments.length - 1];
      if (lastArg && ts.isObjectLiteralExpression(lastArg)) {
        if (objectLiteralOptsOut(lastArg)) covered = true;
      }

      // 2. Destructured `isPlaceholderData` at the call's own declaration.
      let bindingIdentifier: string | undefined;
      const decl = node.parent;
      if (
        !covered &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer === node
      ) {
        if (bindingMarksPlaceholder(decl.name)) {
          covered = true;
        } else if (ts.isIdentifier(decl.name)) {
          bindingIdentifier = decl.name.text;
        }
      }

      // 3. Fallback: the whole result is bound to a name (not destructured
      // at the call site) and `<name>.isPlaceholderData` is read anywhere
      // else in the file — e.g. `const readiness = useReadinessQuery(...);
      //.readiness.isPlaceholderData`.
      if (!covered && bindingIdentifier) {
        const memberAccess = new RegExp(
          `\\b${bindingIdentifier}\\.isPlaceholderData\\b`,
        );
        if (memberAccess.test(text)) covered = true;
      }

      sites.push({ file: relative(UI_SRC, file), hook, covered });
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return sites;
}

describe('keepPreviousData consumers mark the held render (station#3169)', () => {
  test('every call site of an opted-in hook marks isPlaceholderData or opts out', () => {
    const hookNames = new Set(optedInHookNames());
    // Sanity: fails loudly (not silently vacuous) if the SDK scan finds
    // nothing, e.g. because the relative path above ever drifts.
    expect(hookNames.size).toBeGreaterThan(0);

    const uncovered: CallSite[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      const source = readFileSync(file, 'utf8');
      // Cheap pre-filter: skip files that couldn't possibly call one of the
      // hooks, so the AST walk only runs where it matters.
      if (![...hookNames].some((name) => source.includes(name))) continue;
      for (const site of findCallSites(file, hookNames)) {
        if (!site.covered) uncovered.push(site);
      }
    }

    expect(uncovered.map((s) => `${s.file} calls ${s.hook}()`)).toEqual([]);
  });
});
