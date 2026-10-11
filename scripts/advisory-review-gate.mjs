#!/usr/bin/env node
// Admission decision for the advisory PR review (#3101 I). The review engine
// costs credits per run, so it only runs for a pull request that:
//   1. is open and still at the head the triggering event saw;
//   2. was requested: the `advisory-review` label is set, or a person
//      dispatched the workflow for it. Armed auto-merge is not a request:
//      nearly every PR here is armed, and each already gets its own review;
//   3. changes something other than generated output; and
//   4. has no review (comment marker or retained result) for that exact head.
// Everything is read from the GitHub API with the workflow's read token; the
// decision never executes pull-request code. A failed read exits nonzero, so
// the review job (which needs this one) does not run.
import { appendFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { github, listGithub } from './qualification-evidence.mjs';

export const REQUEST_LABEL = 'advisory-review';
// The API stops listing at 3000 files; a full page of that size is truncated.
export const FILE_LISTING_CAP = 3000;

// Generated output and records that no reviewer reads as source. Derived from
// the repo's generators (`generate:openapi`, `docs:metrics:generate`,
// `docs:mcp:generate`, `conduit:conformance:generate`,
// `basis:mcp:generate`, the issue-lifecycle reference, the review ledger) and
// lockfiles. Grow this when a generator is added; a path not listed here is
// reviewed.
const GENERATED_PREFIXES = Object.freeze(['docs/learn/review-ledger/']);
const GENERATED_FILES = new Set([
  'docs/reference/openapi.json',
  'docs/reference/metrics.md',
  'docs/reference/issue-lifecycle.md',
  'docs/conformance/station-runtime-conformance.json',
  'docs/conformance/station-runtime-conformance.md',
  'src-server/tools/station-docs-content.ts',
]);
const LOCKFILE_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'Cargo.lock',
]);

export function isGeneratedPath(file) {
  if (typeof file !== 'string' || file === '') return false;
  if (GENERATED_FILES.has(file)) return true;
  if (GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
  const base = file.slice(file.lastIndexOf('/') + 1);
  return LOCKFILE_BASENAMES.has(base) || base.endsWith('.generated.ts');
}

export function reviewMarker(headSha) {
  return `<!-- flow-agents:codex-pr-review:${headSha} -->`;
}

export function resultArtifactName(headSha) {
  return `codex-pr-review-${headSha}`;
}

/**
 * Pure decision over lazily read facts. `readFiles` and `hasReview` are only
 * called when the cheaper checks before them pass, so a skipped pull request
 * costs as few API reads as possible. Returns `{ admit, reason }`.
 */
export async function decide({
  eventName,
  eventHeadSha,
  pr,
  readFiles,
  hasReview,
}) {
  if (pr.state !== 'open') return { admit: false, reason: 'closed' };
  if (
    eventName === 'workflow_run' &&
    (!eventHeadSha || eventHeadSha !== pr.head?.sha)
  )
    return { admit: false, reason: 'superseded-head' };
  const requested =
    eventName === 'workflow_dispatch' ||
    (pr.labels ?? []).some((label) => label.name === REQUEST_LABEL);
  if (!requested) return { admit: false, reason: 'not-requested' };
  const { files, truncated } = await readFiles();
  if (!truncated && files.every(isGeneratedPath))
    return {
      admit: false,
      reason: files.length === 0 ? 'empty-diff' : 'generated-only',
    };
  if (await hasReview(pr.head.sha))
    return { admit: false, reason: 'already-reviewed' };
  return { admit: true, reason: 'requested' };
}

async function main(env = process.env) {
  const number = env.PULL_REQUEST;
  if (!/^[1-9][0-9]*$/.test(number ?? ''))
    throw new Error('PULL_REQUEST must be a pull request number');
  const eventName = env.EVENT_NAME;
  if (!['workflow_run', 'workflow_dispatch'].includes(eventName))
    throw new Error('EVENT_NAME must be workflow_run or workflow_dispatch');
  const pr = await github(`pulls/${number}`, { env });
  const result = await decide({
    eventName,
    eventHeadSha: env.EVENT_HEAD_SHA || null,
    pr,
    readFiles: async () => {
      const files = await listGithub(`pulls/${number}/files`, null, { env });
      return {
        files: files.map((file) => file.filename),
        truncated: files.length >= FILE_LISTING_CAP,
      };
    },
    hasReview: async (headSha) => {
      const marker = reviewMarker(headSha);
      const reviews = await listGithub(`pulls/${number}/reviews`, null, {
        env,
      });
      if (
        reviews.some(
          (review) =>
            typeof review?.body === 'string' && review.body.includes(marker),
        )
      )
        return true;
      const artifacts = await listGithub(
        `actions/artifacts?name=${resultArtifactName(headSha)}`,
        'artifacts',
        { env },
      );
      return artifacts.some((artifact) => artifact.expired === false);
    },
  });
  const outputs = {
    admit: String(result.admit),
    reason: result.reason,
    same_repository: String(pr.head?.repo?.full_name === env.GITHUB_REPOSITORY),
    head_repository: pr.head?.repo?.full_name ?? '',
    number,
    head_sha: pr.head?.sha ?? '',
    base_sha: pr.base?.sha ?? '',
  };
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
  console.log(`advisory review gate: ${lines.join(' ')}`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (invokedDirectly(import.meta.url))
  main().catch((error) => {
    console.error(`advisory review gate failed: ${error.message}`);
    process.exitCode = 1;
  });
