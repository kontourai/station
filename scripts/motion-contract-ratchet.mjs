#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASELINE_URL = new URL(
  './motion-contract-baseline.json',
  import.meta.url,
);
// Token sheets `src-ui/src/index.css` imports; their declarations are as
// real as any declared under CSS_ROOT.
const IMPORTED_TOKEN_SHEETS = [
  'node_modules/@kontourai/ui/tokens/tokens.css',
  'node_modules/@kontourai/ui/tokens/themes.css',
  'node_modules/@kontourai/ui/tokens/index.css',
  'node_modules/@kontourai/ui/tokens/fonts.css',
  'node_modules/@kontourai/ui/react/styles.css',
];

const CSS_ROOT = 'src-ui/src/';

const MOTION_DECLARATION =
  /\b(?:animation(?:-duration|-timing-function)?|transition(?:-duration|-timing-function)?)\s*:\s*([^;{}]+)/gi;
const DURATION_LITERAL = /(?:^|[\s,(])(?:\d*\.)?\d+(?:ms|s)\b/i;
const EASING_LITERAL =
  /(?:^|[\s,(])(?:ease(?:-in|-out|-in-out)?|linear|cubic-bezier\s*\()/i;
const TRANSITION_ALL = /\btransition\s*:\s*all(?:\s|;|$)/i;

// Matches a custom-property *declaration* (`--name:`), not a `var(--name)`
// reference — the character before `--` must be whitespace, `;`, `{`, or the
// start of the string/line, which a `var(` call is never preceded by.
const CUSTOM_PROPERTY_DECLARATION = /(^|[\s;{])--([a-zA-Z][\w-]*)\s*:/gm;

/** Every custom property *declared* (not referenced) in a CSS source. */
export function extractDeclaredCustomProperties(content) {
  const css = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = new Set();
  let match;
  CUSTOM_PROPERTY_DECLARATION.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: bounded RegExp scan
  while ((match = CUSTOM_PROPERTY_DECLARATION.exec(css)) !== null) {
    declared.add(`--${match[2]}`);
  }
  return declared;
}

// Finds every `var(...)` call in a value, with balanced-paren matching so a
// fallback that itself contains parens (a nested `var(...)` or
// `cubic-bezier(...)`) is captured whole rather than truncated at the first
// `)`.
function extractVarCalls(value) {
  const calls = [];
  const re = /var\(/g;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: bounded RegExp scan
  while ((match = re.exec(value))) {
    const start = match.index;
    let depth = 1;
    let i = start + 4;
    while (i < value.length && depth > 0) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth--;
      i++;
    }
    calls.push({
      text: value.slice(start, i),
      inner: value.slice(start + 4, i - 1),
    });
  }
  return calls;
}

// Splits a `var(...)` call's inner text into [name, fallback] on the first
// top-level comma (depth 0), so a fallback that is itself `var(--a, --b)`-
// shaped or a `cubic-bezier(a, b, c, d)` literal doesn't split early.
function splitTopLevel(inner) {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
    }
  }
  return [inner.trim(), undefined];
}

// A `var(--x)` call resolves if `--x` is declared, or if it has a fallback
// that itself resolves — a fallback that is purely a nested `var(...)` call
// is followed recursively; a fallback with any literal content is always a
// valid renderable value, so it resolves regardless of whether that literal
// is itself hard-coded (a separate concern the hard-coded-literal check
// already covers).
function callResolves(call, declaredTokens, depth) {
  if (depth > 8) return true;
  const [name, fallback] = splitTopLevel(call.inner);
  if (declaredTokens.has(name)) return true;
  if (!fallback) return false;
  const fallbackCalls = extractVarCalls(fallback);
  if (fallbackCalls.length === 1 && fallbackCalls[0].text === fallback) {
    return callResolves(fallbackCalls[0], declaredTokens, depth + 1);
  }
  return true;
}

/** Every `var(--x)` reference in `value` whose token never resolves. */
export function findUnresolvedTokenReferences(value, declaredTokens) {
  const unresolved = [];
  for (const call of extractVarCalls(value)) {
    if (!callResolves(call, declaredTokens, 0)) {
      const [name] = splitTopLevel(call.inner);
      unresolved.push(name);
    }
  }
  return [...new Set(unresolved)];
}

/**
 * Splits a shorthand value into its comma-separated layers, respecting
 * parentheses so `cubic-bezier(0.4, 0, 0.2, 1)` stays one layer rather than
 * four.
 */
export function motionLayers(value) {
  const layers = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      layers.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) layers.push(current);
  return layers.length > 0 ? layers : [value];
}

/** One layer is hard-coded when it states a duration or easing as a literal. */
export function isHardCodedLayer(layer) {
  const usesDurationToken = layer.includes('var(--motion-');
  const usesEasingToken = layer.includes('var(--ease-');
  return (
    (DURATION_LITERAL.test(layer) && !usesDurationToken) ||
    (EASING_LITERAL.test(layer) && !usesEasingToken)
  );
}

export function inspectMotionCss(content, declaredTokens) {
  const css = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const hardCoded = [];
  const transitionAll = [];
  const unresolvedToken = [];
  let match;
  MOTION_DECLARATION.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: bounded RegExp scan
  while ((match = MOTION_DECLARATION.exec(css)) !== null) {
    const value = match[1].trim();
    const declaration = match[0];
    if (TRANSITION_ALL.test(declaration)) transitionAll.push(declaration);
    // Per LAYER, not per declaration. Testing the whole value let a
    // partially tokenized declaration escape: a literal in one comma-separated
    // layer was excused by a `var(--motion-)` in a sibling layer, so
    //
    //   transition:
    //     border-color 0.15s,                                   <- literal
    //     background var(--motion-fast) var(--ease-standard),
    //
    // read as compliant. That mixed form is the LIKELY shape of a regression —
    // a maintenance edit adds a property to an already-tokenized declaration —
    // while the wholly-literal form this used to catch is the beginner case
    // (#3223). Measured at the time of the fix: zero mixed declarations
    // existed, so this closes the hole without moving the ceiling.
    if (motionLayers(value).some(isHardCodedLayer)) {
      hardCoded.push(declaration);
    }
    if (declaredTokens) {
      const tokens = findUnresolvedTokenReferences(value, declaredTokens);
      if (tokens.length > 0) unresolvedToken.push({ declaration, tokens });
    }
  }
  return { hardCoded, transitionAll, unresolvedToken };
}

export function inspectMotionFiles(files, readFile, declaredTokens) {
  const findings = [];
  for (const file of files) {
    if (file === 'src-ui/src/tokens.css') continue;
    const result = inspectMotionCss(readFile(file), declaredTokens);
    for (const declaration of result.hardCoded) {
      findings.push({ file, kind: 'hard-coded', declaration });
    }
    for (const declaration of result.transitionAll) {
      findings.push({ file, kind: 'transition-all', declaration });
    }
    for (const { declaration, tokens } of result.unresolvedToken) {
      findings.push({ file, kind: 'unresolved-token', declaration, tokens });
    }
  }
  return findings;
}

/**
 * The single declared-token inventory. `main()` and the ratchet's own tests
 * MUST both use this: an earlier version had the gate scan CSS_ROOT plus the
 * imported sheets while its test scanned only `tokens.css`, so the test
 * disagreed with the gate about which tokens exist and failed on real code.
 * A checker and its test drifting on what counts as "declared" is the same
 * claim-vs-derivation problem the checker exists to catch.
 */
export function collectDeclaredTokens(files, readFile) {
  const declared = new Set();
  for (const file of files) {
    for (const name of extractDeclaredCustomProperties(readFile(file))) {
      declared.add(name);
    }
  }
  for (const sheet of IMPORTED_TOKEN_SHEETS) {
    if (!existsSync(sheet)) {
      throw new Error(
        `motion contract: imported token sheet missing: ${sheet}. ` +
          'Refusing to run — without it every --k-* reference would be ' +
          'reported as an undefined token.',
      );
    }
    for (const name of extractDeclaredCustomProperties(readFile(sheet))) {
      declared.add(name);
    }
  }
  return declared;
}

export function evaluateMotionContract(
  findings,
  ceiling,
  perFileCeilings = {},
) {
  const hardCoded = findings.filter((finding) => finding.kind === 'hard-coded');
  const transitionAll = findings.filter(
    (finding) => finding.kind === 'transition-all',
  );
  // A token reference that never resolves is not something a legacy ceiling
  // can grandfather in — it means the declaration doesn't animate at all, so
  // any occurrence is a failure, not a ratchetable count.
  const unresolvedToken = findings.filter(
    (finding) => finding.kind === 'unresolved-token',
  );
  const currentByFile = new Map();
  for (const finding of hardCoded) {
    currentByFile.set(finding.file, (currentByFile.get(finding.file) ?? 0) + 1);
  }
  const perFileRegressions = [...currentByFile.entries()]
    .filter(([file, count]) => count > (perFileCeilings[file] ?? 0))
    .map(([file, count]) => ({
      file,
      count,
      ceiling: perFileCeilings[file] ?? 0,
    }));
  return {
    hardCoded,
    transitionAll,
    unresolvedToken,
    perFileRegressions,
    passed:
      transitionAll.length === 0 &&
      unresolvedToken.length === 0 &&
      hardCoded.length <= ceiling &&
      perFileRegressions.length === 0,
  };
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
  const files = execFileSync(
    'git',
    ['ls-files', '--', `${CSS_ROOT}*.css`, `${CSS_ROOT}**/*.css`],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const readFile = (file) => readFileSync(file, 'utf8');
  // A motion token could legitimately be declared in a file other than
  // tokens.css, so the declared-token inventory scans every CSS file under
  // CSS_ROOT (including tokens.css itself), not just the one file it
  // usually lives in.
  //
  // It ALSO scans the design-system token sheets this app imports. Station's
  // `index.css` does `@import url("@kontourai/ui/tokens")`, which supplies
  // the whole `--k-*` family (`--k-dur`, `--k-ease`, …). Scanning only
  // CSS_ROOT would report every one of those as undefined — the check would
  // then be computing "not declared in src-ui" while reporting "undefined",
  // which is precisely the kind of claim this gate exists to prevent. If the
  // sheets are absent (a partial install), fail loudly rather than silently
  // narrowing the inventory and inventing findings.
  const declaredTokens = collectDeclaredTokens(files, readFile);
  const findings = inspectMotionFiles(files, readFile, declaredTokens);
  const result = evaluateMotionContract(
    findings,
    baseline.hardCodedDeclarationCeiling,
    baseline.perFileCeilings,
  );
  if (!result.passed) {
    for (const finding of findings) {
      const tokenSuffix = finding.tokens
        ? ` [undefined: ${finding.tokens.join(', ')}]`
        : '';
      process.stderr.write(
        `[motion-contract] ${finding.kind}: ${finding.file}: ${finding.declaration}${tokenSuffix}\n`,
      );
    }
    for (const regression of result.perFileRegressions) {
      process.stderr.write(
        `[motion-contract] file ceiling: ${regression.file}: ${regression.count} > ${regression.ceiling}\n`,
      );
    }
    throw new Error(
      `motion contract failed: ${result.hardCoded.length} hard-coded declaration(s) (ceiling ${baseline.hardCodedDeclarationCeiling}), ${result.transitionAll.length} transition:all declaration(s), ${result.unresolvedToken.length} unresolved token reference(s)`,
    );
  }
  process.stdout.write(
    `[motion-contract] OK: ${result.hardCoded.length} hard-coded declaration(s) <= ${baseline.hardCodedDeclarationCeiling}; no transition: all; no unresolved token references\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
