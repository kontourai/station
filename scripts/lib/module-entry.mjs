/**
 * Is this module the process entry point?
 *
 *     if (invokedDirectly(import.meta.url)) main();
 *
 * Every script under `scripts/` and `ops/` that runs a body only when executed
 * (and not when a test imports it) asks through this helper (#2682).
 * `scripts/__tests__/module-entry.scan.test.ts` refuses a hand-rolled
 * comparison, so a copied-in `file://` template fails there rather than
 * exiting 0 on somebody's machine.
 *
 * ## Why neither side may be compared as written
 *
 * Node realpath-resolves an ESM entry for `import.meta.url` and
 * percent-encodes it, but leaves `argv[1]` as the (absolute) path it was given.
 * Invoking a script through a symlink (`/tmp` is `/private/tmp` on macOS), or
 * from a checkout whose path contains a space or `%`, therefore makes a string
 * comparison disagree, the `main` body never runs, and the process **exits 0
 * having done nothing** — a gate reporting success while governing nothing.
 * `pathToFileURL(argv[1])` fixes the encoding but not the symlink. Both sides
 * are realpathed here, which also covers the mirror case of the *module*
 * reached through a symlinked path. Found by the guardrail fixtures in
 * `scripts/__tests__/guardrail-known-bad-fixtures.test.ts`.
 *
 * ## Which failures mean "not the entry point"
 *
 * No `argv[1]` (a REPL), or an `argv[1]` that cannot name a file —
 * ENOENT/ENOTDIR (a test that points `argv[1]` at a fixture path, then
 * imports the module) or ENAMETOOLONG (`node -e 'import(…)' <long data>`, where
 * argv[1] is data) — cannot be this module, which exists: `false`. Any other
 * resolution failure (EACCES, ELOOP) is a real problem and is thrown, not read
 * as "imported": swallowing it would make a gate silently do nothing and exit
 * 0, the failure this helper exists to prevent.
 *
 * Four scripts run away from scripts/lib, so they keep an inline realpath
 * comparison instead of importing this module: `scripts/station-dev.mjs` is
 * copied onto PATH by `install-station-dev.mjs`;
 * `scripts/station-dogfood-reconcile.mjs` and
 * `scripts/station-dogfood-health.mjs` are installed on their own by
 * `ops/dogfood/install-macos.zsh` (health already imports from
 * `packages/shared`, a separate defect); and three workflows run
 * `git show "$BASE_SHA:scripts/classify-ci-change.mjs"` from a temp path.
 * `scripts/__tests__/module-entry.scan.test.ts` pins all four.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string | undefined} [argv1] the entry path; defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function invokedDirectly(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let entry;
  try {
    entry = realpathSync(resolve(argv1));
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG')
      return false;
    throw error;
  }
  return entry === realpathSync(fileURLToPath(moduleUrl));
}
