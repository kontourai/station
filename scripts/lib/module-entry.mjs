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
 * resolved is a real problem and now says so.
 *
 * ## The remaining gap (station#1853)
 *
 * 57 other files under `scripts/` still hand-roll this, 15 of them with the
 * `import.meta.url === ` + backtick-`file://${process.argv[1]}` template, which
 * breaks on symlinks *and* on percent-encoding (any space in a checkout path).
 * All are safe as invoked today; none is safe by construction. This helper
 * closes four call sites, not the class.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function invokedDirectly(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
