/**
 * UI copy length ratchet: user-facing strings in `src-ui/src` may not grow
 * longer or wordier than they already are.
 *
 * Two finding kinds, each counted per file and per stable discriminator (the
 * JSX tag that holds the text, or the copy-bearing attribute name), never per
 * line:
 *
 * - `long-copy`: one string or element text longer than `LONG_COPY_CAP`.
 * - `multi-sentence`: one string or element text with more than
 *   `MAX_SENTENCES` sentences.
 *
 * Copy is read from the TypeScript AST, so comments never count:
 *
 * - JSX text. An element's own text, inline phrasing children (`strong`,
 *   `a`, `span`, ...) and string or template literal children are joined
 *   into one run with whitespace normalized. Interpolated expressions add
 *   nothing; only literal parts count.
 * - Literals in copy-bearing JSX attributes (`description`, `title`,
 *   `hint`, ...), including both branches of a conditional and `??`/`||`
 *   fallbacks, and the same literals assigned to an object property of the
 *   same name (`{ description: '...' }` in copy tables such as tour steps
 *   or error translations). Measured at introduction: 742 such property
 *   strings, 11 over the cap, all real copy.
 *
 * Not copy: `aria-label` and other attributes outside `COPY_ATTRIBUTE`, text
 * inside `code`/`pre`/`kbd`/`samp`, strings without whitespace (identifiers,
 * paths, URLs), command lines, and string literals anywhere else (thrown
 * errors, log lines, call arguments): those mix copy with diagnostics and are
 * not worth the noise. There is no i18n catalog in `src-ui`.
 *
 * Ratchet semantics: the gate fails only when a file's count for a key grows
 * or a new file appears with findings. A shrinking count passes and prints a
 * hint to tighten the baseline with `--update`, so parallel merges that each
 * shorten copy never fail the queue.
 *
 *   node scripts/ui-copy-length.mjs            # check
 *   node scripts/ui-copy-length.mjs --update   # rewrite the baseline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOTS = ['src-ui/src'];
const BASELINE_PATH = 'scripts/ui-copy-length-baseline.json';
/** Chosen from the measured distribution; see the baseline commit. */
export const LONG_COPY_CAP = 140;
export const MAX_SENTENCES = 2;
const COPY_ATTRIBUTE =
  /^(?:aria-description|body|caption|confirmLabel|confirmText|description|detail|details|emptyMessage|emptyText|explanation|heading|helperText|hint|label|message|placeholder|subtitle|summary|title|tooltip)$/;
const CODE_TAG = /^(?:code|pre|kbd|samp|script|style)$/;
// Phrasing elements whose text reads as part of the parent's sentence.
const INLINE_TAG = /^(?:a|abbr|b|em|i|mark|q|s|small|span|strong|sub|sup|u)$/;
const COMMAND = /^(?:\$ |npm |npx |pnpm |node |git |curl |station )/;
const EXCLUDED_FILE =
  /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|stories)\/|\.(?:test|spec|stories)\.[cm]?tsx?$/;
const ENTITIES = {
  '&amp;': '&',
  '&apos;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};
const REMEDY =
  'Shorten it, move explanation into a Details disclosure or tooltip, or state each fact once. See src-ui/AGENTS.md#product-copy.';

const normalize = (text) =>
  text
    .replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();

/** Prose, as opposed to an identifier, path, URL or command line. */
function isProse(text) {
  return /\s/.test(text) && !COMMAND.test(text);
}

/**
 * Sentences in one piece of copy. Abbreviations, decimals and ellipses do not
 * end one, and a `Label: {value}.` fragment, whose value is interpolated and
 * so absent here, is a stat line rather than a sentence.
 */
export function countSentences(text) {
  const masked = text
    .replace(/\b(?:e\.g|i\.e|etc|vs|approx)\./gi, 'x')
    .replace(/\d\.\d/g, '0')
    .replace(/\.{2,}|…/g, ' ');
  return masked
    .split(/[.!?]+(?=[\s)"'”’]|$)/)
    .filter(
      (part) => /[\p{L}\p{N}]/u.test(part) && !part.trimEnd().endsWith(':'),
    ).length;
}

/** Literal parts of a template expression, joined. */
function templateText(node) {
  return [
    node.head.text,
    ...node.templateSpans.map((span) => span.literal.text),
  ].join('');
}

/**
 * Each alternative literal an expression can evaluate to: a literal, a
 * template's literal parts, both conditional branches, a `??`/`||` fallback.
 */
function literalAlternatives(expression) {
  if (!expression) return [];
  if (ts.isParenthesizedExpression(expression))
    return literalAlternatives(expression.expression);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  )
    return [expression.text];
  if (ts.isTemplateExpression(expression)) return [templateText(expression)];
  if (ts.isConditionalExpression(expression))
    return [
      ...literalAlternatives(expression.whenTrue),
      ...literalAlternatives(expression.whenFalse),
    ];
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  )
    return [
      ...(expression.operatorToken.kind ===
      ts.SyntaxKind.AmpersandAmpersandToken
        ? []
        : literalAlternatives(expression.left)),
      ...literalAlternatives(expression.right),
    ];
  return [];
}

function tagName(node, ast) {
  if (ts.isJsxFragment(node)) return 'fragment';
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(
    ast,
  );
}

/**
 * Every user-facing copy candidate in one source file, keyed by where it is
 * shown: `text:<tag>` for element text, `attr:<name>` for an attribute,
 * `prop:<name>` for a copy-named object property.
 */
export function collectUiCopy(file, source) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const candidates = [];
  const add = (key, raw) => {
    const text = normalize(raw);
    if (isProse(text)) candidates.push({ key, text });
  };
  const absorbed = new Set();

  /** The element's own text run; inline children are absorbed into it. */
  function textRun(element) {
    const parts = [];
    for (const child of element.children) {
      if (ts.isJsxText(child)) parts.push(child.text);
      else if (ts.isJsxExpression(child)) {
        const expression = child.expression;
        if (
          expression &&
          (ts.isStringLiteral(expression) ||
            ts.isNoSubstitutionTemplateLiteral(expression))
        )
          parts.push(expression.text);
        else if (expression && ts.isTemplateExpression(expression))
          parts.push(templateText(expression));
      } else if (
        ts.isJsxElement(child) &&
        INLINE_TAG.test(tagName(child, ast))
      ) {
        absorbed.add(child);
        parts.push(textRun(child));
      }
    }
    return parts.join('');
  }

  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const tag = tagName(node, ast);
      if (CODE_TAG.test(tag)) return;
      if (!absorbed.has(node)) add(`text:${tag}`, textRun(node));
    }
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      // A conditional child (`{busy ? 'Saving…' : 'Save'}`) shows one branch
      // at a time, so each alternative is its own candidate. A bare literal
      // child is already part of the element's text run.
      const expression = node.expression;
      if (
        expression &&
        !ts.isStringLiteral(expression) &&
        !ts.isNoSubstitutionTemplateLiteral(expression) &&
        !ts.isTemplateExpression(expression)
      )
        for (const text of literalAlternatives(expression))
          add(`text:${tagName(node.parent, ast)}`, text);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      COPY_ATTRIBUTE.test(node.name.getText(ast))
    ) {
      const name = node.name.getText(ast);
      const initializer = node.initializer;
      const texts = ts.isStringLiteral(initializer)
        ? [initializer.text]
        : ts.isJsxExpression(initializer)
          ? literalAlternatives(initializer.expression)
          : [];
      for (const text of texts) add(`attr:${name}`, text);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      COPY_ATTRIBUTE.test(node.name.text)
    )
      for (const text of literalAlternatives(node.initializer))
        add(`prop:${node.name.text}`, text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return candidates;
}

/** Copy candidates over the cap or over the sentence limit. */
export function inspectUiCopy(file, source) {
  const findings = [];
  for (const { key, text } of collectUiCopy(file, source)) {
    if (text.length > LONG_COPY_CAP)
      findings.push({ kind: 'long-copy', key, text });
    if (countSentences(text) > MAX_SENTENCES)
      findings.push({ kind: 'multi-sentence', key, text });
  }
  return findings;
}

export function uiCopyFiles(root) {
  const files = execFileSyncBounded(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', ...ROOTS],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .split('\0')
    .filter((file) => /\.tsx?$/.test(file) && !EXCLUDED_FILE.test(file));
  if (!files.length) throw new Error('UI copy scan found no source files');
  return [...new Set(files)].sort();
}

/** Per-file `kind:key` counts, plus the texts behind each count for messages. */
export function uiCopyInventory(root = process.cwd()) {
  const counts = {};
  const texts = {};
  for (const file of uiCopyFiles(root)) {
    const findings = inspectUiCopy(
      file,
      readFileSync(resolve(root, file), 'utf8'),
    );
    for (const finding of findings) {
      const key = `${finding.kind}:${finding.key}`;
      counts[file] ??= {};
      texts[file] ??= {};
      counts[file][key] = (counts[file][key] ?? 0) + 1;
      texts[file][key] ??= [];
      texts[file][key].push(finding.text);
    }
  }
  return { counts, texts };
}

function assertInventory(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory))
    throw new Error('UI copy inventory must be an object');
  for (const counts of Object.values(inventory)) {
    if (
      !counts ||
      typeof counts !== 'object' ||
      Array.isArray(counts) ||
      Object.values(counts).some(
        (count) => !Number.isSafeInteger(count) || count < 0,
      )
    )
      throw new Error('UI copy counts must be nonnegative integers');
  }
}

/**
 * Growth fails; shrinkage is reported so the baseline can be tightened, but
 * never fails (under a merge queue, two lanes that each shorten copy must not
 * refuse each other).
 */
export function compareUiCopy(current, baseline) {
  assertInventory(current);
  assertInventory(baseline);
  const added = [];
  const reduced = [];
  for (const [file, counts] of Object.entries(current)) {
    for (const [key, count] of Object.entries(counts)) {
      const inherited = baseline[file]?.[key] ?? 0;
      if (count > inherited)
        added.push({ file, key, added: count - inherited });
    }
  }
  for (const [file, counts] of Object.entries(baseline)) {
    for (const [key, inherited] of Object.entries(counts)) {
      const count = current[file]?.[key] ?? 0;
      if (count < inherited)
        reduced.push({ file, key, removed: inherited - count });
    }
  }
  return { added, reduced };
}

const truncate = (text, max = 120) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function main() {
  const { counts, texts } = uiCopyInventory();
  if (process.argv.includes('--update')) {
    const total = Object.values(counts)
      .flatMap((byKey) => Object.values(byKey))
      .reduce((sum, count) => sum + count, 0);
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ version: 1, files: counts }, null, 2)}\n`,
    );
    console.log(
      `UI copy length: baseline rewritten, ${total} finding(s) in ${Object.keys(counts).length} file(s).`,
    );
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.version !== 1)
    throw new Error('Unsupported UI copy baseline version');
  const { added, reduced } = compareUiCopy(counts, baseline.files);
  for (const finding of added) {
    const [kind] = finding.key.split(':', 1);
    const limit =
      kind === 'long-copy'
        ? `over ${LONG_COPY_CAP} characters`
        : `more than ${MAX_SENTENCES} sentences`;
    console.error(
      `${finding.file}: ${finding.key} (+${finding.added}), copy ${limit}. One of:`,
    );
    for (const text of texts[finding.file][finding.key])
      console.error(`  "${truncate(text)}"`);
    console.error(`  ${REMEDY}`);
  }
  if (reduced.length)
    console.log(
      `${reduced.length} file/key count(s) are below the baseline; tighten it with \`node scripts/ui-copy-length.mjs --update\`.`,
    );
  console.log(
    `UI copy length: ${added.length} new long-copy or multi-sentence finding(s).`,
  );
  if (added.length) process.exitCode = 1;
}

if (invokedDirectly(import.meta.url)) main();
