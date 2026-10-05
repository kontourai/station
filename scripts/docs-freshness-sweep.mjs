#!/usr/bin/env node
// Nightly documentation freshness sweep (#2923). Pull requests own the
// freshness of what they change; entries staled by a combination of merges
// are reported here instead of failing the merge queue or main.
//
//   node scripts/docs-freshness-sweep.mjs --report <path>
//   node scripts/docs-freshness-sweep.mjs --upsert --report <path> --repo <owner/name>
//
// --report runs the catch-up report (`docs:impact --catch-up`) plus capture
// freshness and writes ONE issue body. --upsert keeps a single tracking issue
// with a stable title current: open while anything is stale, closed when not.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { documentationCatchUp } from './documentation-impact.mjs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { checkDocumentationFreshness } from './lib/documentation-freshness.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const SWEEP_ISSUE_TITLE = 'Documentation freshness sweep';
export const SWEEP_ISSUE_LABELS = Object.freeze(['documentation', 'P2']);
const MARKER = 'docs-freshness-sweep';
/** GitHub refuses issue bodies over 65,536 characters. */
export const SWEEP_BODY_LIMIT = 60_000;

export function buildFreshnessReport({
  revision,
  generatedAt,
  staleReviews,
  staleCaptures,
  removedDependencies,
  unmappedCount,
}) {
  const staleCount =
    staleReviews.length + staleCaptures.length + removedDependencies.length;
  const head = [
    `<!-- ${MARKER} stale=${staleCount} revision=${revision} -->`,
    `# ${SWEEP_ISSUE_TITLE}`,
    '',
    `Swept \`main\` at ${revision} (${generatedAt}). Pull requests must re-review records their own diff makes stale; these entries went stale through a combination of merges or before scoped freshness existed. Review each changed input against its recorded revision (\`npm run docs:review:record -- --show-delta <path>\` prints the diff), then record it with \`npm run docs:review:record -- <path> --note "<what you checked>"\`. See [Maintaining documentation](../blob/main/docs/guides/documentation.md#keep-reviews-fresh).`,
    '',
    `Stale reviews: ${staleReviews.length}. Stale captures: ${staleCaptures.length}. Removed review coverage: ${removedDependencies.length}. Unmapped changed paths since the coverage baseline: ${unmappedCount} (see \`npm run docs:impact -- --catch-up\`).`,
    '',
  ];
  const lines = [
    ...staleReviews.map(
      (review) =>
        `- [ ] review \`${review.path}\`: ${review.changedInputs.map((input) => `\`${input}\` (reviewed ${String(review.reviewedRevisions?.[input]).slice(0, 12)})`).join(', ')}`,
    ),
    ...staleCaptures.map(
      (capture) =>
        `- [ ] capture \`${capture.path}\`: ${capture.changed.map((input) => `\`${input}\``).join(', ')}`,
    ),
    ...removedDependencies.map(
      (entry) =>
        `- [ ] removed coverage \`${entry.path}\` (record removed: ${entry.recordRemoved}): ${entry.sourcesRemoved.map((input) => `\`${input}\``).join(', ')}`,
    ),
  ];
  if (!lines.length) lines.push('_Nothing is stale._');
  const body = [...head];
  let length = body.join('\n').length;
  for (const [index, line] of lines.entries()) {
    const omitted = `\n_${lines.length - index} more entries omitted from this issue; the sweep job log lists all of them._`;
    if (length + line.length + 1 + omitted.length > SWEEP_BODY_LIMIT) {
      body.push(omitted.trim());
      break;
    }
    body.push(line);
    length += line.length + 1;
  }
  return { staleCount, body: `${body.join('\n')}\n`, lines };
}

export function reportStaleCount(report) {
  const match = new RegExp(
    `^<!-- ${MARKER} stale=(\\d+) revision=([a-f0-9]{40}) -->$`,
    'm',
  ).exec(report);
  if (!match) throw new Error(`report is missing the ${MARKER} marker`);
  return Number(match[1]);
}

function runGh(args) {
  return execFileSyncBounded('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Create, update, reopen or close the single tracking issue.
 * @param {{ repo: string, reportPath: string, gh?: (args: string[]) => string }} input
 */
export function upsertFreshnessIssue({ repo, reportPath, gh = runGh }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ''))
    throw new Error('--repo must be owner/name');
  const staleCount = reportStaleCount(readFileSync(reportPath, 'utf8'));
  const numbers = gh([
    'api',
    '--method',
    'GET',
    // Found by its stable title, not a label, so relabelling the issue
    // cannot make the next sweep open a duplicate. Search matches words;
    // the exact title is checked in the filter.
    'search/issues',
    '-f',
    `q=repo:${repo} is:issue in:title "${SWEEP_ISSUE_TITLE}"`,
    '-f',
    'per_page=100',
    '--jq',
    `.items[] | select(.pull_request == null and .title == ${JSON.stringify(SWEEP_ISSUE_TITLE)}) | .number`,
  ])
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const existing = numbers[0];
  if (existing === undefined) {
    if (!staleCount) return { action: 'none' };
    const created = gh([
      'api',
      '--method',
      'POST',
      `repos/${repo}/issues`,
      '-f',
      `title=${SWEEP_ISSUE_TITLE}`,
      '-F',
      `body=@${reportPath}`,
      ...SWEEP_ISSUE_LABELS.flatMap((label) => ['-f', `labels[]=${label}`]),
      '--jq',
      '.number',
    ]);
    return { action: 'created', number: Number(created) };
  }
  gh([
    'api',
    '--method',
    'PATCH',
    `repos/${repo}/issues/${existing}`,
    '-F',
    `body=@${reportPath}`,
    '-f',
    `state=${staleCount ? 'open' : 'closed'}`,
    ...(staleCount ? [] : ['-f', 'state_reason=completed']),
    '--jq',
    '.number',
  ]);
  return { action: staleCount ? 'updated' : 'closed', number: existing };
}

export async function collectFreshnessReport({ root = process.cwd() } = {}) {
  const catchUp = await documentationCatchUp({ root });
  const media = await checkDocumentationFreshness({
    root,
    policy: { mode: 'advisory', reason: 'Nightly sweep' },
  });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  return buildFreshnessReport({
    revision,
    generatedAt: new Date().toISOString(),
    staleReviews: catchUp.catchUp.staleReviews,
    staleCaptures: media.advisory.filter((entry) => entry.kind === 'capture'),
    removedDependencies: catchUp.catchUp.removedDependencies,
    unmappedCount: catchUp.unmappedPaths.length,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`${name} requires a value`);
    return value;
  };
  const reportPath = flag('--report');
  if (!reportPath) throw new Error('--report <path> is required');
  if (argv.includes('--upsert')) {
    const result = upsertFreshnessIssue({ repo: flag('--repo'), reportPath });
    console.log(
      `[docs-freshness-sweep] ${result.action}${result.number ? ` #${result.number}` : ''}`,
    );
    return;
  }
  const report = await collectFreshnessReport();
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report.body);
  console.log(`[docs-freshness-sweep] ${report.staleCount} stale entries`);
  for (const line of report.lines) console.log(line);
}

if (invokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      `docs-freshness-sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
