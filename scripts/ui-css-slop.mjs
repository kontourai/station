/**
 * UI CSS slop ratchet: stylesheets in `src-ui/src` may not gain decoration
 * the design system does not use, or values that bypass its tokens.
 *
 * Finding kinds, each counted per file by declaration:
 *
 * - `gradient`: a `linear-`, `radial-` or `conic-gradient(` (and their
 *   `repeating-` forms). DESIGN.md uses flat surfaces.
 * - `backdrop-blur`: a `backdrop-filter` with `blur(`.
 * - `infinite-animation`: `animation` or `animation-iteration-count` with
 *   `infinite`. Motion should settle; a spinner that must loop is a reviewed
 *   baseline entry.
 * - `numeric-z-index`: a literal `z-index` other than -1, 0 or 1, which only
 *   order siblings inside one stacking context. Anything higher invents a
 *   layer; use a `--layer-*` role from `src-ui/src/tokens.css`.
 * - `hex-color`: a `#rgb`/`#rrggbb`/`#rrggbbaa` color outside a custom
 *   property definition. Colors come from `--k-*` tokens. A hex that is only
 *   the fallback of a legacy-token `var(--text-primary, #hex)` is not
 *   counted: component-style-hygiene already counts that reference, and one
 *   edit should fail one gate. Any other fallback hex counts.
 *
 * `mask`, `mask-image` and their `-webkit-` forms are skipped for `gradient`
 * and `hex-color`: a mask gradient is an alpha ramp (a fade at a scroll
 * edge), not decoration, and its colors are never painted.
 *
 * Not counted here: legacy (non `--k-*`) token references. That burn-down
 * (#1225, #4690) is already a growth-only ratchet, `legacy-token` in
 * `scripts/component-style-hygiene.mjs`, keyed per file and per token. A
 * second count of the same references would fail twice for one edit. Motion
 * literals belong to `scripts/motion-contract-ratchet.mjs`.
 *
 * Excluded files: the token sheet (`tokens.css`), font faces (`fonts.css`)
 * and generated theme CSS (`*.generated.css`), which define the values the
 * rest must reference. Test fixtures are excluded too.
 *
 * Ratchet semantics match ui-copy-length: the gate fails only when a file's
 * count for a kind grows or a new file appears with findings. A shrinking
 * count passes and prints a hint to tighten the baseline with `--update`.
 *
 *   node scripts/ui-css-slop.mjs            # check
 *   node scripts/ui-css-slop.mjs --update   # rewrite the baseline
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEGACY_TOKEN } from './component-style-hygiene.mjs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { cssDeclarations } from './lib/css-declarations.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { compareUiCopy } from './ui-copy-length.mjs';

export { cssDeclarations };

const ROOTS = ['src-ui/src'];
const BASELINE_PATH = 'scripts/ui-css-slop-baseline.json';
const EXCLUDED_FILE =
  /(?:^|\/)(?:__tests__|__fixtures__|__mocks__)\/|(?:^|\/)(?:tokens|fonts)\.css$|\.generated\.css$/;

const GRADIENT = /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
const BLUR = /\bblur\(/i;
const INFINITE = /\binfinite\b/i;
const HEX_COLOR = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b/i;
const Z_INDEX_KEYWORD = /^(?:auto|inherit|initial|unset|revert(?:-layer)?)$/i;
const LOCAL_Z_INDEX = /^(?:-1|0|1)$/;
const MASK_PROPERTY = /^(?:-webkit-)?mask(?:-|$)/;

/**
 * A value with each legacy-token `var(...)` call removed, balanced, so a hex
 * that is only the fallback of a legacy reference is gone. Legacy means
 * component-style-hygiene's `LEGACY_TOKEN`, which already counts that
 * reference. A non-legacy call (`var(--k-text, #fff)`, a component-local
 * property) is kept, so its fallback hex still counts here; scanning
 * continues inside it, so a legacy call nested in its fallback is removed.
 */
export function withoutLegacyVarCalls(value) {
  const legacy = new RegExp(LEGACY_TOKEN.source, 'y');
  let out = '';
  let i = 0;
  for (;;) {
    let start = value.indexOf('var(', i);
    while (start !== -1) {
      legacy.lastIndex = start;
      if (legacy.test(value)) break;
      start = value.indexOf('var(', start + 4);
    }
    if (start === -1) return out + value.slice(i);
    out += `${value.slice(i, start)} `;
    let depth = 0;
    let end = start + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    i = end + 1;
  }
}

const REMEDIES = Object.freeze({
  gradient: 'use a flat --k-* surface.',
  'backdrop-blur': 'use an opaque --k-* surface.',
  'infinite-animation':
    'let the motion settle, or keep a loading spinner in the baseline with a reason.',
  'numeric-z-index': 'use a --layer-* role from src-ui/src/tokens.css.',
  'hex-color': 'use a --k-* color token.',
});

/** The slop kinds one declaration carries. */
export function declarationKinds({ property, value }) {
  const kinds = [];
  const custom = property.startsWith('--');
  const mask = MASK_PROPERTY.test(property);
  if (!mask && GRADIENT.test(value)) kinds.push('gradient');
  if (/^(?:-webkit-)?backdrop-filter$/.test(property) && BLUR.test(value))
    kinds.push('backdrop-blur');
  if (
    (property === 'animation' || property === 'animation-iteration-count') &&
    INFINITE.test(value)
  )
    kinds.push('infinite-animation');
  if (property === 'z-index') {
    const literal = value.replace(/\s*!important$/i, '').trim();
    if (
      !/\bvar\(/.test(literal) &&
      !Z_INDEX_KEYWORD.test(literal) &&
      !LOCAL_Z_INDEX.test(literal)
    )
      kinds.push('numeric-z-index');
  }
  if (!custom && !mask && HEX_COLOR.test(withoutLegacyVarCalls(value)))
    kinds.push('hex-color');
  return kinds;
}

/** Every slop finding in one stylesheet: `{ kind, declaration }`. */
export function inspectCssSlop(source) {
  const findings = [];
  for (const declaration of cssDeclarations(source))
    for (const kind of declarationKinds(declaration))
      findings.push({
        kind,
        declaration: `${declaration.property}: ${declaration.value}`,
      });
  return findings;
}

export function cssSlopFiles(root) {
  const files = execFileSyncBounded(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', ...ROOTS],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  )
    .split('\0')
    .filter((file) => file.endsWith('.css') && !EXCLUDED_FILE.test(file));
  if (!files.length) throw new Error('UI CSS scan found no stylesheets');
  return [...new Set(files)].sort();
}

/** Per-file kind counts, plus the declarations behind each count. */
export function cssSlopInventory(root = process.cwd()) {
  const counts = {};
  const declarations = {};
  for (const file of cssSlopFiles(root)) {
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const { kind, declaration } of inspectCssSlop(source)) {
      counts[file] ??= {};
      declarations[file] ??= {};
      counts[file][kind] = (counts[file][kind] ?? 0) + 1;
      declarations[file][kind] ??= [];
      declarations[file][kind].push(declaration);
    }
  }
  return { counts, declarations };
}

function main() {
  const { counts, declarations } = cssSlopInventory();
  if (process.argv.includes('--update')) {
    const total = Object.values(counts)
      .flatMap((byKind) => Object.values(byKind))
      .reduce((sum, count) => sum + count, 0);
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ version: 1, files: counts }, null, 2)}\n`,
    );
    console.log(
      `UI CSS slop: baseline rewritten, ${total} finding(s) in ${Object.keys(counts).length} file(s).`,
    );
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.version !== 1)
    throw new Error('Unsupported UI CSS slop baseline version');
  const { added, reduced } = compareUiCopy(
    counts,
    baseline.files,
    'UI CSS slop',
  );
  for (const finding of added) {
    console.error(
      `${finding.file}: ${finding.key} (+${finding.added}); ${REMEDIES[finding.key]} One of:`,
    );
    for (const declaration of declarations[finding.file][finding.key])
      console.error(`  ${declaration}`);
  }
  if (reduced.length)
    console.log(
      `${reduced.length} file/kind count(s) are below the baseline; tighten it with \`node scripts/ui-css-slop.mjs --update\`.`,
    );
  console.log(`UI CSS slop: ${added.length} new CSS slop finding(s).`);
  if (added.length) process.exitCode = 1;
}

if (invokedDirectly(import.meta.url)) main();
