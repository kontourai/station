#!/usr/bin/env node
/**
 * Mobile CSS convergence gate. Responsive rules belong to the shared
 * primitives; this records the remaining page-local rules and only permits
 * them to fall. It scans tracked shipped stylesheets plus UI source for
 * CSS-in-JS at-rules, so generated output and test fixtures cannot affect the
 * gate.
 *
 * It is a NAMED allowlist, not a bare count. A count-ratchet fails on whoever
 * gates next rather than whoever caused it: a single total told the reader
 * "94 exceeds 93" and then printed all 94 locations, which names everything
 * and therefore names nothing. The baseline instead records, per file, how
 * many page-local at-rules it carries and WHY it still has any — so a new
 * query fails on the file that introduced it, with the recorded reason for
 * that file beside it, in the change that introduced it. Four things fail:
 *
 * - a page-local at-rule in a file that is in neither list (the common case:
 *   someone added responsive CSS to a page);
 * - a listed file carrying MORE than it recorded;
 * - a listed file carrying NONE (an entry that outlived its reason — delete
 *   it, do not leave it standing);
 * - an entry with no reason, or a reason too short to be one.
 *
 * The aggregate ceiling is kept as a second, weaker assertion so the total
 * cannot creep up through per-file edits alone.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// These are layout/state primitives, not page homes. Keep the allowlist at
// file granularity: exempting index.css (or a whole component directory) would
// let a page hide a responsive rule by moving it into shared-looking CSS.
export const PRIMITIVE_REASONS = {
  'src-ui/src/components/SplitPaneLayout.css':
    'the list+detail skeleton; owns the mobile detail-sheet contract every collection view inherits',
  'src-ui/src/components/page-frame/page-frame.css':
    'renders every page header; owns its one stacked mobile treatment',
  'src-ui/src/views/page-layout.css':
    'the single-page skeleton — .page roots plus the section/card/tab/row families',
  'src-ui/src/components/state/FilteredEmpty.css':
    'shared filtered-empty primitive',
  'src-ui/src/app-shell/route-pending-skeleton.css':
    'the shell placeholder; reads the destination route shape, so it is responsive by construction',
  'src-ui/src/app-shell/route-transition.css': 'the shell entrance primitive',
  'src-ui/src/tokens.css':
    'the MOTION primitive: one global prefers-reduced-motion reset plus the duration tokens every animated surface reads',
};

export const PRIMITIVE_ALLOWLIST = new Set(Object.keys(PRIMITIVE_REASONS));

export const RESPONSIVE_AT_RULE_PATTERN = /@(?:media|container)\b/g;

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function isTestFile(file) {
  return file.includes('/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(file);
}

/** Blank comments without moving offsets, so reported source lines stay true. */
export function blankComments(source) {
  const blank = (text) => text.replaceAll(/[^\n]/g, ' ');
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, blank)
    .replaceAll(/(^|[^:])\/\/[^\n]*/gm, (match, prefix) =>
      prefix === '' ? blank(match) : prefix + blank(match.slice(prefix.length)),
    );
}

export function countPageLocalResponsiveQueries(files, readFile) {
  return files.flatMap((file) => {
    if (
      isTestFile(file) ||
      (file.endsWith('.css') && PRIMITIVE_ALLOWLIST.has(file))
    ) {
      return [];
    }
    const source = blankComments(readFile(file));
    return [...source.matchAll(RESPONSIVE_AT_RULE_PATTERN)].map((match) => ({
      file,
      line: lineAt(source, match.index),
    }));
  });
}

/** The shortest text that can carry a reason; below this it is a placeholder. */
const MIN_REASON_LENGTH = 24;

export function evaluateMobileCss(findings, baseline) {
  const counts = new Map();
  for (const finding of findings) {
    counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1);
  }
  const recorded = baseline.pageLocal ?? {};
  const failures = [];
  for (const [file, count] of [...counts].sort()) {
    const entry = recorded[file];
    if (!entry) {
      failures.push(
        `${file}: ${count} page-local responsive at-rule(s), and this file is ` +
          'not recorded. Responsive behaviour belongs to the shared ' +
          'primitives (SplitPaneLayout, PageFrame, page-layout, the dialog ' +
          'surface, the form-field and state primitives). Extend the ' +
          'primitive, or record this file in scripts/mobile-css-baseline.json ' +
          'with a one-line reason it is genuinely page-specific.',
      );
      continue;
    }
    if (count > entry.count) {
      failures.push(
        `${file}: ${count} page-local responsive at-rule(s), recorded ` +
          `${entry.count}. Recorded reason: ${entry.reason}`,
      );
    }
  }
  for (const [file, entry] of Object.entries(recorded).sort()) {
    if (!counts.has(file)) {
      failures.push(
        `${file}: recorded ${entry.count} page-local responsive at-rule(s) ` +
          'but it now has none. Remove the entry — a recorded exception must ' +
          'not outlive its reason.',
      );
    }
    if (
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < MIN_REASON_LENGTH
    ) {
      failures.push(`${file}: recorded with no usable reason.`);
    }
  }
  if (findings.length > baseline.pageLocalMediaQueryCeiling) {
    failures.push(
      `total ${findings.length} page-local responsive at-rules exceeds the ` +
        `recorded ceiling ${baseline.pageLocalMediaQueryCeiling}.`,
    );
  }
  return { counts, failures };
}

export function main() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const baseline = JSON.parse(
    readFileSync(`${scriptDir}mobile-css-baseline.json`, 'utf8'),
  );
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'src-ui/src/*.css',
      'src-ui/src/**/*.css',
      'src-ui/src/*.ts',
      'src-ui/src/*.tsx',
      'src-ui/src/**/*.ts',
      'src-ui/src/**/*.tsx',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    // `git ls-files` includes an unstaged working-tree deletion. Evaluate
    // shipped files that still exist instead of crashing before the ratchet.
    .filter((file) => existsSync(file));
  const findings = countPageLocalResponsiveQueries(files, (file) =>
    readFileSync(file, 'utf8'),
  );
  const { counts, failures } = evaluateMobileCss(findings, baseline);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`mobile-css-ratchet: ${failure}`);
    }
    // Locations only for the files that actually failed, so the report names
    // the culprit rather than reprinting the whole inventory.
    const named = new Set(
      failures.map((failure) => failure.slice(0, failure.indexOf(':'))),
    );
    for (const finding of findings) {
      if (named.has(finding.file)) {
        console.error(`  ${finding.file}:${finding.line}`);
      }
    }
    process.exitCode = 1;
  }
  console.log(
    `mobile-css-ratchet: ${findings.length}/${baseline.pageLocalMediaQueryCeiling} ` +
      `page-local responsive at-rules across ${counts.size} recorded file(s); ` +
      `${PRIMITIVE_ALLOWLIST.size} primitive(s) exempt.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
