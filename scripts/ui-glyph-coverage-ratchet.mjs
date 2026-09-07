#!/usr/bin/env node
// Gate for #1649. The UI's `--font-sans` resolves to `"DM Sans", system-ui,
// sans-serif` and `src-ui/src/fonts.css` bundles latin + latin-ext subsets
// only, so every codepoint outside those subsets is drawn by whatever the
// host's fontconfig picks — or by nothing, as a tofu box. That dependency was
// real and invisible: nothing derived which codepoints it applied to, and a
// manual count of a source tree got it badly wrong in both directions
// (thousands of `─` that are `// ── section ──` comment banners and render
// zero times; ~30 glyphs that ARE drawn and were missing from the tally).
//
// This gate re-derives the inventory on every run: parse the `unicode-range`
// declarations out of `fonts.css`, strip comments from the shipped UI sources,
// and require every remaining codepoint at or above U+2000 to be either
// covered by a bundled range or listed in
// `scripts/ui-glyph-coverage-allowlist.json` under a category with a written
// reason.
//
// WHAT THIS PROVES: that every out-of-subset codepoint the UI ships is
// declared, and that adding a new one is a deliberate act with a reason
// attached rather than a silent new host dependency.
//
// WHAT IT DOES NOT PROVE: that any of those codepoints RENDERS. Nothing here
// opens a font or rasterizes a glyph. An allowlisted codepoint is one somebody
// decided to accept host fallback for, not one shown to resolve on any host.
//
// Two further limits, stated so the number is bounded rather than trusted:
//   - It treats every non-comment occurrence as rendered, so it over-counts
//     strings that never reach the DOM (a regex matching server output, a
//     log line). Over-counting is the safe direction for a gate.
//   - It cannot see a glyph composed at runtime (`String.fromCodePoint`, a
//     codepoint arriving from the server, an emoji in user content).
//
// Re-subsetting is not an available answer and the allowlist should not be
// read as deferring one: DM Sans is published in latin and latin-ext only,
// and neither standard subset reaches the geometric-shapes, arrows or
// miscellaneous-technical blocks. #1704 shrinks the `icon` category by
// replacing those glyphs with real icons.
//
// Follows the ratchet family in this directory (pure exported helpers +
// a `main()` gated behind `import.meta.url === file://process.argv[1]`,
// `git ls-files`-scoped).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  assertCoverageIntegrity,
  assertScanScope,
  collectUncovered,
  formatCodepoint,
  hasCandidateCodepoint,
  loadAllowlist,
  parseUnicodeRanges,
  reconcile,
  stripComments,
} from './lib/ui-glyph-coverage.mjs';

const FONTS_CSS = 'src-ui/src/fonts.css';
const ALLOWLIST = 'scripts/ui-glyph-coverage-allowlist.json';

// The whole tree, filtered by extension in `selectScanFiles`. A pathspec of
// the shape `src-ui/src/**/*.css` reads as "every CSS file under here" and
// is not: git's `**` requires at least one intervening directory, so it
// silently drops `src-ui/src/index.css` — the largest stylesheet in scope.
// SCOPE_SENTINELS caught exactly that while this gate was being written.
const SCAN_PATHSPECS = ['src-ui/src'];

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css'];

// Tests and stories are not shipped. A `⌘` in an assertion is a fixture, not
// a glyph the product draws, and counting them would inflate the inventory
// with exactly the kind of noise the corrected #1649 measurement removed.
const EXCLUDED = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.stories\.[cm]?[jt]sx?$/,
  /(^|\/)test-utils\//,
];

// Files that held an uncovered codepoint when this gate was written, one per
// allowlist category. If a pathspec or an exclusion silently stops matching
// one of these, the gate would go quietly green over a shrinking scan; a
// scope check that only asserted "the list is non-empty" could not see that.
const SCOPE_SENTINELS = [
  'src-ui/src/components/badges/GitBadge.tsx', // icon
  'src-ui/src/contexts/KeyboardShortcutsContext.tsx', // keycap
  'src-ui/src/index.css', // the largest CSS file in scope
];

export function selectScanFiles(files) {
  return files.filter(
    (file) =>
      SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
      !EXCLUDED.some((pattern) => pattern.test(file)),
  );
}

export function inspectFiles(files, readFile, ranges) {
  const findings = [];
  for (const file of files) {
    const raw = readFile(file);
    // Comment stripping only removes characters, so a file with no uncovered
    // codepoint in its raw bytes cannot produce one afterwards. Skipping
    // those keeps the TypeScript parser off ~95% of the corpus.
    if (!hasCandidateCodepoint(raw, ranges)) continue;
    findings.push(...collectUncovered(stripComments(raw, file), ranges, file));
  }
  return findings;
}

function main() {
  const reportOnly = process.argv.includes('--report');

  const { ranges, declarationCount } = parseUnicodeRanges(
    readFileSync(FONTS_CSS, 'utf8'),
  );
  assertCoverageIntegrity({ ranges, declarationCount });

  const tracked = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const files = selectScanFiles(tracked);
  assertScanScope(files, SCOPE_SENTINELS);

  const findings = inspectFiles(
    files,
    (file) => readFileSync(file, 'utf8'),
    ranges,
  );

  if (reportOnly) {
    const byCodepoint = new Map();
    for (const finding of findings) {
      byCodepoint.set(
        finding.codepoint,
        (byCodepoint.get(finding.codepoint) ?? 0) + 1,
      );
    }
    for (const [codepoint, count] of [...byCodepoint].sort(
      (left, right) => right[1] - left[1],
    )) {
      process.stdout.write(
        `${formatCodepoint(codepoint)}\t${String.fromCodePoint(codepoint)}\t${count}\n`,
      );
    }
    process.stdout.write(
      `# ${byCodepoint.size} distinct uncovered codepoint(s), ${findings.length} occurrence(s), ${files.length} file(s) scanned\n`,
    );
    return;
  }

  const allowlist = loadAllowlist(JSON.parse(readFileSync(ALLOWLIST, 'utf8')));
  const { unlisted, stale } = reconcile(findings, allowlist);

  if (unlisted.size > 0) {
    for (const [codepoint, occurrences] of unlisted) {
      for (const occurrence of occurrences) {
        process.stderr.write(
          `[ui-glyph-coverage] ${occurrence.file}:${occurrence.line}:${occurrence.column}: ` +
            `${formatCodepoint(codepoint)} (${occurrence.character}) is outside every bundled unicode-range and is not in ${ALLOWLIST}\n`,
        );
      }
    }
  }
  for (const codepoint of stale) {
    process.stderr.write(
      `[ui-glyph-coverage] ${ALLOWLIST}: ${formatCodepoint(codepoint)} (${String.fromCodePoint(codepoint)}) is listed but no shipped source uses it any more — remove the entry so the allowlist keeps describing the product\n`,
    );
  }

  if (unlisted.size > 0 || stale.length > 0) {
    throw new Error(
      `ui-glyph-coverage gate failed: ${unlisted.size} undeclared uncovered codepoint(s), ${stale.length} stale allowlist entry/entries. ` +
        `Either the glyph belongs in ${ALLOWLIST} with a category and a reason, or it should not be drawn as a host-resolved text character at all (#1649, #1704).`,
    );
  }

  process.stdout.write(
    `[ui-glyph-coverage] OK: ${allowlist.size} declared uncovered codepoint(s) across ${files.length} scanned file(s); 0 undeclared\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
