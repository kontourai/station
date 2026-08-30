/**
 * Pre-push scope guard for the UI entry-bundle ceiling.
 *
 * The ceiling in `scripts/ui-bundle-budget.json` is enforced by `build:ui`,
 * which only runs inside `full:regression` — after the whole Vitest corpus.
 * That is too late to protect anybody: the ratchet fails on whoever gates
 * next, never on whoever added the bytes, so an unowned raise is consumed
 * within hours and the next lane inherits a red it did not cause (#3033,
 * #3141). Running the same measurement at push time makes the attribution
 * correct by construction — an over-ceiling UI tree physically cannot leave
 * the machine, and a raise happens in the branch that spent the bytes.
 *
 * This file adds no new opinion about size. It decides one thing — does this
 * push change anything the UI build reads — and then delegates to the
 * existing `npm run build:ui`, so the measured bytes, the ceiling, and the
 * guidance all keep coming from `scripts/ui-bundle-budget.mjs` in one voice.
 *
 * A server-only push must not pay for a UI build, so the measurement is
 * scoped to the branch delta against `origin/main`. When the scope cannot be
 * computed the gate measures anyway: "I could not look" must not resolve to
 * the same answer as "nothing changed" (docs/guides/code-quality.md, "a
 * default that decides").
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRef } from './lib/git-ref.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';

/**
 * Built into `dist-ui-prepush/` rather than `dist-ui/`: a push must not
 * silently replace the build a running dev server or desktop app is serving.
 * The `dist-ui-` prefix is already gitignored, and `emptyOutDir` bounds it.
 */
export const PREPUSH_BUILD_DIR = 'dist-ui-prepush';

/**
 * Everything the Vite build reads, from `vite.config.ts`: root `src-ui`, the
 * `@shared` alias, and the three workspace packages aliased straight to their
 * TypeScript sources. Manifests are inputs too — a dependency bump changes the
 * bundle without touching a single source file, and that is one of the ways
 * bytes have historically arrived unattributed.
 */
export const UI_BUILD_INPUT_PREFIXES = Object.freeze([
  'src-ui/',
  'src-shared/',
  'packages/sdk/src/',
  'packages/connect/src/',
  'packages/contracts/src/',
]);

export const UI_BUILD_INPUT_FILES = Object.freeze([
  'vite.config.ts',
  'package.json',
  'package-lock.json',
  'scripts/ui-bundle-budget.mjs',
  'scripts/ui-bundle-budget.json',
]);

/** Does one repo-relative path feed the UI build? */
export function isUiBuildInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized) return false;
  if (UI_BUILD_INPUT_FILES.includes(normalized)) return true;
  // Trailing slashes are load-bearing: `src-ui/` must not match `src-uix/`.
  return UI_BUILD_INPUT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function uiBuildInputs(paths) {
  return paths.filter((path) => isUiBuildInput(path));
}

/**
 * `measure: false` is only ever returned when the scope was computed AND
 * contained nothing the build reads.
 */
export function decideBundleScope({ baseSha, changedPaths }) {
  if (!baseSha) {
    return {
      measure: true,
      matched: [],
      reason: `no ${BASE_REF} ref here, so this push cannot be scoped; measuring rather than assuming`,
    };
  }
  const matched = uiBuildInputs(changedPaths);
  if (matched.length === 0) {
    return {
      measure: false,
      matched,
      reason: `none of the ${changedPaths.length} path(s) this branch changes feed the UI build`,
    };
  }
  return {
    measure: true,
    matched,
    reason: `this branch changes ${matched.length} UI build input(s): ${describeMatches(matched)}`,
  };
}

export function describeMatches(matched, limit = 3) {
  const shown = matched.slice(0, limit).join(', ');
  const remaining = matched.length - Math.min(limit, matched.length);
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Paths this branch changes relative to `base`, as repo-relative strings. */
export function changedPathsSince(base, run = git) {
  return run(['diff', '--name-only', '-z', `${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
}

function runBuild() {
  const result = spawnSync('npm', ['run', '--silent', 'build:ui'], {
    stdio: 'inherit',
    env: { ...process.env, STATION_BUILD_UI_DIR: PREPUSH_BUILD_DIR },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Deliberately does not restate what the budget gate already said. `build:ui`
 * can also fail for reasons that are not the ceiling (a broken build), so this
 * asserts only what is certainly true and points at the output above it.
 */
export const BUILD_FAILURE_NOTE = [
  '',
  'FAIL: `npm run build:ui` did not pass, so this push is refused.',
  '',
  'If it was the entry-bundle ceiling, the measured bytes, the current ceiling,',
  'and the two legitimate responses are printed above by',
  'scripts/ui-bundle-budget.mjs. Reproduce exactly what the hook ran with:',
  '',
  `  STATION_BUILD_UI_DIR=${PREPUSH_BUILD_DIR} npm run build:ui`,
  '',
].join('\n');

function main() {
  const baseSha = resolveRef(BASE_REF);
  const decision = decideBundleScope({
    baseSha,
    changedPaths: baseSha ? changedPathsSince(BASE_REF) : [],
  });

  if (!decision.measure) {
    console.log(`UI bundle: skipped — ${decision.reason}.`);
    return;
  }

  console.log(`UI bundle: measuring — ${decision.reason}.`);
  if (runBuild() !== 0) {
    console.error(BUILD_FAILURE_NOTE);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
