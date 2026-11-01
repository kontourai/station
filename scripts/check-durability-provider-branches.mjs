import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const PROVIDERS = new Set(['claude', 'codex', 'acp', 'station-agent', 'muse']);
const DURABILITY =
  /steer|fork|resum|cancel|interrupt|recover|compac|continu|replay|transcript|turn.?boundary/i;
const CREDENTIAL = /credential|oauth|authentication/i;

/** Find provider-specific decisions near a durability action, ignoring comments. */
export function findDurabilityProviderBranches(text, file = 'module.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length)
    throw new Error(`Cannot parse ${file}; durability branch check refused.`);
  const aliases = new Set(['provider']);
  const constants = new Set();
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      PROVIDERS.has(node.initializer.text)
    )
      constants.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === 'provider'
    )
      aliases.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isElementAccessExpression(node.initializer) &&
      node.initializer.argumentExpression &&
      ts.isStringLiteralLike(node.initializer.argumentExpression) &&
      node.initializer.argumentExpression.text === 'provider'
    )
      aliases.add(node.name.text);
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      ((node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        node.propertyName.text === 'provider') ||
        (!node.propertyName && node.name.text === 'provider'))
    )
      aliases.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const provider = (node) =>
    (ts.isIdentifier(node) &&
      (aliases.has(node.text) || /provider|engine/i.test(node.text))) ||
    (ts.isPropertyAccessExpression(node) &&
      /provider|engine/i.test(node.name.text));
  const literal = (node) =>
    (ts.isStringLiteralLike(node) && PROVIDERS.has(node.text)) ||
    (ts.isIdentifier(node) &&
      (constants.has(node.text) ||
        /^PROVIDER_(CLAUDE|CODEX|ACP|MUSE|STATION_AGENT)$/.test(node.text)));
  const branchWords = (node) => {
    const words = [];
    const collectWords = (part) => {
      if (ts.isIdentifier(part) || ts.isStringLiteralLike(part))
        words.push(part.text);
      ts.forEachChild(part, collectWords);
    };
    collectWords(node);
    return words.join(' ');
  };
  const inScope = (node) => {
    const names = [file];
    let branch = ts.isCaseClause(node) ? node : undefined;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        !branch &&
        (ts.isIfStatement(parent) ||
          ts.isConditionalExpression(parent) ||
          ts.isCaseClause(parent))
      )
        branch = parent;
      if (
        ts.isVariableDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent)
      ) {
        if (parent.name) names.push(parent.name.getText(source));
        if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent))
          break;
      }
    }
    const context = names.join(' ');
    if (CREDENTIAL.test(context)) return false;
    return (
      DURABILITY.test(context) ||
      Boolean(branch && DURABILITY.test(branchWords(branch)))
    );
  };
  const found = [];
  const add = (node) => {
    if (!inScope(node)) return;
    found.push({
      startLine:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      expression: node.getText(source),
    });
  };
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ((provider(node.left) && literal(node.right)) ||
        (literal(node.left) && provider(node.right)))
    )
      add(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.expression.expression.elements.some(literal) &&
      node.arguments.some(provider)
    )
      add(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      node.expression.name.text === 'is' &&
      node.arguments.length === 2 &&
      ((provider(node.arguments[0]) && literal(node.arguments[1])) ||
        (literal(node.arguments[0]) && provider(node.arguments[1])))
    )
      add(node);
    if (
      ts.isCaseClause(node) &&
      literal(node.expression) &&
      ts.isCaseBlock(node.parent) &&
      ts.isSwitchStatement(node.parent.parent) &&
      provider(node.parent.parent.expression)
    )
      add(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function git(args) {
  return execFileSyncBounded('git', args, { encoding: 'utf8' });
}

function addedLines(diff) {
  const lines = new Set();
  let line = 0;
  for (const part of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(part);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (part.startsWith('+++') || part.startsWith('---')) continue;
    if (part.startsWith('+')) {
      lines.add(line);
      line += 1;
    } else if (part.startsWith(' ')) line += 1;
  }
  return lines;
}

export function main() {
  const base = process.env.STATION_CI_FAST_BASE || 'origin/main';
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const changed = git([
    'diff',
    '--name-only',
    '-z',
    mergeBase,
    '--',
    'src-server',
  ])
    .split('\0')
    .filter(Boolean);
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'src-server',
  ])
    .split('\0')
    .filter(Boolean);
  const untrackedSet = new Set(untracked);
  const files = [...new Set([...changed, ...untracked])].filter(
    (file) =>
      /\.(?:ts|tsx)$/.test(file) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) &&
      !file.includes('/__tests__/') &&
      !file.includes('/__test-utils__/') &&
      !file.includes('/__fixtures__/'),
  );
  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const added = untrackedSet.has(file)
      ? undefined
      : addedLines(
          git(['diff', '--no-ext-diff', '--unified=0', mergeBase, '--', file]),
        );
    for (const found of findDurabilityProviderBranches(text, file)) {
      if (
        added &&
        ![...added].some(
          (line) => line >= found.startLine && line <= found.endLine,
        )
      )
        continue;
      violations.push(`${file}:${found.startLine}: ${found.expression}`);
    }
  }
  if (violations.length) {
    process.stderr.write(
      `New provider-specific durability decisions:\n${violations.join('\n')}\n`,
    );
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Durability provider branch backstop: ${files.length} changed server file(s), no new findings.\n`,
    );
}

if (invokedDirectly(import.meta.url)) main();
