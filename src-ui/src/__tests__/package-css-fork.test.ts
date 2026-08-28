/**
 * @vitest-environment node
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * archive#883 — a package stylesheet and a src-ui stylesheet must not both
 * define the same selector at top level.
 *
 * When a component's CSS lives in `packages/*` but a copy of its rules is
 * forked into a src-ui stylesheet, which copy wins is decided by nothing more
 * than the order the two sheets happen to load — and that order is a property
 * of CHUNKING, not of anything a reviewer reads. archive#883 deferred the SDK barrel
 * out of the entry chunk, which moved `LayoutHeader.css` into a lazily
 * injected sheet and silently inverted TWO such forks: one in `chat.css` (a
 * 16px→8px padding change across every project-layout header) and one in
 * `index.css` (a tokenized transition replaced by `transition: all`, which the
 * motion contract bans but its ratchet cannot see, because that gate only
 * scans `src-ui/src/`).
 *
 * Both were found by inspection, one round apart. This is the mechanical
 * version, so a third fork fails here instead of shipping a restyle.
 *
 * Deliberately TOP-LEVEL only. An app-level override inside an `@media` block
* e.g. index.css raising `.workspace-header__prompt-btn` to a 44px touch
 * target on coarse pointers — is real layering, not a fork: it adds a property
 * the package sheet never sets, and it is meant to sit on top.
 */

const repoRoot = join(__dirname, '..', '..', '..');

/**
 * Walked with `fs` rather than `git ls-files` on purpose: shelling out would
 * make this a `node:child_process` importer, which the vitest resource
 * manifest requires to be classified as process-heavy. This test reads a few
 * dozen small files and has no business holding one of those slots.
 */
function cssFilesUnder(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFilesUnder(full));
    else if (entry.name.endsWith('.css')) out.push(relative(repoRoot, full));
  }
  return out;
}

/** Every `packages/<name>/src` directory that exists. */
function packageSrcDirs(): string[] {
  return readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(repoRoot, 'packages', e.name, 'src'));
}

/** Selectors declared outside any at-rule block. */
function topLevelSelectors(css: string): Set<string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  let depth = 0;
  let buf = '';
  let atRuleDepth = -1;

  for (const ch of withoutComments) {
    if (ch === '{') {
      if (depth === 0) {
        const head = buf.trim();
        if (head.startsWith('@')) {
// Entering an at-rule block; everything inside is layered, not forked.
          atRuleDepth = depth;
        } else {
          for (const sel of head.split(',')) {
            const s = sel.trim().replace(/\s+/g, ' ');
            if (s) out.add(s);
          }
        }
      }
      depth++;
      buf = '';
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === atRuleDepth) atRuleDepth = -1;
      buf = '';
      continue;
    }
    if (depth === 0) buf += ch;
  }
  return out;
}

describe('package CSS is not forked into src-ui stylesheets (station#883)', () => {
  test('no selector is defined at top level in both a package and a src-ui stylesheet', () => {
    const packageSelectors = new Map<string, string>();
    const packageCss = packageSrcDirs().flatMap(cssFilesUnder);
    expect(packageCss.length).toBeGreaterThan(0);
    for (const file of packageCss) {
      for (const sel of topLevelSelectors(
        readFileSync(join(repoRoot, file), 'utf-8'),
      )) {
        if (!packageSelectors.has(sel)) packageSelectors.set(sel, file);
      }
    }
    expect(packageSelectors.size).toBeGreaterThan(0);

    const collisions: string[] = [];
    const appCss = cssFilesUnder(join(repoRoot, 'src-ui', 'src'));
    expect(appCss.length).toBeGreaterThan(0);
    for (const file of appCss) {
      for (const sel of topLevelSelectors(
        readFileSync(join(repoRoot, file), 'utf-8'),
      )) {
        const owner = packageSelectors.get(sel);
        if (owner) collisions.push(`${sel}\n    ${owner}\n    ${file}`);
      }
    }

    expect(
      collisions,
      `A package stylesheet owns these selectors and a src-ui stylesheet ` +
        `redefines them at top level. Which one wins depends on chunk load ` +
        `order, so a change to lazy-loading can silently restyle the app ` +
        `(station#883). Delete the src-ui copy and move any values it was ` +
        `winning with into the package's own stylesheet, next to the ` +
        `component that renders the markup:\n\n${collisions.join('\n\n')}\n`,
    ).toEqual([]);
  });
});
