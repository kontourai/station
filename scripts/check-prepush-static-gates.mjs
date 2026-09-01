/**
 * Pre-push scope guard for the cheap `verify:static` gates.
 *
 * The UI-contract ratchets (motion-contract, a11y, focus-visible,
 * state-primitives, shell-conformance, responsive-surface, lazy-boundary),
 * the content gates (noun-consistency, station-vocabulary,
 * coding-composition-inventory), and the cross-package random-uuid-guard
 * (station#1137) all live in `verify:static`, which is composed only by
 * `full:regression`, which CI runs only on push-to-main or
 * `workflow_dispatch`. Pull requests get `ci:fast`, which by design never runs
 * broad static verification. So nothing evaluates a candidate diff against any
 * of them until it is already on main.
 *
 * The consequence is the one `check-prepush-ui-bundle.mjs` was written for,
 * and its docblock states it exactly: "the ratchet fails on whoever gates
 * next, never on whoever added the bytes". Observed twice in one day
 * (2026-08-18): 3af6c1820 added `animation: … 1.2s ease-in-out` and 6600ad8b8
 * added `transition: … 0.15s`, each putting motion-contract over its ceiling
 * on main. A third, f6aa6568d, added a file the coding-composition inventory
 * did not declare. Each was found only when an unrelated branch tried to take
 * a completion receipt and inherited a red main (#3208).
 *
 * This adds no new opinion about motion, accessibility, or shells. It decides
 * one thing — does this push change anything these ratchets read — and then
 * delegates to the existing scripts, so the counts, the ceilings, and the
 * remedies all keep coming from one voice.
 *
 * Cost, measured on this repo: eleven of the twelve run in under 500ms each
 * (~2s combined, random-uuid-guard included); `a11y` is ~5s because it runs
 * its own biome pass. A docs-only or workflow-only push pays none of it.
 *
 * When the scope cannot be computed the gate runs anyway: "I could not look"
 * must not resolve to the same answer as "nothing changed"
 * (docs/guides/code-quality.md, "a default that decides").
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPathsSince,
  describeMatches,
} from './check-prepush-ui-bundle.mjs';
import { resolveRef } from './lib/git-ref.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';

/**
 * The ratchets this guard runs, in ascending cost so a cheap failure reports
 * before an expensive one starts. Each is the same script `verify:static`
 * composes — this file never reimplements a count.
 */
export const PREPUSH_STATIC_GATES = Object.freeze([
  'lazy-boundary-ratchet',
  'focus-visible-ratchet',
  'responsive-surface-ratchet',
  'mobile-css-ratchet',
  'coding-composition-inventory-gate',
  'noun-consistency-gate',
  // 'rename-inventory' retired at the 2026-08-28 public reset: a denylist in
  // a public repo publishes its own denylist. The competitor-name policy
  // lives in docs/cape.md; no replacement name gate by design.
  'motion-contract-ratchet',
  'shell-conformance-ratchet',
  'state-primitives-ratchet',
  'station-vocabulary-gate',
  'random-uuid-guard',
  'dialog-surface-class-guard',
  'a11y-ratchet',
]);

/**
 * Source roots these ratchets read. `a11y` scans the whole `lint:check` set,
 * which is why this is broader than the UI build's inputs; the rest are
 * `src-ui`-scoped. Their own scripts and baselines count as inputs too — a
 * ceiling edit changes the verdict without touching a source file.
 */
export const STATIC_GATE_INPUT_PREFIXES = Object.freeze([
  'src-ui/',
  'src-server/',
  'src-shared/',
  'packages/',
  'tests/',
  'examples/',
  'scripts/',
]);

/** Does one repo-relative path feed any of these gates? */
export function isStaticGateInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized) return false;
  // Trailing slashes are load-bearing: `src-ui/` must not match `src-uix/`.
  return STATIC_GATE_INPUT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function staticGateInputs(paths) {
  return paths.filter((path) => isStaticGateInput(path));
}

/**
 * `run: false` is only ever returned when the scope was computed AND
 * contained nothing these ratchets read.
 */
export function decideStaticGateScope({ baseSha, changedPaths }) {
  if (!baseSha) {
    return {
      run: true,
      matched: [],
      reason: `no ${BASE_REF} ref here, so this push cannot be scoped; running rather than assuming`,
    };
  }
  const matched = staticGateInputs(changedPaths);
  if (matched.length === 0) {
    return {
      run: false,
      matched,
      reason: `none of the ${changedPaths.length} path(s) this branch changes feed one of these gates`,
    };
  }
  return {
    run: true,
    matched,
    reason: `this branch changes ${matched.length} gate input(s): ${describeMatches(matched)}`,
  };
}

function runRatchet(name) {
  const result = spawnSync('node', [`scripts/${name}.mjs`], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Deliberately does not restate the counts or ceilings — each ratchet has
 * already printed its own, and duplicating them here would let the two drift.
 */
export function failureNote(failed) {
  return [
    '',
    `FAIL: ${failed.length} static gate(s) did not pass, so this push is refused:`,
    ...failed.map((name) => `  - ${name}`),
    '',
    'Each printed its own counts, ceilings, and remedy above. Reproduce with:',
    '',
    ...failed.map((name) => `  node scripts/${name}.mjs`),
    '',
    'These run here rather than only in full:regression so the failure lands on',
    'the change that caused it, not on whoever gates next (#3208).',
    '',
  ].join('\n');
}

function main() {
  const baseSha = resolveRef(BASE_REF);
  const decision = decideStaticGateScope({
    baseSha,
    changedPaths: baseSha ? changedPathsSince(BASE_REF) : [],
  });

  if (!decision.run) {
    console.log(`Static gates: skipped — ${decision.reason}.`);
    return;
  }

  console.log(`Static gates: checking — ${decision.reason}.`);
  const failed = PREPUSH_STATIC_GATES.filter((name) => runRatchet(name) !== 0);
  if (failed.length > 0) {
    console.error(failureNote(failed));
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
