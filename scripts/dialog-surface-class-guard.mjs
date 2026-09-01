#!/usr/bin/env node
// Zero-tolerance gate for #1130 (and the identical shape found beside it,
// #1170's sibling class-of-defect) — a `overlayClassName` or
// `panelClassName` passed DIRECTLY to a `<ResponsiveDialogSurface>` element
// names a class no stylesheet in this scan defines.
//
// A missing class here does not error — `ResponsiveDialogSurface` always
// falls back to its own `.responsive-surface-overlay`/
// `.responsive-surface-panel` (`ResponsiveDialogSurface.tsx`), and the
// overlay one sets no `position` at all. The overlay then renders in normal
// document flow instead of a fixed, centered backdrop, and the panel below —
// which assumes it IS fixed/centered, because every sibling dialog family
// supplies that — overflows the viewport on a phone with no error, no red
// test locally, and a client only sees it at a width nobody develops at.
// `acp-add-dialog__overlay` (#1130, ACPAddConnectionModal.tsx) and
// `conversation-handoff-dialog__overlay` (found by this gate's own sweep,
// ConversationHandoffDialog.tsx) were both this exact shape: a fully-styled
// panel class sitting on an overlay class that had never been given a rule.
//
// Scope is deliberately narrow, in two ways:
//
// 1. Only a class passed straight to `<ResponsiveDialogSurface>` counts. A
//    class passed to `<Dialog>` does NOT — `Dialog.tsx` always prefixes the
//    caller's value with its own real classes
//    (`station-dialog station-dialog--${size}` / `station-dialog__overlay`,
//    both defined in index.css), so the caller's extra class is optional
//    scoping for a modifier or a descendant selector, never the sole source
//    of geometry. Three callers reached exactly that during this gate's
//    write-up — `UsageTelemetryDisclosure.tsx`'s `panelClassName=
//    "usage-telemetry-disclosure"`, `TaskPicker.tsx`'s `"task-picker__dialog"`,
//    `JobFormModal.tsx`'s `"schedule__modal"` — each styled only via a `__x`/
//    `-x` descendant (`.task-picker__dialog-body`, etc.), never the bare
//    token itself, and each is fully positioned regardless by `Dialog`'s own
//    base classes. Flagging those would be exactly the noise the task that
//    added this gate warned against. The owning tag is resolved positionally
//    (the nearest preceding `<ResponsiveDialogSurface`/`<Dialog` open-tag),
//    not by import — see `extractDialogSurfaceClasses`.
// 2. A token inside a template literal that still contains `${` after
//    extraction (a genuinely composed class, e.g. `ConfirmModal.tsx`'s
//    `` `station-dialog--${variant}` ``) is dropped rather than flagged —
//    its final name depends on a runtime value this static scan cannot
//    resolve, and guessing would be noise too.
// 3. A prop VALUE with more than one class is a violation only when NONE of
//    its tokens are defined — not when any single token in it lacks a rule.
//    `SnoozeMenu.tsx`'s `overlayClassName="composer-popover-overlay
//    composer-popover-overlay--start"` pairs a fully-styled base
//    (`.composer-popover-overlay`: `position: fixed; inset: 0; …`,
//    chat.css) with a horizontal-alignment modifier that need not exist on
//    its own. `ComposerModeSheet.tsx`/`ChatDockMobileOverflowSheet.tsx` do
//    the identical thing for `panelClassName` (`"composer-popover-panel
//    composer-mode-sheet"` / `"composer-popover-panel
//    chat-dock__mobile-overflow-panel"` — chat.css's own comment on
//    `.composer-popover-panel` names both as the reason that class became
//    every popover's default opaque surface, archive#992). One token in the
//    value providing real geometry means the surface IS positioned/opaque
//    regardless of whether a sibling modifier token also has a rule —
//    checking every token independently here reintroduced exactly the noise
//    this gate's scope note above says to avoid.
//
// Not "every className in src-ui has a rule" — unenforceable (dynamic/
// composed class names, classes owned by a sibling published package's own
// stylesheet, semantic scoping hooks a component keeps for a modifier it may
// never need, all confirmed present in this repo during the sweep that
// motivated this gate). `overlayClassName`/`panelClassName` passed directly
// to `ResponsiveDialogSurface` is exactly the seam #1130 lived on: the one
// place a missing rule silently degrades to a documented, position-less
// fallback rather than just doing nothing visible.
//
// Follows the established ratchet family (pure exported functions + a
// `main()` behind `import.meta.url === file://process.argv[1]`, `git
// ls-files`-scoped, SCOPE_SENTINELS so a pathspec that stops matching fails
// instead of reporting vacuously green). Modeled directly on
// `random-uuid-guard.mjs`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * `ResponsiveDialogSurface`/`Dialog` and every consumer of them live under
 * `src-ui/src` — no `packages/connect` component ever imports either (that
 * package's own dialogs are hand-rolled with their own `station-connect-*`
 * classes, confirmed styled). Restated at the file's tail via
 * SCOPE_SENTINELS.
 */
export const SCAN_PATHSPECS = ['src-ui/src'];

/**
 * `(file, className)` pairs exempt because the defining stylesheet is
 * genuinely outside this scan, not because the class is unstyled.
 */
export const EXEMPT = [
  {
    file: 'src-ui/src/workspace-panes/ConnectedStationBasisPane.tsx',
    className: 'station-basis-pane__inspector',
    reason:
      "defined in @kontourai/station-basis-pane's own station-basis-pane.css " +
      '— a published sibling workspace package this repo consumes, not one ' +
      'whose source this repo vendors under src-ui/src.',
  },
];

/**
 * Files with a DIRECT `<ResponsiveDialogSurface>` `overlayClassName`/
 * `panelClassName` when this gate was written, covering a plain literal, a
 * multi-class string (`SnoozeMenu.tsx`), and — deliberately — `Dialog.tsx`
 * itself, whose own internal `<ResponsiveDialogSurface>` call is where
 * `station-dialog__overlay`/`station-dialog` genuinely are the direct props
 * (every `<Dialog>` CALLER is out of scope; the wrapper's own definition is
 * not). If a pathspec change drops one out of scope the gate fails rather
 * than reporting green over a smaller tree (station#1559 class).
 */
export const SCOPE_SENTINELS = [
  'src-ui/src/components/acp-connections/ACPAddConnectionModal.tsx',
  'src-ui/src/components/chat-dock/ConversationHandoffDialog.tsx',
  'src-ui/src/components/Dialog.tsx',
  'src-ui/src/components/home/SnoozeMenu.tsx',
];

/**
 * Matches `overlayClassName`/`panelClassName` set to a plain string literal
 * OR a template literal (optionally followed by `.trim()`, `Dialog.tsx`'s
 * own shape). Anything else — a bare identifier, a member expression, a
 * function call with no template (`FolderBrowserModal.tsx`'s
 * `overlayClassName={cx.overlay}`) — does not match and is silently
 * skipped: it is not statically resolvable here, and that is a deliberate
 * scope boundary, not an oversight (module docblock).
 */
const CLASS_PROP =
  /\b(overlayClassName|panelClassName)\s*=\s*(?:"([^"]*)"|\{\s*`([^`]*)`\s*(?:\.trim\(\))?\s*\})/g;

/** The two JSX tags whose direct props this gate cares about — see the
 * module docblock for why a `<Dialog>` caller is excluded. */
const OWNER_TAG = /<(ResponsiveDialogSurface|Dialog)\b/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listScannedSourceFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .filter((line) => line.endsWith('.tsx'))
    .filter((line) => !line.includes('__tests__'));
}

export function listScannedStyleFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output.split('\n').filter((line) => line.endsWith('.css'));
}

/**
 * Every DIRECT `<ResponsiveDialogSurface>` `overlayClassName`/
 * `panelClassName` occurrence in this source, as `{ prop, tokens }` — tokens
 * in the ORIGINAL order of the value, one entry per space-separated class
 * name, grouped per prop occurrence rather than flattened (module docblock,
 * point 3: a value is judged as a whole, not token by token). A token that
 * still contains `${` (a composed class whose suffix is a runtime value) is
 * dropped — see the module docblock, point 2.
 *
 * "Direct" is resolved positionally: for each matched prop, the nearest
 * preceding `<ResponsiveDialogSurface`/`<Dialog` open-tag is its owner. A
 * prop on a `<Dialog>` call is skipped — that wrapper always supplies its
 * own real base classes first, so the caller's extra class is optional
 * scoping, never the sole source of geometry (module docblock, point 1).
 */
export function extractDialogSurfaceClasses(source) {
  const owners = [...source.matchAll(OWNER_TAG)].map((match) => ({
    index: match.index,
    tag: match[1],
  }));
  const ownerAt = (position) => {
    let owner = null;
    for (const candidate of owners) {
      if (candidate.index > position) break;
      owner = candidate.tag;
    }
    return owner;
  };

  const found = [];
  for (const match of source.matchAll(CLASS_PROP)) {
    const [, prop, literal, template] = match;
    if (ownerAt(match.index) !== 'ResponsiveDialogSurface') continue;
    const raw = literal ?? template ?? '';
    const tokens = raw
      .split(/\s+/)
      .filter((token) => token && !token.includes('${'));
    if (tokens.length === 0) continue;
    found.push({ prop, tokens });
  }
  return found;
}

/** Builds a memoized `(token) => boolean` against the concatenated text of
 * every scanned stylesheet. A plain substring/regex check, not a CSS parser
 * — consistent with every other ratchet in this family — so it also matches
 * a class inside a compound selector (`.foo.bar`) or a `:is()`/`:has()`
 * group without needing to understand either. */
/** Strips `/* ... *\/` CSS comments before the text is searched. Without
 * this, a doc comment that merely NAMES a class as an example (this file's
 * own module docblock does exactly that, and so does
 * ConversationHandoff.css's cross-reference to `.acp-add-dialog__overlay`)
 * reads as a definition — caught live during this gate's own fault-injection
 * proof, where deleting the real `.acp-add-dialog__overlay` rule still
 * passed because the sibling file's comment mentioning it verbatim was
 * enough to satisfy the substring check. */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function buildDefinedClassChecker(
  cssFiles,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const text = stripCssComments(cssFiles.map((file) => read(file)).join('\n'));
  const cache = new Map();
  return function isDefined(token) {
    if (cache.has(token)) return cache.get(token);
    const pattern = new RegExp(`\\.${escapeRegExp(token)}(?![A-Za-z0-9_-])`);
    const result = pattern.test(text);
    cache.set(token, result);
    return result;
  };
}

/**
 * A prop occurrence is a violation only when NONE of its tokens are defined
 * (module docblock, point 3) and none are exempted. `exempt` matches on ANY
 * token in the occurrence, so a single-class exemption
 * (`station-basis-pane__inspector`) still clears its one-token value.
 */
export function findUndefinedDialogSurfaceClasses(
  files,
  {
    readSource = (file) => readFileSync(file, 'utf8'),
    isDefined,
    exempt = EXEMPT,
  },
) {
  const violations = [];
  for (const file of files) {
    const source = readSource(file);
    for (const { prop, tokens } of extractDialogSurfaceClasses(source)) {
      if (tokens.some((token) => isDefined(token))) continue;
      const isExempt = tokens.some((token) =>
        exempt.some((entry) => entry.file === file && entry.className === token),
      );
      if (isExempt) continue;
      violations.push({ file, prop, tokens });
    }
  }
  return violations;
}

export function evaluate(violations, sourceFiles) {
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !sourceFiles.includes(sentinel),
  );
  return {
    violations,
    missingSentinels,
    ok: missingSentinels.length === 0 && violations.length === 0,
  };
}

function main() {
  const sourceFiles = listScannedSourceFiles();
  const styleFiles = listScannedStyleFiles();
  const isDefined = buildDefinedClassChecker(styleFiles);
  const violations = findUndefinedDialogSurfaceClasses(sourceFiles, {
    isDefined,
  });
  const result = evaluate(violations, sourceFiles);

  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: dialog-surface-class guard scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${violations.length} overlayClassName/panelClassName value(s) name a class no stylesheet defines.`,
    );
    console.error(
      'ResponsiveDialogSurface falls back to `.responsive-surface-overlay`',
    );
    console.error(
      'alone, which sets no `position` — the overlay renders in normal flow',
    );
    console.error(
      'instead of a fixed, centered backdrop, and the panel below it',
    );
    console.error(
      'overflows the viewport on a phone with no error and no local repro at',
    );
    console.error('desktop width (#1130, #1170).');
    console.error(
      'Give the class real positioning CSS (see NewProjectModal.css or',
    );
    console.error(
      'Dialog.tsx/index.css\'s `.station-dialog__overlay` for the pattern),',
    );
    console.error(
      'or if it truly needs no rule (its stylesheet lives in a sibling',
    );
    console.error('package this repo does not vendor), add it to EXEMPT in');
    console.error('scripts/dialog-surface-class-guard.mjs with why.');
    for (const violation of violations) {
      console.error(
        `  ${violation.file}: ${violation.prop}="${violation.tokens.join(' ')}"`,
      );
    }
    process.exit(1);
  }
  console.log(
    `OK: 0 undefined overlayClassName/panelClassName classes across ${sourceFiles.length} scanned files.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
