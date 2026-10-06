#!/usr/bin/env node
// Recorded documentation review and capture freshness under the shared
// scoped/advisory/strict policy (scripts/lib/documentation-freshness.mjs).
//
//   npm run docs:freshness:check
//   STATION_DOCS_FRESHNESS_BASE=<ref> npm run docs:freshness:check
//   npm run docs:freshness:check -- --json   # { mode, appendOnly, blocking, advisory } or { error: { code } }
//
// Exit 1 names every stale entry this change owns; stale entries outside the
// change are printed as advisory and do not fail.
import {
  assertDocumentationFresh,
  checkDocumentationFreshness,
  formatFreshnessAdvisory,
  isPullRequestContext,
} from './lib/documentation-freshness.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const entryJson = ({ kind, path, changed, rule }) => ({
  kind,
  path,
  changed,
  rule,
});

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  if (argv.some((arg) => arg !== '--json'))
    throw new Error('Usage: check-documentation-freshness.mjs [--json]');
  const result = await checkDocumentationFreshness();
  if (json) {
    // Machine-readable result for callers and tests (#2927): the rule and
    // entries, never the wording of the human report.
    console.log(
      JSON.stringify({
        mode: result.policy.mode,
        historyUnavailable: result.historyUnavailable,
        appendOnly: result.policy.appendOnly ?? 'not-checked',
        reviews: result.reviews.size,
        captures: result.captures.size,
        blocking: result.blocking.map(entryJson),
        advisory: result.advisory.map(entryJson),
      }),
    );
    if (result.blocking.length) process.exitCode = 1;
    return;
  }
  if (result.historyUnavailable) console.warn(result.historyUnavailable);
  if (result.policy.appendOnly === 'NOT_VERIFIED')
    console.warn(
      'Append-only notes: NOT_VERIFIED (no merge base to compare against); a deleted note would pass this run.',
    );
  else if (
    !['verified', 'not-applicable'].includes(result.policy.appendOnly) &&
    isPullRequestContext(process.env)
  )
    console.warn(
      `Append-only notes: not checked (${result.policy.mode}); a deleted note would pass this run.`,
    );
  const advisory = formatFreshnessAdvisory(result.policy, result.advisory);
  if (advisory) console.warn(advisory);
  assertDocumentationFresh(result);
  console.log(
    `Documentation freshness (${result.policy.mode}): ${result.reviews.size} reviews and ${result.captures.size} captures checked; ${result.advisory.length} advisory. ${result.policy.reason}`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (process.argv.includes('--json'))
      console.log(
        JSON.stringify({
          error: {
            ...error,
            code: error?.code ?? 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
