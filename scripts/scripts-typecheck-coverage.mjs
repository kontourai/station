#!/usr/bin/env node
/**
 * Typecheck `scripts/**` and prove the partition is exhaustive (station#1805).
 *
 * ## What was wrong
 *
 * `npm run typecheck` ran ten projects and **none of them included `scripts/`**
 * — 157 TypeScript files, gate implementations among them, never compiled by
 * anything. Vitest transpiles without typechecking, so a type error there was
 * invisible to every gate in the repo. It surfaced only because a lane compiled
 * one file by hand and immediately found a real `TS2353` it had introduced
 * (a stale `gatePass` in an object literal, runtime-harmless only because a
 * later spread happened to override it).
 *
 * That is this repo's recurring defect wearing a new coat: a gate reporting
 * clean over the scope it can see, and saying nothing about the rest.
 *
 * ## Why this is a gate and not just a tsconfig
 *
 * Adding `scripts/**` to a project would be an include-glob edit; the risk is
 * everything that comes after. `tsconfig.scripts.json` carries an enumerated
 * `exclude` list, and an enumerated exclusion is only honest if something holds
 * it to its enumeration. So this gate asserts, every run:
 *
 * 1. `tsconfig.scripts.json`'s exclusions are **exactly** the baseline's
 *    `deferred` list. Widening coverage-loss is then a visible two-file edit a
 *    reviewer sees, not a one-line glob tweak.
 * 2. Every deferred entry still **exists**. A list that keeps naming deleted
 *    files can hide a deletion behind a stale entry, and an assertion that only
 *    iterates the list checking non-emptiness cannot notice an entry vanishing.
 * 3. The compiled set and the deferred set **partition** every `.ts`, `.tsx`,
 *    `.mts` and `.cts` file under `scripts/` — disjoint, and their union is the
 *    real on-disk count. A new file lands in neither list, so it is compiled
 *    **by default** rather than by someone remembering. That is the acceptance
 *    criterion, and a floor ("at least N files checked") could not deliver it.
 *    Covering only `.ts` was a live gap, not a hypothetical one: 19 `.mts`
 *    files under `scripts/dogfood/` were in neither set, and two of them
 *    imported `src-server` modules that had since moved directories.
 *
 * The compiled set is not re-derived from the globs: it is what `tsc` reports
 * with `--listFiles`, i.e. the program it actually built. A reimplementation of
 * tsc's own file resolution could disagree with tsc and still read green.
 *
 * ## The `allowJs` / `checkJs` decision (stated, not deferred)
 *
 * `allowJs: true`, `checkJs: false`. Much of `scripts/` is `.mjs`, and the
 * `.ts` files import it. With `allowJs`, TypeScript *infers* types for those
 * modules, so the `.ts` call sites get real checking today without a single
 * hand-written `.d.ts` — the reason no `TS7016` appears in the deferred set.
 *
 * That inference is not sound for options bags: a parameter destructured
 * without a default is dropped from the inferred type entirely, which is what
 * produces the false `TS2353` on `acquireLock(..., { afterBaseline })` in
 * `station-dogfood-reconcile.mjs` — a real, live parameter the compiler cannot
 * see. Fixing that class means JSDoc typedefs (or `.d.ts`) on the `.mjs`
 * libraries, which is the follow-up, not this gate. `checkJs: true` would put
 * 105 untyped `.mjs` files under `strict` in one step and is explicitly not
 * proposed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * TypeScript source extensions the partition covers.
 *
 * `.ts` alone was a scope gap, not a false statement: the `OK:` sentence said
 * `.ts` and meant it, but the stated acceptance criterion — *a new file lands
 * in neither list, so it is compiled by default* — did not hold for `.tsx`,
 * `.mts`, or `.cts`. `scripts/dogfood/` already held 19 `.mts` files that were
 * in neither the compiled set nor the deferred list, and two of them turned out
 * to import `src-server` modules that had moved directories.
 */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

export const TSCONFIG = 'tsconfig.scripts.json';
export const BASELINE = 'scripts/scripts-typecheck-baseline.json';
export const SCAN_ROOT = 'scripts';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const toPosix = (value) => value.split(sep).join('/');

/** Every TypeScript file that exists under `scripts/`, repo-relative, sorted. */
export function discoverScriptSources(repoRoot, scanRoot = SCAN_ROOT) {
  const found = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
      ) {
        found.push(toPosix(relative(repoRoot, abs)));
      }
    }
  };
  walk(join(repoRoot, scanRoot));
  return found.sort();
}

/** The exclusions `tsconfig.scripts.json` declares, minus `node_modules`. */
export function configuredExclusions(repoRoot) {
  const config = readJson(join(repoRoot, TSCONFIG));
  return (config.exclude ?? [])
    .filter((entry) => entry !== 'node_modules')
    .sort();
}

export function baselineDeferrals(repoRoot) {
  return [...(readJson(join(repoRoot, BASELINE)).deferred ?? [])].sort();
}

/**
 * Absolute path to the installed TypeScript compiler entry point.
 *
 * Deliberately not `npx tsc`. `npx` will happily reach past a missing local
 * install and execute *something else* named `tsc` from the registry or PATH —
 * which is both a supply-chain hazard and, observed while building this gate, a
 * silent correctness one: the placeholder `tsc` package exits 1 with a friendly
 * message, which this gate would have reported as a compile failure.
 */
export function resolveCompiler(repoRoot) {
  const require = createRequire(join(repoRoot, 'package.json'));
  return require.resolve('typescript/bin/tsc');
}

/**
 * Compile the project and return both the diagnostics and the file list tsc
 * actually built, in one invocation — a second `tsc` run purely to enumerate
 * would double the gate's cost for a number it already has.
 */
export function compileProject(repoRoot, { run = spawnSync } = {}) {
  const result = run(
    process.execPath,
    [resolveCompiler(repoRoot), '-p', TSCONFIG, '--noEmit', '--listFiles'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? '';
  const prefix = `${toPosix(repoRoot)}/${SCAN_ROOT}/`;
  const compiled = [];
  const diagnostics = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const posix = toPosix(line);
    if (
      posix.startsWith(prefix) &&
      SOURCE_EXTENSIONS.some((ext) => posix.endsWith(ext))
    ) {
      compiled.push(posix.slice(toPosix(repoRoot).length + 1));
      continue;
    }
    // tsc prints diagnostics on the same stream as --listFiles output.
    if (/error TS\d+/.test(line)) diagnostics.push(line);
  }
  for (const raw of (result.stderr ?? '').split('\n')) {
    if (raw.trim()) diagnostics.push(raw.trim());
  }
  return {
    status: result.status,
    compiled: [...new Set(compiled)].sort(),
    diagnostics,
  };
}

function difference(a, b) {
  const other = new Set(b);
  return a.filter((entry) => !other.has(entry));
}

export function evaluate({ discovered, compiled, configured, baseline }) {
  const failures = [];

  const configuredOnly = difference(configured, baseline);
  const baselineOnly = difference(baseline, configured);
  if (configuredOnly.length || baselineOnly.length) {
    failures.push(
      `FAIL: ${TSCONFIG} and ${BASELINE} disagree about what is deferred.\n` +
        `      Only in ${TSCONFIG}: ${configuredOnly.join(', ') || '(none)'}\n` +
        `      Only in ${BASELINE}: ${baselineOnly.join(', ') || '(none)'}\n` +
        '      Deferring a file is a deliberate, reviewable act; edit both.',
    );
  }

  const uncovered = difference(discovered, [...compiled, ...configured]);
  if (uncovered.length) {
    failures.push(
      `FAIL: ${uncovered.length} TypeScript file(s) under ${SCAN_ROOT}/ are neither compiled nor declared deferred:\n` +
        uncovered.map((file) => `        ${file}`).join('\n'),
    );
  }

  const both = compiled.filter((file) => new Set(configured).has(file));
  if (both.length) {
    failures.push(
      `FAIL: ${both.length} file(s) are declared deferred but the compiler built them anyway:\n` +
        both.map((file) => `        ${file}`).join('\n') +
        '\n      They are already covered; remove them from the deferred list.',
    );
  }

  const missing = difference(baseline, discovered);
  if (missing.length) {
    failures.push(
      `FAIL: ${missing.length} deferred entr(ies) name a file that no longer exists:\n` +
        missing.map((file) => `        ${file}`).join('\n') +
        '\n      A list that keeps naming deleted files can hide a deletion behind a stale entry.',
    );
  }

  const ghosts = difference(compiled, discovered);
  if (ghosts.length) {
    failures.push(
      `FAIL: the compiler built ${ghosts.length} file(s) the scan did not discover: ${ghosts.join(', ')}`,
    );
  }

  return failures;
}

export function checkScriptsTypecheckCoverage({
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  log = console.log,
  logError = console.error,
  run,
} = {}) {
  for (const required of [TSCONFIG, BASELINE]) {
    if (!existsSync(join(repoRoot, required))) {
      logError(`FAIL: ${required} is missing.`);
      return false;
    }
  }

  const discovered = discoverScriptSources(repoRoot);
  const configured = configuredExclusions(repoRoot);
  const baseline = baselineDeferrals(repoRoot);
  const { status, compiled, diagnostics } = compileProject(repoRoot, { run });

  const failures = evaluate({ discovered, compiled, configured, baseline });

  log(
    `Typechecked ${compiled.length} of ${discovered.length} TypeScript file(s) under ${SCAN_ROOT}/; ` +
      `${configured.length} deferred (${BASELINE}).`,
  );

  if (status !== 0) {
    logError(`FAIL: tsc -p ${TSCONFIG} exited ${status}.`);
    for (const line of diagnostics) logError(`      ${line}`);
  }
  for (const failure of failures) logError(failure);

  if (status === 0 && failures.length === 0) {
    log(
      `OK:   every ${SOURCE_EXTENSIONS.join('/')} file under ${SCAN_ROOT}/ is compiled or declared deferred.`,
    );
    return true;
  }
  return false;
}

if (invokedDirectly(import.meta.url)) {
  if (!checkScriptsTypecheckCoverage()) process.exitCode = 1;
}
