#!/usr/bin/env node
// Regression gate for the shell contract in docs/design/shell-skeletons.md: one page header,
// rendered by one component, for every route that has one. Follows
// `scripts/state-primitives-ratchet.mjs`'s established architecture (pure exported functions;
// `main()` gated behind `import.meta.url === file://process.argv[1]`; checked-in numeric ceilings
// that must only decrease; reasoned, staleness-checked exception lists) and carries two counted
// signals.
//
// ---------------------------------------------------------------------------
// First counted signal: bespoke page headers (SHELL-17, station UX audit lane C1)
// ---------------------------------------------------------------------------
//
// WHAT CHANGED AND WHY. This signal used to classify the ROOT WRAPPER of six named view files
// (`TRACKED_VIEWS`) as "renders <SplitPaneLayout>" or "root className carries the `page` token".
// The UX audit measured the app that gate was green over and found six page-title sizes, nine
// title x-positions and four content widths across 28 routes, because a `page`-rooted wrapper says
// nothing about the header inside it — and because a fixed six-file list cannot see a seventh
// view. The script's own header disclosed that second gap ("a brand-new *seventh* bespoke view …
// has no automated coverage").
//
// Both halves are addressed by moving the header OUT of the views: `components/page-frame`
// renders it, `app-shell/page-frame-registry.ts` decides which routes get one (a `Record` over
// `NavigationView['type']`, so a new route without a decision is a type error), and a view's root
// wrapper is no longer load-bearing. What is left to enforce is the thing a view can still get
// wrong: writing a page header of its own.
//
// Signal: over EVERY git-tracked `.tsx` under `src-ui/src/views/**` and `src-ui/src/pages/**` — a
// glob, not a named list — a file is BESPOKE when its source contains any of
//   (i)   a canonical page-header class token written by hand (`page__header`, `page__title`,
//         `page__label`), which only `PageFrame` may render;
//   (ii)  a page-level `<h1>`, which is the frame's to render; or
//   (iii) a HEADER BLOCK carrying a page-level heading — an element whose class names a
//         `*__header`/`*-header` family, or a `<header>` element, containing an `<h1>` or `<h2>`.
// `BESPOKE_HEADER_EXCEPTIONS` below names every file allowed to do so, each with the reason. The
// ceiling (`scripts/shell-conformance-baseline.json`'s `bespokeHeaderCeiling`) counts everything
// else and is recorded at 0.
//
// WHY (iii) EXISTS. Signals (i) and (ii) only recognise a bespoke header written in the canonical
// vocabulary. Ordinary markup in a vocabulary of its own —
//
//     <header className="tools-view__header"><h2>Tools</h2></header>
//
// — is exactly the shape that produced six title sizes and nine title x-positions across 28
// routes, and it passed this gate at ceiling zero. The signal that catches it has to be about
// STRUCTURE, not about which class names someone happened to reuse. `<h1>`/`<h2>` is the
// discriminating level: `docs/design/shell-skeletons.md` §2.1 already prescribes `<h3>` for an
// item title in a detail pane and for a section heading under a page title, so a header block
// that reaches for a page-level heading is claiming to name the screen.
//
// Known, accepted heuristic limitations:
//   - The scan is textual, so a token inside a comment or string literal counts. That fails
//     CLOSED (a visible gate failure a human resolves, never a silent pass). The same is true of
//     (iii)'s element walk: an unbalanced tag makes it scan to end-of-file rather than give up.
//   - The class-token pattern in (i) exempts exactly one prefixed family, `project-page__header`
//     — the project workspace's own class, a documented `null` in the frame registry. It used to
//     exempt EVERY `*-page__header`, which would have let a new `tools-page__header` through a
//     rule about `page__header`. Both halves of that boundary are pinned by tests.
//   - (iii) counts `<h1>`/`<h2>`, not `<h3>`. Including `<h3>` was measured against this repo and
//     matched 16 files — card headers, dialog headers and section headers whose `<h3>` is the
//     level the shell rule PRESCRIBES. An exception list that long is a rubber stamp, and the
//     gate would then be teaching the opposite of the rule.
//   - A page-level `<h2>` written with no header element and no header class around it (a card's
//     own heading, a settings section's hero) is NOT counted here. Where such a file also renders
//     `<SplitPaneLayout>`/`<DetailHeader>`, the stacked-heading signal below counts it at ceiling
//     zero; where it does not, review remains the backstop, as it is for every gate in this
//     family. The claim this gate makes is therefore: a view cannot introduce a page HEADER —
//     canonical markup, a bare `<h1>`, or a header block titled at page level — without either
//     failing or being named in the exception list with a reason.
//   - Co-located `__tests__` files under the roots are IN scope, deliberately: header markup in a
//     fixture is header markup waiting to be copied into a view, and narrowing the enumeration is
//     the exact move `assertScopeIsHonest` exists to refuse. A test that needs to assert a view
//     renders no header uses the exported `PAGE_HEADER_CLASS` constant instead of the literal.
//   - The exception list is checked for staleness in both directions: an exception naming a file
//     that no longer has a bespoke header fails the gate, so the list cannot outlive its reason,
//     and an exception naming a file that has left the scope fails too.
//

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertScopeIsHonest,
  describeScope,
  listTrackedFilesUnder,
} from './lib/gate-scope.mjs';

// ---------------------------------------------------------------------------
// Bespoke page headers (first signal)
// ---------------------------------------------------------------------------

/** The two directories every route view and page lives in. */
export const HEADER_SCAN_ROOTS = ['src-ui/src/views', 'src-ui/src/pages'];
export const HEADER_SCAN_EXTENSIONS = ['.tsx'];

/**
 * Paths that must be inside the enumerated scope. The tree-walk oracle in
 * `assertScopeIsHonest` derives from the roots above, so narrowing the roots narrows the oracle
 * with it; this pinned list is the part that cannot be narrowed silently. It names one framed
 * split-pane route, one framed page route, one `pages/` route (the directory a `views`-only glob
 * would drop) and one nested view (the depth a non-recursive walk would drop).
 */
export const HEADER_PINNED_SCOPE_INVENTORY = [
  'src-ui/src/views/AgentsView.tsx',
  'src-ui/src/views/ScheduleView.tsx',
  'src-ui/src/pages/NotificationsPage.tsx',
  'src-ui/src/views/home/HomeSurface.tsx',
];

/**
 * Files allowed to render a page-level heading of their own, and why. Each entry is a decision
 * about a surface, not a suppression: the frame registry records the same decision as a `null`
 * spec for that route, so the two cannot drift without one of them failing.
 */
export const BESPOKE_HEADER_EXCEPTIONS = new Map([
  [
    'src-ui/src/views/home/HomeSurface.tsx',
    'Home\'s H1 is a prompt ("What do you want to work on?"), not a page name. ' +
      '`page-frame-registry.ts` records the matching decision: home => null.',
  ],
  [
    'src-ui/src/views/share/SharedAnswerView.tsx',
    'The shared-answer route renders outside the app shell (no sidebar, no frame) for a reader ' +
      'who may not have a Station at all, so it owns its own document title.',
  ],
  [
    'src-ui/src/views/project-page/ProjectPageHeader.tsx',
    "The project workspace's own identity row (avatar, name, path) IS the content of that " +
      'surface, and it is titled at page level on purpose. `page-frame-registry.ts` records the ' +
      'matching decision: project => null.',
  ],
]);

/**
 * The canonical page-header classes, and the one prefixed family that is NOT them.
 *
 * `project-page__header` is the project workspace's own class (its `null` in the frame registry
 * is the matching decision). The lazy prefix group is what keeps that exemption to that ONE
 * family: an exemption written as "anything ending in `page__header`" would silently pass a
 * brand-new `tools-page__header`, which is the same bespoke header under a different word.
 */
const CANONICAL_HEADER_CLASS =
  /(?<![\w-])([\w-]*?)page__(?:header|title|label)(?![\w-])/g;
const CANONICAL_CLASS_EXEMPT_PREFIX = 'project-';

function hasCanonicalHeaderClass(content) {
  CANONICAL_HEADER_CLASS.lastIndex = 0;
  let match = CANONICAL_HEADER_CLASS.exec(content);
  while (match) {
    if (match[1] !== CANONICAL_CLASS_EXEMPT_PREFIX) return true;
    match = CANONICAL_HEADER_CLASS.exec(content);
  }
  return false;
}

/** A class token naming a header family — `x__header`, `x-header`, or plain `header`. */
const HEADER_FAMILY_CLASS = /(?<![\w-])[\w-]*(?:__header|-header)(?![\w-])/;

/** The heading levels that claim to name a screen. `<h3>` is the level the shell rule prescribes. */
const PAGE_LEVEL_HEADING = /<h[12][\s/>]/;

/**
 * Reads one JSX opening tag starting at `start` (which must point at its `<`).
 *
 * Attributes are walked character by character rather than matched with `[^>]*`, because a
 * `className={`x${n > 0 ? 'a' : 'b'}`}` contains a `>` that is not the end of the tag — a naive
 * pattern ends the tag early and then reads the rest of the expression as markup.
 */
function readOpeningTag(content, start) {
  const name = /^<([A-Za-z][\w.:-]*)/.exec(content.slice(start, start + 128));
  if (!name) return null;
  let index = start + name[0].length;
  let quote = null;
  let braces = 0;
  while (index < content.length) {
    const char = content[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      braces += 1;
    } else if (char === '}') {
      braces -= 1;
    } else if (char === '>' && braces === 0) {
      return {
        name: name[1],
        attributes: content.slice(start + name[0].length, index),
        end: index + 1,
        selfClosing: content[index - 1] === '/',
      };
    }
    index += 1;
  }
  return null;
}

/**
 * Everything between `tag`'s `>` and its matching close tag.
 *
 * On unbalanced markup it returns the rest of the file rather than nothing, so a parse it cannot
 * follow over-reports rather than under-reports — the same fail-closed direction as the rest of
 * this gate.
 */
function elementContents(content, tag) {
  if (tag.selfClosing) return '';
  let depth = 1;
  let index = tag.end;
  while (index < content.length) {
    const next = content.indexOf('<', index);
    if (next < 0) break;
    if (content.startsWith(`</${tag.name}`, next)) {
      depth -= 1;
      if (depth === 0) return content.slice(tag.end, next);
      index = next + 2;
      continue;
    }
    if (
      content.startsWith(`<${tag.name}`, next) &&
      !/[\w.:-]/.test(content[next + 1 + tag.name.length] ?? '')
    ) {
      const nested = readOpeningTag(content, next);
      if (nested && !nested.selfClosing) depth += 1;
      index = nested ? nested.end : next + 1;
      continue;
    }
    index = next + 1;
  }
  return content.slice(tag.end);
}

/**
 * Every header block in `content` that carries a page-level heading, named by the class (or tag)
 * that made it a header block. This is signal (iii) — see the file header for why it exists.
 */
export function findPageHeaderBlocks(content) {
  const found = [];
  const openings = /<[A-Za-z]/g;
  let match = openings.exec(content);
  while (match) {
    const tag = readOpeningTag(content, match.index);
    openings.lastIndex = match.index + 1;
    if (tag) {
      const headerClass = HEADER_FAMILY_CLASS.exec(tag.attributes);
      if (
        (headerClass || tag.name === 'header') &&
        PAGE_LEVEL_HEADING.test(elementContents(content, tag))
      ) {
        found.push(headerClass ? headerClass[0] : '<header>');
      }
    }
    match = openings.exec(content);
  }
  return [...new Set(found)];
}

const BESPOKE_HEADER_PATTERNS = [
  {
    label: 'canonical page-header class written by hand',
    test: hasCanonicalHeaderClass,
  },
  {
    label: 'page-level <h1>',
    test: (content) => /<h1[\s/>]/.test(content),
  },
  {
    label: 'header block with a page-level heading',
    test: (content) => findPageHeaderBlocks(content).length > 0,
  },
];

/** Every bespoke-header marker in one file's source. Empty for a conformant file. */
export function findBespokeHeaderSignals(content) {
  return BESPOKE_HEADER_PATTERNS.filter(({ test }) => test(content)).map(
    ({ label }) => label,
  );
}

/**
 * Scans `files`, returning the bespoke set (excluding excepted files), the excepted files that
 * actually still carry a marker, and the stale exceptions — an exception whose file no longer has
 * a bespoke header, which must be removed rather than left to excuse a future one.
 */
export function scanBespokeHeaders(files, readFile, exceptions) {
  const bespoke = [];
  const excepted = [];
  const fileSet = new Set(files);
  for (const file of files) {
    const signals = findBespokeHeaderSignals(readFile(file));
    if (signals.length === 0) continue;
    if (exceptions.has(file)) excepted.push({ file, signals });
    else bespoke.push({ file, signals });
  }
  const staleExceptions = [...exceptions.keys()].filter(
    (file) =>
      !excepted.some((entry) => entry.file === file) && fileSet.has(file),
  );
  const missingExceptions = [...exceptions.keys()].filter(
    (file) => !fileSet.has(file),
  );
  bespoke.sort((a, b) => a.file.localeCompare(b.file));
  return { bespoke, excepted, staleExceptions, missingExceptions };
}

export function listTrackedHeaderScanFiles() {
  return HEADER_SCAN_ROOTS.flatMap((root) =>
    listTrackedFilesUnder(root, HEADER_SCAN_EXTENSIONS),
  );
}

// ---------------------------------------------------------------------------
// Stacked-heading count (station#2931 — see the file header's second signal)
// ---------------------------------------------------------------------------

/** The scope the stacked-heading signal reports on, declared once and used for the success line. */
export const HEADING_SCAN_ROOTS = ['src-ui/src'];
export const HEADING_SCAN_EXTENSIONS = ['.tsx'];

/**
 * Paths that must be inside the enumerated scope. The tree-walk oracle in `assertScopeIsHonest` is
 * derived from `HEADING_SCAN_ROOTS`, so narrowing the roots would narrow the oracle with it; this
 * pinned list is the part that cannot be narrowed silently. It names the two files this signal was
 * built from — the only two that carried the defect station#2931 fixed.
 */
export const HEADING_PINNED_SCOPE_INVENTORY = [
  'src-ui/src/views/ReviewQueueView.tsx',
  'src-ui/src/views/TaskWorkspaceView.tsx',
];

/** A file already renders a canonical header (`DetailHeader`) or the list+detail shell. */
const CANONICAL_HEADER_PATTERN = /<(?:DetailHeader|SplitPaneLayout)\b/;

/** Page-level heading elements — the level the canonical header already occupies. */
const PAGE_LEVEL_HEADING_PATTERN = /<h[12]\b/g;

/**
 * True when `content` renders a canonical header, i.e. something in this file already owns the
 * page-level title for the screen it belongs to. Files that do not are out of this signal's scope
 * entirely: an ordinary section component's own `<h2>` is not a stacked heading.
 */
export function isHeadingSurface(content) {
  return CANONICAL_HEADER_PATTERN.test(content);
}

/**
 * Counts page-level headings a heading-surface file writes itself — each one stacked on the
 * page-level title the canonical header in the same file already renders. Returns 0 for any file
 * that is not a heading surface.
 */
export function countStackedHeadings(content) {
  if (!isHeadingSurface(content)) return 0;
  return (content.match(PAGE_LEVEL_HEADING_PATTERN) ?? []).length;
}

/**
 * Scans `files` and returns one `{ file, count }` finding per heading-surface file that writes at
 * least one page-level heading of its own, plus the total the ceiling is compared against.
 */
export function scanStackedHeadings(files, readFile) {
  const findings = [];
  for (const file of files) {
    const count = countStackedHeadings(readFile(file));
    if (count > 0) findings.push({ file, count });
  }
  findings.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return {
    findings,
    total: findings.reduce((sum, finding) => sum + finding.count, 0),
  };
}

export function listTrackedHeadingSurfaceFiles() {
  return listTrackedFilesUnder(HEADING_SCAN_ROOTS[0], HEADING_SCAN_EXTENSIONS);
}

function main() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const baselinePath = `${scriptDir}shell-conformance-baseline.json`;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  console.log(
    'Shell-conformance ratchet (one page header, rendered by one component; no view writes its\n' +
      'own). Both counts must only decrease.\n',
  );

  const readFile = (file) => readFileSync(file, 'utf8');
  const recordMode = process.argv.includes('--record');

  // Fail closed BEFORE counting: a ratchet whose enumeration is short of its declared scope
  // reports "count N <= ceiling" over a tree it never walked (station#1559).
  const headerFiles = listTrackedHeaderScanFiles();
  assertScopeIsHonest({
    gate: 'shell-conformance ratchet (bespoke page headers)',
    roots: HEADER_SCAN_ROOTS,
    extensions: HEADER_SCAN_EXTENSIONS,
    pinned: HEADER_PINNED_SCOPE_INVENTORY,
    files: headerFiles,
  });
  const headerScope = describeScope({
    roots: HEADER_SCAN_ROOTS,
    extensions: HEADER_SCAN_EXTENSIONS,
    files: headerFiles,
  });
  const headers = scanBespokeHeaders(
    headerFiles,
    readFile,
    BESPOKE_HEADER_EXCEPTIONS,
  );
  const headerCeiling = baseline.bespokeHeaderCeiling;

  const headingFiles = listTrackedHeadingSurfaceFiles();
  assertScopeIsHonest({
    gate: 'shell-conformance ratchet (stacked headings)',
    roots: HEADING_SCAN_ROOTS,
    extensions: HEADING_SCAN_EXTENSIONS,
    pinned: HEADING_PINNED_SCOPE_INVENTORY,
    files: headingFiles,
  });
  const headingScope = describeScope({
    roots: HEADING_SCAN_ROOTS,
    extensions: HEADING_SCAN_EXTENSIONS,
    files: headingFiles,
  });
  const stacked = scanStackedHeadings(headingFiles, readFile);
  const stackedCeiling = baseline.stackedHeadingCeiling;

  if (recordMode) {
    console.log(
      `RECORD: bespokeHeaders=${headers.bespoke.length}, ` +
        `excepted=${headers.excepted.length}, stackedHeadings=${stacked.total}.\n`,
    );
    for (const entry of headers.bespoke) {
      console.log(
        `  bespoke header: ${entry.file} (${entry.signals.join(', ')})`,
      );
    }
    for (const finding of stacked.findings) {
      console.log(`  stacked heading(s): ${finding.file} (${finding.count})`);
    }
    process.exit(0);
  }

  let failed = false;

  if (typeof headerCeiling !== 'number') {
    failed = true;
    console.error(
      'FAIL: scripts/shell-conformance-baseline.json has no numeric `bespokeHeaderCeiling`.',
    );
  } else if (headers.bespoke.length > headerCeiling) {
    failed = true;
    console.error(
      `FAIL: bespoke page-header count ${headers.bespoke.length} exceeds the recorded ceiling ` +
        `${headerCeiling} (scripts/shell-conformance-baseline.json's bespokeHeaderCeiling):\n`,
    );
    for (const entry of headers.bespoke) {
      console.error(`  ${entry.file}: ${entry.signals.join(', ')}`);
    }
    console.error(
      '\nThe page header belongs to `components/page-frame`, and which routes get one belongs to' +
        '\n`src-ui/src/app-shell/page-frame-registry.ts`. Give the route a spec there (or publish' +
        '\nits title from the view with `usePageHeader`) instead of writing header markup in the' +
        '\nview. If this surface genuinely owns its own page-level heading, add it to' +
        '\nBESPOKE_HEADER_EXCEPTIONS with the reason — and record the matching `null` in the frame' +
        '\nregistry. See docs/design/shell-skeletons.md §2.2.',
    );
  }

  if (headers.staleExceptions.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${headers.staleExceptions.length} BESPOKE_HEADER_EXCEPTIONS entr(ies) no longer` +
        ' carry a bespoke header:\n',
    );
    for (const file of headers.staleExceptions) console.error(`  ${file}`);
    console.error(
      '\nRemove the exception. An exception that outlives its reason is how the next bespoke' +
        '\nheader gets excused.',
    );
  }

  if (headers.missingExceptions.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${headers.missingExceptions.length} BESPOKE_HEADER_EXCEPTIONS entr(ies) name a file` +
        ' that is not in scope (moved or deleted):\n',
    );
    for (const file of headers.missingExceptions) console.error(`  ${file}`);
  }

  if (typeof stackedCeiling !== 'number') {
    failed = true;
    console.error(
      'FAIL: scripts/shell-conformance-baseline.json has no numeric `stackedHeadingCeiling`.' +
        '\nThe stacked-heading signal cannot report a verdict without its recorded ceiling.',
    );
  } else if (stacked.total > stackedCeiling) {
    failed = true;
    console.error(
      `\nFAIL: stacked page-level heading count ${stacked.total} exceeds the recorded ceiling ` +
        `${stackedCeiling} (scripts/shell-conformance-baseline.json's stackedHeadingCeiling).\n` +
        'A file that renders <DetailHeader> or <SplitPaneLayout> already owns the page-level title\n' +
        'for its screen; a page-level heading (<h1>/<h2>) written beside it stacks a second one on\n' +
        'top. See docs/design/shell-skeletons.md §2.1 for who owns which heading, and use <h3> for\n' +
        'an item title inside a detail pane or for a section heading under a page title.\n',
    );
    for (const finding of stacked.findings) {
      console.error(
        `  ${finding.file}: ${finding.count} page-level heading(s)`,
      );
    }
  }

  if (!failed) {
    console.log(
      `OK: bespoke page-header count ${headers.bespoke.length} <= ceiling ${headerCeiling} ` +
        `(scope: ${headerScope}; ${headers.excepted.length} recorded exception(s)).`,
    );
    for (const entry of headers.excepted) {
      console.log(`  exception: ${entry.file} (${entry.signals.join(', ')})`);
    }
    console.log(
      `OK: stacked page-level heading count ${stacked.total} <= ceiling ${stackedCeiling} ` +
        `(scope: ${headingScope}).`,
    );
    for (const finding of stacked.findings) {
      console.log(`  stacked: ${finding.file} (${finding.count})`);
    }
  }

  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
