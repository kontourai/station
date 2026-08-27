#!/usr/bin/env node
// Regression gate for #192 (state primitives convergence — one Empty/Loading/
// Error family instead of bespoke per-view variants). Follows the established
// rename-inventory.mjs / noun-consistency-gate.mjs / unsaved-guard-gate.mjs
// family (pure exported functions + a `main()` gated behind
// `import.meta.url === file://process.argv[1]`, `git ls-files`-scoped,
// reasoned + staleness-checked exclusion lists), but adds the one new
// ingredient this program needs: a checked-in numeric baseline
// (scripts/state-primitives-baseline.json) that must only decrease — the
// first true "ratchet" gate in this repo (ceilings, not zero-tolerance bans),
// referenced by name in the S5 shaping brief as the template for its own
// inline-style/hex-literal ratchets.
//
// Two independent checks, run together:
//
//   1. Bespoke empty-family count (file-membership style, mirrors
//      unsaved-guard-gate.mjs's editor-membership check more than
//      noun-consistency-gate.mjs's per-match allowlist, because the unit of
//      migration here is "a view converts its bespoke markup," not "a single
//      string changes"): scans every tracked `.tsx` file under src-ui/src (see
//      SCAN_ROOTS and the scope assertion below — station#1559), reading its
//      `className` values (plain string, template-literal, and
//      JSX-expression-string forms) for a live `*__empty` class. Two
//      staleness-checked exclusion lists answer two different questions:
//        - ALREADY_CANONICAL_EXCLUSIONS: this file's `__empty*` classes are
//          layout-hook CSS around an already-Console-Kit-`Empty`-composing
//          view, not a bespoke duplicate — subtracted from the count
//          entirely.
//        - S4_DEFERRED_EXCLUSIONS: this file's bespoke markup is real but
//          deliberately not migrated yet — counted, but named so that any
//          live match outside the list is an untriaged regression. The list
//          is EMPTY today; an entry is an escape hatch that must name a live
//          issue to remove it (see the list's own comment).
//      Both lists fail the gate if an entry no longer matches any live
//      finding (stale — either the file was migrated and the entry should be
//      removed, or the file no longer exists).
//
//   2. Ad-hoc "No X" string count (per-occurrence, noun-consistency-gate.mjs
//      style, because the unit of regression here is "someone typed a new
//      bespoke 'No X' string," which can happen inside an already-migrated
//      file): scans JSX text nodes matching `>No X<` (single-line only — see
//      Known limitation below) and known UI-copy attribute values (reusing
//      noun-consistency-gate.mjs's ATTR_NAMES list) matching `/^No [A-Za-z]/`
//      across plain, template-literal, and JSX-expression-string attribute
//      forms, plus bare single-quoted default-parameter-style assignments
//      (e.g. `listEmptyTitle = 'No items yet'`). The sum must stay at or
//      below `adHocNoXCeiling`; on failure the script names every counted
//      `file:line` so the fix is directly actionable.
//
// Known, accepted heuristic limitations (same class of risk already accepted
// in noun-consistency-gate.mjs / unsaved-guard-gate.mjs):
//   - The string-count check is a blunt regex — a worker could dodge it by
//     rewording a string (e.g. "Nothing here yet") without deduplicating the
//     underlying concept. Screenshot evidence (tests/screenshots.spec.ts) and
//     manual source-diff review at PR time are the real backstop, not the
//     count alone.
//   - The JSX-text-node pattern only matches a `>No X<` run that is
//     *immediately* tag-adjacent (no intervening whitespace/newline) — a
//     "No X" string sitting on its own indented line inside a multi-line JSX
//     block is not counted by this check. In practice this undercounts the
//     *pre*-migration inventory (many bespoke `<div>No X</div>` blocks are
//     multi-line), but converges to accurate post-migration, because
//     migrating onto `Empty`'s `label`/`description` props turns that same
//     copy into a single-line JSX attribute value, which the attribute-value
//     half of this check catches directly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertScopeIsHonest,
  describeScope,
  listTrackedFilesUnder,
  UI_SCAN_EXTENSIONS,
  UI_SCAN_ROOTS,
} from './lib/gate-scope.mjs';

// ---------------------------------------------------------------------------
// Check 1: bespoke empty-family count
// ---------------------------------------------------------------------------

// Already compose Console Kit `Empty` internally — their `__empty*` classes
// are layout-hook CSS around the canonical component, not a bespoke
// duplicate. Subtracted from the count entirely (not just "deferred").
export const ALREADY_CANONICAL_EXCLUSIONS = [
  'src-ui/src/components/SplitPaneLayout.tsx',
  'src-ui/src/components/registry/RegistryCatalog.tsx',
];

// EMPTY, and meant to stay that way. Every bespoke empty state has been
// migrated onto the canonical family, so `emptyFamilyCeiling` is 0 and any
// live match at all is an untriaged regression.
//
// History, because the shape of this list is easy to misread: it once named
// files deferred to #193 (S4 shell convergence). #193 closed 2026-07-08
// having scoped the shell/skeleton port and never this empty-state
// migration, so the last entry outlived its owner and pointed at closed
// work — the defect #3101 was filed for. The Knowledge port (#242) removed
// two entries before that; #3101 removed the last one
// (project-settings/LayoutsSection.tsx).
//
// Adding an entry here is an escape hatch from the ceiling, so it needs a
// live owner: name the issue that will remove it, not a closed one. A stale
// entry — one that no longer matches a live finding — fails the gate.
export const S4_DEFERRED_EXCLUSIONS = [];

const CLASSNAME_STRING_PATTERN = /className\s*=\s*"([^"]*)"/g;
const CLASSNAME_TEMPLATE_PATTERN = /className\s*=\s*\{`([^`]*)`\}/g;
const CLASSNAME_EXPR_STRING_PATTERN =
  /className\s*=\s*\{\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\}/g;

export const EMPTY_CLASS_PATTERN = /\b[a-z0-9-]+__empty\b/i;

/**
 * Returns true if `content` has a live, statically-matchable `className`
 * value containing a `*__empty` class (string, template-literal, or
 * JSX-expression-string form).
 */
export function fileHasLiveEmptyClass(content) {
  for (const pattern of [
    CLASSNAME_STRING_PATTERN,
    CLASSNAME_TEMPLATE_PATTERN,
    CLASSNAME_EXPR_STRING_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = pattern.exec(content)) !== null) {
      const captured = match.slice(1).find((group) => group !== undefined);
      if (captured && EMPTY_CLASS_PATTERN.test(captured)) return true;
    }
  }
  return false;
}

/**
 * Scans `files` for a live `*__empty` className. Returns the subset that
 * match.
 */
export function findEmptyFamilyFiles(files, readFile) {
  return files.filter((file) => fileHasLiveEmptyClass(readFile(file)));
}

/**
 * Runs the full empty-family check. Returns:
 *   - rawMatches: every file with a live `*__empty` className
 *   - liveBespoke: rawMatches minus ALREADY_CANONICAL_EXCLUSIONS
 *   - untriaged: liveBespoke entries not in S4_DEFERRED_EXCLUSIONS (a
 *     regression: a new bespoke file, or an incomplete migration)
 *   - staleDeferred: S4_DEFERRED_EXCLUSIONS entries no longer live
 *   - staleCanonical: ALREADY_CANONICAL_EXCLUSIONS entries no longer live
 *   - withinCeiling: liveBespoke.length <= ceiling
 */
export function runEmptyFamilyCheck({
  files,
  readFile,
  alreadyCanonical,
  s4Deferred,
  ceiling,
}) {
  const rawMatches = findEmptyFamilyFiles(files, readFile);
  const rawSet = new Set(rawMatches);
  const alreadyCanonicalSet = new Set(alreadyCanonical);
  const liveBespoke = rawMatches.filter(
    (file) => !alreadyCanonicalSet.has(file),
  );
  const liveBespokeSet = new Set(liveBespoke);

  const untriaged = liveBespoke.filter((file) => !s4Deferred.includes(file));
  const staleDeferred = s4Deferred.filter((file) => !liveBespokeSet.has(file));
  const staleCanonical = alreadyCanonical.filter((file) => !rawSet.has(file));

  return {
    rawMatches,
    liveBespoke,
    untriaged,
    staleDeferred,
    staleCanonical,
    ceiling,
    withinCeiling: liveBespoke.length <= ceiling,
  };
}

// ---------------------------------------------------------------------------
// Check 2: ad-hoc "No X" string count
// ---------------------------------------------------------------------------

// Known UI-copy attribute names, mirrors noun-consistency-gate.mjs's
// ATTR_NAMES list exactly (the two gates scan the same user-facing surfaces).
export const ATTR_NAMES = [
  'label',
  'title',
  'subtitle',
  'placeholder',
  'aria-label',
  'alt',
  'emptyTitle',
  'emptyDescription',
  'listEmptyTitle',
  'listEmptyDescription',
  'searchPlaceholder',
  'confirmLabel',
  'addLabel',
  'manageLabel',
  'description',
];

const ATTR_NAME_GROUP = ATTR_NAMES.join('|');
const NO_X_BODY = 'No [A-Za-z][^"\'`<{]{0,70}';

// `>No agent selected<` — plain JSX text node, single-line (see file header's
// "Known limitation" note for why this is intentionally single-line-only).
export const TEXT_NODE_PATTERN = />No [A-Za-z][^<{]{0,70}</g;

// `emptyTitle="No agent selected"` — plain double-quoted JSX attribute value.
const ATTR_DOUBLE_QUOTE_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*"(${NO_X_BODY})"`,
  'g',
);

// `listEmptyTitle = 'No items yet'` — bare single-quoted assignment, covers
// both a JSX attribute written with single quotes and a default-parameter
// declaration (e.g. SplitPaneLayout.tsx's own defaults) sharing the same
// `name = 'value'` shape.
const ATTR_SINGLE_QUOTE_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*'(${NO_X_BODY})'`,
  'g',
);

// `subtitle={\`No ${x} found\`}` — template-literal JSX attribute value.
const ATTR_TEMPLATE_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*\\{\`(${NO_X_BODY})\``,
  'g',
);

// `title={'No agent selected'}` — string literal wrapped in a JSX expression
// container.
const ATTR_EXPR_STRING_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*\\{\\s*(?:'(${NO_X_BODY})'|"(${NO_X_BODY})")\\s*\\}`,
  'g',
);

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Scans a single file's content for ad-hoc "No X" occurrences (JSX text
 * nodes + known UI-copy attribute values, in all supported forms). Returns
 * findings deduped by `file:line` (a single line can trip more than one
 * pattern; only counted once), sorted by line.
 */
export function scanAdHocNoXFile(file, content) {
  const byLine = new Map();

  function collect(pattern, captureIndex = 0) {
    pattern.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = pattern.exec(content)) !== null) {
      const line = lineNumberAt(content, match.index);
      const key = line;
      if (byLine.has(key)) continue;
      const snippet =
        captureIndex === 0
          ? match[0]
          : (match.slice(1).find((group) => group !== undefined) ?? match[0]);
      byLine.set(key, { file, line, snippet: snippet.trim() });
    }
  }

  collect(TEXT_NODE_PATTERN);
  collect(ATTR_DOUBLE_QUOTE_PATTERN, 1);
  collect(ATTR_SINGLE_QUOTE_PATTERN, 1);
  collect(ATTR_TEMPLATE_PATTERN, 1);
  collect(ATTR_EXPR_STRING_PATTERN, 1);

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Scans every file in `files` for ad-hoc "No X" occurrences. Returns a flat,
 * file-then-line-sorted findings array.
 */
/**
 * Test files are skipped, as they are for checks 3-7 (review M1 brought this
 * check into line with the rest): a fixture string asserting that some OTHER
 * component does NOT render its empty copy is not shipped copy, and counting
 * it let test fixtures consume the shipped ceiling's headroom — which is
 * exactly how a real regression hides behind a "the count went up by one, it
 * was only a test" reading. The ceiling falls to the shipped count in the
 * same change.
 */
export function scanAdHocNoX(files, readFile) {
  const findings = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    findings.push(...scanAdHocNoXFile(file, readFile(file)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 3: bespoke loading strings (SHELL-13)
// ---------------------------------------------------------------------------
//
// The audit counted ELEVEN loading treatments across 28 routes — `SkeletonList`
// plus ten one-off strings that disagreed on casing, ellipsis and noun
// ("Loading...", "Loading…", "Loading scheduler...", "Loading notifications…",
// "Loading profile...", "Loading Logs…", "Loading environments...") and, in
// two cases, the empty state itself. The vocabulary is now exactly two
// components — `SkeletonList` (row-shaped waits) and `SkeletonBlock`
// (region-shaped waits) — both from `src-ui/src/components/state`.
//
// A skeleton's `label`/`aria-label` prop is the CANONICAL place a wait names
// itself ("Loading notifications"), so this check deliberately reads JSX TEXT
// NODES only: what the eye sees, not what the accessibility tree is told.
// Unlike check 1's className scan, the `\s*` here spans newlines, so the
// multi-line `<div>\n  Loading…\n</div>` form is counted too.
//
// Test files are excluded: they assert on OTHER components' fallbacks by
// rendering fixture text, and a fixture string is not a shipped treatment.

// The FIRST version of this check matched literal JSX text starting with
// `Loading` and nothing else, which the independent review (M1) correctly
// called gameable in two directions:
//
//     const WAIT_COPY = 'Loading notifications…';   // hoisted out of JSX
//     return <p>{WAIT_COPY}</p>;
//
//     return <p>Fetching notifications…</p>;        // outside the vocabulary
//
// Both now count, and the review's live example — "Opening the sample
// workspace…" at LocalUiSessionGate.tsx:96 — was a real offender the narrow
// scan could not see. It is fixed in the same change, not baselined.
//
// Two channels, because a wait can be written two ways:
//
//   A. JSX TEXT NODE — what the eye sees, not what the accessibility tree is
//      told, so a skeleton's `label`/`aria-label` prop (the canonical place a
//      wait names itself) is deliberately NOT a finding. `Loading` matches
//      with or without a trailing ellipsis, exactly as before — narrowing it
//      would have weakened the check this change is meant to strengthen. The
//      ADDED verbs are ordinary English words that appear as stage names and
//      button labels ("Checking" is a setup stage in
//      ACPConnectionSetupStages), so they count only as an ellipsis-terminated
//      wait SENTENCE.
//
//   B. STRING LITERAL — an ellipsis-terminated wait sentence anywhere in the
//      module, which closes the hoist-to-a-constant hole regardless of how the
//      constant is later rendered. Skeleton labels never carry an ellipsis
//      ("Loading notifications"), so channel B does not collide with them.
//
// Two things are deliberately NOT counted, and each is a rule rather than an
// exemption:
//
//   - COMMENTS. This file's own prose quotes every string it bans; so do the
//     views that record why a treatment was removed. A comment is not a
//     shipped treatment, so comments are blanked before scanning (blanked, not
//     deleted, so line numbers stay true).
//   - A PENDING-LABEL TERNARY — `{isPending ? 'Checking…' : 'Check again'}`.
//     A wait word that is one arm of a ternary whose OTHER arm is also a
//     string literal is a label swap on a control, which is the shared
//     `Button`'s `pendingLabel` contract (SHELL-02), not a treatment that
//     replaces content. `{loading ? 'Loading…' : null}` has no second label
//     and is still counted.

const LOADING_VERBS_EXTRA = 'Fetching|Opening|Checking|Negotiating|Please wait';
const LOADING_ELLIPSIS = '(?:…|\\.\\.\\.)';

export const LOADING_TEXT_NODE_PATTERN = new RegExp(
  `>\\s*(?:Loading\\b[^<{]{0,60}|(?:${LOADING_VERBS_EXTRA})\\b[^<{]{0,60}?${LOADING_ELLIPSIS})\\s*<`,
  'g',
);

export const LOADING_LITERAL_PATTERN = new RegExp(
  `(['"\`])((?:Loading|${LOADING_VERBS_EXTRA})\\b[^'"\`]{0,60}?${LOADING_ELLIPSIS})\\1`,
  'g',
);

/** An alternate that renders nothing — the partner is not a second label. */
const RENDERS_NOTHING_PATTERN = /^(?:null\b|undefined\b|''|""|``)/;

/**
 * True when the match at `[start, end)` is one arm of a conditional whose
 * OTHER arm is a real value — i.e. a label swap on a control
 * (`{isPending ? 'Checking…' : submitLabel}`), which is the shared `Button`'s
 * `pendingLabel` contract, not a treatment that replaces content.
 *
 * `{loading ? 'Loading…' : null}` has no second label and IS counted: nothing
 * else renders in its place, so the sentence is the treatment. So is a
 * hoisted `const WAIT_COPY = 'Loading…'`, which is not an arm at all — the
 * exact hole the review named.
 */
export function isConditionalLabelArm(code, start, end) {
  const before = code.slice(0, start).trimEnd();
  const after = code.slice(end).trimStart();
  const marker = before.at(-1);

  if (marker === '?') {
    // Consequent arm: the alternate follows the `:`.
    if (!after.startsWith(':')) return false;
    return !RENDERS_NOTHING_PATTERN.test(after.slice(1).trimStart());
  }
  if (marker === ':') {
    // Alternate arm: the consequent sits between the nearest `?` and this `:`.
    const question = before.lastIndexOf('?', before.length - 1);
    if (question === -1 || before.length - question > 200) return false;
    const consequent = before.slice(question + 1, before.length - 1).trim();
    return consequent.length > 0 && !RENDERS_NOTHING_PATTERN.test(consequent);
  }
  return false;
}

/**
 * Replaces every `//` and block comment with spaces of the same length, so
 * offsets and line numbers in the blanked copy match the original file.
 * Deliberately simple: it does not model strings containing `//`, which in
 * this codebase are URLs — blanking the tail of a URL literal cannot create a
 * false POSITIVE (the vocabulary words are not URL fragments), only, at worst,
 * hide a wait sentence written after a URL on the same line.
 */
export function blankComments(content) {
  const blank = (text) => text.replaceAll(/[^\n]/g, ' ');
  return content
    .replaceAll(/\/\*[\s\S]*?\*\//g, blank)
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, (match, prefix) =>
      prefix === '' ? blank(match) : prefix + blank(match.slice(prefix.length)),
    );
}

export function isTestFile(file) {
  return file.includes('__tests__/') || file.endsWith('.test.tsx');
}

/**
 * Scans a single file's content for bespoke loading strings. Returns findings
 * deduped by line, sorted by line.
 */
export function scanLoadingStringsFile(file, content) {
  const code = blankComments(content);

  const byLine = new Map();
  for (const pattern of [LOADING_TEXT_NODE_PATTERN, LOADING_LITERAL_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = pattern.exec(code)) !== null) {
      if (
        isConditionalLabelArm(code, match.index, match.index + match[0].length)
      ) {
        continue;
      }
      const line = lineNumberAt(code, match.index);
      if (byLine.has(line)) continue;
      byLine.set(line, {
        file,
        line,
        snippet: match[0].replaceAll(/\s+/g, ' ').trim(),
      });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/**
 * Full-screen/boot-level wait sentences SHELL-13 keeps, named by file AND
 * exact text rather than absorbed into the ceiling, so removing or rewording
 * one fails the gate (a stale entry) instead of silently freeing a slot for a
 * new one.
 *
 * LocalUiSessionGate: nothing else can render until this browser is known to
 * have a device session — no region to skeleton, no shell to keep.
 *
 * The two packages/sdk entries joined when the ratchet's tree widened to the
 * ONE shared UI scope: both are DEFAULT prop values of published SDK
 * components (LoadingState's inline spinner message, KnowledgeRecall's
 * overridable renderLoading), where the src-ui Skeleton primitives are
 * unreachable — src-ui imports FROM the SDK, so the dependency direction is
 * closed. Excluded as waits an SDK consumer sees before/without any shell,
 * same reasoning as the pre-auth gate; callers override both props.
 */
export const PRE_SHELL_LOADING_EXCLUSIONS = [
  {
    file: 'src-ui/src/components/LocalUiSessionGate.tsx',
    text: "Checking this browser's Station access…",
  },
  {
    file: 'packages/sdk/src/components/Loading.tsx',
    text: 'Loading...',
  },
  {
    file: 'packages/sdk/src/components/KnowledgeRecall.tsx',
    text: 'Loading canonical record…',
  },
];

export function scanLoadingStrings(files, readFile) {
  const findings = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    findings.push(...scanLoadingStringsFile(file, readFile(file)));
  }
  return findings;
}

/**
 * Splits `findings` into the counted ones and the pre-shell exclusions they
 * matched, and reports any exclusion that matched nothing (stale — the same
 * discipline the two empty-family exclusion lists already use).
 */
export function applyPreShellLoadingExclusions(
  findings,
  exclusions = PRE_SHELL_LOADING_EXCLUSIONS,
) {
  const matched = new Set();
  const counted = findings.filter((finding) => {
    const hit = exclusions.find(
      (exclusion) =>
        exclusion.file === finding.file &&
        finding.snippet.includes(exclusion.text),
    );
    if (!hit) return true;
    matched.add(hit);
    return false;
  });
  return {
    counted,
    stale: exclusions.filter((exclusion) => !matched.has(exclusion)),
  };
}

// ---------------------------------------------------------------------------
// Check 4: fabricated loading facts (SHELL-09's actual mechanism)
// ---------------------------------------------------------------------------
//
// This is the narrowest, most exact check in the file, and it exists because
// the highest-severity finding in the shell audit reduced to a single line:
//
//     const isLoading = false;   // src-ui/src/views/SkillsView.tsx
//
// `/guidance` therefore rendered its DEFINITIVE empty state — "No installed
// skills yet", with a CTA to create one — for the ~2.2 s its skills query was
// in flight, then replaced it with 24 installed skills (reproduced 3/3). The
// view held the fact and threw it away. A second instance sat in
// `ConversationStats`, where the modal's own `isLoading ? … : …` branch could
// never take its loading arm.
//
// A loading flag is a DERIVATION from a read, never a literal. There is no
// legitimate `const isLoading = false` in a view: if nothing is loading, the
// branch does not need the constant.

export const FABRICATED_LOADING_PATTERN =
  /\bconst\s+(isLoading|isPending|isFetching|loading)\s*(?::\s*boolean\s*)?=\s*(?:false|true)\s*;/g;

export function scanFabricatedLoadingFile(file, content) {
  const findings = [];
  FABRICATED_LOADING_PATTERN.lastIndex = 0;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = FABRICATED_LOADING_PATTERN.exec(content)) !== null) {
    findings.push({
      file,
      line: lineNumberAt(content, match.index),
      snippet: match[0].trim(),
    });
  }
  return findings;
}

export function scanFabricatedLoading(files, readFile) {
  const findings = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    findings.push(...scanFabricatedLoadingFile(file, readFile(file)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 5: `Empty` rendered by a file that knows about loading and shows none
// ---------------------------------------------------------------------------
//
// The general form of SHELL-09: a surface renders `<Empty>` off
// `items.length === 0`, which is ALSO true for the whole initial read, so "no
// data yet" is drawn as "no data". Whether a particular `<Empty>` is inside
// the guard is not statically decidable, so this is deliberately a blunt
// FILE-level heuristic in the same spirit as check 2 (see the header's
// "Known, accepted heuristic limitations"): a file that renders `<Empty>` AND
// reads a loading signal MUST also render a loading treatment, or hand the
// loading fact to a component that does (`loading={…}` — SplitPaneLayout owns
// the skeleton for eight split-pane routes).
//
// Mutation pendings are excluded from the signal: `saveMutation.isPending` is
// an ACTION in flight, which says nothing about whether the list has been
// read. The ceiling is 0 and must only fall; a file that legitimately trips it
// is evidence the heuristic needs sharpening, not a reason to raise the
// number.

const EMPTY_RENDER_PATTERN = /<Empty\b/;
const READ_LOADING_SIGNALS = [
  /\bisLoading\b/,
  /\bisFetching\b/,
  // `x.isPending` is a mutation/promise handle; a bare `isPending` is a read.
  /(?<![A-Za-z0-9_]\.)\bisPending\b/,
];
const LOADING_TREATMENT_PATTERN =
  /\b(Skeleton|SkeletonList|SkeletonBlock|LoadingDots|FullScreenLoader|LazyBoundary|Suspense)\b|\bloading=\{/;

export function fileRendersUnguardedEmpty(content) {
  if (!EMPTY_RENDER_PATTERN.test(content)) return false;
  if (!READ_LOADING_SIGNALS.some((pattern) => pattern.test(content))) {
    return false;
  }
  return !LOADING_TREATMENT_PATTERN.test(content);
}

// The review (M1) found the file-level form above too blunt in a specific,
// exploitable way: ANY skeleton anywhere in a file cleared EVERY `<Empty>` in
// it, regardless of branch relationship — a helper component that renders a
// skeleton at the top of a file silently vouches for an unguarded `<Empty>` in
// a different component 400 lines below. `<Empty>` must be reachable only
// after a loading guard in the SAME render function, so the scan is now
// component-scoped: each top-level declaration is checked on its own.
//
// The file-level arm is KEPT and the two are UNIONed, because component
// scoping alone would be a weakening in the mirror case — component A reads
// the loading signal while component B renders the `<Empty>`, and neither
// chunk trips on its own. A superset can only ratchet down.
//
// Top-level declarations only. A component nested inside another component's
// body is scanned as part of its host, which is the correct reading: it closes
// over the host's guards.
const TOP_LEVEL_DECLARATION_PATTERN =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=])/gm;

/**
 * Splits a module into `{ name, body }` chunks, one per top-level
 * declaration, plus a leading `<module>` chunk for anything above the first.
 */
export function splitTopLevelChunks(content) {
  TOP_LEVEL_DECLARATION_PATTERN.lastIndex = 0;
  const starts = [];
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = TOP_LEVEL_DECLARATION_PATTERN.exec(content)) !== null) {
    starts.push({ index: match.index, name: match[1] ?? match[2] });
  }
  if (starts.length === 0) return [{ name: '<module>', body: content }];

  const chunks = [];
  if (starts[0].index > 0) {
    chunks.push({ name: '<module>', body: content.slice(0, starts[0].index) });
  }
  for (const [position, start] of starts.entries()) {
    chunks.push({
      name: start.name,
      body: content.slice(
        start.index,
        starts[position + 1]?.index ?? content.length,
      ),
    });
  }
  return chunks;
}

function chunkRendersUnguardedEmpty(body) {
  if (!EMPTY_RENDER_PATTERN.test(body)) return false;
  if (!READ_LOADING_SIGNALS.some((pattern) => pattern.test(body))) return false;
  return !LOADING_TREATMENT_PATTERN.test(body);
}

/**
 * Returns `{ file, component }` findings — one per offending render function,
 * or one `<file>` finding when only the whole-file arm trips.
 */
export function scanUnguardedEmptyFile(file, content) {
  const findings = splitTopLevelChunks(content)
    .filter((chunk) => chunkRendersUnguardedEmpty(chunk.body))
    .map((chunk) => ({ file, component: chunk.name }));
  if (findings.length > 0) return findings;
  return fileRendersUnguardedEmpty(content)
    ? [{ file, component: '<file>' }]
    : [];
}

export function scanUnguardedEmpty(files, readFile) {
  const findings = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    findings.push(...scanUnguardedEmptyFile(file, readFile(file)));
  }
  return findings;
}

export function findUnguardedEmptyFiles(files, readFile) {
  return [...new Set(scanUnguardedEmpty(files, readFile).map((f) => f.file))];
}

// ---------------------------------------------------------------------------
// Check 6: bespoke button classes (SHELL-02)
// ---------------------------------------------------------------------------
//
// The audit found FIVE primary-button treatments coexisting — a dark-outlined
// Create, a teal-filled Add Job, a red-filled Delete, an amber Set up, and a
// bare-text variant — over three class families: the shared `.button`, plus
// `editor-btn*` (149 uses) and `page__btn*` (23). `page__btn*` is retired; its
// 13 remaining call sites render the shared `Button` at `size="sm"` and its
// selectors are deleted.
//
// `editor-btn*` is the large remainder, deliberately NOT migrated in one
// change: it is spread over 40+ editor surfaces whose layout CSS targets it,
// and a blind sweep would relayout half the app without an eye on any of it.
// The ceiling is what makes that a plan rather than an excuse — the count may
// only fall, so no new bespoke button can be added while it does.

export const BESPOKE_BUTTON_CLASS_PATTERN =
  /\b(?:editor-btn|page__btn)[a-z-]*/g;

export function scanBespokeButtonsFile(file, content) {
  const findings = [];
  BESPOKE_BUTTON_CLASS_PATTERN.lastIndex = 0;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = BESPOKE_BUTTON_CLASS_PATTERN.exec(content)) !== null) {
    findings.push({
      file,
      line: lineNumberAt(content, match.index),
      snippet: match[0],
    });
  }
  return findings;
}

export function scanBespokeButtons(files, readFile) {
  const findings = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    findings.push(...scanBespokeButtonsFile(file, readFile(file)));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 7: bespoke modal class FAMILIES (SHELL-02)
// ---------------------------------------------------------------------------
//
// 20 distinct `*-modal__*` families existed alongside `ResponsiveDialogSurface`
// when the audit ran, and opening four dialogs in one session produced four
// different chromes. `components/Dialog` is now the one chrome; this counts
// how many families still hand-roll their own.
//
// FAMILIES, not occurrences: the unit of migration is "this dialog adopts the
// shared chrome", and a family that keeps three body-layout classes after its
// header/footer are gone is not the regression this is watching for. A NEW
// family is.

export const MODAL_FAMILY_PATTERN =
  /\b([a-z0-9]+(?:-[a-z0-9]+)*-modal)__[a-z-]+/g;

export function collectModalFamilies(files, readFile) {
  const families = new Map();
  for (const file of files) {
    if (isTestFile(file)) continue;
    const content = readFile(file);
    MODAL_FAMILY_PATTERN.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = MODAL_FAMILY_PATTERN.exec(content)) !== null) {
      families.set(match[1], (families.get(match[1]) ?? 0) + 1);
    }
  }
  return families;
}

// ---------------------------------------------------------------------------
// File listing (git-tracked files only, same discipline as
// rename-inventory.mjs / noun-consistency-gate.mjs / unsaved-guard-gate.mjs)
// ---------------------------------------------------------------------------

/**
 * The scope this ratchet reports on. ONE shared constant, imported from the
 * scope lib alongside the noun gate (gate-scope.test.ts pins that neither
 * gate declares its own); the historical note below is why the enumeration
 * stopped trusting pathspec globs.
 *
 * `packages/sdk/src/components` joined the shared tree with review L. The
 * SDK's components cannot adopt the shared state families this ratchet
 * counts toward (Empty/Skeleton/Dialog live in src-ui and @kontourai/ui;
 * src-ui imports FROM the SDK, so the dependency direction is closed), so
 * the SDK's own older chrome is absorbed by reasoned ceiling adjustments in
 * scripts/state-primitives-baseline.json, in the same change that widened
 * the tree — not by exclusions that would narrow the scan.
 */
export const SCAN_ROOTS = UI_SCAN_ROOTS;
export const SCAN_EXTENSIONS = UI_SCAN_EXTENSIONS;

/**
 * Paths that must be inside the enumerated scope. The tree-walk oracle in
 * `assertScopeIsHonest` is derived from `SCAN_ROOTS`, so narrowing the roots
 * would narrow the oracle with it; this pinned list is the part that cannot be
 * narrowed silently.
 */
export const PINNED_SCOPE_INVENTORY = [
  'src-ui/src/App.tsx',
  'src-ui/src/main.tsx',
];

export function listTrackedTsxFiles() {
  return SCAN_ROOTS.flatMap((root) =>
    listTrackedFilesUnder(root, SCAN_EXTENSIONS),
  );
}

function main() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const baselinePath = `${scriptDir}state-primitives-baseline.json`;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  const files = listTrackedTsxFiles();
  const readFile = (file) => readFileSync(file, 'utf8');

  // Fail closed BEFORE counting: a ratchet whose enumeration is short of its
  // declared scope reports "count N <= ceiling" over a tree it never walked
  // (station#1559).
  assertScopeIsHonest({
    gate: 'state-primitives ratchet',
    roots: SCAN_ROOTS,
    extensions: SCAN_EXTENSIONS,
    pinned: PINNED_SCOPE_INVENTORY,
    files,
  });
  const scope = describeScope({
    roots: SCAN_ROOTS,
    extensions: SCAN_EXTENSIONS,
    files,
  });

  const recordMode = process.argv.includes('--record');

  const emptyFamily = runEmptyFamilyCheck({
    files,
    readFile,
    alreadyCanonical: ALREADY_CANONICAL_EXCLUSIONS,
    s4Deferred: S4_DEFERRED_EXCLUSIONS,
    ceiling: baseline.emptyFamilyCeiling,
  });
  const adHocFindings = scanAdHocNoX(files, readFile);
  const { counted: loadingStringFindings, stale: staleLoadingExclusions } =
    applyPreShellLoadingExclusions(scanLoadingStrings(files, readFile));
  const fabricatedLoadingFindings = scanFabricatedLoading(files, readFile);
  const unguardedEmptyFindings = scanUnguardedEmpty(files, readFile);
  const bespokeButtonFindings = scanBespokeButtons(files, readFile);
  const modalFamilies = collectModalFamilies(files, readFile);

  console.log(
    'State-primitives ratchet (#192 + SHELL-02/09/13 — one Empty/Loading/Error family, one Dialog chrome, one Button; every count below must only decrease).',
  );
  console.log(`Scanned ${scope}.\n`);

  if (recordMode) {
    console.log(
      `RECORD: empty-family liveBespoke=${emptyFamily.liveBespoke.length} (raw=${emptyFamily.rawMatches.length}), ad-hoc "No X"=${adHocFindings.length}.\n`,
    );
    console.log('liveBespoke files:');
    for (const file of emptyFamily.liveBespoke) console.log(`  ${file}`);
    console.log('\nad-hoc "No X" findings:');
    for (const finding of adHocFindings) {
      console.log(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.log('\nbespoke loading strings:');
    for (const finding of loadingStringFindings) {
      console.log(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.log('\nfabricated loading facts:');
    for (const finding of fabricatedLoadingFindings) {
      console.log(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.log('\nunguarded-Empty renders (file :: component):');
    for (const finding of unguardedEmptyFindings) {
      console.log(`  ${finding.file} :: ${finding.component}`);
    }
    console.log(
      `\nbespoke button class occurrences: ${bespokeButtonFindings.length}`,
    );
    console.log(`bespoke modal families: ${modalFamilies.size}`);
    for (const [family, count] of [...modalFamilies].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${family} (${count})`);
    }
    process.exit(0);
  }

  let failed = false;

  // --- Check 1: empty-family ---
  if (emptyFamily.untriaged.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${emptyFamily.untriaged.length} untriaged file(s) with a live bespoke *__empty className (not in S4_DEFERRED_EXCLUSIONS):\n`,
    );
    for (const file of emptyFamily.untriaged) console.error(`  ${file}`);
    console.error(
      '\nMigrate onto the canonical family (src-ui/src/components/state) and remove the' +
        '\nbespoke *__empty class. That is the expected fix: the ceiling is 0 and' +
        '\nS4_DEFERRED_EXCLUSIONS is empty.' +
        '\n\nAdding an entry to S4_DEFERRED_EXCLUSIONS is an escape hatch, not a fix.' +
        '\nIf you take it, name a LIVE issue that will remove the entry — a deferral' +
        '\npointing at closed work is how this list last went stale (#3101).',
    );
  }

  if (emptyFamily.staleDeferred.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${emptyFamily.staleDeferred.length} S4_DEFERRED_EXCLUSIONS entry(ies) no longer match any live finding (stale):\n`,
    );
    for (const file of emptyFamily.staleDeferred) console.error(`  ${file}`);
    console.error(
      '\nRemove the stale entry(ies) from S4_DEFERRED_EXCLUSIONS in' +
        ' scripts/state-primitives-ratchet.mjs (the view has been migrated).',
    );
  }

  if (emptyFamily.staleCanonical.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${emptyFamily.staleCanonical.length} ALREADY_CANONICAL_EXCLUSIONS entry(ies) no longer match any live finding (stale):\n`,
    );
    for (const file of emptyFamily.staleCanonical) console.error(`  ${file}`);
    console.error(
      '\nRemove the stale entry(ies) from ALREADY_CANONICAL_EXCLUSIONS in' +
        ' scripts/state-primitives-ratchet.mjs.',
    );
  }

  if (!emptyFamily.withinCeiling) {
    failed = true;
    console.error(
      `\nFAIL: empty-family count ${emptyFamily.liveBespoke.length} exceeds the recorded ceiling ${emptyFamily.ceiling} (scripts/state-primitives-baseline.json's emptyFamilyCeiling):\n`,
    );
    for (const file of emptyFamily.liveBespoke) console.error(`  ${file}`);
  }

  if (
    emptyFamily.untriaged.length === 0 &&
    emptyFamily.staleDeferred.length === 0 &&
    emptyFamily.staleCanonical.length === 0 &&
    emptyFamily.withinCeiling
  ) {
    console.log(
      `OK: empty-family count ${emptyFamily.liveBespoke.length} <= ceiling ${emptyFamily.ceiling} (naming only S4_DEFERRED_EXCLUSIONS: ${S4_DEFERRED_EXCLUSIONS.length} file(s)).`,
    );
  }

  // --- Check 2: ad-hoc "No X" strings ---
  if (adHocFindings.length > baseline.adHocNoXCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${adHocFindings.length} ad-hoc "No X" occurrence(s) exceed the recorded ceiling ${baseline.adHocNoXCeiling} (scripts/state-primitives-baseline.json's adHocNoXCeiling):\n`,
    );
    for (const finding of adHocFindings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.error(
      '\nCollapse the redundant "No X" copy to the shared default where it adds no' +
        "\ninformation beyond restating the noun (see SplitPaneLayout's own" +
        '\n"Nothing selected" default), or update the checked-in ceiling in' +
        '\nscripts/state-primitives-baseline.json if this is a deliberate, reasoned' +
        '\naddition (not a silent regrowth).',
    );
  } else {
    console.log(
      `OK: ad-hoc "No X" count ${adHocFindings.length} <= ceiling ${baseline.adHocNoXCeiling}.`,
    );
  }

  // --- Check 3: bespoke loading strings ---
  if (loadingStringFindings.length > baseline.loadingStringCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${loadingStringFindings.length} bespoke loading string(s) exceed the recorded ceiling ${baseline.loadingStringCeiling} (scripts/state-primitives-baseline.json's loadingStringCeiling):\n`,
    );
    for (const finding of loadingStringFindings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.error(
      '\nThe loading vocabulary is exactly two components — SkeletonList (row-' +
        '\nshaped waits) and SkeletonBlock (region-shaped waits), both from' +
        "\nsrc-ui/src/components/state. Name the wait in the skeleton's `label`" +
        '\nprop; do not render a new sentence (SHELL-13 counted eleven treatments' +
        '\nacross 28 routes, ten of them one-off strings).',
    );
  } else {
    console.log(
      `OK: bespoke loading string count ${loadingStringFindings.length} <= ceiling ${baseline.loadingStringCeiling} (naming ${PRE_SHELL_LOADING_EXCLUSIONS.length} pre-shell exclusion(s)).`,
    );
  }

  if (staleLoadingExclusions.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${staleLoadingExclusions.length} PRE_SHELL_LOADING_EXCLUSIONS entry(ies) no longer match any live finding (stale):\n`,
    );
    for (const exclusion of staleLoadingExclusions) {
      console.error(`  ${exclusion.file}: ${exclusion.text}`);
    }
    console.error(
      '\nThe pre-shell wait it names has been removed or reworded. Delete the' +
        '\nentry from PRE_SHELL_LOADING_EXCLUSIONS in' +
        '\nscripts/state-primitives-ratchet.mjs — an exclusion that matches' +
        '\nnothing is a free slot for a wait sentence nobody reviewed.',
    );
  }

  // --- Check 4: fabricated loading facts ---
  if (fabricatedLoadingFindings.length > baseline.fabricatedLoadingCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${fabricatedLoadingFindings.length} fabricated loading fact(s) exceed the recorded ceiling ${baseline.fabricatedLoadingCeiling}:\n`,
    );
    for (const finding of fabricatedLoadingFindings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.error(
      '\nA loading flag is DERIVED from a read, never written as a literal.' +
        '\nThis exact line — `const isLoading = false;` — is what made /guidance' +
        '\nrender "No installed skills yet" over 24 installed skills (SHELL-09).' +
        '\nRead the flag off the query (`isPending` for the initial read), or' +
        '\ndelete the branch that consumes it.',
    );
  } else {
    console.log(
      `OK: fabricated loading fact count ${fabricatedLoadingFindings.length} <= ceiling ${baseline.fabricatedLoadingCeiling}.`,
    );
  }

  // --- Check 5: unguarded `Empty` renders ---
  if (unguardedEmptyFindings.length > baseline.unguardedEmptyCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${unguardedEmptyFindings.length} render function(s) render <Empty> and read a loading signal without rendering any loading treatment, exceeding the recorded ceiling ${baseline.unguardedEmptyCeiling}:\n`,
    );
    for (const finding of unguardedEmptyFindings) {
      console.error(`  ${finding.file} :: ${finding.component}`);
    }
    console.error(
      '\nGate the empty state on the read: render SkeletonList/SkeletonBlock' +
        '\nwhile the query is pending, or pass the loading fact to a component' +
        '\nthat owns the skeleton (`loading={…}`). "No data" and "no data YET"' +
        '\nare different sentences and the user cannot tell them apart.',
    );
  } else {
    console.log(
      `OK: unguarded-Empty render count ${unguardedEmptyFindings.length} <= ceiling ${baseline.unguardedEmptyCeiling} (component-scoped).`,
    );
  }

  // --- Check 6: bespoke button classes ---
  if (bespokeButtonFindings.length > baseline.bespokeButtonCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${bespokeButtonFindings.length} bespoke button class use(s) exceed the recorded ceiling ${baseline.bespokeButtonCeiling}:\n`,
    );
    for (const finding of bespokeButtonFindings.slice(0, 40)) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.error(
      '\nUse the shared `components/Button` (primary | secondary | danger, plus' +
        '\n`pending`) rather than adding another `editor-btn`/`page__btn`. The' +
        '\ncount may only fall: SHELL-02 found FIVE primary-button treatments' +
        '\ncoexisting across three class families.',
    );
  } else {
    console.log(
      `OK: bespoke button class count ${bespokeButtonFindings.length} <= ceiling ${baseline.bespokeButtonCeiling}.`,
    );
  }

  // --- Check 7: bespoke modal families ---
  if (modalFamilies.size > baseline.modalFamilyCeiling) {
    failed = true;
    console.error(
      `\nFAIL: ${modalFamilies.size} bespoke modal class families exceed the recorded ceiling ${baseline.modalFamilyCeiling}:\n`,
    );
    for (const [family, count] of [...modalFamilies].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.error(`  ${family} (${count} use(s))`);
    }
    console.error(
      '\nA new dialog composes `components/Dialog` (eyebrow · title · subtitle ·' +
        '\nclose X, scroll-safe body, footer action row) over' +
        '\n`ResponsiveDialogSurface`; it does not mint a new `*-modal__*` family.' +
        '\nSHELL-02 opened four dialogs in one session and found four chromes.',
    );
  } else {
    console.log(
      `OK: bespoke modal family count ${modalFamilies.size} <= ceiling ${baseline.modalFamilyCeiling}.`,
    );
  }

  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
