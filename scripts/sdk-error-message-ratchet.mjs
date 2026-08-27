#!/usr/bin/env node
// Zero-tolerance gate for #3749 (hand-rolled refusal messages in the SDK).
//
// The shared zod middleware answers a rejected body with
// `{ error: 'Validation failed', details: { fieldErrors } }`. The sentence
// naming the broken rule is in `details`, so a caller that reads `result.error`
// alone can only ever show the user "Validation failed" — the refusal arrives
// with its reason removed. `apiErrorMessage` (packages/sdk/src/client/
// api-error-message.ts) reads the details and falls back to the envelope's own
// message; it existed for two call sites while 152 others hand-rolled
// `result.error || 'Something failed'` beside it.
//
// The whole package was swept in #3749, so this is zero-tolerance rather than a
// counted ceiling: there is no migration left to stage, and one new hook
// written the old way is one more refusal that reaches a user with nothing to
// say. A helper nobody is required to use is a helper that goes unadopted —
// that is the state this gate was written out of.
//
// Follows the established ratchet family (pure exported functions + a `main()`
// behind `import.meta.url === file://process.argv[1]`, `git ls-files`-scoped,
// SCOPE_SENTINELS so a pathspec that stops matching fails instead of reporting
// vacuously green).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCAN_PATHSPECS = ['packages/sdk/src'];

/**
 * `api-error-message.ts` IS the helper (its own doc comment quotes the banned
 * shape), and tests must be free to construct the envelopes the helper reads.
 */
export const EXEMPT_FILES = ['packages/sdk/src/client/api-error-message.ts'];

/**
 * Files that held a hand-rolled refusal when this gate was written. If a
 * pathspec change drops one out of scope the gate fails rather than going
 * quietly green over a smaller tree (station#1559 class).
 */
export const SCOPE_SENTINELS = [
  'packages/sdk/src/query-domains/workspaceConnections.ts',
  'packages/sdk/src/query-domains/chatRuntimeOrchestration.ts',
  'packages/sdk/src/client/conversations.ts',
  'packages/sdk/src/query-domains/plugin-queries.ts',
];

/**
 * `<anything>.error ||` / `<anything>.error ??` — the envelope read that
 * discards `details`. Deliberately not anchored to `result`: the same line is
 * written against `payload`, `json`, `j`, `data` and `current` in this package,
 * and the receiver is matched as "an expression ending in a name or a closing
 * bracket" so a nested one (`state.result.error ||`) cannot slip past by being
 * spelled differently.
 */
export const HAND_ROLLED_REFUSAL = /[\w$)\]]\??\.error\s*(\|\||\?\?)/g;

export function listScannedFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'))
    .filter((line) => !line.includes('__tests__'))
    .filter((line) => !EXEMPT_FILES.includes(line));
}

export function countHandRolledRefusals(
  files,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const occurrences = [];
  for (const file of files) {
    const matches = read(file).match(HAND_ROLLED_REFUSAL);
    if (matches) occurrences.push({ file, count: matches.length });
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
  const result = evaluate(countHandRolledRefusals(files), files);

  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: sdk-error-message ratchet scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${result.total} hand-rolled refusal message(s) in packages/sdk/src.`,
    );
    console.error(
      'Reading `result.error` alone drops `details.fieldErrors`, so a schema',
    );
    console.error(
      'refusal reaches the user as "Validation failed" with the reason removed.',
    );
    console.error(
      "Use apiErrorMessage(result, '<fallback>') from packages/sdk/src/client/",
    );
    console.error('api-error-message.ts (re-exported by api-core).');
    for (const entry of result.occurrences) {
      console.error(`  ${entry.file}: ${entry.count}`);
    }
    process.exit(1);
  }
  console.log(
    `OK: 0 hand-rolled refusal messages across ${files.length} SDK source files; every refusal reads details.fieldErrors.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
