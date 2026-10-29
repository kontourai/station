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
const ACTION_TAG = /^(?:button|Button|ActionControl|NoticeAction)$/;
// One fix per finding kind, so a message never suggests the element that
// triggered it.
const REMEDIES = Object.freeze({
  'legacy-token': 'use the canonical --k-* token.',
  'bespoke-action': 'use Button (ActionControl in packages) or NoticeAction.',
  'bespoke-dialog': 'use Dialog or ConfirmModal (host.confirm in a pane).',
  'alert-with-action':
    'use ErrorState with an action (variant="compact" inline). If the action is not a recovery (dismiss, conflict choice, navigation), baseline it with a reason in the PR.',
});

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
  // `alert` is the nearest enclosing role="alert" element, if any.
  function visit(node, alert = undefined) {
    // A hand-rolled error surface with its own retry/recovery action is the
    // job ErrorState owns (`variant="compact"` for inline use). Each action
    // belongs to its NEAREST alert, and each alert that receives one counts
    // once: nesting around one action is one finding, independent actions in
    // independent alerts are separate findings.
    if (
      ts.isJsxElement(node) &&
      hasLiteralRole(node.openingElement, ast, /^alert$/)
    ) {
      const own = { hit: false };
      visit(node.openingElement, alert);
      for (const child of node.children) visit(child, own);
      visit(node.closingElement, alert);
      if (own.hit)
        findings.push({
          kind: 'alert-with-action',
          key: node.openingElement.tagName.getText(ast),
        });
      return;
    }
    if (
      alert &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ACTION_TAG.test(node.tagName.getText(ast))
    )
      alert.hit = true;
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
    ts.forEachChild(node, (child) => visit(child, alert));
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
      `${finding.file}: ${finding.key} (+${finding.added}); ${REMEDIES[finding.key.split(':', 1)[0]]}`,
    );
  }
  console.log(
    `Component/style hygiene: ${added.length} new legacy-token, bespoke-action, bespoke-dialog or alert-with-action finding(s).`,
  );
  if (added.length) process.exitCode = 1;
}
