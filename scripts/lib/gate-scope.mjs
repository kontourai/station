/**
 * Scope-honesty helpers for the guardrail family (station#1559, station#1543;
 * epic #1555 slice 4b, `absence-as-success`).
 *
 * ## The defect this exists to prevent
 *
 * `scripts/noun-consistency-gate.mjs` and `scripts/state-primitives-ratchet.mjs`
 * both enumerated their scope with:
 *
 *     git ls-files 'src-ui/src/**\/*.tsx'
 *
 * Git's `**` in that pathspec form requires at least one intervening directory,
 * so files sitting directly in `src-ui/src` were never listed: 523 files
 * enumerated against 525 tracked. Both gates then printed a clean verdict that
 * *named the glob as its scope* — "no un-allowlisted stale-noun matches in
 * `src-ui/src/**\/*.tsx` (523 files scanned)" — asserting a result over a scope
 * they had not walked. `src-ui/src/App.tsx` (the router shell) and
 * `src-ui/src/main.tsx` (the app entry point) were permanently invisible to
 * both. `scripts/unsaved-guard-gate.mjs` had already hit and documented this
 * exact pathspec hazard; the two gates here had not.
 *
 * station#1543 is the same failure from the other direction: user-facing copy
 * MOVED OUT of the scanned tree (into `packages/contracts/src/settings-registry.ts`,
 * which renders straight into `PageRow` label/description/aria-label) and the
 * gate kept reporting clean, meaning "clean where I still look."
 *
 * ## The invariant
 *
 * A guardrail must declare the scope it enumerated, prove that enumeration
 * actually covers the declared scope, and never print a clean verdict naming a
 * scope it did not walk. Three checks, all fail-closed:
 *
 *   1. **Non-empty** — an enumeration that matched nothing is a broken gate
 *      reporting success, not a clean tree.
 *   2. **Covers the tree** — every extension-matching, git-tracked file that
 *      actually exists on disk under a declared root must be in the enumerated
 *      set. This is an INDEPENDENT oracle: the enumeration works by git
 *      pathspec, the oracle by walking the working tree and intersecting with
 *      the tracked set. A pathspec that silently drops files fails here.
 *   3. **Covers a pinned inventory** — a short, checked-in list of paths that
 *      must be in scope. The oracle in (2) is derived from the gate's own
 *      declared roots, so narrowing the roots would narrow the oracle with it;
 *      the pinned inventory is the part that cannot be narrowed silently. It
 *      carries exactly the files these two issues found missing.
 *
 * The success line is then built from what was ACTUALLY enumerated (roots,
 * extensions, per-root counts) rather than from the pathspec string.
 */
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { gitLsFiles } from './ratchet-utils.mjs';

/**
 * The ONE UI tree every gate in this family scans — the shared scope
 * contract (gate-scope.test.ts pins that no gate declares its own).
 *
 * `packages/sdk/src/components` joined when review L found LayoutHeader.tsx
 * rendering a retired noun from OUTSIDE `src-ui`: a gate that scans only one
 * package's tree reports "clean in the places I look". Before that, the two
 * gates each declared their own roots array, equal only by coincidence —
 * either could narrow alone and only the test would notice. Now both import
 * THIS constant, so narrowing is a one-place decision this docblock records.
 */
export const UI_SCAN_ROOTS = ['src-ui/src', 'packages/sdk/src/components'];
export const UI_SCAN_EXTENSIONS = ['.tsx'];

/**
 * Tracked files under `dir`, filtered to `extensions` in JS.
 *
 * Deliberately `git ls-files '<dir>'` (a plain directory pathspec, which git
 * treats as "everything under here") and NOT `'<dir>/**\/*.ext'`: the
 * extension-suffixed recursive form silently excludes files sitting directly
 * in `<dir>` (station#1559). Filtering the extension in JS sidesteps the
 * pathspec-glob ambiguity entirely — the same conclusion
 * `scripts/unsaved-guard-gate.mjs` reached independently.
 */
export function listTrackedFilesUnder(dir, extensions) {
  return gitLsFiles([dir]).filter((file) =>
    extensions.some((ext) => file.endsWith(ext)),
  );
}

/**
 * Every extension-matching file that exists on disk under `dir`, as
 * repo-relative POSIX paths. Walks the working tree with `readdirSync` — a
 * different mechanism from the git pathspec the gates enumerate with, which is
 * what makes it usable as an independent oracle.
 */
export function walkTreeFiles(dir, extensions) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A declared root that does not exist is caught by the non-empty check
      // below with a message naming the root, which is more useful than an
      // ENOENT stack trace here.
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(path.split(sep).join('/'));
      }
    }
  }
  return found;
}

/**
 * Asserts that `files` really covers `roots` × `extensions` plus `pinned`, and
 * throws a message naming the unscanned paths when it does not. Throwing
 * (rather than returning a boolean the caller might forget to read) is
 * deliberate: the failure mode being guarded is a gate that reports clean, so
 * the assertion must be impossible to skip past.
 */
export function assertScopeIsHonest({
  gate,
  roots,
  extensions,
  pinned,
  files,
}) {
  const enumerated = new Set(files);

  if (enumerated.size === 0) {
    throw new Error(
      `${gate}: enumerated 0 files for roots [${roots.join(', ')}] ` +
        `(extensions ${extensions.join(', ')}). An empty scope cannot produce a ` +
        `clean verdict — this is a broken enumeration, not a clean tree.`,
    );
  }

  const missing = [];
  for (const root of roots) {
    const tracked = new Set(gitLsFiles([root]));
    for (const onDisk of walkTreeFiles(root, extensions)) {
      // Untracked / gitignored files are legitimately out of scope: every gate
      // in this family scans tracked content only.
      if (!tracked.has(onDisk)) continue;
      if (!enumerated.has(onDisk)) missing.push(onDisk);
    }
  }

  const missingPinned = (pinned ?? []).filter((file) => !enumerated.has(file));

  if (missing.length === 0 && missingPinned.length === 0) return;

  const lines = [
    `${gate}: SCOPE DRIFT — the enumeration does not cover the scope this gate ` +
      `reports on. A clean verdict here would be a false claim.`,
  ];
  if (missing.length > 0) {
    lines.push(
      `\n  ${missing.length} tracked file(s) under [${roots.join(', ')}] matching ` +
        `[${extensions.join(', ')}] were never enumerated:`,
      ...[...new Set(missing)].sort().map((file) => `    ${file}`),
    );
  }
  if (missingPinned.length > 0) {
    lines.push(
      `\n  ${missingPinned.length} pinned-inventory path(s) are outside the ` +
        `enumerated scope:`,
      ...missingPinned.map((file) => `    ${file}`),
    );
  }
  lines.push(
    '\n  Fix the enumeration (see scripts/lib/gate-scope.mjs — a ' +
      '`dir/**/*.ext` git pathspec silently drops files directly in `dir`), or, ' +
      'if the scope genuinely changed, update the declared roots AND the pinned ' +
      'inventory together so the success line stays true.',
  );
  throw new Error(lines.join('\n'));
}

/**
 * Renders what was actually enumerated, for the gate's success line. Names the
 * concrete roots and per-root counts instead of a pathspec string, so a reader
 * can tell what "OK" covered without reading the script.
 */
export function describeScope({ roots, extensions, files, extraFiles = [] }) {
  const perRoot = roots.map((root) => {
    const count = files.filter(
      (file) => file === root || file.startsWith(`${root}/`),
    ).length;
    return `${root} (${count} ${extensions.join('/')} file${count === 1 ? '' : 's'})`;
  });
  const parts = [...perRoot];
  if (extraFiles.length > 0) parts.push(...extraFiles);
  return parts.join(' + ');
}
