#!/usr/bin/env node
// Counted-baseline gate for #2773 (unguarded code-split surfaces).
//
// A `lazy()` import that rejects is cached by React FOREVER — the rejected
// promise is reused on every subsequent render, so nothing recovers without a
// full reload. A bare `<Suspense fallback={null}>` with no error boundary
// above it therefore turns one 404'd chunk into a blank application.
//
// That is not hypothetical: `station upgrade` and `station service install`
// rebuild `dist-ui` in place, so any tab open across a deploy requests chunk
// filenames that no longer exist. It happened five times in one session on
// 2026-08-15 while delivering builds.
//
// The repo already owns the fix — `src-ui/src/components/LazyBoundary.tsx`
// contains the pending state, catches the rejection, and retries with a
// freshly created lazy component rather than React's cached one. The gap is
// adoption, not capability: 3 files used it against 17 mounting bare when
// this gate was written. An unadopted fix regrows silently, so the count of
// bare mounts may only ever fall.
//
// Follows the established ratchet family (pure exported functions + a
// `main()` gated behind `import.meta.url === file://process.argv[1]`,
// `git ls-files`-scoped, checked-in baseline). Counted rather than
// zero-tolerance because the migration is per-call-site: `LazyBoundary` owns
// the `lazy()` creation, so each adoption restructures its call site and a
// big-bang conversion of every surface at once is its own risk.
//
// Scope-integrity note (station#1559 class): a pathspec that silently stops
// matching would make this gate vacuously green, so SCOPE_SENTINELS pins
// files that held a bare mount when the gate was introduced, and the gate
// fails if any of them falls out of the scanned list.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCAN_PATHSPECS = ['src-ui/src'];

const SCOPE_SENTINELS = [
  'src-ui/src/App.tsx',
  'src-ui/src/components/OnboardingGate.tsx',
  'src-ui/src/components/chat-dock/ChatDock.tsx',
];

const BASELINE_PATH = 'scripts/lazy-boundary-baseline.json';

/**
 * A Suspense whose fallback is `null` and which is not wrapped by
 * `LazyBoundary`. `fallback={null}` specifically: a surface that renders a
 * real pending state has been thought about, while `null` is the shape that
 * silently blanks.
 */
const BARE_SUSPENSE = /<Suspense\b[^>]*\bfallback\s*=\s*\{\s*null\s*\}[^>]*>/g;

export function listScannedFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter((line) => line.endsWith('.tsx'))
    .filter((line) => !line.includes('__tests__'));
}

export function countBareMounts(
  files,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const occurrences = [];
  for (const file of files) {
    const source = read(file);
    const matches = source.match(BARE_SUSPENSE);
    if (matches) occurrences.push({ file, count: matches.length });
  }
  return occurrences;
}

export function evaluate(occurrences, files, baseline) {
  const total = occurrences.reduce((sum, entry) => sum + entry.count, 0);
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    total,
    occurrences,
    missingSentinels,
    ceiling: baseline.bareSuspenseCeiling,
    ok: missingSentinels.length === 0 && total <= baseline.bareSuspenseCeiling,
  };
}

function main() {
  const files = listScannedFiles();
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const result = evaluate(countBareMounts(files), files, baseline);

  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: lazy-boundary ratchet scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${result.total} bare <Suspense fallback={null}> mounts exceeds the ceiling of ${result.ceiling}.`,
    );
    console.error(
      'A rejected lazy() import is cached by React permanently, so an unguarded',
    );
    console.error(
      'chunk 404 (every station upgrade rebuilds dist-ui) blanks the app until reload.',
    );
    console.error(
      'Wrap the surface in LazyBoundary (src-ui/src/components/LazyBoundary.tsx)',
    );
    console.error('rather than raising this number.');
    for (const entry of result.occurrences) {
      console.error(`  ${entry.file}: ${entry.count}`);
    }
    process.exit(1);
  }
  console.log(
    `OK: ${result.total} bare Suspense mounts (ceiling ${result.ceiling}); LazyBoundary adoption may only grow.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
