#!/usr/bin/env node
// Regression gate for #195 (editor unsaved-guard unification + kill last
// window.confirm). Two independent checks, run together:
//
//   1. No-confirm check (zero-tolerance, whole-src-ui scope, mirrors
//      scripts/rename-inventory.mjs's "ban a pattern everywhere" style):
//      bare `confirm(`/`prompt(` and `window.confirm(`/`window.prompt(` are
//      banned anywhere under src-ui/src/**. This is a *ban*, not an
//      allowlist, because native dialogs are never the right UX here — the
//      in-app `ConfirmModal` (src-ui/src/components/modals/ConfirmModal.tsx) is the
//      one sanctioned pattern for both destructive-action confirms and
//      unsaved-nav guards (via useUnsavedGuard). The pattern is careful not
//      to flag `onConfirm(`, `confirmLabel`, `ConfirmModal`, `PromptModal`,
//      etc. — it requires the literal lowercase word `confirm`/`prompt`
//      immediately followed by `(`, with nothing word-like (or `.`/`$`)
//      immediately before it (so `showConfirm(` and `.confirm(` on some
//      unrelated object are also left alone; `window.confirm(`/
//      `window.prompt(` are matched by a dedicated, explicit pattern since
//      the leading `.` would otherwise exclude them from the bare pattern).
//
//   2. Editor-membership check (honest *inclusion* gate, not a ban-list —
//      mirrors scripts/noun-consistency-gate.mjs's curated-allowlist +
//      staleness-check shape, but the direction is reversed: nothing here is
//      forbidden, a fixed set of known dirty-state editors is *required* to
//      import the hook):
//        a. A curated `KNOWN_DIRTY_STATE_EDITORS` list — the confirmed
//           dirty-state editors — each must import
//           `useUnsavedGuard`. Catches a regression on a file we already
//           know about (e.g. someone strips the import while refactoring).
//        b. A bounded, declaration-shaped heuristic scan over
//           `src-ui/src/views/**` + `src-ui/src/hooks/**` (`.ts`/`.tsx`,
//           excluding `useUnsavedGuard.tsx` itself and any `__tests__/**`
//           path) for `const dirty` / `const [dirty` / `isDirty` /
//           `hasChanges` / `hasUnsavedChanges` declarations. Any matching
//           file that is neither in `KNOWN_DIRTY_STATE_EDITORS` nor in the
//           small `KNOWN_NON_EDITOR_EXCLUSIONS` list (starts empty) is an
//           un-triaged finding: either it's a new dirty-state editor that
//           needs migrating (add it to the known list once it imports the
//           hook) or it's a legitimate non-editor false positive (add a
//           reasoned exclusion entry). Any exclusion entry that no longer
//           matches a current heuristic finding is stale and fails the gate
//           (keeps the escape hatch honest instead of accumulating dead
//           entries) — exactly like noun-consistency-gate.mjs's
//           `staleEntries` check.
//
//      This heuristic is intentionally narrow (declaration-shaped, scoped to
//      views/+hooks/) rather than a whole-repo `\bdirty\b` substring ban,
//      because a naive whole-repo grep hits real false positives in this
//      codebase today: `main.tsx`'s DOMPurify `dirty` config param, and
//      `ProjectPage.tsx`'s `project-page__git-section-dirty` CSS class name.
//      Declaration-shaped + scope-bounded avoids both without an exclusion
//      list entry being needed for either (neither is a `const`/`const [`
//      declaration of the tracked identifiers, and CSS class name strings
//      never appear as a bare declaration either).
//
//      Known, accepted limitation (documented in the #195 plan's Stop-short
//      risks): a future dirty-state editor using a differently-named flag
//      (e.g. `isModified`) would not be caught by 2b. This is a heuristic,
//      not exhaustive static analysis — mitigated by keeping the pattern
//      list easy to extend.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Check 1: no bare confirm()/prompt() or window.confirm()/window.prompt()
// ---------------------------------------------------------------------------

// Matches a bare `confirm(`/`prompt(` call: the literal lowercase word
// immediately followed by `(`, with nothing word-like (or `.`/`$`) directly
// before it. Never matches `onConfirm(`, `confirmLabel`, `ConfirmModal`,
// `PromptModal`, `showConfirm(`, or `someObj.confirm(`.
export const BARE_CONFIRM_PROMPT_PATTERN = /(?<![\w.$])(confirm|prompt)\(/g;

// Matches `window.confirm(`/`window.prompt(` explicitly — the leading `.`
// before `confirm`/`prompt` means the bare pattern above never matches
// these, so they need their own pattern.
export const WINDOW_CONFIRM_PROMPT_PATTERN = /\bwindow\.(confirm|prompt)\(/g;

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function normalizeSnippet(content, index) {
  const lineStart = content.lastIndexOf('\n', index) + 1;
  let lineEnd = content.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = content.length;
  return content.slice(lineStart, lineEnd).trim();
}

/**
 * Scans a single file's content for banned bare/window confirm()/prompt()
 * calls. Returns an array of findings: { file, line, snippet }.
 */
export function scanForBannedConfirmPrompt(file, content) {
  const findings = [];
  const seen = new Set();

  function collect(pattern) {
    pattern.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = pattern.exec(content)) !== null) {
      const key = match.index;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file,
        line: lineNumberAt(content, match.index),
        snippet: normalizeSnippet(content, match.index),
      });
    }
  }

  collect(WINDOW_CONFIRM_PROMPT_PATTERN);
  collect(BARE_CONFIRM_PROMPT_PATTERN);

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

// ---------------------------------------------------------------------------
// Check 2: editor-membership (curated list + bounded heuristic)
// ---------------------------------------------------------------------------

export const KNOWN_DIRTY_STATE_EDITORS = [
  'src-ui/src/views/ProjectSettingsView.tsx',
  'src-ui/src/views/SkillsView.tsx',
  'src-ui/src/views/agent-editor/useAgentsViewModel.ts',
  'src-ui/src/views/KnowledgeConnectionView.tsx',
  'src-ui/src/views/ProviderSettingsView.tsx',
  'src-ui/src/views/SettingsView.tsx',
  'src-ui/src/views/integrations/SecretBindingsSection.tsx',
];

// Non-editor false positives for the heuristic below. Starts empty by
// design (see file header) — every entry must be a reasoned exception, and
// stale entries (no longer matching any current heuristic finding) fail the
// gate just like an un-triaged finding does.
export const KNOWN_NON_EDITOR_EXCLUSIONS = [];

export const USE_UNSAVED_GUARD_IMPORT_PATTERN =
  /import\s*\{[^}]*\buseUnsavedGuard\b[^}]*\}\s*from\s*['"][^'"]*useUnsavedGuard['"]/;

export const DIRTY_STATE_DECLARATION_PATTERN =
  /\bconst\s*\[?\s*(dirty|isDirty|hasChanges|hasUnsavedChanges)\b/;

/**
 * Checks each file in `KNOWN_DIRTY_STATE_EDITORS` imports useUnsavedGuard.
 * Returns an array of file paths that are missing the import.
 */
export function findMissingGuardImports(files, readFile) {
  const missing = [];
  for (const file of files) {
    const content = readFile(file);
    if (!USE_UNSAVED_GUARD_IMPORT_PATTERN.test(content)) {
      missing.push(file);
    }
  }
  return missing;
}

/**
 * Scans `candidateFiles` (expected: views/**+hooks/**, .ts/.tsx, already
 * excluding useUnsavedGuard.tsx + __tests__/**) for the declaration-shaped
 * dirty-state pattern. Returns the subset of files that match.
 */
export function findDirtyStateDeclarations(candidateFiles, readFile) {
  const matches = [];
  for (const file of candidateFiles) {
    const content = readFile(file);
    if (DIRTY_STATE_DECLARATION_PATTERN.test(content)) {
      matches.push(file);
    }
  }
  return matches;
}

/**
 * Runs the full editor-membership check. Returns:
 *   - missingImports: known editors that don't import useUnsavedGuard
 *   - untriagedFindings: heuristic matches that are neither a known editor
 *     nor a declared exclusion
 *   - staleExclusions: exclusion entries that no longer match any finding
 */
export function runEditorMembershipCheck({
  knownEditors,
  exclusions,
  candidateFiles,
  readFile,
}) {
  const missingImports = findMissingGuardImports(knownEditors, readFile);
  const heuristicMatches = findDirtyStateDeclarations(candidateFiles, readFile);

  const knownSet = new Set(knownEditors);
  const exclusionSet = new Set(exclusions);
  const matchSet = new Set(heuristicMatches);

  const untriagedFindings = heuristicMatches.filter(
    (file) => !knownSet.has(file) && !exclusionSet.has(file),
  );
  const staleExclusions = exclusions.filter((file) => !matchSet.has(file));

  return { missingImports, untriagedFindings, staleExclusions };
}

// ---------------------------------------------------------------------------
// File listing helpers (git-tracked files only, same discipline as
// rename-inventory.mjs / noun-consistency-gate.mjs)
// ---------------------------------------------------------------------------

function listTrackedFilesUnder(dir) {
  // `git ls-files '<dir>/**'` lists every tracked path under `<dir>`
  // regardless of extension or depth (verified against this repo's git
  // version — an extension-suffixed pathspec like `<dir>/**/*.tsx` is *not*
  // used here because it unexpectedly excludes files directly inside `dir`
  // on this git version; listing everything and filtering the extension in
  // JS sidesteps that pathspec-glob ambiguity entirely).
  const out = execFileSync('git', ['ls-files', `${dir}/**`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.trim().split('\n').filter(Boolean);
}

function isTsOrTsx(file) {
  return file.endsWith('.ts') || file.endsWith('.tsx');
}

function listSrcUiFiles() {
  return listTrackedFilesUnder('src-ui/src').filter(isTsOrTsx);
}

function listHeuristicCandidateFiles() {
  const files = [
    ...listTrackedFilesUnder('src-ui/src/views'),
    ...listTrackedFilesUnder('src-ui/src/hooks'),
  ].filter(isTsOrTsx);
  return files.filter(
    (file) =>
      !file.includes('/__tests__/') &&
      file !== 'src-ui/src/hooks/useUnsavedGuard.tsx',
  );
}

function main() {
  const readFile = (file) => readFileSync(file, 'utf8');

  console.log(
    'Unsaved-guard gate (no bare confirm()/prompt(); known dirty-state editors import useUnsavedGuard).\n',
  );

  let failed = false;

  // --- Check 1: no-confirm ---
  const srcUiFiles = listSrcUiFiles();
  const confirmFindings = srcUiFiles.flatMap((file) =>
    scanForBannedConfirmPrompt(file, readFile(file)),
  );

  if (confirmFindings.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${confirmFindings.length} bare confirm()/prompt() (or window.confirm()/window.prompt()) call(s) found:\n`,
    );
    for (const finding of confirmFindings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    console.error(
      '\nUse the in-app ConfirmModal (src-ui/src/components/modals/ConfirmModal.tsx) instead' +
        ' — directly for a destructive-action confirm, or via useUnsavedGuard for an' +
        ' unsaved-nav guard.',
    );
  } else {
    console.log(
      `OK: no bare confirm()/prompt() calls in src-ui/src/** (${srcUiFiles.length} files scanned).`,
    );
  }

  // --- Check 2: editor membership ---
  const candidateFiles = listHeuristicCandidateFiles();
  const { missingImports, untriagedFindings, staleExclusions } =
    runEditorMembershipCheck({
      knownEditors: KNOWN_DIRTY_STATE_EDITORS,
      exclusions: KNOWN_NON_EDITOR_EXCLUSIONS,
      candidateFiles,
      readFile,
    });

  if (missingImports.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${missingImports.length} known dirty-state editor(s) missing the useUnsavedGuard import:\n`,
    );
    for (const file of missingImports) {
      console.error(`  ${file}`);
    }
  }

  if (untriagedFindings.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${untriagedFindings.length} un-triaged dirty-state declaration(s) found outside the known-editor list:\n`,
    );
    for (const file of untriagedFindings) {
      console.error(`  ${file}`);
    }
    console.error(
      '\nEither migrate the file onto useUnsavedGuard and add it to' +
        ' KNOWN_DIRTY_STATE_EDITORS in scripts/unsaved-guard-gate.mjs, or add a' +
        ' reasoned entry to KNOWN_NON_EDITOR_EXCLUSIONS if it is not really a' +
        ' dirty-state editor.',
    );
  }

  if (staleExclusions.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${staleExclusions.length} KNOWN_NON_EDITOR_EXCLUSIONS entry(ies) no longer match any heuristic finding (stale):\n`,
    );
    for (const file of staleExclusions) {
      console.error(`  ${file}`);
    }
    console.error(
      '\nRemove the stale entry(ies) from KNOWN_NON_EDITOR_EXCLUSIONS in' +
        ' scripts/unsaved-guard-gate.mjs.',
    );
  }

  if (
    missingImports.length === 0 &&
    untriagedFindings.length === 0 &&
    staleExclusions.length === 0
  ) {
    console.log(
      `OK: all ${KNOWN_DIRTY_STATE_EDITORS.length} known dirty-state editors import useUnsavedGuard; ` +
        `heuristic scan of ${candidateFiles.length} views/+hooks/ files found no un-triaged dirty-state declarations.`,
    );
  }

  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
