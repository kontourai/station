/**
 * UI copy length ratchet: user-facing strings in `src-ui/src` may not grow
 * longer or wordier than they already are.
 *
 * Two finding kinds, each counted per file and per stable discriminator (the
 * JSX tag that holds the text, the copy-bearing attribute name, or where a
 * literal is used), never per line:
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
 * - Every other string or template literal, so moving copy out of JSX into
 *   a constant, a return value, a call argument (`toast.error('...')`) or a
 *   lookup table does not hide it. Keyed `literal:<site>` by where it is
 *   used (`literal:const`, `literal:return`, `literal:call:<callee>`,
 *   `literal:prop:<name>`, `literal:attr:<name>`, ...); see `literalSite`.
 *   Measured at introduction: 43 findings over the copy rules above, about
 *   five of them agent prompts a person sees in the composer, none markup.
 *
 * Not copy: `aria-label` and the other names in `NON_COPY_NAME` (styling,
 * identity, addresses, prompt slots), text inside `code`/`pre`/`kbd`/`samp`,
 * strings without whitespace (identifiers, paths, URLs), command lines,
 * markup and SVG path data, types, imports, property names, comparisons,
 * tagged templates, and log and DOM calls (`NON_COPY_CALLEE`). Error messages
 * count, because the UI often renders them as written. There is no i18n catalog in
 * `src-ui`.
 *
 * Known gap: the ratchet counts findings, so a string already over the cap
 * in the baseline can grow longer without failing. Accepted: counting
 * lengths would key the baseline to text that every edit changes.
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
  /^(?:aria-description|body|caption|confirmLabel|confirmText|description|detail|details|emptyMessage|emptyText|error|explanation|heading|helperText|hint|label|message|placeholder|subtitle|summary|text|title|tooltip)$/;
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
function literalAlternatives(expression, claimed) {
  if (!expression) return [];
  if (ts.isParenthesizedExpression(expression))
    return literalAlternatives(expression.expression, claimed);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    claimed?.add(expression);
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    claimed?.add(expression);
    return [templateText(expression)];
  }
  if (ts.isConditionalExpression(expression))
    return [
      ...literalAlternatives(expression.whenTrue, claimed),
      ...literalAlternatives(expression.whenFalse, claimed),
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
        : literalAlternatives(expression.left, claimed)),
      ...literalAlternatives(expression.right, claimed),
    ];
  return [];
}

function tagName(node, ast) {
  if (ts.isJsxFragment(node)) return 'fragment';
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(
    ast,
  );
}

/** Wrappers a literal passes through on its way to where it is used. */
function isTransparent(parent, child) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isTemplateExpression(parent)
  )
    return true;
  if (ts.isConditionalExpression(parent)) return child !== parent.condition;
  if (ts.isJsxExpression(parent)) return ts.isJsxAttribute(parent.parent);
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.PlusToken ||
      (operator === ts.SyntaxKind.AmpersandAmpersandToken &&
        child === parent.right)
    );
  }
  return false;
}

/** A callee as a stable dotted name (`toast.error`), else its last name. */
function calleeName(expression, ast) {
  const text = expression.getText(ast);
  if (/^[\w$]+(?:\.[\w$]+)*$/.test(text)) return text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'expression';
}

/**
 * Not copy, by name: markup and styling, identifiers, addresses, and
 * accessibility names (`aria-label` is spoken, not shown).
 */
const NON_COPY_NAME =
  /^(?:aria-(?!description$).*|aria(?!Description$)[A-Z]\w*|as|class|className|\w+ClassName|css|d|data-.*|font|fontFamily|href|id|instructions|key|points|prompt|rel|role|sandbox|sizes|src|srcSet|style|system|systemPrompt|testId|transform|type|viewBox)$/;
/**
 * Not copy, by shape: HTML or CSS markup, a code comment, or SVG path data.
 * Only the catch-all literal rule applies this; JSX text cannot start so.
 */
const MARKUP =
  /^(?:<|\/\*|\{)|^[MmLlHhVvCcSsQqTtAaZz][\d\s.,eMmLlHhVvCcSsQqTtAaZz-]*$/;
/** Developer-facing calls: logs, thrown errors, DOM and regex plumbing. */
const NON_COPY_CALLEE =
  /^(?:console\..*|(?:\w+\.)*(?:log|logger|debug|trace)(?:\.\w+)?|(?:\w+\.)*(?:querySelector|querySelectorAll|closest|matches|matchMedia|setAttribute|getAttribute|addEventListener|removeEventListener|getPropertyValue|setProperty)|RegExp|require|import)$/;

/**
 * Where a literal outside the copy-specific rules is used, as a stable key:
 * `const`, `return`, `call:<callee>`, `new:<callee>`, `attr:<name>`,
 * `prop:<name>`, `assign`, `default`, `field`, `throw`. Null when the
 * literal is not copy: a type, an import, a property name, a comparison or
 * switch label, a tagged template, a developer-facing call, or a styling,
 * identity or accessibility-name slot.
 */
function literalSite(node, ast) {
  let child = node;
  let parent = node.parent;
  while (parent && isTransparent(parent, child)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return null;
  if (ts.isVariableDeclaration(parent))
    return child === parent.initializer ? 'const' : null;
  if (ts.isReturnStatement(parent)) return 'return';
  if (ts.isArrowFunction(parent))
    return child === parent.body ? 'return' : null;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    if (child === parent.expression) return null;
    const callee = calleeName(parent.expression, ast);
    if (NON_COPY_CALLEE.test(callee)) return null;
    // `new Error(...)` counts too: src-ui renders many error messages as
    // written (e.g. a query's `error.message`).
    return `${ts.isNewExpression(parent) ? 'new' : 'call'}:${callee}`;
  }
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText(ast);
    return NON_COPY_NAME.test(name) ? null : `attr:${name}`;
  }
  if (ts.isPropertyAssignment(parent)) {
    if (child !== parent.initializer) return null;
    const name =
      ts.isIdentifier(parent.name) ||
      ts.isStringLiteral(parent.name) ||
      ts.isNumericLiteral(parent.name)
        ? parent.name.text
        : 'computed';
    return NON_COPY_NAME.test(name) ? null : `prop:${name}`;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return child === parent.right ? 'assign' : null;
  if (ts.isParameter(parent) || ts.isBindingElement(parent))
    return child === parent.initializer ? 'default' : null;
  if (ts.isPropertyDeclaration(parent))
    return child === parent.initializer ? 'field' : null;
  if (ts.isThrowStatement(parent)) return 'throw';
  return null;
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
  // Literals a copy-specific rule above already measured; the catch-all
  // literal rule skips them so nothing counts twice.
  const claimed = new Set();

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
        ) {
          claimed.add(expression);
          parts.push(expression.text);
        } else if (expression && ts.isTemplateExpression(expression)) {
          claimed.add(expression);
          parts.push(templateText(expression));
        }
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
        for (const text of literalAlternatives(expression, claimed))
          add(`text:${tagName(node.parent, ast)}`, text);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      COPY_ATTRIBUTE.test(node.name.getText(ast))
    ) {
      const name = node.name.getText(ast);
      const initializer = node.initializer;
      const texts = literalAlternatives(
        ts.isJsxExpression(initializer) ? initializer.expression : initializer,
        claimed,
      );
      for (const text of texts) add(`attr:${name}`, text);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      COPY_ATTRIBUTE.test(node.name.text)
    )
      for (const text of literalAlternatives(node.initializer, claimed))
        add(`prop:${node.name.text}`, text);
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      !claimed.has(node)
    ) {
      const site = literalSite(node, ast);
      const text = ts.isTemplateExpression(node)
        ? templateText(node)
        : node.text;
      if (site && !MARKUP.test(text.trim())) add(`literal:${site}`, text);
    }
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
