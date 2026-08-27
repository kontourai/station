#!/usr/bin/env node
// Zero-tolerance regression gate for #200's K2 acceptance criterion
// `k2-no-kit-internal-imports` (mirrors scripts/rename-inventory.mjs's /
// scripts/unsaved-guard-gate.mjs's "ban a pattern everywhere" style, not a
// narrow one-off substring check).
//
// `@kontourai/flow-agents`'s published `package.json` `exports` map exposes
// ONLY `"."` and `"./package.json"` (verified empirically during #200's
// planning — see s200-knowledge-store--plan.md's "Evidence — the
// importability fork" section) — the Kit's `kits/knowledge/adapters/**`
// files physically exist in the installed tarball but are NOT reachable
// through any import specifier Node will resolve. Station's K2 knowledge
// store adapters are therefore from-scratch, file-format-conformant
// implementations that never import Kit internals (ADR-0001: the published
// file format is the legitimate contract surface; a deep/internal import
// would not be, even if Node allowed it).
//
// This gate bans two shapes across src-server/**, packages/**, src-ui/**:
//
//   1. Deep-import ban (DEEP_IMPORT_PATTERN): any import/require specifier
//      (or any string literal containing one, since a dynamic
//      `import(...)`/`require(...)` built from a template/concatenation
//      still contains the literal substring somewhere) reaching under
//      `@kontourai/flow-agents/kits/`, `@kontourai/flow-agents/build/`, or
//      `@kontourai/flow-agents/src/` — i.e. anything past the package's
//      declared `exports` map. Bare `@kontourai/flow-agents` and
//      `@kontourai/flow-agents/package.json` (the two actually-exported
//      entries) are NOT matched by this pattern and remain allowed — both
//      are legitimately used elsewhere in this repo today (sidecar tooling,
//      workflow.ts doc comments).
//
//   2. Filesystem-escape-hatch ban (FS_PATH_WORKAROUND_PATTERN): the
//      empirical fork this gate exists to enforce is precisely that the ESM
//      import path is blocked — a contributor might otherwise reach for a
//      raw-filesystem workaround instead, e.g.
//      `readFileSync(join('node_modules', '@kontourai', 'flow-agents',
//      'kits', ...))`. That shape never contains the single contiguous
//      substring pattern 1 bans (the path segments are separate string
//      arguments), so it needs its own heuristic: the four segment
//      literals `'node_modules'`, `'@kontourai'`, `'flow-agents'`, and one
//      of `'kits'`/`'build'`/`'src'` appearing, in that order, within a
//      bounded character window of each other (same statement/call,
//      practically speaking).
//
// Both patterns are heuristics over source text, not a full static-analysis
// pass (consistent with every other gate in this file's family) — the
// bounded windows are generous enough to catch realistic multi-line
// `join(...)` calls without false-positiving on unrelated `node_modules`/
// `@kontourai` mentions elsewhere in the tree (verified empirically: this
// repo's existing `node_modules` references, in packages/cli and
// packages/shared, are never adjacent to `@kontourai`/`flow-agents` tokens).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Matches `@kontourai/flow-agents/kits`, `/build`, or `/src` — i.e. any
// subpath past the package's declared `exports` map (`"."` and
// `"./package.json"` only). Does NOT match the bare package specifier or
// the `/package.json` subpath, both of which are legitimately exported and
// used elsewhere in this repo.
export const DEEP_IMPORT_PATTERN =
  /@kontourai\/flow-agents\/(kits|build|src)(?:\/|['"`)]|$)/;

// Matches the segmented raw-filesystem workaround: 'node_modules',
// '@kontourai', 'flow-agents', then one of 'kits'/'build'/'src' — each as
// its own quoted string literal, appearing in that order within a bounded
// window (covers both `'` and `"` quoting; a realistic multi-line
// `path.join(...)` call fits comfortably within the window).
export const FS_PATH_WORKAROUND_PATTERN =
  /['"]node_modules['"][^;]{0,150}?['"]@kontourai['"][^;]{0,150}?['"]flow-agents['"][^;]{0,150}?['"](kits|build|src)['"]/;

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
 * Scans a single file's content for banned Kit-internal-import shapes.
 * Returns an array of findings: { file, line, snippet, kind }.
 */
export function scanFileForKitInternalImports(file, content) {
  const findings = [];

  const deepImportMatch = DEEP_IMPORT_PATTERN.exec(content);
  if (deepImportMatch) {
    findings.push({
      file,
      line: lineNumberAt(content, deepImportMatch.index),
      snippet: normalizeSnippet(content, deepImportMatch.index),
      kind: 'deep-import',
    });
  }

  const fsWorkaroundMatch = FS_PATH_WORKAROUND_PATTERN.exec(content);
  if (fsWorkaroundMatch) {
    findings.push({
      file,
      line: lineNumberAt(content, fsWorkaroundMatch.index),
      snippet: normalizeSnippet(content, fsWorkaroundMatch.index),
      kind: 'fs-workaround',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// File listing (git-tracked files only, same discipline as
// rename-inventory.mjs / unsaved-guard-gate.mjs)
// ---------------------------------------------------------------------------

const SCOPED_DIRS = ['src-server', 'packages', 'src-ui'];
const SCOPED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
];

// This gate's own script file legitimately names the banned patterns in
// prose/regexes above — self-exclude it, same precedent as
// rename-inventory.mjs excluding itself.
const SELF_EXCLUDE = 'scripts/knowledge-kit-import-gate.mjs';

function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '--', ...SCOPED_DIRS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.trim().split('\n').filter(Boolean);
}

function isScopedSourceFile(file) {
  return SCOPED_EXTENSIONS.some((ext) => file.endsWith(ext));
}

export function listScopedFiles() {
  return listTrackedFiles()
    .filter(isScopedSourceFile)
    .filter((file) => file !== SELF_EXCLUDE);
}

function main() {
  console.log(
    'Knowledge Kit no-internal-imports gate (#200 k2-no-kit-internal-imports): ' +
      'zero imports/fs-reads past @kontourai/flow-agents\'s published "." entry ' +
      'across src-server/**, packages/**, src-ui/**.\n',
  );

  const files = listScopedFiles();
  const findings = files.flatMap((file) =>
    scanFileForKitInternalImports(file, readFileSync(file, 'utf8')),
  );

  if (findings.length > 0) {
    console.error(
      `FAIL: ${findings.length} Kit-internal-import violation(s) found:\n`,
    );
    for (const finding of findings) {
      console.error(
        `  [${finding.kind}] ${finding.file}:${finding.line}: ${finding.snippet}`,
      );
    }
    console.error(
      '\n@kontourai/flow-agents only exports "." and "./package.json" — reaching ' +
        'under kits/, build/, or src/ (via a deep import OR a raw-filesystem ' +
        "workaround) is an ADR-0001 violation. Implement against the Kit's " +
        'PUBLISHED FILE FORMAT instead (see docs/design/knowledge-foundation.md, ' +
        "store-contract.md), matching kit-default-store/kit-obsidian-store's " +
        'existing precedent.',
    );
    process.exit(1);
  }

  console.log(
    `OK: no Kit-internal-import violations found (${files.length} files scanned ` +
      `under ${SCOPED_DIRS.join(', ')}).`,
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
