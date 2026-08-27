#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectWorkspaceProvenance,
  summarizeAttempts,
  updateHashFromRegularFile,
  writeReceiptSecurely,
} from './lib/test-reliability.mjs';
import {
  PREPUSH_TEST_FILES,
  PREPUSH_TEST_GROUPS,
} from './prepush-test-manifest.mjs';

const DEFAULT_OUTPUT = '.kontourai/test-reliability/prepush-latest.json';
const DEFAULT_REPEAT_OUTPUT =
  '.kontourai/test-reliability/prepush-repeat-latest.json';

export { summarizeAttempts, updateHashFromRegularFile, writeReceiptSecurely };

/** Preserve the schema-v2 pre-push provenance projection byte-for-byte. */
export function collectProvenance() {
  const workspace = collectWorkspaceProvenance();
  return {
    // Keep this insertion order as well as the values: schema-v2 receipts are
    // stored JSON evidence and existing consumers compare their bytes.
    headSha: workspace.headSha,
    dirty: workspace.dirty,
    workspaceDigest: workspace.workspaceDigest,
    manifestDigest: createHash('sha256')
      .update(JSON.stringify(PREPUSH_TEST_GROUPS))
      .digest('hex'),
    nodeVersion: workspace.nodeVersion,
    platform: workspace.platform,
    arch: workspace.arch,
    files: PREPUSH_TEST_FILES,
    vitestArguments: ['run', '--maxWorkers=1', '--no-file-parallelism'],
  };
}

export function parsePrepushOptions(args) {
  let repeat = 1;

  for (const arg of args) {
    if (arg.startsWith('--repeat=')) {
      const repeatText = arg.slice('--repeat='.length);
      repeat = /^\d+$/.test(repeatText) ? Number(repeatText) : Number.NaN;
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) {
        throw new Error('--repeat must be an integer from 1 to 100');
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    repeat,
    output: repeat === 1 ? DEFAULT_OUTPUT : DEFAULT_REPEAT_OUTPUT,
  };
}

export function buildVitestArgs() {
  return [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    ...PREPUSH_TEST_FILES,
    '--maxWorkers=1',
    '--no-file-parallelism',
  ];
}

function classifyAttempt(attempt, result, durationMs) {
  const infrastructureError = result.error || result.status === null;
  return {
    attempt,
    status: infrastructureError
      ? 'infrastructure_error'
      : result.status === 0
        ? 'passed'
        : 'failed',
    exitCode: result.status,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error
      ? {
          error: {
            name: result.error.name,
            message: result.error.message,
            ...(result.error.code ? { code: result.error.code } : {}),
          },
        }
      : {}),
    durationMs,
  };
}

function executeAttempts({ repeat, args, run, now }) {
  const attempts = [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const startedAt = now();
    process.stdout.write(`\n[prepush-tier] attempt ${attempt}/${repeat}\n`);
    const result = run(args);
    attempts.push(
      classifyAttempt(attempt, result, Math.max(0, now() - startedAt)),
    );
  }
  return attempts;
}

function buildReceipt(attempts, provenanceBefore, provenanceAfter) {
  const provenanceStable =
    JSON.stringify(provenanceBefore) === JSON.stringify(provenanceAfter);
  const summary = summarizeAttempts(attempts);
  if (!provenanceStable) summary.infrastructureErrors += 1;
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    lane: 'prepush',
    groups: Object.fromEntries(
      Object.entries(PREPUSH_TEST_GROUPS).map(([name, files]) => [
        name,
        files.length,
      ]),
    ),
    fileCount: PREPUSH_TEST_FILES.length,
    provenance: {
      stable: provenanceStable,
      before: provenanceBefore,
      after: provenanceAfter,
    },
    summary,
    attempts,
  };
}

export function runPrepushTier({
  repeat,
  output,
  run = (args) =>
    spawnSync(process.execPath, args, {
      stdio: 'inherit',
      windowsHide: true,
    }),
  now = () => Date.now(),
  provenance = collectProvenance,
  receiptRoot = process.cwd(),
}) {
  const args = buildVitestArgs();
  const provenanceBefore = provenance();
  const attempts = executeAttempts({ repeat, args, run, now });
  const receipt = buildReceipt(attempts, provenanceBefore, provenance());
  const { summary } = receipt;
  writeReceiptSecurely(
    output,
    `${JSON.stringify(receipt, null, 2)}\n`,
    receiptRoot,
  );
  process.stdout.write(
    `\n[prepush-tier] ${summary.passed}/${summary.attempts} passed; ` +
      `slowest ${(summary.slowestAttemptMs / 1000).toFixed(2)}s; ` +
      `receipt ${output}\n`,
  );
  return summary.failed === 0 && summary.infrastructureErrors === 0 ? 0 : 1;
}

function main() {
  try {
    const options = parsePrepushOptions(process.argv.slice(2));
    process.exitCode = runPrepushTier(options);
  } catch (error) {
    process.stderr.write(
      `[prepush-tier] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
