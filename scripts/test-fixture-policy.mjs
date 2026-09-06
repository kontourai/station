#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const STRICT_BROWSER_FILES = [
  'tests/mobile-chat-composer.spec.ts',
  'tests/settings.spec.ts',
  'tests/connections-crud.spec.ts',
];
const BASELINE = 'scripts/test-fixture-policy-baseline.json';
const ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'check',
  'uncheck',
  'tap',
]);
const nameOf = (node) =>
  ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
const literal = (node) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;

/** Syntax policy only: it detects bypass shapes, not whether every assertion is meaningful. */
export function inspectBrowserFixture(source, file) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings = [];
  const report = (node, rule) => {
    const snippet = node.getText(ast).replace(/\s+/g, ' ');
    findings.push({
      file,
      rule,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      fingerprint: createHash('sha256')
        .update(`${rule}\n${snippet}`)
        .digest('hex'),
      snippet: snippet.slice(0, 240),
    });
  };
  const inEvaluation = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        ts.isCallExpression(parent) &&
        ['evaluate', 'evaluateAll'].includes(nameOf(parent.expression))
      )
        return true;
    }
    return false;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const method = nameOf(node.expression);
      if (
        ACTIONS.has(method) &&
        node.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(ast).replace(/['"]/g, '') === 'force' &&
                property.initializer.kind === ts.SyntaxKind.TrueKeyword,
            ),
        )
      ) {
        report(node, 'forced-user-action');
      } else if (
        method === 'removeAttribute' &&
        inEvaluation(node) &&
        ['disabled', 'inert'].includes(literal(node.arguments[0]))
      ) {
        report(node, 'removes-interaction-guard');
      } else if (method === 'dispatchEvent') {
        const event = node.arguments[0];
        const eventName =
          literal(event) ??
          (event && ts.isNewExpression(event)
            ? literal(event.arguments?.[0])
            : undefined);
        if (eventName === 'click' || eventName === 'dblclick')
          report(node, 'synthetic-click');
      } else if (method === 'click' && inEvaluation(node))
        report(node, 'dom-click-bypasses-actionability');
      if (method === 'route' && literal(node.arguments[0])?.endsWith('**')) {
        const callback = node.arguments[1];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          ts.isBlock(callback.body)
        ) {
          const last = callback.body.statements.at(-1);
          if (
            last &&
            ts.isReturnStatement(last) &&
            last.expression?.getText(ast).includes('fulfill')
          ) {
            let success = false,
              empty = false;
            const check = (child) => {
              if (ts.isPropertyAssignment(child)) {
                success ||=
                  child.name.getText(ast) === 'success' &&
                  child.initializer.kind === ts.SyntaxKind.TrueKeyword;
                empty ||=
                  child.name.getText(ast) === 'data' &&
                  ts.isArrayLiteralExpression(child.initializer) &&
                  child.initializer.elements.length === 0;
              }
              ts.forEachChild(child, check);
            };
            check(last);
            if (success && empty) report(last, 'unmodeled-success-fallback');
          }
        }
      }
    }
    if (
      ts.isIfStatement(node) &&
      ts.isPrefixUnaryExpression(node.expression) &&
      node.expression.operator === ts.SyntaxKind.ExclamationToken &&
      /\.isVisible\s*\(/.test(node.expression.getText(ast))
    ) {
      const body = ts.isBlock(node.thenStatement)
        ? node.thenStatement.statements
        : [node.thenStatement];
      if (
        body.length === 1 &&
        ts.isReturnStatement(body[0]) &&
        !body[0].expression
      )
        report(node, 'visibility-short-circuit');
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
}

export function browserFixtureInventory(root) {
  const findings = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name))
        findings.push(
          ...inspectBrowserFixture(
            readFileSync(path, 'utf8'),
            relative(root, path).split('\\').join('/'),
          ),
        );
    }
  };
  walk(join(root, 'tests'));
  return findings;
}

export function evaluateFixturePolicy(findings, baseline, previousBaseline) {
  const key = (entry) => `${entry.file}:${entry.rule}:${entry.fingerprint}`;
  const admitted = new Map(
    baseline.entries.map((entry) => [key(entry), entry]),
  );
  const actual = new Set(findings.map(key));
  const errors = findings
    .filter(
      (entry) =>
        STRICT_BROWSER_FILES.includes(entry.file) || !admitted.has(key(entry)),
    )
    .map((entry) => `${entry.file}:${entry.line} ${entry.rule}`);
  for (const entry of baseline.entries) {
    if (entry.reason !== 'legacy-unqualified')
      errors.push(`Invalid baseline reason: ${entry.file}`);
    if (!actual.has(key(entry)))
      errors.push(`Remove stale baseline entry: ${entry.file} ${entry.rule}`);
  }
  if (previousBaseline) {
    const prior = new Set(previousBaseline.entries.map(key));
    for (const entry of baseline.entries)
      if (!prior.has(key(entry)))
        errors.push(
          `New bypass cannot be baselined: ${entry.file} ${entry.rule}`,
        );
  }
  return {
    errors,
    legacyUnqualifiedSites: findings.filter((entry) => admitted.has(key(entry)))
      .length,
  };
}

export function fixturePolicyCommands(paths) {
  return paths.some((path) =>
    /^(tests\/|src-ui\/|scripts\/.*(fixture|mutation|journey))/.test(path),
  )
    ? [
        'npm run test:fixtures:guard',
        'docs/guides/testing.md#fixture-fidelity-and-test-effectiveness',
      ]
    : [];
}

export function main(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const findings = browserFixtureInventory(root);
  if (process.argv.includes('--inventory')) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  const gitOptions = { cwd: root, encoding: 'utf8', windowsHide: true };
  execFileSync('git', ['rev-parse', '--verify', 'origin/main'], gitOptions);
  const upstreamHasBaseline = execFileSync(
    'git',
    ['ls-tree', '--name-only', 'origin/main', '--', BASELINE],
    gitOptions,
  ).trim();
  const introduction = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%H', '--', BASELINE],
    gitOptions,
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  const baselineRef = upstreamHasBaseline ? 'origin/main' : introduction;
  const previous = baselineRef
    ? JSON.parse(
        execFileSync('git', ['show', `${baselineRef}:${BASELINE}`], gitOptions),
      )
    : undefined;
  const result = evaluateFixturePolicy(findings, baseline, previous);
  console.log(
    `[fixture-policy] ${result.errors.length ? 'FAIL' : 'PASS'}; legacy unqualified sites=${result.legacyUnqualifiedSites}; ${STRICT_BROWSER_FILES.length} strict files`,
  );
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
