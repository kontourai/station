#!/usr/bin/env node
// Zero-tolerance gate for station#1137 (a bare `crypto.randomUUID()` white-
// screens Station off localhost).
//
// `Crypto.randomUUID()` requires a secure context per the Web Crypto spec:
// `https:`, `http://localhost`, and `http://127.0.0.1` qualify; any other
// plain-`http://` origin does not, and the method is simply `undefined`
// there — not throwing, absent. Station listens on `0.0.0.0` by default
// (`packages/cli/src/commands/lifecycle.ts`) and ships `--allowed-origin`
// (`packages/cli/src/cli.ts`) precisely so a non-localhost origin can reach
// it, so a phone on the LAN or a `.local` hostname hits this for real. A
// bare `crypto.randomUUID()` call on a render path or at module scope threw
// `TypeError: crypto.randomUUID is not a function` there and took the whole
// app down (`ConnectionsContext`'s `useRef` initializer, station#1137).
//
// `randomCorrelationId()` (`packages/shared/src/random-id.ts`) is the one
// fallback; 32 call sites across `src-ui`, `packages/connect`,
// `packages/sdk`, and `packages/cli` were converted to it. Two sites already
// hand-rolled their own `typeof crypto.randomUUID === 'function'` guard
// before this gate existed (`browserPreviewPaneInstance.ts`,
// `filePreviewPaneInstance.ts`) — real security-shaped nonces with their own
// fallback tier, exempted below rather than converted, since they are not
// bare/unguarded. There is no migration left to stage, so this is
// zero-tolerance rather than a counted ceiling: a new bare call is one more
// crash on a real, by-design, non-localhost origin.
//
// Follows the established ratchet family (pure exported functions + a
// `main()` behind `import.meta.url === file://process.argv[1]`, `git
// ls-files`-scoped, SCOPE_SENTINELS so a pathspec that stops matching fails
// instead of reporting vacuously green). Modeled directly on
// `sdk-error-message-ratchet.mjs`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCAN_PATHSPECS = [
  'src-ui/src',
  'packages/connect/src',
  'packages/sdk/src',
  'packages/shared/src',
  'packages/cli/src',
  'packages/contracts/src',
  'packages/basis-pane/src',
  'packages/board-pane/src',
];

/**
 * Already guarded via an explicit `typeof crypto.randomUUID === 'function'`
 * branch with its own `crypto.getRandomValues` fallback tier — these predate
 * this gate (station#1137's docblock cites them as evidence that per-site
 * patching does not converge) and are real nonces, not correlation ids, so
 * they were left on `crypto.randomUUID` rather than converted to
 * `randomCorrelationId()`. `random-id.ts` is the helper itself: its own
 * fallback ladder calls through a `webCrypto` binding, not the literal
 * `crypto.randomUUID(` / `globalThis.crypto.randomUUID(` this gate bans, so
 * it does not need an exemption to pass — it is listed for documentation.
 */
export const EXEMPT_FILES = [
  'src-ui/src/workspace-panes/browserPreviewPaneInstance.ts',
  'src-ui/src/workspace-panes/filePreviewPaneInstance.ts',
  'packages/shared/src/random-id.ts',
  // Doc-comment mentions describing an id's shape (`board.ts:92,95`), not
  // executable calls — this file has no runtime `crypto.randomUUID` usage.
  'packages/contracts/src/board.ts',
];

/**
 * Files that held a bare, unguarded `crypto.randomUUID()` call when this
 * gate was written (station#1137's 32-site sweep). If a pathspec change
 * drops one out of scope the gate fails rather than going quietly green
 * over a smaller tree (station#1559 class).
 */
export const SCOPE_SENTINELS = [
  'src-ui/src/contexts/ApiBaseContext.tsx',
  'src-ui/src/hooks/useServerEvents.ts',
  'packages/connect/src/react/ConnectionsContext.tsx',
  'packages/connect/src/core/devicePairing.ts',
  'packages/sdk/src/app-config.ts',
  'packages/cli/src/commands/core.ts',
];

/**
 * A bare `crypto.randomUUID(` or `globalThis.crypto.randomUUID(` call.
 * Excludes optional-chained (`crypto?.randomUUID?.()`) and `typeof`-guarded
 * lines — the two shapes already used, independently, before
 * `randomCorrelationId()` existed — by checking the matched line's full text
 * for `?.` or `typeof` rather than trying to parse control flow.
 */
export const BARE_RANDOM_UUID = /(?:globalThis\.)?crypto\.randomUUID\s*\(/g;

export function listScannedFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .filter((line) => /\.(ts|tsx|mjs|js)$/.test(line))
    .filter((line) => !line.includes('__tests__'))
    .filter((line) => !EXEMPT_FILES.includes(line));
}

export function countBareRandomUUIDCalls(
  files,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const occurrences = [];
  for (const file of files) {
    const lines = read(file).split('\n');
    let count = 0;
    const hits = [];
    lines.forEach((line, index) => {
      if (line.includes('?.') || line.includes('typeof')) return;
      const matches = line.match(BARE_RANDOM_UUID);
      if (matches) {
        count += matches.length;
        hits.push({ line: index + 1, text: line.trim() });
      }
    });
    if (count > 0) occurrences.push({ file, count, hits });
  }
  return occurrences;
}

export function evaluate(occurrences, files) {
  const total = occurrences.reduce((sum, entry) => sum + entry.count, 0);
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    total,
    occurrences,
    missingSentinels,
    ok: missingSentinels.length === 0 && total === 0,
  };
}

function main() {
  const files = listScannedFiles();
  const result = evaluate(countBareRandomUUIDCalls(files), files);

  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: random-uuid guard scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${result.total} bare crypto.randomUUID() call(s) found.`,
    );
    console.error(
      'crypto.randomUUID() is undefined (not throwing) in an insecure context —',
    );
    console.error(
      'any http:// origin other than localhost/127.0.0.1. Station listens on',
    );
    console.error(
      '0.0.0.0 by default and ships --allowed-origin for exactly this reason,',
    );
    console.error(
      'so a bare call here white-screens a real user (station#1137).',
    );
    console.error(
      "Use randomCorrelationId() from '@kontourai/station-shared/random-id'",
    );
    console.error(
      'unless this id must be unguessable (a token, nonce, or pairing secret) —',
    );
    console.error(
      'in that case keep crypto.randomUUID() with a comment stating the secure-',
    );
    console.error(
      'context requirement, and add the file to EXEMPT_FILES here.',
    );
    for (const entry of result.occurrences) {
      console.error(`  ${entry.file}: ${entry.count}`);
      for (const hit of entry.hits) {
        console.error(`    ${entry.file}:${hit.line}: ${hit.text}`);
      }
    }
    process.exit(1);
  }
  console.log(
    `OK: 0 bare crypto.randomUUID() calls across ${files.length} scanned files.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
