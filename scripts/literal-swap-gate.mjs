/**
 * Literal-swap detector (#1175).
 *
 * A change that edits a string literal in source AND edits the assertion
 * asserting it leaves a test that agrees by construction: it runs green, it
 * reports coverage, and it has no power to disagree. The canonical instance is
 * dc3eb7988, which swapped the engine chip's separator from a middot to a
 * hyphen in `EngineChip.tsx` and in the three tests asserting it. Thirty tests
 * passed. Nothing in review flagged it, because the tests agreed. The change
 * was never part of that issue and made the label worse -- model names already
 * carry hyphens, so "OpenCode - GLM-4.7" reads as one token.
 *
 * WHY IT MATCHES ON SUBSTITUTIONS, NOT LITERALS: the source side of that
 * example is a template (`${engine.name} · ${engine.model}`) while the test
 * side is concrete ('OpenCode · GLM-4.7'). The strings are never equal, so
 * intersecting changed literals finds nothing. What the two share is the EDIT:
 * `·` -> `-`. This gate pairs each removed literal with the added literal it
 * most plausibly became, reduces the pair to its differing segment, and reports
 * segment substitutions that occur in both a source file and a test file.
 *
 * REPORT-ONLY, DELIBERATELY. A legitimate copy change lands in exactly this
 * shape -- product text edited alongside the test asserting it is correct and
 * common. Blocking would punish the honest case as loudly as the smuggled one,
 * so this prints and exits 0. It is a reading aid for review, not a gate that
 * decides. `--strict` exits 1 for a caller that wants to enforce it.
 *
 * Run it directly:
 *   node scripts/literal-swap-gate.mjs [--base <ref>] [--range <commit>] [--strict]
 *
 * There is deliberately no npm alias yet. Adding one edits package.json, which
 * `classify-ci-change.mjs` counts as a dependency input, forcing the full live
 * advisory scan on every CI attempt -- a cost unrelated to this gate. The alias
 * is a follow-up for when the npm advisory registry is healthy.
 */

import { execFileSync } from 'node:child_process';

const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const CODE_PATH = /\.[cm]?[jt]sx?$/;
/** A pair must still look like the same sentence after the edit. */
const MIN_RETAINED_RATIO = 0.6;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Quoted runs on a diff line. Template literals included; interpolation kept verbatim. */
function literalsOf(line) {
  const out = [];
  const re =
    /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value && value.length >= 2) out.push(value);
  }
  return out;
}

/** The differing middle of two strings, after shared prefix and suffix. */
function substitution(before, after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p])
    p += 1;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s += 1;
  }
  const retained = p + s;
  const longest = Math.max(before.length, after.length);
  if (longest === 0 || retained / longest < MIN_RETAINED_RATIO) return null;
  return [before.slice(p, before.length - s), after.slice(p, after.length - s)];
}

/** Pair each removed literal with the added literal it most plausibly became. */
function substitutionsIn(removed, added) {
  const found = [];
  for (const before of removed) {
    if (added.includes(before)) continue; // unchanged, merely moved
    let best = null;
    let bestRetained = -1;
    for (const after of added) {
      if (removed.includes(after)) continue;
      const sub = substitution(before, after);
      if (!sub) continue;
      const retained =
        Math.max(before.length, after.length) -
        Math.max(sub[0].length, sub[1].length);
      if (retained > bestRetained) {
        bestRetained = retained;
        best = { before, after, sub };
      }
    }
    if (best && (best.sub[0] !== '' || best.sub[1] !== '')) found.push(best);
  }
  return found;
}

function parseDiff(diffText) {
  const files = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      current = header[1];
      if (!files.has(current)) files.set(current, { removed: [], added: [] });
      continue;
    }
    if (!current || line.startsWith('+++') || line.startsWith('---')) continue;
    const bucket = files.get(current);
    if (line.startsWith('-')) bucket.removed.push(...literalsOf(line.slice(1)));
    else if (line.startsWith('+'))
      bucket.added.push(...literalsOf(line.slice(1)));
  }
  return files;
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const baseFlag = argv.indexOf('--base');
  const rangeFlag = argv.indexOf('--range');

  let diffText;
  let scope;
  if (rangeFlag !== -1 && argv[rangeFlag + 1]) {
    scope = argv[rangeFlag + 1];
    diffText = git(['show', '--unified=0', '--format=', scope]);
  } else {
    const base =
      baseFlag !== -1 && argv[baseFlag + 1]
        ? argv[baseFlag + 1]
        : git(['merge-base', 'HEAD', 'origin/main']).trim();
    scope = `${base}...HEAD`;
    diffText = git(['diff', '--unified=0', scope]);
  }

  const files = parseDiff(diffText);
  const bySubstitution = new Map();
  for (const [path, { removed, added }] of files) {
    if (!CODE_PATH.test(path)) continue;
    const kind = TEST_PATH.test(path) ? 'test' : 'source';
    for (const hit of substitutionsIn(removed, added)) {
      const key = `${JSON.stringify(hit.sub[0])} -> ${JSON.stringify(hit.sub[1])}`;
      if (!bySubstitution.has(key))
        bySubstitution.set(key, { source: [], test: [] });
      bySubstitution.get(key)[kind].push({ path, ...hit });
    }
  }

  const lockstep = [...bySubstitution.entries()].filter(
    ([, sides]) => sides.source.length > 0 && sides.test.length > 0,
  );

  if (lockstep.length === 0) {
    console.log(
      `OK: no literal edited in lockstep with its own assertion (${scope}).`,
    );
    return;
  }

  console.log(
    `Literal(s) edited in BOTH source and the tests asserting them (${scope}).\n` +
      'This is correct for a deliberate copy change. It is also how an unrelated\n' +
      'user-visible change rides along unnoticed, because the tests agree with it\n' +
      'by construction. Confirm the change was intended:\n',
  );
  for (const [key, sides] of lockstep) {
    console.log(`  ${key}`);
    for (const kind of ['source', 'test']) {
      for (const hit of sides[kind]) {
        console.log(`    ${kind.padEnd(6)} ${hit.path}`);
        console.log(
          `           ${JSON.stringify(hit.before)} -> ${JSON.stringify(hit.after)}`,
        );
      }
    }
  }
  if (strict) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
