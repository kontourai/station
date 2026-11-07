#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLivenessScale } from './lib/liveness-scale-resolve.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { assertWorkspacePackageProvenance } from './workspace-dependency-provenance.mjs';

const SCRIPT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const EVIDENCE_LIMIT = 128 * 1024;
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

function retainEvidence(current, chunk) {
  const next = current + chunk;
  if (next.length <= EVIDENCE_LIMIT) return next;
  const headLength = Math.floor(EVIDENCE_LIMIT / 4);
  return `${next.slice(0, headLength)}\n[output elided]\n${next.slice(
    next.length - (EVIDENCE_LIMIT - headLength),
  )}`;
}

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..'
  );
}

export function resolveFocusedTestFiles(args, root = SCRIPT_ROOT) {
  if (!args.length) {
    throw new Error(
      'usage: npm run test:focused -- <exact-test-file> [exact-test-file ...]',
    );
  }

  const realRoot = realpathSync(root);
  return args.map((argument) => {
    if (!argument || argument.startsWith('-')) {
      throw new Error(
        `focused tests accept exact file paths, not options: ${argument || '<empty>'}`,
      );
    }
    const candidate = path.resolve(realRoot, argument);
    if (!relativeInside(realRoot, candidate)) {
      throw new Error(
        `focused test path leaves the active worktree: ${argument}`,
      );
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error(`focused test file does not exist: ${argument}`);
    }
    const realCandidate = realpathSync(candidate);
    if (!relativeInside(realRoot, realCandidate)) {
      throw new Error(
        `focused test file resolves outside the active worktree: ${argument}`,
      );
    }
    return path.relative(realRoot, candidate).split(path.sep).join('/');
  });
}

/**
 * @param {readonly string[]} args
 * @param {string} [root]
 * @param {{ testTimeoutMs?: number }} [options]
 */
export function buildFocusedVitestInvocation(
  args,
  root = SCRIPT_ROOT,
  { testTimeoutMs } = {},
) {
  if (
    testTimeoutMs !== undefined &&
    (!Number.isSafeInteger(testTimeoutMs) ||
      testTimeoutMs < 1 ||
      testTimeoutMs > 2_147_483_647)
  ) {
    throw new Error('testTimeoutMs must be a positive timer-range integer');
  }
  const realRoot = realpathSync(root);
  const files = [];
  const testNames = [];
  for (const argument of args) {
    if (!argument.startsWith('--test-name=')) {
      files.push(argument);
      continue;
    }
    const name = argument.slice('--test-name='.length);
    if (!name || name.trim() !== name || /[\r\n\0]/.test(name)) {
      throw new Error(
        '--test-name requires a nonempty fully qualified literal name',
      );
    }
    if (testNames.includes(name)) {
      throw new Error(`duplicate --test-name: ${name}`);
    }
    testNames.push(name);
  }
  const tests = resolveFocusedTestFiles(files, realRoot);
  const vitestPath = path.join(
    realRoot,
    'node_modules',
    'vitest',
    'vitest.mjs',
  );
  if (!existsSync(vitestPath)) {
    throw new Error(
      `Vitest is unavailable in ${realRoot}; install this worktree's dependencies first`,
    );
  }
  return {
    root: realRoot,
    tests,
    testNames,
    command: process.execPath,
    args: [
      vitestPath,
      'run',
      '--root',
      realRoot,
      ...tests,
      '--maxWorkers=1',
      '--no-file-parallelism',
      ...(testNames.length
        ? [
            '--testNamePattern',
            `^(?:${testNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
          ]
        : []),
      ...(testTimeoutMs === undefined
        ? []
        : [`--testTimeout=${testTimeoutMs}`]),
    ],
  };
}

/**
 * Vitest colours its own summary, and this wrapper deliberately passes that
 * output through unaltered so a human reading a focused run sees what vitest
 * printed. Anything matching on it must strip first — a plain
 * `/Test Files\s+1 passed/` cannot cross the SGR sequences and silently reads
 * as "the run did not pass" (station#1739).
 */
export function plainFocusedVitestOutput(output) {
  return output.replace(ANSI_ESCAPE, '');
}

export function inspectFocusedVitestOutput(output, expectedRoot) {
  const plain = plainFocusedVitestOutput(output);
  const runMatch = plain.match(/^\s*RUN\s+v\S+\s+(.+?)\s*$/m);
  return {
    runRoot: runMatch?.[1] ? path.resolve(runMatch[1]) : null,
    expectedRoot: realpathSync(expectedRoot),
    zeroTests: /^No test files found, exiting with code 1\s*$/im.test(plain),
  };
}

/**
 * @param {{
 *   inspection: ReturnType<typeof inspectFocusedVitestOutput>,
 *   invocation: ReturnType<typeof buildFocusedVitestInvocation>,
 *   exitCode: number | null,
 *   signal?: NodeJS.Signals | null,
 *   selectionReport?: import('vitest/reporters').JsonTestResults | null,
 * }} options
 */
export function focusedVitestVerdict({
  inspection,
  invocation,
  exitCode,
  signal = null,
  selectionReport = null,
}) {
  if (exitCode === null) {
    return {
      exitCode: 2,
      diagnostic: `Vitest did not complete${signal ? ` (signal ${signal})` : ''}: missing exit code`,
    };
  }
  if (inspection.runRoot !== inspection.expectedRoot) {
    return {
      exitCode: 2,
      diagnostic: `rejected verdict: expected RUN root ${inspection.expectedRoot}, got ${inspection.runRoot ?? 'no RUN header'}`,
    };
  }
  if (exitCode !== 0 && inspection.zeroTests) {
    return {
      exitCode: 2,
      diagnostic: `existing focused test files collected zero tests under ${invocation.root}: ${invocation.tests.join(', ')}`,
    };
  }
  if (exitCode === 0 && invocation.testNames.length) {
    const passed = selectionReport?.testResults?.flatMap((suite) =>
      suite.assertionResults.filter((test) => test.status === 'passed'),
    );
    if (
      selectionReport?.success !== true ||
      selectionReport.numFailedTests !== 0 ||
      selectionReport.numFailedTestSuites !== 0 ||
      selectionReport.numPassedTests !== invocation.testNames.length ||
      passed?.length !== invocation.testNames.length ||
      invocation.testNames.some(
        (name) => passed.filter((test) => test.fullName === name).length !== 1,
      )
    ) {
      return {
        exitCode: 2,
        diagnostic: `selected tests did not all pass exactly once: expected ${invocation.testNames.length} named cases, observed ${passed?.length ?? 0} passed`,
      };
    }
  }
  return { exitCode, diagnostic: null };
}

/**
 * @param {readonly string[]} args
 * @param {{ root?: string, spawnProcess?: typeof spawn, assertDependencyProvenance?: typeof assertWorkspacePackageProvenance, testTimeoutMs?: number }} [options]
 */
export async function runFocusedTests(
  args,
  {
    root = SCRIPT_ROOT,
    spawnProcess = spawn,
    assertDependencyProvenance = assertWorkspacePackageProvenance,
    testTimeoutMs,
  } = {},
) {
  assertDependencyProvenance({ cwd: root });
  const invocation = buildFocusedVitestInvocation(args, root, {
    testTimeoutMs,
  });
  process.stdout.write(
    `[test:focused] root=${invocation.root}; files=${invocation.tests.length}\n`,
  );

  let reportDirectory;
  let reportPath;
  if (invocation.testNames.length) {
    const reportsRoot =
      process.env.STATION_TEMP_ROOT || path.join(tmpdir(), 'station');
    mkdirSync(reportsRoot, { recursive: true });
    reportDirectory = mkdtempSync(path.join(reportsRoot, 'focused-selection-'));
    reportPath = path.join(reportDirectory, 'result.json');
    invocation.args.push(
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
    );
  }

  try {
    let evidence = '';
    let spawnError = null;
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd: invocation.root,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });

    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream?.on('data', (chunk) => {
        const text = chunk.toString();
        evidence = retainEvidence(evidence, text);
        destination.write(chunk);
      });
    }
    child.on('error', (error) => {
      spawnError = error;
    });

    const result = await new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    if (spawnError) {
      process.stderr.write(
        `[test:focused] Vitest did not complete${result.signal ? ` (signal ${result.signal})` : ''}: ${spawnError?.message ?? 'missing exit code'}\n`,
      );
      return 2;
    }

    const inspection = inspectFocusedVitestOutput(evidence, invocation.root);
    const selectionReport =
      reportPath && result.exitCode === 0
        ? JSON.parse(readFileSync(reportPath, 'utf8'))
        : null;
    const verdict = focusedVitestVerdict({
      inspection,
      invocation,
      exitCode: result.exitCode,
      signal: result.signal,
      selectionReport,
    });
    if (verdict.diagnostic) {
      process.stderr.write(`[test:focused] ${verdict.diagnostic}\n`);
    }
    if (verdict.exitCode === 0 && invocation.testNames.length) {
      process.stdout.write(
        `[test:focused] selected named cases passed: ${JSON.stringify(invocation.testNames)}\n`,
      );
    }
    return verdict.exitCode;
  } finally {
    if (reportDirectory)
      rmSync(reportDirectory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await ensureLivenessScale();
    process.exitCode = await runFocusedTests(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[test:focused] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  await main();
}
