import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOTS = [
  'src-ui/src',
  'packages/sdk/src/components',
  'packages/basis-pane/src',
  'packages/board-pane/src',
];
const LEGACY_TOKEN =
  /var\(\s*(--(?:space|text|radius|font|bg|border|accent|color)-[\w-]+)/g;
const STANDARD_ACTION =
  /(?:__action\b|__confirm\b|--(?:primary|secondary|danger)\b)/;
const ACTION_TAG = /^(?:button|Button|NoticeAction)$/;

/** The literal text of a string-valued JSX attribute initializer, if any. */
function literalAttributeText(initializer) {
  const literal = ts.isStringLiteral(initializer)
    ? initializer
    : ts.isJsxExpression(initializer) &&
        initializer.expression &&
        (ts.isStringLiteral(initializer.expression) ||
          ts.isNoSubstitutionTemplateLiteral(initializer.expression))
      ? initializer.expression
      : undefined;
  return literal?.text;
}

function hasLiteralRole(opening, ast, pattern) {
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.initializer &&
      attribute.name.getText(ast) === 'role' &&
      pattern.test(literalAttributeText(attribute.initializer) ?? ''),
  );
}

function containsActionElement(node, ast) {
  let found = false;
  (function walk(child) {
    if (found) return;
    if (
      (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
      ACTION_TAG.test(child.tagName.getText(ast))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, walk);
  })(node);
  return found;
}

/** New standard actions use shared controls; composite widget buttons remain valid. */
export function inspectComponentStyle(file, source) {
  const findings = [];
  if (file.endsWith('.css')) {
    const css = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
    for (const match of css.matchAll(LEGACY_TOKEN)) {
      findings.push({ kind: 'legacy-token', key: match[1] });
    }
    return findings;
  }
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    // A hand-rolled error surface with its own retry/recovery action is the
    // job ErrorState owns (`variant="compact"` for inline use).
    if (
      ts.isJsxElement(node) &&
      hasLiteralRole(node.openingElement, ast, /^alert$/) &&
      node.children.some((child) => containsActionElement(child, ast))
    ) {
      findings.push({
        kind: 'alert-with-action',
        key: node.openingElement.tagName.getText(ast),
      });
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      if (tag === 'dialog') {
        findings.push({ kind: 'bespoke-dialog', key: tag });
      }
      if (/^[a-z]/.test(tag) && !tag.includes('.')) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
          const name = attribute.name.getText(ast);
          const value = attribute.initializer.getText(ast);
          if (
            tag === 'button' &&
            name === 'className' &&
            STANDARD_ACTION.test(value)
          ) {
            findings.push({ kind: 'bespoke-action', key: value });
          }
          if (
            name === 'role' &&
            /^(?:alert)?dialog$/.test(
              literalAttributeText(attribute.initializer) ?? '',
            )
          ) {
            findings.push({ kind: 'bespoke-dialog', key: tag });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}

function inventory(files, readFile) {
  const counts = {};
  for (const file of files) {
    if (
      /(?:^|\/)(?:__tests__|__fixtures__)\//.test(file) ||
      /\.(?:test|spec)\./.test(file)
    )
      continue;
    const findings = inspectComponentStyle(file, readFile(file));
    if (findings.length === 0) continue;
    counts[file] = {};
    for (const finding of findings) {
      const key = `${finding.kind}:${finding.key}`;
      counts[file][key] = (counts[file][key] ?? 0) + 1;
    }
  }
  return counts;
}

export function compareComponentStyle(current, baseline) {
  for (const inventory of [current, baseline]) {
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory))
      throw new Error('Component/style inventory must be an object');
    for (const counts of Object.values(inventory)) {
      if (
        !counts ||
        typeof counts !== 'object' ||
        Array.isArray(counts) ||
        Object.values(counts).some(
          (count) => !Number.isSafeInteger(count) || count < 0,
        )
      )
        throw new Error('Component/style counts must be nonnegative integers');
    }
  }
  const added = [];
  for (const [file, counts] of Object.entries(current)) {
    for (const [key, count] of Object.entries(counts)) {
      const inherited = baseline[file]?.[key] ?? 0;
      if (count > inherited)
        added.push({ file, key, added: count - inherited });
    }
  }
  return added;
}

export function componentStyleInventory(root = process.cwd()) {
  const files = execFileSyncBounded(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', ...ROOTS],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .split('\0')
    .filter((file) => /\.(?:tsx|css)$/.test(file));
  if (!files.length)
    throw new Error('Component/style scan found no source files');
  return inventory([...new Set(files)], (file) =>
    readFileSync(resolve(root, file), 'utf8'),
  );
}

if (invokedDirectly(import.meta.url)) {
  const baseline = JSON.parse(
    readFileSync('scripts/component-style-hygiene-baseline.json', 'utf8'),
  );
  if (baseline.version !== 1)
    throw new Error('Unsupported component/style baseline version');
  const added = compareComponentStyle(
    componentStyleInventory(),
    baseline.files,
  );
  for (const finding of added) {
    console.error(
      `${finding.file}: ${finding.key} (+${finding.added}); use canonical tokens, Button/NoticeAction, Dialog/ConfirmModal, or ErrorState for an alert with a recovery action.`,
    );
  }
  console.log(
    `Component/style hygiene: ${added.length} new legacy-token, bespoke-action, bespoke-dialog or alert-with-action finding(s).`,
  );
  if (added.length) process.exitCode = 1;
}
