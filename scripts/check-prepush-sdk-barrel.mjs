#!/usr/bin/env node
/**
 * Refuses a push that adds a value to an SDK query domain without routing it
 * through the public barrel (station#3629).
 *
 * `publicBarrel.test.ts` already derives this correctly. The problem is *when*
 * it runs: the pre-push gate runs `lint:check`, and `test:changed` deliberately
 * DEFERS a package-touching change to the `ci-fast` lane rather than executing
 * it (`executed: []`, `diagnostic: true`). So a barrel omission is first
 * observed on `main`, where it blocks every other lane until someone notices.
 *
 * Five reached main in one day (#3540, #3611, #3641 twice over, and the repair
 * on #3637's branch), every one caught by that test doing its job — afterwards.
 * The failure is asymmetric in exactly the way this hook's own header describes
 * for formatting: seconds for whoever wrote it, a whole gate cycle for whoever
 * finds it.
 *
 * This is the same shape #3208 applied to the UI-contract ratchets, and #3033
 * to the entry-bundle ceiling: run the invariant that already exists at the
 * moment the change is still the author's problem.
 *
 * Scope is deliberately narrow. The barrel can only break when the SDK's own
 * sources change, so a push that touches nothing under `packages/sdk/src/`
 * skips — which is most pushes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRef } from './lib/git-ref.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';

/**
 * The barrel test reads the SDK's own sources: the domain modules it
 * enumerates, and the two files that must re-export them. Its own file counts
 * as an input — an edit to the excluded-domain list changes the verdict without
 * touching a domain module.
 */
export const SDK_BARREL_INPUT_PREFIXES = Object.freeze(['packages/sdk/src/']);

/** Does one repo-relative path feed the barrel invariant? */
export function isSdkBarrelInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized) return false;
  // The trailing slash is load-bearing: `packages/sdk/src/` must not match a
  // sibling like `packages/sdk/src-legacy/`.
  return SDK_BARREL_INPUT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function sdkBarrelInputs(paths) {
  return paths.filter((path) => isSdkBarrelInput(path));
}

/**
 * `run: false` is only ever returned when the scope was computed AND contained
 * nothing the barrel reads. An unresolvable base must not resolve to the same
 * answer as "nothing changed" — that would turn a broken assumption into a
 * silent pass, which is the defect class this gate exists to catch.
 */
export function decideSdkBarrelScope({ baseSha, changedPaths }) {
  if (!baseSha)
    return {
      run: true,
      reason: `${BASE_REF} could not be resolved, so the changed set is unknown`,
    };
  const inputs = sdkBarrelInputs(changedPaths);
  if (inputs.length === 0)
    return { run: false, reason: 'this push changes no SDK source' };
  return {
    run: true,
    reason: `${inputs.length} SDK source path(s) changed`,
  };
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

function runBarrelTest() {
  const result = spawnSync(
    'npm',
    [
      'run',
      '--silent',
      'test:focused',
      '--',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Names the two files a repair almost always touches, because the fix is
 * mechanical and the diagnostic above it already names the exact symbol.
 */
export const BARREL_FAILURE_NOTE = [
  '',
  'FAIL: the SDK public barrel does not re-export everything a public query',
  'domain exports, so this push is refused.',
  '',
  'The symbol is named in the assertion above. A value reaches the barrel',
  'through both of:',
  '',
  '  packages/sdk/src/queries.ts   (re-export from the domain module)',
  '  packages/sdk/src/index.ts     (re-export from queries)',
  '',
  'Adding it to only one produces a DIFFERENT failure — a name that resolves',
  'to another binding — so add it to both, then run `npx biome check --write`',
  'on them: a hand-inserted line commonly breaks import order.',
  '',
  'Reproduce exactly what the hook ran with:',
  '',
  '  npm run test:focused -- packages/sdk/src/__tests__/publicBarrel.test.ts',
  '',
].join('\n');

function main() {
  const baseSha = resolveRef(BASE_REF);
  const decision = decideSdkBarrelScope({
    baseSha,
    changedPaths: baseSha ? changedPathsSince(BASE_REF) : [],
  });

  if (!decision.run) {
    console.log(`SDK barrel: skipped — ${decision.reason}.`);
    return;
  }

  console.log(`SDK barrel: checking — ${decision.reason}.`);
  if (runBarrelTest() !== 0) {
    console.error(BARREL_FAILURE_NOTE);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
