#!/usr/bin/env node
/**
 * Pre-push scope guard for the TypeScript aggregate.
 *
 * `ci:fast` runs `scripts/typecheck-aggregate.mjs` on pull requests, on
 * merge-queue candidates and on push-to-main, so a type break cannot reach
 * `main` unobserved. What it cannot do is observe it BEFORE the push: the
 * author learns about it a CI cycle later, and on a busy queue an intervening
 * candidate inherits the red. That is the same asymmetry the hook's header
 * describes for formatting, and the same one #3033, #3208 and #3629 closed for
 * the bundle ceiling, the UI-contract ratchets and the SDK barrel.
 *
 * Unlike those three, this one is NOT seconds-scale: the aggregate is ~82s for
 * all thirteen lanes, an order of magnitude above everything else in the hook,
 * and its two preconditions add ~9s. So it runs only when the push changes
 * something a `tsc` project reads. A docs-only, workflow-only or `.mjs`-only
 * push pays none of it, which is why this is a scope guard and not a line in
 * the hook: adding it unconditionally would break the hook's own stated
 * doctrine that only seconds-scale checks belong there.
 *
 * This file adds no new opinion about types. It decides one thing — does this
 * push change anything the typecheck lanes read — and then runs the same three
 * commands `run-ci-fast.mjs` runs, in the same order, so the projects, the
 * diagnostics and the remedies all keep coming from one voice.
 *
 * When the scope cannot be computed the gate runs anyway: "I could not look"
 * must not resolve to the same answer as "nothing changed"
 * (docs/guides/code-quality.md, "a default that decides").
 */

import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPathsSince,
  describeMatches,
} from './check-prepush-ui-bundle.mjs';
import { resolveRef } from './lib/git-ref.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';

/**
 * What a `tsc` project compiles. `tsconfig.scripts.json` sets `checkJs:
 * false` and every project's `include` lists only these four extensions, so a
 * `.mjs` or `.js` edit cannot produce a type error — deliberately not listed.
 */
const TYPECHECK_INPUT_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

/**
 * Manifests are inputs too: a dependency bump or a patch changes the types the
 * projects resolve without touching a single source file, and `package.json`
 * is where every `typecheck:*` script is defined.
 */
const TYPECHECK_INPUT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  // The aggregate's own catalog. Adding or removing a lane changes the
  // verdict without changing a source file.
  'scripts/typecheck-aggregate.mjs',
  'scripts/lib/npm-lane-aggregate.mjs',
]);

export const TYPECHECK_INPUT_PREFIXES = Object.freeze(['patches/']);

/** Does one repo-relative path feed a typecheck lane? */
export function isTypecheckInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized) return false;
  if (TYPECHECK_INPUT_FILES.includes(normalized)) return true;
  // Any project's config, at the root or inside a workspace package:
  // tsconfig.json, tsconfig.tests.json, packages/sdk/tsconfig.json.
  const name = basename(normalized);
  if (name.startsWith('tsconfig') && name.endsWith('.json')) return true;
  if (TYPECHECK_INPUT_EXTENSIONS.some((ext) => normalized.endsWith(ext)))
    return true;
  // Trailing slashes are load-bearing: `patches/` must not match `patches-old/`.
  return TYPECHECK_INPUT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function typecheckInputs(paths) {
  return paths.filter((path) => isTypecheckInput(path));
}

/**
 * `run: false` is only ever returned when the scope was computed AND contained
 * nothing a typecheck lane reads.
 */
export function decideTypecheckScope({ baseSha, changedPaths }) {
  if (!baseSha)
    return {
      run: true,
      matched: [],
      reason: `${BASE_REF} could not be resolved, so the changed set is unknown`,
    };
  const matched = typecheckInputs(changedPaths);
  if (matched.length === 0)
    return {
      run: false,
      matched,
      reason: `none of the ${changedPaths.length} path(s) this branch changes feed a typecheck lane`,
    };
  return {
    run: true,
    matched,
    reason: `this branch changes ${matched.length} typecheck input(s): ${describeMatches(matched)}`,
  };
}

/**
 * The same three commands `FAST_STATIC_COMMANDS` runs, in the same order and
 * for the same stated reasons: `build:connect` because `typecheck:ui` resolves
 * `@kontourai/station-connect` through `packages/connect/dist` and reports a
 * bogus `Cannot find module` without it, and the Basis MCP generator because
 * three lanes resolve its git-ignored bundles as ordinary modules. Both write
 * only build output, and `dist:freshness` already requires that output to be a
 * build of the current sources.
 *
 * `npm run typecheck` is deliberately not used: it chains `dist:freshness`
 * ahead of the aggregate, which fails on an unbuilt `packages/cli/dist` before
 * any lane runs and would refuse a push for a reason that is not a type error.
 */
export const TYPECHECK_PREPUSH_COMMANDS = Object.freeze([
  Object.freeze(['npm', Object.freeze(['run', '--silent', 'build:connect'])]),
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/generate-basis-mcp-apps.mjs']),
  ]),
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/typecheck-aggregate.mjs']),
  ]),
]);

/**
 * Stops at the first failing command and returns its status, so a broken
 * `build:connect` reports as a build failure instead of as thirteen lanes of
 * `Cannot find module`. `spawn` is a parameter so the short-circuit is
 * provable without paying 82 seconds for the real aggregate.
 */
export function runTypecheckCommands(
  commands = TYPECHECK_PREPUSH_COMMANDS,
  spawn = spawnSync,
) {
  for (const [command, args] of commands) {
    const result = spawn(command, [...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

/**
 * The aggregate names every failing lane and every error itself, so this says
 * only what is certainly true and points at the output above it.
 */
export const TYPECHECK_FAILURE_NOTE = [
  '',
  'FAIL: at least one `typecheck:*` lane did not pass, so this push is refused.',
  '',
  'Every failing lane is named above; the aggregate runs all thirteen rather',
  'than stopping at the first, so that list is complete. Reproduce exactly',
  'what the hook ran with:',
  '',
  '  npm run build:connect',
  '  node scripts/generate-basis-mcp-apps.mjs',
  '  node scripts/typecheck-aggregate.mjs',
  '',
  'A single lane is faster to iterate on: `npm run typecheck:server-tests`',
  'is the only one of the thirteen that needs no build.',
  '',
].join('\n');

function main() {
  const baseSha = resolveRef(BASE_REF);
  const decision = decideTypecheckScope({
    baseSha,
    changedPaths: baseSha ? changedPathsSince(BASE_REF) : [],
  });

  if (!decision.run) {
    console.log(`Typecheck: skipped — ${decision.reason}.`);
    return;
  }

  console.log(`Typecheck: checking — ${decision.reason}.`);
  if (runTypecheckCommands() !== 0) {
    console.error(TYPECHECK_FAILURE_NOTE);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
