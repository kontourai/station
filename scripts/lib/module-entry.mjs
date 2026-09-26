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
 * resolved is a real problem and says so: every realpath error throws,
 * ENOENT included. Catching ENOENT would reopen the silent skip for a direct
 * invocation whose `argv[1]` was rewritten (a preload) or whose script was
 * deleted after load.
 *
 * ## Eval and print mode
 *
 * Under `node -e` / `--eval` / `-p` / `--print` / `-pe` (including
 * `--input-type=module -e`) there is no entry module, and `argv[1]` is the
 * first user positional argument — a version string such as `1.2.3` in
 * `.github/workflows/internal-testflight.yml`. No module can be the entry
 * point there, so the answer is `false` without reading `argv[1]` at all.
 * That mode is read from `process.execArgv`, which node fills from the
 * command line and never from the script.
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

const EVAL_FLAG = /^(?:-e|-p|-pe|--eval|--print)(?:=|$)/;

function evalMode() {
  return process.execArgv.some((arg) => EVAL_FLAG.test(arg));
}

export function invokedDirectly(moduleUrl) {
  if (evalMode()) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
