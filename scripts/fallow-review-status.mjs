import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Findings retain the report's identity; neither a scan nor a threshold is a review. */
export function createFallowReview(sourceRevision, reports) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision))
    throw new Error('An exact source revision is required');
  const [dead, health, dupes] = reports;
  if (
    reports.length !== 3 ||
    dead?.kind !== 'dead-code' ||
    health?.kind !== 'health' ||
    dupes?.kind !== 'dupes'
  )
    throw new Error('A review requires all three whole-tree reports');
  const deadFindings = Object.entries(dead).flatMap(([kind, values]) =>
    Array.isArray(values) &&
    !['workspace_diagnostics', 'next_steps'].includes(kind)
      ? values.map((finding) => ({ kind, finding }))
      : [],
  );
  const groups = [
    [deadFindings, dead.summary?.total_issues],
    [
      health.findings?.map((finding) => ({ kind: 'complexity', finding })),
      health.summary?.functions_above_threshold,
    ],
    [
      dupes.clone_groups?.map((finding) => ({ kind: 'clone', finding })),
      dupes.stats?.clone_groups,
    ],
  ];
  if (
    groups.some(
      ([items, count]) =>
        !Array.isArray(items) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        items.length !== count,
    )
  )
    throw new Error('Finding inventory does not match the report totals');
  const findings = groups
    .flatMap(([items]) => items)
    .map(({ kind, finding }) => ({
      id: digest({ kind, finding }),
      kind,
      finding,
      status: 'pending',
      rationale: '',
      evidence: [],
    }));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length)
    throw new Error('Duplicate finding identity');
  return {
    schemaVersion: 1,
    sourceRevision,
    reportDigests: reports.map(digest),
    findings,
  };
}

/** Validates coverage and freshness, not the truth of a human's written disposition. */
export function evaluateFallowReview(
  review,
  reports,
  sourceRevision,
  workingTreeClean,
) {
  if (!workingTreeClean || review.sourceRevision !== sourceRevision)
    throw new Error('Review source is stale or the working tree is dirty');
  const inventory = createFallowReview(sourceRevision, reports);
  if (
    review.schemaVersion !== 1 ||
    JSON.stringify(review.reportDigests) !==
      JSON.stringify(inventory.reportDigests)
  )
    throw new Error('Review reports do not match');
  const expected = new Map(
    inventory.findings.map((finding) => [finding.id, finding]),
  );
  if (
    !Array.isArray(review.findings) ||
    review.findings.length !== expected.size
  )
    throw new Error('Review is missing findings');
  let pending = 0;
  let actionRequired = 0;
  for (const entry of review.findings) {
    const original = expected.get(entry.id);
    if (
      !original ||
      original.kind !== entry.kind ||
      digest(original.finding) !== digest(entry.finding)
    )
      throw new Error('Unknown, duplicate or changed finding');
    expected.delete(entry.id);
    if (
      !['pending', 'retained', 'fixed', 'action_required'].includes(
        entry.status,
      )
    )
      throw new Error('Unknown review disposition');
    if (entry.status === 'pending') pending += 1;
    else {
      if (
        typeof entry.rationale !== 'string' ||
        !entry.rationale.trim() ||
        !Array.isArray(entry.evidence) ||
        !entry.evidence.length ||
        entry.evidence.some((item) => typeof item !== 'string' || !item.trim())
      )
        throw new Error('A reviewed finding requires rationale and evidence');
      if (entry.status === 'action_required') actionRequired += 1;
    }
  }
  return {
    sourceRevision,
    total: review.findings.length,
    reviewed: review.findings.length - pending,
    pending,
    actionRequired,
    reviewCompleted: pending === 0,
    remediationCompleted: pending === 0 && actionRequired === 0,
    qualification:
      'Disposition coverage is human-authored; it does not prove an exhaustive manual source review or absence of other defects.',
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error(
        'Usage: node scripts/fallow-review-status.mjs <fallow-audit.json>',
      );
    const artifact = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    if (
      !artifact.completed ||
      artifact.scope !== 'whole-tree' ||
      !artifact.working_tree_clean
    )
      throw new Error('A clean, completed whole-tree analysis is required');
    const reports = artifact.raw_reports.map((path) =>
      JSON.parse(readFileSync(path, 'utf8')),
    );
    const review = JSON.parse(readFileSync(artifact.review, 'utf8'));
    if (review.sourceRevision !== artifact.source_revision)
      throw new Error('Review does not belong to this analysis');
    const git = (args) =>
      execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
    const result = evaluateFallowReview(
      review,
      reports,
      git(['rev-parse', 'HEAD']),
      git(['status', '--porcelain']) === '',
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.remediationCompleted) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
