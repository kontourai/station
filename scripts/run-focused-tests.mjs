#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const tests = resolveFocusedTestFiles(args, realRoot);
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
    command: process.execPath,
    args: [
      vitestPath,
      'run',
      '--root',
      realRoot,
      ...tests,
      '--maxWorkers=1',
      '--no-file-parallelism',
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

export function focusedVitestVerdict({ inspection, invocation, exitCode }) {
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
  if (spawnError || result.exitCode === null) {
    process.stderr.write(
      `[test:focused] Vitest did not complete${result.signal ? ` (signal ${result.signal})` : ''}: ${spawnError?.message ?? 'missing exit code'}\n`,
    );
    return 2;
  }

  const inspection = inspectFocusedVitestOutput(evidence, invocation.root);
  const verdict = focusedVitestVerdict({
    inspection,
    invocation,
    exitCode: result.exitCode,
  });
  if (verdict.diagnostic) {
    process.stderr.write(`[test:focused] ${verdict.diagnostic}\n`);
  }
  return verdict.exitCode;
}

async function main() {
  try {
    process.exitCode = await runFocusedTests(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[test:focused] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
