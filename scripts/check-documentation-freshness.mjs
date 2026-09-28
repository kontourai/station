#!/usr/bin/env node
// Recorded documentation review and capture freshness under the shared
// scoped/advisory/strict policy (scripts/lib/documentation-freshness.mjs).
//
//   npm run docs:freshness:check
//   STATION_DOCS_FRESHNESS_BASE=<ref> npm run docs:freshness:check
//
// Exit 1 names every stale entry this change owns; stale entries outside the
// change are printed as advisory and do not fail.
import {
  assertDocumentationFresh,
  checkDocumentationFreshness,
  formatFreshnessAdvisory,
} from './lib/documentation-freshness.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length)
    throw new Error('Usage: check-documentation-freshness.mjs (no arguments)');
  const result = await checkDocumentationFreshness();
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
