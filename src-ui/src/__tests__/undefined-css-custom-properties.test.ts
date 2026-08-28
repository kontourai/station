import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * `var(--token)` with no fallback, where `--token` is defined nowhere, is
 * **invalid at computed-value time**. It parses, the bundle builds, biome and
 * tsc stay green, and the declaration simply never applies: `color` falls back
 * to `inherit` and `background-color` to `transparent`.
 *
 * That has now shipped three times in the same component family:
 *
 * - **archive#1125/archive#1167** — the danger red used as a fill under white text.
 * - **archive#1168** — `--error-primary` / `--error-secondary`, referenced in
*   eight places and defined in none. Eight error indicators, including the
*   badge that says a tool call was DENIED, rendered as ordinary body copy.
 * - **archive#1246** — `--success-primary` / `--success-secondary`, the exact
 * mirror, *one CSS rule above* the rule archive#1168 fixed. It survived because
 * archive#1168's search was scoped to the `--error-` prefix. The same sweep found
*   `--color-bg-tertiary` two rules further up, which is why the "Auto-approved"
*   chip had no fill either.
 *
 * Contrast assertions cannot see this class of defect on a foreground: an
 * uncoloured error label just inherits body copy and measures beautifully.
 * Only "does this name resolve to anything?" catches it, and only a check that
 * is not scoped to one prefix catches the *next* family.
 *
 * So this is a whole-tree ratchet, in the shape `state-primitives-ratchet.mjs`
 * and `shell-conformance-ratchet.mjs` already use: the set of custom properties
 * that are referenced somewhere the reference cannot possibly resolve is pinned
 * to {@link KNOWN_UNDEFINED}. A new one fails here. Removing one fails here
 * too, so the list cannot rot into a lie.
 *
 * "Cannot possibly resolve" is deliberately not the same as "undefined".
 * `var(--x, #fff)` renders `#fff`, so the surface is styled and the name is
 * only a smell. But `var(--hover-bg, var(--surface-hover))` with **both**
 * undefined is a blank surface again, and scoping the check to
 * no-fallback references alone would miss it — `share-target-picker.css` is
 * written almost entirely against a token vocabulary this app does not have,
 * and it chains undefined onto undefined four times. So a reference counts
 * when its name is undefined **and** its fallback (recursively) is also
 * unresolvable.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** Trees whose `var` references are audited. */
const REFERENCE_ROOTS = ['src-ui/src', 'packages'];

/**
 * Trees that may *define* a custom property. Wider than the reference roots:
 * the server can set one on a served surface too.
 */
const DEFINITION_ROOTS = ['src-ui/src', 'packages', 'src-server'];

/**
 * Console Kit ships the `--k-*` layer this app's own tokens alias, so its
 * stylesheets are a definition source. Deliberately **only** the stylesheets
 * of **only** that package: scanning `node_modules/@kontourai` wholesale
 * picked up `@kontourai/flow-agents`' eval-fixture HTML, which declares
 * `--border` and would have marked a genuinely-undefined token as defined.
 */
const VENDOR_STYLESHEET_ROOTS = ['node_modules/@kontourai/ui'];

const SOURCE_EXTENSIONS = new Set([
  '.css',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.html',
]);

/**
 * Built output is a copy of source; auditing it double-counts and rots.
 * `__tests__` is excluded because nothing in it is a shipped surface — this
 * file's own prose names `var(--token)` as an example, and a scan that counted
 * it would report a defect that does not exist.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__tests__',
]);

function walk(root: string, extensions: Set<string>): string[] {
  const absolute = path.join(REPO_ROOT, root);
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry)) continue;
        visit(full);
        continue;
      }
      if (extensions.has(path.extname(entry))) found.push(full);
    }
  };
  visit(absolute);
  return found;
}

const DEFINITION_PATTERNS = [
/**
* A declaration: `--x: value` in CSS, and the quoted-key form
* `'--x': value` a JSX inline-style object uses (the closing quote sits
* between the name and the colon, which is why the quote is optional here).
*/
  /(?:^|[;{\s,("'`])(--[A-Za-z0-9_-]+)['"`]?\s*:/g,
/** Set imperatively, e.g. the accent picker and the dock height. */
  /(?:setProperty|getPropertyValue|removeProperty)\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g,
/** Registered via the `@property` at-rule. */
  /@property\s+(--[A-Za-z0-9_-]+)/g,
];

interface VarExpression {
  name: string;
/** Everything after the first top-level comma, or `null` when there is none. */
  fallback: string | null;
}

/**
* Every `var` in `text`, with its fallback kept intact.
 *
* A regex cannot do this: a fallback can itself contain `var`, so finding
 * where the expression ends needs paren balancing. Getting that wrong is how
 * `var(--a, var(--b))` reads as "has a fallback, therefore fine" when both
 * names are undefined and the declaration is dropped entirely.
 *
 * Only **top-level** expressions are returned. A nested one is not an
 * independent reference — `var(--accent-primary, var(--border-focus))` is
 * fine whenever `--accent-primary` exists, and reporting the inner name would
 * flag a branch that can never be taken. {@link resolves} descends into the
 * fallback itself, which is where nesting actually matters.
 */
function parseVarExpressions(text: string): VarExpression[] {
  const found: VarExpression[] = [];
  const opener = /var\(/g;
  let match = opener.exec(text);
  while (match) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    let commaAt = -1;
    while (cursor < text.length && depth > 0) {
      const character = text[cursor];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      else if (character === ',' && depth === 1 && commaAt === -1)
        commaAt = cursor;
      cursor += 1;
    }
// An unbalanced expression means the value is wrapped across source lines;
// the caller scans line by line, so this only happens on truncated input
// and the expression is skipped rather than guessed at.
    if (depth === 0) {
      const end = cursor - 1;
      const name = (
        commaAt === -1
          ? text.slice(match.index + match[0].length, end)
          : text.slice(match.index + match[0].length, commaAt)
      ).trim();
      if (/^--[A-Za-z0-9_-]+$/.test(name)) {
        found.push({
          name,
          fallback: commaAt === -1 ? null : text.slice(commaAt + 1, end).trim(),
        });
      }
// Resume after the whole expression so its own fallback's `var`s are
// not re-reported as top-level references.
      opener.lastIndex = cursor;
    } else {
      opener.lastIndex = match.index + match[0].length;
    }
    match = opener.exec(text);
  }
  return found;
}

/**
* Whether a `var` can produce a value: either its name is defined, or its
* fallback can. A fallback with no `var` in it is a literal and always can.
 */
function resolves(expression: VarExpression, defined: Set<string>): boolean {
  if (defined.has(expression.name)) return true;
  if (expression.fallback === null) return false;
  const nested = parseVarExpressions(expression.fallback);
  if (nested.length === 0) return expression.fallback.length > 0;
  return nested.every((inner) => resolves(inner, defined));
}

function collectDefinitions(): Set<string> {
  const defined = new Set<string>();
  const files = [
    ...DEFINITION_ROOTS.flatMap((root) => walk(root, SOURCE_EXTENSIONS)),
    ...VENDOR_STYLESHEET_ROOTS.flatMap((root) => walk(root, new Set(['.css']))),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of DEFINITION_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match) {
        defined.add(match[1]);
        match = pattern.exec(text);
      }
    }
  }
  return defined;
}

interface Reference {
  name: string;
  site: string;
}

/**
* Every `var` reference in the audited trees, one entry per occurrence,
 * carrying enough source position to name the offender in a failure.
 */
function collectReferences(): Array<Reference & { expression: VarExpression }> {
  const references: Array<Reference & { expression: VarExpression }> = [];
  for (const root of REFERENCE_ROOTS) {
    for (const file of walk(root, SOURCE_EXTENSIONS)) {
      const relative = path.relative(REPO_ROOT, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const expression of parseVarExpressions(line)) {
            references.push({
              name: expression.name,
              site: `${relative}:${index + 1}`,
              expression,
            });
          }
        });
    }
  }
  return references;
}

/**
 * Every custom property whose reference cannot resolve. Each entry is a
 * surface that is *not* rendering what its author wrote — this list is a
 * backlog, not an approval.
 *
 * **It is empty, and that is the point.** archive#1246's sweep opened it with
 * 24 names across eight surfaces; archive#1254 closed all 24, one owning
 * surface per commit, and each of those commits shrank this array. There is
* now no `var` anywhere in `src-ui` or `packages` that cannot produce a
 * value.
 *
 * Adding a name here is a deliberate act: it says "this surface is knowingly
 * unstyled", and it should be a rare and argued one now that the backlog is
 * clear. Fixing one means deleting its entry, and the test enforces that in
 * both directions.
 *
 * **A retired token can come back.** While this branch was open, `main`
 * re-seeded `--border-subtle` — the exact token archive#1254 retired — into
 * five new sites: archive#1359 added four (`ConnectionsHubPage.css`,
 * `SettingsView.css`, and two in `KeyboardShortcutsSection.css`) and
 * archive#1423/archive#1492 added a fifth (`AnswerSharesSection.css`, written as
 * `var(--border-subtle, var(--border))` — an undefined token chained onto
 * another undefined token, which is precisely the paren-balanced case the
 * parser above was rewritten to catch). All five were converted to
 * `--border-primary` at merge. The lesson is that this gate is a live ratchet,
 * not a one-time sweep: a token name outlives its definition in muscle memory,
 * so the fix for a re-seeded name is to point it at the real ramp
 * (`--border-primary` subtle, `--border-secondary` strong), never to re-add it
 * to the array above.
 */
const KNOWN_UNDEFINED: string[] = [];

/**
 * The sibling class the ratchet above deliberately cannot see: a reference
 * whose **name** is undefined but whose fallback is a **colour literal**.
 *
 * `var(--color-warning, #f59e0b)` paints. Nothing is missing, nothing is
 * unstyled, and {@link KNOWN_UNDEFINED} is silent by design — the docblock
 * above calls it "only a smell". archive#3050 is what that smell costs when it
 * is left alone: `--color-warning` was defined in no theme root, so five
 * stylesheets rendered a **hardcoded** amber. It could not flip with the
 * theme, and it had never been contrast-measured — the literal `#f59e0b` is
 * ~2.2:1 on a light surface, and `.settings__field-warning` renders it at
 * 11px. Every one of those sites read as a themed token at the call site and
 * behaved like a magic number.
 *
 * So this is the same ratchet shape applied one step earlier: not "does this
 * render?" but "is this name real, or is the literal doing all the work?".
 *
 * **Scoped to colour on purpose.** The same shape with a non-colour fallback
 * (`var(--sticky-header-height, 48px)`, `var(--z-modal, 1000)`) is a smell too,
 * but it has no theme and no contrast requirement, and the tree carries ~35 of
 * them — sweeping those in would bury the colour defects this exists to catch
 * under a backlog with a different remedy. {@link isColourLiteral} draws the
 * line, and {@link KNOWN_UNDEFINED} still covers every name whose reference
 * cannot paint at all, colour or not.
 *
 * The list is a backlog, not an approval — 22 names that each render a fixed
 * pigment in both themes today. It was opened by this gate rather than by a
 * sweep, so nothing on it has been triaged. archive#3050 cleared the names it
 * was filed for and pinned the rest so they stay visible and cannot grow:
 *
 * - `--color-warning` — five stylesheets, now `--warning-text`.
 * - `--color-success` — two rules in `CodingLayout.css`, now `--success-text`.
*   One is the runtime dot directly below a `--color-warning` rule; the other
*   was also the LABEL over an 18% tint of itself, so it took the self-tint
*   recipe its own sibling rule had already settled on. Stopping at the first
*   would have repeated archive#1246 precisely — that defect shipped because
*   archive#1168's search was prefix-scoped and stopped one rule short.
 * - `--color-bg-tertiary` — the token archive#1246 explicitly retired, re-seeded
*   behind a translucent-white fallback. Now `--bg-tertiary`.
 *
 * Note what the list is NOT: `--color-bg`, `--color-text`, `--color-border`,
 * `--color-primary`, `--color-error` and three siblings ARE defined, as a
 * semantic alias layer over the `--bg-*`/`--text-*` ramp in both theme roots.
 * That layer is why `--color-warning` looked plausible at every call site: it
 * is a real family with a real hole in it. Filling the hole was the considered
 * alternative and would render identically (`--color-error` is just
 * `var(--error-text)`), but it adds a second name for one colour, so the
 * references were pointed at the real foreground tokens instead. The same
 * family's last two holes (`--color-surface-muted`, `--color-text-muted`) were
 * in `MCPToolUIFrame.css` and went with archive#3177 — that panel wrote
 * theme-aware text on a card those names pinned light, 1.07:1 in dark.
 *
 * Adding a name is a deliberate act. The fix is to point the reference at a
 * token that exists and delete the fallback with it — removal is enforced in
 * both directions, exactly like the list above.
 */
const UNTHEMED_FALLBACK: string[] = [
  '--accent',
  '--accent-danger',
  '--accent-primary-alpha',
  '--background',
  '--bg-subtle',
  '--border',
  '--border-color',
  '--border-subtle',
  '--color-danger',
  '--color-negative',
  '--overlay-scrim',
  '--status-success',
  '--status-warning',
  '--success',
  '--surface-hover',
  '--surface-raised',
  '--warning',
  '--warning-color',
];

/**
 * Whether a fallback is a colour, and therefore theme- and contrast-bearing.
 *
* Conservative by construction: hex and the `rgb`/`hsl` function forms are
 * what this codebase actually writes, and a fallback that is a bare keyword
 * (`transparent`, `currentColor`) carries no fixed pigment to go stale.
 * Anything unrecognised is treated as not-a-colour, so the gate under-reports
 * rather than inventing failures on `48px`.
 */
function isColourLiteral(fallback: string): boolean {
  return /(^|[\s,(])#[0-9a-fA-F]{3,8}\b|(^|[\s,(])(rgba?|hsla?)\(/.test(
    fallback,
  );
}

describe('custom properties that no var() reference can resolve', () => {
  const defined = collectDefinitions();
  const references = collectReferences();

  test('the scan actually found the tree (guards against a silent empty walk)', () => {
// A broken root path would make every assertion below vacuously pass.
    expect(references.length).toBeGreaterThan(500);
    expect(defined.size).toBeGreaterThan(100);
    expect(defined.has('--success-text')).toBe(true);
    expect(defined.has('--error-text')).toBe(true);
  });

  test('the declared scope is pinned, so narrowing it is a decision and not a silent edit (epic #1555)', () => {
// The floor above is necessary and not sufficient. `src-ui/src` alone
// contributes far more than 500 references, so dropping `packages` from
// REFERENCE_ROOTS leaves the floor satisfied and this whole suite
// reporting clean over a tree it no longer reads — the same shape as
// archive#1559 (a gate enumerating 523 of 525 files while printing a
// success line naming the scope it did not walk).
//
// The pin has to be an INDEPENDENT statement of what the scope must be.
// Iterating REFERENCE_ROOTS and checking each entry is non-empty cannot
// catch this: delete an entry and the loop simply iterates one fewer
// time, every assertion passing. (Written that way first; the injection
// that removed `packages` came back green, which is what sent it back.)
    expect(REFERENCE_ROOTS).toEqual(['src-ui/src', 'packages']);
    expect(DEFINITION_ROOTS).toEqual(['src-ui/src', 'packages', 'src-server']);
    expect(VENDOR_STYLESHEET_ROOTS).toEqual(['node_modules/@kontourai/ui']);

// Stated rather than implied: `examples/` also contains `var` sites and
// is deliberately NOT audited — the sample workspaces carry their own
// token sets and are not shipped surfaces of this app. Naming it here
// means the next reader knows it is unscanned, instead of assuming the
// roots above cover every `var` in the repository.
  });

  test('EVERY declared root is actually walked, not just enough of them to clear the floor (epic #1555)', () => {
// The complement of the pin: a root that is still declared but has moved,
// been renamed, or stopped being reachable by the walk. The pin cannot see
// that; this can. Both are needed, and neither substitutes for the other.
    for (const root of REFERENCE_ROOTS) {
      const fromRoot = references.filter((reference) =>
        reference.site.startsWith(`${root}/`),
      );
      expect(
        fromRoot.length,
        `REFERENCE_ROOTS declares "${root}" but the walk produced no var() ` +
          'reference from it. Either the root has moved and the declaration is ' +
          'stale, or the walk is not reaching it — both mean this suite is ' +
          'reporting on a smaller tree than it claims.',
      ).toBeGreaterThan(0);
    }

// The definition side matters just as much in the opposite direction: a
// definition root dropping out does not hide references, it invents
// failures — but a VENDOR root dropping out is silent and dangerous,
// because Console Kit ships the `--k-*` layer this app's tokens alias.
    for (const root of [...DEFINITION_ROOTS, ...VENDOR_STYLESHEET_ROOTS]) {
      expect(
        walk(root, SOURCE_EXTENSIONS).length +
          walk(root, new Set(['.css'])).length,
        `"${root}" is declared as a definition source but contains no scannable file.`,
      ).toBeGreaterThan(0);
    }
  });

  test('the parser reads a nested fallback rather than trusting the comma', () => {
// The inert-test hazard for this file is a parser that stops at the first
// `)`: `var(--a, var(--b))` would then look fallback-less, or — worse, in
// the version this replaced — the outer comma alone would mark it
// resolved. Pin the shape, the top-level-only rule, and the sibling case.
    expect(parseVarExpressions('color: var(--a, var(--b));')).toEqual([
      { name: '--a', fallback: 'var(--b)' },
    ]);
    expect(parseVarExpressions('border: 1px solid var(--a) var(--c);')).toEqual(
      [
        { name: '--a', fallback: null },
        { name: '--c', fallback: null },
      ],
    );
    const known = new Set(['--b']);
    expect(resolves({ name: '--a', fallback: 'var(--b)' }, known)).toBe(true);
    expect(resolves({ name: '--a', fallback: 'var(--c)' }, known)).toBe(false);
    expect(resolves({ name: '--a', fallback: '#fff' }, known)).toBe(true);
    expect(resolves({ name: '--a', fallback: null }, known)).toBe(false);
  });

  test('no new unresolvable custom-property reference has appeared', () => {
    const undefinedNames = new Map<string, string[]>();
    for (const reference of references) {
      if (resolves(reference.expression, defined)) continue;
      const sites = undefinedNames.get(reference.name) ?? [];
      sites.push(reference.site);
      undefinedNames.set(reference.name, sites);
    }

    const found = [...undefinedNames.keys()].sort();
    const introduced = found.filter((name) => !KNOWN_UNDEFINED.includes(name));
    const fixed = KNOWN_UNDEFINED.filter((name) => !found.includes(name));

    expect(
      introduced.map((name) => `${name} @ ${undefinedNames.get(name)?.[0]}`),
      'a var() naming an undefined custom property renders nothing at all (station#1168, station#1246) — define the token, or use one that exists',
    ).toEqual([]);
    expect(
      fixed,
      'these are defined now — remove them from KNOWN_UNDEFINED so the list keeps meaning something',
    ).toEqual([]);
  });

  test('no new reference leans on a literal fallback instead of a real token (station#3050)', () => {
    const leaning = new Map<string, string[]>();
    for (const reference of references) {
      if (defined.has(reference.name)) continue;
// Only the ones that DO paint. The ones that do not are the assertion
// above's business, and double-reporting them would make a single defect
// fail two tests with two different remedies.
      if (!resolves(reference.expression, defined)) continue;
      if (
        reference.expression.fallback === null ||
        !isColourLiteral(reference.expression.fallback)
      )
        continue;
      const sites = leaning.get(reference.name) ?? [];
      sites.push(reference.site);
      leaning.set(reference.name, sites);
    }

    const found = [...leaning.keys()].sort();
    const introduced = found.filter(
      (name) => !UNTHEMED_FALLBACK.includes(name),
    );
    const fixed = UNTHEMED_FALLBACK.filter((name) => !found.includes(name));

    expect(
      introduced.map((name) => `${name} @ ${leaning.get(name)?.[0]}`),
      'this name is defined in no theme root, so every use renders its hardcoded fallback — unthemed, and unmeasured for contrast (station#3050). Point it at a token that exists and drop the fallback.',
    ).toEqual([]);
    expect(
      fixed,
      'these no longer lean on a fallback — remove them from UNTHEMED_FALLBACK so the list keeps meaning something',
    ).toEqual([]);
  });

  test('the token families that have already shipped this defect stay defined', () => {
// Named explicitly so a regression reads as itself rather than as a
// one-line diff in the list above.
    for (const token of [
      '--error-text',
      '--error-bg',
      '--error-fill',
      '--error-border',
      '--success-text',
      '--success-bg',
      '--success-border',
      '--bg-tertiary',
// archive#3050: five stylesheets now reference this with no fallback, so
// deleting it would drop their declarations entirely rather than quietly
// reverting them to a literal.
      '--warning-text',
// archive#3140: the engine chip's fill and its text rung.
      '--text-tertiary',
    ]) {
      expect(defined.has(token), `${token} must be defined`).toBe(true);
    }
  });

  test('Task outputs use the semantic text and border token families', () => {
    const taskWorkspaceStyles = readFileSync(
      path.join(REPO_ROOT, 'src-ui/src/views/TaskWorkspaceView.css'),
      'utf8',
    );

    expect(taskWorkspaceStyles).toContain('color: var(--success-text);');
    expect(taskWorkspaceStyles).toContain(
      'border-color: var(--success-border);',
    );
    expect(taskWorkspaceStyles).toContain('border-color: var(--error-border);');
    expect(taskWorkspaceStyles).not.toContain('var(--success,');
    expect(taskWorkspaceStyles).not.toContain('var(--danger,');
  });
});
