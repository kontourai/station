/**
 * UI copy style ratchet: user-facing strings in `src-ui/src` may not gain
 * internal vocabulary, filler, issue numbers or the other wording patterns
 * `docs/guides/ui-copy.md` retires.
 *
 * It reads exactly the copy `scripts/ui-copy-length.mjs` reads (the shared
 * `collectUiCopy` extractor), plus single-word element text and copy-bearing
 * attributes (`Loading...`, a `Legacy` badge) and accessible names
 * (`aria-label`, `alt`, an `ariaLabel` prop, and `ariaLabel`/`'aria-label'`
 * object properties), which a screen reader speaks. Known gap: a single-word
 * literal outside those places (`const label = 'Legacy'`) is not read,
 * because there it is almost always an identifier. Comments, identifiers,
 * class names, `code`/`pre`/`kbd` text, log calls and test files are not
 * copy. Finding kinds, each counted per file:
 *
 * - `jargon:<word>`: a word from `JARGON` (whole word, any case).
 * - `issue-ref`: `station#1234`, `archive#1234`, or a bare `#123` to `#99999`.
 * - `filler`: a phrase from `FILLER`, or `!` ending a sentence.
 * - `not-just`: "not just" or "not only".
 * - `ascii-ellipsis`: `...` where `…` belongs.
 * - `emoji`: an Extended_Pictographic character. ©, ®, ™, arrows and
 *   geometric shapes are typography, not emoji.
 * - `em-dash`: a string containing " — ". DESIGN.md prefers a full stop.
 * - `title-dup`: a JSX element whose literal `title` equals its own
 *   non-empty literal visible text. The tooltip repeats what is already on
 *   screen. An icon-only control's `title` matching its `aria-label` is not
 *   counted: there the tooltip is the only hover hint. Truncated text that
 *   needs the tooltip is not detectable from source, so the baseline absorbs
 *   those.
 *
 * Each kind counts strings, not occurrences: a string with two jargon words
 * adds one to each word's count.
 *
 * Ratchet semantics match ui-copy-length: the gate fails only when a file's
 * count for a kind grows or a new file appears with findings. A shrinking
 * count passes and prints a hint to tighten the baseline with `--update`.
 * Fix a failure by rewriting the copy, not by widening the baseline.
 *
 *   node scripts/ui-copy-style.mjs            # check
 *   node scripts/ui-copy-style.mjs --update   # rewrite the baseline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  collectUiCopy,
  compareUiCopy,
  jsxTextRun,
  parseUiSource,
  uiCopyFiles,
} from './ui-copy-length.mjs';

const BASELINE_PATH = 'scripts/ui-copy-style-baseline.json';
const REMEDY =
  'Rewrite the copy in the user’s words; do not widen the baseline. See docs/guides/ui-copy.md.';

/**
 * Internal vocabulary that narrates the system instead of telling the user
 * what happened (SPEC copy rule 2, docs/guides/ui-copy.md). Each entry is a
 * finding key and the whole-word pattern that matches it in any case.
 * `binding` excludes key and keyboard bindings; `lease` is a whole word, so
 * "release" never matches. "Secret binding" is a product name (the secret
 * binding administration surface) that `binding` still counts; its existing
 * uses sit in the baseline rather than in an exception here.
 */
export const JARGON = Object.freeze({
  authority: /\bauthorit(?:y|ies|ative)\b/i,
  admitted: /\badmitted\b/i,
  projection: /\bprojections?\b/i,
  receipt: /\breceipts?\b/i,
  reconcile: /\breconcil(?:e|es|ed|ing|iation)\b/i,
  converge: /\bconverg(?:e|es|ed|ing|ence)\b/i,
  durable: /\bdurabl[ey]\b/i,
  're-anchor': /\bre-?anchor(?:s|ed|ing)?\b/i,
  legacy: /\blegacy\b/i,
  interim: /\binterim\b/i,
  canonical: /\bcanonical(?:ly)?\b/i,
  seam: /\bseams?\b/i,
  lease: /\bleas(?:e|es|ed)\b/i,
  custody: /\bcustody\b/i,
  enrolled: /\benrol(?:l|ls|led|ling|ment|ments|lment|lments)?\b/i,
  'terminal state': /\bterminal states?\b/i,
  binding: /(?<!\bkey\s|\bkeyboard\s|\bshortcut\s)\bbindings?\b/i,
});

/** Filler and hype (SPEC copy rule 6). `!` is matched separately. */
export const FILLER = Object.freeze([
  /\blet['’]s\b/i,
  /\bsimply\b/i,
  /\bseamless(?:ly)?\b/i,
  /\beffortless(?:ly)?\b/i,
  /\b(?:wh)?oops\b/i,
  /\bsupercharg(?:e|es|ed|ing)\b/i,
  // "Unlock" is a real verb for a vault or a device; only the hype phrases
  // count.
  /\bunlock (?:more|new|the full|the power)\b/i,
  /\bplease\b/i,
  // A sentence ending in `!`, not `!=` or `!important`.
  /[\p{L}\p{N})’'"]!+(?=\s|$|["')”’])/u,
]);

// Three to five digits: a six-digit `#000000` is a color, not an issue.
const ISSUE_REF = /\b(?:station|archive)#\d+\b|(?<![\w&/])#\d{3,5}\b/i;
const NOT_JUST = /\bnot (?:just|only)\b/i;
const ASCII_ELLIPSIS = /\.\.\./;
// Typographic marks, arrows and geometric shapes (a `▶` disclosure caret)
// are Extended_Pictographic but not emoji.
const EMOJI = /(?![©®™←-⇿■-◿])\p{Extended_Pictographic}/u;
const EM_DASH = / — /;

/** Style findings for one piece of copy, one per kind it matches. */
export function styleKinds(text) {
  const kinds = [];
  for (const [word, pattern] of Object.entries(JARGON))
    if (pattern.test(text)) kinds.push(`jargon:${word}`);
  if (ISSUE_REF.test(text)) kinds.push('issue-ref');
  if (FILLER.some((pattern) => pattern.test(text))) kinds.push('filler');
  if (NOT_JUST.test(text)) kinds.push('not-just');
  if (ASCII_ELLIPSIS.test(text)) kinds.push('ascii-ellipsis');
  if (EMOJI.test(text)) kinds.push('emoji');
  if (EM_DASH.test(text)) kinds.push('em-dash');
  return kinds;
}

const normalizeText = (text) => text.replace(/\s+/g, ' ').trim();

/** The literal text of a string-valued JSX attribute, if it has one. */
function literalAttribute(opening, ast, name) {
  for (const attribute of opening.attributes.properties) {
    if (
      !ts.isJsxAttribute(attribute) ||
      attribute.name.getText(ast) !== name ||
      !attribute.initializer
    )
      continue;
    const initializer = attribute.initializer;
    const expression = ts.isJsxExpression(initializer)
      ? initializer.expression
      : initializer;
    if (
      expression &&
      (ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression))
    )
      return normalizeText(expression.text);
  }
  return undefined;
}

/**
 * Elements whose literal `title` repeats their own non-empty literal visible
 * text. Only literal values compare: an interpolated title may say more than
 * the text it sits on. `aria-label` is deliberately not compared: on an
 * icon-only button the tooltip is the only hover hint for its name.
 */
export function titleDuplicates(
  file,
  source,
  ast = parseUiSource(file, source),
) {
  const found = [];
  function visit(node) {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening && ts.isJsxElement(node)) {
      const title = literalAttribute(opening, ast, 'title');
      if (title && title === normalizeText(jsxTextRun(node, ast)))
        found.push(title);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

/** Every style finding in one source file: `{ kind, text }`. */
export function inspectUiCopyStyle(file, source) {
  const findings = [];
  const ast = parseUiSource(file, source);
  for (const { text } of collectUiCopy(file, source, {
    words: true,
    accessibleNames: true,
    ast,
  }))
    for (const kind of styleKinds(text)) findings.push({ kind, text });
  for (const text of titleDuplicates(file, source, ast))
    findings.push({ kind: 'title-dup', text });
  return findings;
}

/** Per-file kind counts, plus the texts behind each count for messages. */
export function uiCopyStyleInventory(root = process.cwd()) {
  const counts = {};
  const texts = {};
  for (const file of uiCopyFiles(root)) {
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const { kind, text } of inspectUiCopyStyle(file, source)) {
      counts[file] ??= {};
      texts[file] ??= {};
      counts[file][kind] = (counts[file][kind] ?? 0) + 1;
      texts[file][kind] ??= [];
      texts[file][kind].push(text);
    }
  }
  return { counts, texts };
}

const truncate = (text, max = 120) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function main() {
  const { counts, texts } = uiCopyStyleInventory();
  if (process.argv.includes('--update')) {
    const total = Object.values(counts)
      .flatMap((byKind) => Object.values(byKind))
      .reduce((sum, count) => sum + count, 0);
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ version: 1, files: counts }, null, 2)}\n`,
    );
    console.log(
      `UI copy style: baseline rewritten, ${total} finding(s) in ${Object.keys(counts).length} file(s).`,
    );
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.version !== 1)
    throw new Error('Unsupported UI copy style baseline version');
  const { added, reduced } = compareUiCopy(
    counts,
    baseline.files,
    'UI copy style',
  );
  for (const finding of added) {
    console.error(
      `${finding.file}: ${finding.key} (+${finding.added}). One of:`,
    );
    for (const text of texts[finding.file][finding.key])
      console.error(`  "${truncate(text)}"`);
    console.error(`  ${REMEDY}`);
  }
  if (reduced.length)
    console.log(
      `${reduced.length} file/kind count(s) are below the baseline; tighten it with \`node scripts/ui-copy-style.mjs --update\`.`,
    );
  console.log(`UI copy style: ${added.length} new style finding(s).`);
  if (added.length) process.exitCode = 1;
}

if (invokedDirectly(import.meta.url)) main();
