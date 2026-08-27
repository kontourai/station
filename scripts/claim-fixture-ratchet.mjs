#!/usr/bin/env node
// Regression gate for #1184 (the "honesty rule needs a mechanical guard, not a norm" meta-issue).
// Follows `scripts/state-primitives-ratchet.mjs` / `scripts/shell-conformance-ratchet.mjs`'s exact,
// established architecture (pure exported functions; `main()` gated behind
// `import.meta.url === file://process.argv[1]`; a checked-in numeric ceiling
// (scripts/claim-fixture-baseline.json's `gapCeiling`) that must only decrease; a fixed, curated,
// staleness-checked registry rather than a repo-wide scan) — this is Option 1 from #1184: a
// fixture-completeness lint for status/capability/identity surfaces.
//
// #1184's own motivating fact: `KnownEnvironmentsSection.tsx` already carries a doc comment
// ("Source badge tone is provenance-only, never a liveness/health signal... this page must not
// fake it") that #1116 violated a few lines below, and #1166 violated the same rule in a sibling
// file. A norm a careful engineer breaks while reading it is not a control. This gate does not
// (cannot) verify the CONTENT of a claim is honest — see the two known-uncatchable classes named
// below and in the PR description — it only verifies that every state of a union feeding a
// rendered claim was actually exercised (or, for a plain copy/tone table, that the value it
// currently emits was actually asserted) by some test. Forcing that exercise is what catches the
// bug in practice: a developer/reviewer who has to render the `idle` phase to satisfy this gate
// looks at what that render says, which is exactly how #1166's fix was actually found (independent
// review, not this gate — this gate is the mechanization of writing that fixture down permanently).
//
// Signal — two declaration kinds, matching #1184's own description of the pattern
// ("Record<SomeUnion, string> copy tables, Record<Union, tone> badge tables, or a switch on a
// status/source/phase union that produces user-facing text"):
//
//   1. kind: 'switch' — a named function (`function NAME(...) { switch (x.discriminant) { case
//      'a': ...; case 'b': ...; } }`) whose case labels enumerate a union's members. Coverage
//      signal: does the paired test file construct a fixture for that exact case label at all
//      (an exact quoted-token search, e.g. `'idle'` or `"idle"`, deliberately NOT a bare substring
//      search — see "Known, accepted heuristic limitations" below)? This is "was this STATE ever
//      exercised" — the #1166 shape: the capability sentence wasn't gated by any switch at all
//      pre-fix, so `idle` was never a phase the test suite rendered; this gate would have named
//      `idle` as an unexercised state (see the fixture-completeness test suite's #1166
//      reconstruction — it uses SshEnvironmentsSection's own OTHER phase-exhaustive switch,
//      `statusView`, which already existed pre-fix, as the union anchor: the component was already
//      known to be phase-sensitive, and this gate's job is to make sure every phase actually gets
//      rendered by a test, not to know in advance which specific line of copy is honest).
//
//   2. kind: 'record' — a `const NAME: Record<SomeUnion, PlainStringType> = { key: 'value', ... }`
//      copy/tone table with plain (non-template) string values. Coverage signal: does the paired
//      test file contain, as a literal substring, the CURRENT value assigned to that member (e.g.
//      `'disabled'`, matched inside a longer asserted string like
//      `'connections-page__status-badge--disabled'`)? This is "was the CLAIM this member currently
//      makes ever asserted," which is a stronger bar than "was the row rendered" — the #1116 shape:
//      the `paired` row WAS rendered and its label text WAS asserted (`getByText('Paired')`)
//      pre-fix, so a plain "was this member's key ever exercised" check would have missed it; but
//      no test asserted anything about the badge's tone/class at all, so the *value* `SOURCE_TONE`
//      computed for `paired` (`'ready'`, pre-fix) was never asserted — this gate's value-coverage
//      check correctly flags that gap (see the fixture-completeness test suite's #1116
//      reconstruction).
//
// What this gate cannot catch (state plainly, per #1184's own instruction — do not let a green run
// be mistaken for "no unevidenced claims anywhere"):
//   - #1182 (a model badge echoing requested config as observed fact) and #1185 (an attention item
//     projected from a lifecycle flag instead of the request event) are server-side DATA-PROVENANCE
//     problems: the value flowing into the render is wrong before it ever reaches a union/switch,
//     and no amount of UI-side fixture-coverage analysis can see that the *source* of a value is a
//     request instead of an observation. That is #1184's own Option 2 (a typed "evidenced value"
//     wrapper) — a categorically different, larger mechanism, not implemented here.
//   - #1128/#1142 (an authorization/isolation decision derived from route-family scope inheritance)
//     are not union-completeness problems at all — there is no discriminated union whose members
//     this gate could enumerate; the defect is treating scope inheritance as a decision. Out of
//     scope for Option 1 by construction.
//   - A registered declaration this gate has never heard of (a brand-new claim surface added to a
//     new or existing file) is invisible until a human adds it to CLAIM_SURFACES below — same
//     "new seventh bespoke view" class of gap shell-conformance-ratchet.mjs already discloses. PR
//     review is the backstop for noticing a new capability/liveness/identity surface and
//     registering it here.
//
// Known, accepted heuristic limitations (same class of risk already accepted in
// state-primitives-ratchet.mjs / shell-conformance-ratchet.mjs):
//   - Record value-coverage is a SUBSTRING search, not tied to which row a test actually asserted
//     it against — two members sharing an identical value (e.g. `paired` and `manual` both mapping
//     to `'disabled'`) can shadow each other's coverage: a test asserting `'disabled'` for the
//     `paired` row will also mark `manual` "covered" even if no test ever renders a manual row and
//     checks its tone. This is a deliberate, disclosed tradeoff (same blunt-regex class as
//     noun-consistency-gate.mjs), not a guarantee of true per-member assertion.
//   - Record value-coverage is now polarity-aware (fix round 2, PR #1196 independent review) — it
//     requires some occurrence of the value to sit in a non-`.not.` assertion chain (see
//     `testFileHasSubstring`'s own doc comment for the exact heuristic and its scope) — but it is
//     still only scoped to the NEAREST preceding `expect(` call per occurrence, not proof that the
//     positive assertion it found is actually about the same member: a value that only ever appears
//     positively inside some OTHER, unrelated assertion's chain would still be misread as coverage
//     for this member. Same-member negative-assertion shadowing (a `.not.` guard for the correct
//     member with no accompanying positive assertion anywhere) is exactly what this fix closes; a
//     positive assertion belonging to a genuinely different claim shadowing this member is not, and
//     is a variant of the cross-member shadowing risk named directly above.
//   - Switch key-coverage is an exact quoted-token search (`'idle'`/`"idle"`), chosen specifically
//     to avoid the false-positive a bare substring search would create (e.g. `'error'` matching
//     inside an unrelated `'network error'` string) — but it also means a test that constructs a
//     fixture via a non-literal expression (a shared variable, a spread, a factory whose argument
//     isn't a quoted literal) will not be recognized as covering that member. Not observed in any
//     of today's registered surfaces (verified directly against both tracked files' test suites
//     during authoring), but a real latent gap in the parser, not just theoretical.
//   - Switch key-coverage (and record value-coverage) also has no CONTROL-FLOW awareness — a fixture
//     literal that only appears inside `test.skip(...)` (never executes), only after an
//     unconditional `return;` (dead code), or as an unrelated variable's value that drives no render
//     at all (e.g. `const label = 'idle';` never passed to the component) is indistinguishable from
//     a real, executing fixture to this token search. Confirmed by direct probe (PR #1196
//     independent review) against all three shapes. This is the same class of false-positive risk
//     already disclosed above for record value-coverage (a token present in source text is treated
//     as proof of exercise), just triggered by dead/inert code instead of an unrelated member's
//     value. Not fixed here — a real control-flow check needs an actual parser, and this gate is
//     deliberately not one (see "Signal" above); disclosed so a green run is never read as "this
//     fixture literal definitely executes."
//   - CLAIM_SURFACES is a fixed, curated list (mirrors TRACKED_VIEWS's reasoning exactly): reliably
//     avoids false positives from repo-wide Record<Union,X>/switch scanning (most such
//     constructs are not capability/liveness/identity claims — an icon map or a CSS-variant table
//     is a `Record<Union,X>` too, and would be noise here), at the cost of requiring a human to
//     register each new claim surface (see "What this gate cannot catch" above).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertFilesAreGitTracked } from './lib/ratchet-utils.mjs';

// ---------------------------------------------------------------------------
// Claim surface registry (fixed, curated — mirrors TRACKED_VIEWS)
// ---------------------------------------------------------------------------

export const CLAIM_SURFACES = [
  {
    // Both switches moved here verbatim when the two computer lists merged
    // into one (`ComputersSection`): the row model is pure so the claim each
    // phase makes is testable without a DOM, and the registration follows the
    // declarations rather than the file they used to live in.
    file: 'src-ui/src/views/connections-hub/computer-rows.ts',
    testFile: 'src-ui/src/__tests__/computer-rows.test.ts',
    declarations: [
      // Badge label/tone per SSH connection phase.
      { name: 'sshComputerState', kind: 'switch' },
      // Station#1134/#1166's "what this unlocks" capability sentence, made phase-aware by the
      // #1166 fix this gate exists to guard against regressing.
      { name: 'sshRelationship', kind: 'switch' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Structural extraction (function body / object literal — brace-balanced, no real parser)
// ---------------------------------------------------------------------------

/**
 * Given an index positioned right after a function's parameter list `)`, returns the index of the
 * function BODY's own opening `{` — skipping past an inline object-type return-type annotation
 * (e.g. `): { label: string; tone: 'a' | 'b' } {`) if present, unlike a naive "first `{` after the
 * params" scan (which `SshEnvironmentsSection.tsx`'s own `statusView` — an inline `{ label: ...;
 * tone: ...; detail?: ... }` return type — proves is wrong: the naive scan would stop at the return
 * type's own brace and never reach the switch inside the real body). Heuristic: brace-balance the
 * first `{...}` span found; if what immediately follows (past whitespace) is itself `{`, the first
 * span was the return-type annotation and the second `{` is the real body start. Not a real parser
 * — a return type shaped like `{...} | null {` (a brace-object type immediately followed by more
 * union tokens before the body) would defeat this, but that shape does not occur in either
 * currently-registered claim surface (verified directly against both during authoring).
 */
function findFunctionBodyStart(content, fromIndex) {
  let i = fromIndex;
  while (i < content.length && content[i] !== '{') i++;
  if (i >= content.length) return -1;

  let braceDepth = 0;
  let j = i;
  for (; j < content.length; j++) {
    if (content[j] === '{') braceDepth++;
    else if (content[j] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        j++;
        break;
      }
    }
  }
  let k = j;
  while (k < content.length && /\s/.test(content[k])) k++;
  return content[k] === '{' ? k : i;
}

/**
 * Extracts the source text of a named top-level function's body (the `{...}` block, inclusive of
 * braces), given a `function Name(...)` / `export function Name(...)` declaration. Returns null if
 * no such declaration is found. Mirrors shell-conformance-ratchet.mjs's `extractFunctionBody`, with
 * one addition (`findFunctionBodyStart`, see its own doc comment) this gate's own registered
 * surfaces need and shell-conformance-ratchet.mjs's six tracked views never exercised: skipping an
 * inline object-type return-type annotation instead of naively taking the first `{` after the
 * params.
 */
export function extractFunctionBody(content, name) {
  const declPattern = new RegExp(
    `(?:export\\s+default\\s+function|export\\s+function|function)\\s+${name}\\s*\\(`,
  );
  const declMatch = declPattern.exec(content);
  if (!declMatch) return null;

  let i = declMatch.index + declMatch[0].length - 1;
  let parenDepth = 0;
  for (; i < content.length; i++) {
    if (content[i] === '(') parenDepth++;
    else if (content[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        i++;
        break;
      }
    }
  }
  const bodyStart = findFunctionBodyStart(content, i);
  if (bodyStart < 0) return null;
  i = bodyStart;

  let braceDepth = 0;
  for (; i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    else if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        i++;
        break;
      }
    }
  }
  return content.slice(bodyStart, i);
}

/**
 * Extracts the source text of a top-level `const NAME: <TypeAnnotation> = { ... };` object literal
 * (inclusive of braces). Returns null if no such declaration is found. Non-greedy match up to the
 * first `{` after `const NAME :` — safe here because none of this repo's registered `record`-kind
 * type annotations (`Record<Union, PlainType>`) contain a brace themselves.
 */
export function extractConstObjectLiteral(content, name) {
  const declPattern = new RegExp(`const\\s+${name}\\s*:[\\s\\S]*?=\\s*\\{`);
  const declMatch = declPattern.exec(content);
  if (!declMatch) return null;

  let i = declMatch.index + declMatch[0].length - 1; // positioned at the object literal's '{'
  const bodyStart = i;
  let braceDepth = 0;
  for (; i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    else if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        i++;
        break;
      }
    }
  }
  return content.slice(bodyStart, i);
}

const CASE_LABEL_PATTERN = /case\s*(?:'([^']*)'|"([^"]*)")\s*:/g;

/**
 * Extracts every `case '<label>':` (or double-quoted) member from a named function's switch
 * statement, in source order, deduped. Stacked case labels sharing one body (`case 'a': case 'b':
 * return ...`) each count as their own member — each is still a distinct union state that needs its
 * own fixture, even though today's code happens to render the same copy for both.
 */
export function extractSwitchMembers(content, functionName) {
  const body = extractFunctionBody(content, functionName);
  if (body === null) return null;
  const members = [];
  const seen = new Set();
  CASE_LABEL_PATTERN.lastIndex = 0;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = CASE_LABEL_PATTERN.exec(body)) !== null) {
    const label = match[1] ?? match[2];
    if (!seen.has(label)) {
      seen.add(label);
      members.push(label);
    }
  }
  return members;
}

const RECORD_ENTRY_PATTERN =
  /([A-Za-z_$][\w-]*|'[^']*'|"[^"]*")\s*:\s*(?:'([^']*)'|"([^"]*)")/g;

/**
 * Extracts every `key: 'value'` (or double-quoted) top-level entry from a named `const NAME: Record
 * <...> = { ... }` object literal. Returns `[{ key, value }]` in source order. Returns null if the
 * declaration isn't found.
 */
export function extractRecordEntries(content, constName) {
  const literal = extractConstObjectLiteral(content, constName);
  if (literal === null) return null;
  const entries = [];
  RECORD_ENTRY_PATTERN.lastIndex = 0;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = RECORD_ENTRY_PATTERN.exec(literal)) !== null) {
    const rawKey = match[1];
    const key = rawKey.replace(/^['"]|['"]$/g, '');
    const value = match[2] ?? match[3];
    entries.push({ key, value });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Coverage checks
// ---------------------------------------------------------------------------

/**
 * Strips `//` line comments and `/* *\/` block comments from `content`, leaving string/template
 * literal contents untouched (quote-skip logic mirrors `findTopLevelJsxReturn` in
 * shell-conformance-ratchet.mjs). Required before either coverage check below: proven necessary
 * during authoring — `SshEnvironmentsSection.test.tsx` has a code comment reading "The busy overlay
 * text is shared with 'starting'/'verifying'", and without stripping it first, the quoted words in
 * that PROSE, not any actual test fixture, made `testFileHasQuotedToken` false-report both phases
 * as covered. Not stripping `//` blindly (a naive per-line regex) matters too: this same test file
 * has URLs like `'https://box-b.tailnet.ts.net'`, and a `//`-to-end-of-line strip that didn't skip
 * over string contents first would truncate the URL's own closing quote right off the fixture.
 */
export function stripComments(content) {
  let result = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      result += content.slice(start, i);
      continue;
    }
    if (c === '`') {
      const start = i;
      i++;
      while (i < n && content[i] !== '`') {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      result += content.slice(start, i);
      continue;
    }
    if (c === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/** Exact quoted-token search — see file header for why this is exact, not a bare substring. */
export function testFileHasQuotedToken(testContent, token) {
  return (
    testContent.includes(`'${token}'`) || testContent.includes(`"${token}"`)
  );
}

/**
 * Value-coverage search for `kind: 'record'` — polarity-aware: a match only counts if some
 * occurrence of `value` in `testContent` is NOT inside a `.not.` assertion chain (see file header's
 * "Known, accepted heuristic limitations" for what this heuristic still cannot catch).
 *
 * Fix round 2 (independent review, PR #1196): a bare substring search reported `covered: true` for
 * the exact historical #1116 bug re-injected against the REAL, current `KnownEnvironmentsSection
 * .test.tsx` — that file asserts `expect(badge.className).not.toContain('...--ready')` as a
 * regression guard, and the old bare search matched the `'ready'` token inside that string with no
 * regard for the surrounding `.not.`, i.e. it treated a test asserting the OPPOSITE of a value as
 * proof the value was covered. See the reconstruction test below ("fix round 2 (#1196 review)
 * reconstruction") for the red-then-green proof.
 *
 * Heuristic: for each occurrence of `value`, look back to the nearest preceding `expect(` call (the
 * enclosing assertion chain, on the reasonable assumption assertions are sequential and
 * non-overlapping in source) — or, if there is no preceding `expect(` at all, a fixed
 * `NOT_CHAIN_FALLBACK_WINDOW`-character lookback — and check whether that span contains `.not.`. An
 * occurrence with no `.not.` anywhere in its enclosing chain counts as a positive assertion (or, for
 * a bare non-assertion fixture literal with no `expect(` nearby at all within the fallback window,
 * still counts — this function intentionally does not require an `expect(...)` wrapper to exist;
 * that would be a much larger, separately-scoped change, and the switch-kind MEDIUM disclosure below
 * already names the class of false positive a bare-literal match like this can produce).
 *
 * Blunt on purpose, same class of tradeoff as the rest of this file: a value that only ever appears
 * inside SOME OTHER positive assertion's chain (not the one actually about this claim) would still
 * be misread as coverage — this function proves polarity, not that the positive assertion is about
 * the right subject. Not observed in either of today's registered `record`-kind surfaces (verified
 * directly against both during authoring of this fix), but a real latent gap, disclosed here and in
 * the file header rather than silently left unstated.
 */
const NOT_CHAIN_FALLBACK_WINDOW = 200;

export function testFileHasSubstring(testContent, value) {
  let fromIndex = 0;
  while (true) {
    const idx = testContent.indexOf(value, fromIndex);
    if (idx === -1) return false;
    const lastExpectIdx = testContent.lastIndexOf('expect(', idx);
    const chainStart =
      lastExpectIdx === -1
        ? Math.max(0, idx - NOT_CHAIN_FALLBACK_WINDOW)
        : lastExpectIdx;
    const chain = testContent.slice(chainStart, idx);
    if (!chain.includes('.not.')) {
      return true;
    }
    fromIndex = idx + 1;
  }
}

/**
 * Checks one declaration's fixture coverage. Returns:
 *   - membersFound: the raw extraction result (null if the declaration could not be located —
 *     structural drift, see `assertClaimSurfacesResolvable`)
 *   - findings: one entry per member — { member, covered, evidence }
 */
export function checkDeclarationCoverage({
  sourceContent,
  testContent,
  declaration,
}) {
  if (declaration.kind === 'switch') {
    const members = extractSwitchMembers(sourceContent, declaration.name);
    if (members === null) return { membersFound: null, findings: [] };
    const findings = members.map((member) => ({
      member,
      covered: testFileHasQuotedToken(testContent, member),
      evidence: `no fixture in the paired test file constructs this state (expected a quoted '${member}' literal)`,
    }));
    return { membersFound: members, findings };
  }

  if (declaration.kind === 'record') {
    const entries = extractRecordEntries(sourceContent, declaration.name);
    if (entries === null) return { membersFound: null, findings: [] };
    const findings = entries.map(({ key, value }) => ({
      member: key,
      covered: testFileHasSubstring(testContent, value),
      evidence: `no test in the paired test file asserts the current value ('${value}') this member renders`,
    }));
    return { membersFound: entries.map((e) => e.key), findings };
  }

  throw new Error(`unknown declaration kind: ${declaration.kind}`);
}

/**
 * Runs the full claim-fixture-completeness check across every registered surface. Returns:
 *   - results: per (surface, declaration) — { file, testFile, declaration, kind, membersFound,
 *     findings }
 *   - unresolved: declarations whose source construct could not be located at all (registry drift
 *     — the declaration was renamed/removed and CLAIM_SURFACES was not updated)
 *   - gaps: every finding across every surface where `covered` is false
 *   - withinCeiling: gaps.length <= ceiling
 */
export function runClaimFixtureCheck({ surfaces, readFile, ceiling }) {
  const results = [];
  const unresolved = [];
  const gaps = [];

  for (const surface of surfaces) {
    const sourceContent = stripComments(readFile(surface.file));
    const testContent = stripComments(readFile(surface.testFile));
    for (const declaration of surface.declarations) {
      const { membersFound, findings } = checkDeclarationCoverage({
        sourceContent,
        testContent,
        declaration,
      });
      results.push({
        file: surface.file,
        testFile: surface.testFile,
        declaration: declaration.name,
        kind: declaration.kind,
        membersFound,
        findings,
      });
      if (membersFound === null) {
        unresolved.push({ file: surface.file, declaration: declaration.name });
        continue;
      }
      for (const finding of findings) {
        if (!finding.covered) {
          gaps.push({
            file: surface.file,
            testFile: surface.testFile,
            declaration: declaration.name,
            kind: declaration.kind,
            member: finding.member,
            evidence: finding.evidence,
          });
        }
      }
    }
  }

  return {
    results,
    unresolved,
    gaps,
    ceiling,
    withinCeiling: gaps.length <= ceiling,
  };
}

// ---------------------------------------------------------------------------
// Git-tracked verification (mirrors shell-conformance-ratchet.mjs's "tracked-simulation practice")
// ---------------------------------------------------------------------------

/**
 * Verifies every CLAIM_SURFACES entry's file and testFile are actually git-tracked. Thin
 * domain-specific wrapper over the shared `assertFilesAreGitTracked`
 * (scripts/lib/ratchet-utils.mjs) — see that module's header for why this was extracted (this
 * function used to be a line-for-line duplicate of shell-conformance-ratchet.mjs's
 * `assertTrackedViewsAreGitTracked`).
 */
export function assertClaimSurfacesAreGitTracked(surfaces) {
  const allPaths = surfaces.flatMap((s) => [s.file, s.testFile]);
  return assertFilesAreGitTracked(allPaths);
}

function main() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const baselinePath = `${scriptDir}claim-fixture-baseline.json`;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

  console.log(
    'Claim-fixture ratchet (#1184 — every registered capability/liveness/identity claim surface\n' +
      'must have a test fixture per union member it renders from; gap count must only decrease).\n',
  );

  const untrackedFiles = assertClaimSurfacesAreGitTracked(CLAIM_SURFACES);
  if (untrackedFiles.length > 0) {
    console.error(
      `FAIL: ${untrackedFiles.length} CLAIM_SURFACES file(s) are not git-tracked (staged/committed) — cannot trust their content for this gate:\n`,
    );
    for (const file of untrackedFiles) console.error(`  ${file}`);
    process.exit(1);
  }

  const readFile = (file) => readFileSync(file, 'utf8');
  const recordMode = process.argv.includes('--record');

  const result = runClaimFixtureCheck({
    surfaces: CLAIM_SURFACES,
    readFile,
    ceiling: baseline.gapCeiling,
  });

  if (recordMode) {
    console.log(`RECORD: gaps=${result.gaps.length}.\n`);
    for (const r of result.results) {
      console.log(`  ${r.file} :: ${r.declaration} (${r.kind})`);
      if (r.membersFound === null) {
        console.log('    UNRESOLVED — declaration not found in source');
        continue;
      }
      for (const finding of r.findings) {
        console.log(
          `    ${finding.covered ? 'ok  ' : 'GAP '} ${finding.member}`,
        );
      }
    }
    process.exit(0);
  }

  let failed = false;

  if (result.unresolved.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${result.unresolved.length} registered declaration(s) could not be located in source (stale CLAIM_SURFACES entry):\n`,
    );
    for (const u of result.unresolved) {
      console.error(`  ${u.file} :: ${u.declaration}`);
    }
    console.error(
      "\nUpdate or remove the entry in scripts/claim-fixture-ratchet.mjs's CLAIM_SURFACES — the" +
        '\ndeclaration was renamed, restructured (e.g. a switch collapsed into an unconditional' +
        '\nreturn, which is itself exactly the #1166 shape this gate exists to catch — re-derive' +
        '\nwhether the claim is still union-gated before removing the entry), or removed.',
    );
  }

  if (result.gaps.length > 0) {
    if (result.gaps.length > result.ceiling) failed = true;
    const label =
      result.gaps.length > result.ceiling ? 'FAIL' : 'OK (within ceiling)';
    console[result.gaps.length > result.ceiling ? 'error' : 'log'](
      `${label}: ${result.gaps.length} unfixtured claim state(s) (ceiling ${result.ceiling}):\n`,
    );
    for (const gap of result.gaps) {
      const logFn =
        result.gaps.length > result.ceiling ? console.error : console.log;
      logFn(
        `  ${gap.file} :: ${gap.declaration} :: '${gap.member}' — ${gap.evidence}`,
      );
    }
    if (result.gaps.length > result.ceiling) {
      console.error(
        `\nAdd a test fixture to the paired test file (named per-surface in CLAIM_SURFACES) that` +
          `\nrenders the component for this state and asserts what it claims, or — if this is a` +
          `\ndeliberate, reasoned, already-tracked gap — raise gapCeiling in` +
          `\nscripts/claim-fixture-baseline.json with a dated reason (same discipline as` +
          `\nscripts/state-primitives-baseline.json).`,
      );
    }
  }

  if (!failed) {
    console.log(
      `\nOK: ${result.gaps.length} gap(s) <= ceiling ${result.ceiling}, ${result.unresolved.length} unresolved declaration(s).`,
    );
  }

  console.log(
    '\nReminder (see file header): this gate verifies fixture COVERAGE, not claim CORRECTNESS, and' +
      '\nonly for registered switch/Record union surfaces — it cannot catch a data-provenance defect' +
      '\n(a value that is wrong before it reaches any union) or an authorization/isolation decision' +
      '\nderived from scope inheritance. A green run is not "no unevidenced claims anywhere."',
  );

  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
