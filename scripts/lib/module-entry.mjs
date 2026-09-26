/**
 * Is this module the process entry point?
 *
 * ## Why this is not `resolve(argv[1]) === fileURLToPath(import.meta.url)`
 *
 * Node realpath-resolves an ESM entry for `import.meta.url` but leaves
 * `argv[1]` exactly as written. Invoking a script by an absolute path under
 * `/tmp` (a symlink to `/private/tmp`) therefore makes the two disagree, the
 * `main` body never runs, and the process **exits 0 having done nothing** — a
 * gate reporting success while governing nothing, which is the shape these
 * gates exist to catch. Found by the guardrail fixtures in
 * `scripts/__tests__/guardrail-known-bad-fixtures.test.ts`.
 *
 * Both sides are realpathed, which also covers the mirror case: the *module*
 * reached through a symlinked path. That is the form
 * `scripts/lockfile-sync-gate.mjs` already used, and it now imports this helper
 * rather than the repo keeping a second, weaker copy.
 *
 * ## Why it does not swallow errors
 *
 * An earlier draft wrapped this in `catch { return false }` — fail-*open* in
 * the one module written to prevent fail-open, since an unresolvable entry path
 * would make every gate silently do nothing and exit 0. A path that cannot be
 * resolved is a real problem and says so, with one exact exception.
 *
 * When `realpathSync(argv[1])` fails with ENOENT or ENOTDIR, the answer is
 * `false`. Under `node -e` / `--input-type=module -e`, `argv[1]` is the first
 * positional argument (a version string such as `1.2.3` in
 * `.github/workflows/internal-testflight.yml`), not a script path, so a module
 * imported there must not crash at import. That is not fail-open: node only
 * runs a script it could open, so a directly invoked gate's `argv[1]` always
 * exists, and a path that does not exist cannot be this module. Every other
 * error (EACCES, ELOOP, …) still throws, and the module-side realpath stays
 * strict.
 *
 * ## Windows and percent-encoding
 *
 * Both sides are native paths (`fileURLToPath` decodes `%20` and turns
 * `file:///C:/x` into `C:\x`), so neither a space in the checkout path nor a
 * Windows drive path can make the comparison false. The string-built forms
 * this replaced — a URL assembled from `process.argv[1]`, or
 * `new URL(import.meta.url).pathname` compared against it — failed on both,
 * and on Windows that made gates in the required portable-floor job exit 0
 * without running. `scripts/__tests__/module-entry-guard.scan.test.ts` rejects
 * the textual forms of those checks; it does not see an aliased `argv` or a URL
 * built in a helper.
 *
 * ## The remaining gap (station#1853)
 *
 * Many scripts still hand-roll a path-based comparison
 * (`resolve(argv[1]) === fileURLToPath(...)`, `pathToFileURL(argv[1]).href`).
 * Those survive spaces and Windows paths but not a symlinked invocation path.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function invokedDirectly(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolvedEntry;
  try {
    resolvedEntry = realpathSync(entry);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
  return resolvedEntry === realpathSync(fileURLToPath(moduleUrl));
}
