#!/usr/bin/env node

import { spawnSync as defaultSpawnSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  discoverVitestResourceGroups,
  ORDINARY_MAX_WORKERS,
  ordinaryVitestExcludes,
} from './vitest-resource-manifest.mjs';

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const FAILURE_LOG_TAIL_BYTES = 16 * 1024;
const SETTLEMENT_MS = 5_000;
export const PROCESS_HEAVY_MAX_WORKERS = 2;
export const ORDINARY_SHARD_COUNT = 4;

export const VITEST_CORPUS_GROUPS = Object.freeze([
  Object.freeze({ name: 'ordinary', maxWorkers: ORDINARY_MAX_WORKERS }),
  // Direct child-process use requires isolation from the four-worker ordinary
  // pool, not global serialization. Two isolated Vitest fork workers preserve
  // the reviewed resource boundary while allowing independent temp-dir/port
  // fixtures to overlap. Shared repo outputs and dogfood remain truly serial.
  Object.freeze({
    name: 'process-heavy',
    maxWorkers: PROCESS_HEAVY_MAX_WORKERS,
  }),
  Object.freeze({
    name: 'process-exclusive',
    maxWorkers: 1,
    noFileParallelism: true,
  }),
  Object.freeze({
    name: 'shared-output',
    maxWorkers: 1,
    noFileParallelism: true,
  }),
  Object.freeze({
    name: 'dogfood-reconcile',
    maxWorkers: 1,
    noFileParallelism: true,
  }),
]);

export const VITEST_CORPUS_GROUP_NAMES = Object.freeze(
  VITEST_CORPUS_GROUPS.map((group) => group.name),
);

function ordinaryShardDescriptor(shardIndex) {
  return Object.freeze({
    ...VITEST_CORPUS_GROUPS[0],
    shard: `${shardIndex}/${ORDINARY_SHARD_COUNT}`,
    resultName: `ordinary-${shardIndex}-of-${ORDINARY_SHARD_COUNT}`,
  });
}

export const ORDINARY_SHARD_DESCRIPTORS = Object.freeze(
  Array.from({ length: ORDINARY_SHARD_COUNT }, (_, index) =>
    ordinaryShardDescriptor(index + 1),
  ),
);

function corpusDescriptors(groupName, shard) {
  if (!groupName)
    return [...ORDINARY_SHARD_DESCRIPTORS, ...VITEST_CORPUS_GROUPS.slice(1)];
  if (groupName === 'ordinary') {
    const selected = ORDINARY_SHARD_DESCRIPTORS.find(
      (descriptor) => descriptor.shard === shard,
    );
    if (!selected)
      throw new Error(
        `ordinary Vitest corpus requires exactly --shard=<1-${ORDINARY_SHARD_COUNT}>/${ORDINARY_SHARD_COUNT}`,
      );
    return [selected];
  }
  if (shard) throw new Error('--shard is supported only with --group=ordinary');
  const selected = VITEST_CORPUS_GROUPS.find(
    (descriptor) => descriptor.name === groupName,
  );
  if (!selected) throw new Error(`unknown Vitest corpus group '${groupName}'`);
  return [selected];
}

function groupFiles(groups, name) {
  const keys = {
    ordinary: 'ordinary',
    'process-heavy': 'processHeavy',
    'process-exclusive': 'processExclusive',
    'shared-output': 'sharedOutput',
    'dogfood-reconcile': 'dogfoodReconcile',
  };
  return groups[keys[name]];
}

export function buildVitestCommand(
  group,
  files,
  { root = process.cwd(), ordinaryExcludes = ordinaryVitestExcludes() } = {},
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Vitest group '${group.name}' has no discovered tests`);
  }
  const command = [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    `--maxWorkers=${group.maxWorkers}`,
  ];
  if (group.name === 'ordinary') {
    if (!ORDINARY_SHARD_DESCRIPTORS.some(({ shard }) => shard === group.shard))
      throw new Error(
        `ordinary Vitest corpus requires exactly one of ${ORDINARY_SHARD_DESCRIPTORS.map(({ shard }) => `--shard=${shard}`).join(', ')}`,
      );
    return [
      ...command,
      ...ordinaryExcludes.map((pattern) => `--exclude=${pattern}`),
      `--shard=${group.shard}`,
      ...(group.noFileParallelism ? ['--no-file-parallelism'] : []),
    ];
  }
  return [
    ...command,
    ...files,
    ...(group.noFileParallelism ? ['--no-file-parallelism'] : []),
  ];
}

/**
 * Windows has no portable process-tree settlement primitive in Node.  The
 * normal owned runner therefore refuses to treat a launcher close as proof.
 * This fallback preserves the pre-existing safe behavior instead: one
 * synchronous, no-file-parallelism Vitest invocation that cannot overlap a
 * second group from this coordinator.  Its nonzero/launch/overflow outcomes
 * remain failures; it is not a synthetic tree-settlement claim.
 */
export function buildWindowsSerializedCommand({ root = process.cwd() } = {}) {
  return [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ];
}

export function runWindowsSerializedCorpus({
  root = process.cwd(),
  spawnSync = defaultSpawnSync,
  signal,
  groupName,
  shard,
  groups,
} = {}) {
  if (signal?.aborted)
    return terminalFailure(
      'windows-serialized-fallback',
      `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
    );
  let selected = null;
  try {
    selected = groupName ? corpusDescriptors(groupName, shard)[0] : null;
  } catch (error) {
    return terminalFailure('windows-serialized-fallback', error);
  }
  const args = selected
    ? buildVitestCommand(
        { ...selected, maxWorkers: 1, noFileParallelism: true },
        groupFiles(
          groups ?? discoverVitestResourceGroups({ root }),
          selected.name,
        ),
        { root },
      )
    : buildWindowsSerializedCommand({ root });
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: OUTPUT_LIMIT_BYTES,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr}`;
  const error =
    result.error ??
    (result.status === 0
      ? null
      : new Error(
          `serialized Vitest exited with status ${result.status ?? 'unknown'}`,
        ));
  return {
    name:
      selected?.resultName ?? selected?.name ?? 'windows-serialized-fallback',
    status: result.status,
    passed: result.status === 0 && !error,
    error: error ? String(error.message ?? error) : null,
    stdout,
    stderr,
    output,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    outputBytes: Buffer.byteLength(output),
  };
}

function tail(text, maxBytes = FAILURE_LOG_TAIL_BYTES) {
  const value = String(text ?? '');
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return value;
  return `[tail of ${bytes} byte(s)]\n${Buffer.from(value).subarray(-maxBytes).toString('utf8')}`;
}

function terminalFailure(name, reason) {
  return {
    name,
    status: null,
    passed: false,
    error: String(reason),
    stdout: '',
    stderr: '',
    output: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    outputBytes: 0,
  };
}

/** Run one owned process group and retain bounded diagnostics for receipts. */
export async function runVitestGroup(
  group,
  files,
  {
    root = process.cwd(),
    execute = executeOwnedProcess,
    capture = captureOwnedProcessOutput,
    terminate = terminateSuiteExecution,
    waitForSettlement = waitForSuiteSettlement,
    spawnProcess = spawn,
    signal,
  } = {},
) {
  const resultName = group.resultName ?? group.name;
  if (signal?.aborted) {
    return terminalFailure(
      resultName,
      `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
    );
  }
  const args = buildVitestCommand(group, files, { root });
  const label = `Vitest corpus ${resultName}`;
  let execution;
  try {
    execution = execute(process.execPath, args, spawnProcess, label, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return terminalFailure(resultName, error);
  }
  let cancellation = null;
  let cleanupPromise = null;
  let resolveCancellation;
  const cancellationRequested = new Promise((resolveCancellationPromise) => {
    resolveCancellation = resolveCancellationPromise;
  });
  const cancel = async (reason) => {
    cancellation ??= reason;
    resolveCancellation(cancellation);
    cleanupPromise ??= Promise.resolve()
      .then(() =>
        terminate(execution, {
          processLabel: label,
          terminationGraceMs: SETTLEMENT_MS,
          terminationForceMs: SETTLEMENT_MS,
          waitForSuiteSettlement: waitForSettlement,
        }),
      )
      .catch((error) => ({ settled: false, errors: [error] }));
    return cleanupPromise;
  };
  const output = capture(execution, {
    maxBytes: OUTPUT_LIMIT_BYTES,
    onOverflow: () =>
      void cancel(`output exceeded ${OUTPUT_LIMIT_BYTES} byte limit`),
  });
  const abort = () => void cancel(signal?.reason ?? 'aborted');
  signal?.addEventListener?.('abort', abort, { once: true });
  try {
    if (signal?.aborted) await cancel(signal.reason ?? 'aborted');
    const completion = await Promise.race([
      execution.completion.then((result) => ({ kind: 'completed', result })),
      cancellationRequested.then((reason) => ({ kind: 'cancelled', reason })),
    ]);
    if (completion.kind === 'cancelled') {
      const cleanup = await cleanupPromise;
      const captured = output.finish();
      return {
        name: resultName,
        status: null,
        passed: false,
        error: `${label} cancelled: ${completion.reason}`,
        stdout: captured.stdout.text,
        stderr: captured.stderr.text,
        output: `${captured.stdout.text}${captured.stderr.text}`,
        stdoutBytes: captured.stdout.sourceBytes,
        stderrBytes: captured.stderr.sourceBytes,
        outputBytes: captured.stdout.sourceBytes + captured.stderr.sourceBytes,
        cleanup,
      };
    }
    const result = completion.result;
    if (result.error)
      await cancel(`runner error: ${result.error.message ?? result.error}`);
    if (
      execution.isAlive() &&
      !(await waitForSettlement(execution, SETTLEMENT_MS))
    )
      await cancel('process tree remained alive');
    const cleanup = cancellation ? await cancel(cancellation) : null;
    const captured = output.finish();
    const error =
      result.error ??
      (cleanup?.settled === false
        ? new Error(`${label} left an owned process tree alive`)
        : cancellation
          ? new Error(`${label} cancelled: ${cancellation}`)
          : captured.truncated
            ? new Error(
                `${label} output exceeded ${OUTPUT_LIMIT_BYTES} byte limit`,
              )
            : null);
    return {
      name: resultName,
      status: result.status,
      passed: result.status === 0 && !error,
      error: error ? String(error.message ?? error) : null,
      stdout: captured.stdout.text,
      stderr: captured.stderr.text,
      output: `${captured.stdout.text}${captured.stderr.text}`,
      stdoutBytes: captured.stdout.sourceBytes,
      stderrBytes: captured.stderr.sourceBytes,
      outputBytes: captured.stdout.sourceBytes + captured.stderr.sourceBytes,
      cleanup,
    };
  } finally {
    signal?.removeEventListener?.('abort', abort);
  }
}

export function emitResult(result) {
  const state = result.passed ? 'PASS' : 'FAIL';
  process.stdout.write(
    `[vitest-corpus] ${result.name}: ${state}; ${result.outputBytes ?? 0} byte(s) captured\n`,
  );
  if (!result.passed) {
    process.stderr.write(
      `[vitest-corpus] ${result.name}: ${result.error ?? 'non-zero Vitest status'}\n`,
    );
    process.stdout.write(
      `[vitest-corpus] ${result.name} stdout tail:\n${tail(result.stdout ?? '') || '<empty>'}\n`,
    );
    process.stderr.write(
      `[vitest-corpus] ${result.name} stderr tail:\n${tail(result.stderr ?? '') || '<empty>'}\n`,
    );
  }
}

/** Fail fast, preserving the historical test:full behavior after a failure. */
export async function runVitestCorpus({
  root = process.cwd(),
  groups,
  runGroup = runVitestGroup,
  platform = process.platform,
  runWindowsSerialized = runWindowsSerializedCorpus,
  signal,
  onResult = emitResult,
  groupName,
  shard,
} = {}) {
  if (signal?.aborted) {
    const result = terminalFailure(
      'vitest-corpus',
      `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
    );
    onResult?.(result);
    return { passed: false, results: [result] };
  }
  const resolvedGroups = groups ?? discoverVitestResourceGroups({ root });
  const descriptors = corpusDescriptors(groupName, shard);
  const results = [];
  for (const descriptor of descriptors) {
    if (signal?.aborted) {
      const result = terminalFailure(
        descriptor.resultName ?? descriptor.name,
        `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
      );
      results.push(result);
      onResult?.(result);
      return { passed: false, results };
    }
    const files = groupFiles(resolvedGroups, descriptor.name);
    const result =
      platform === 'win32'
        ? runWindowsSerialized({
            root,
            signal,
            groupName: descriptor.name,
            shard: descriptor.shard,
            groups: resolvedGroups,
          })
        : await runGroup(descriptor, files, { root, signal });
    results.push(result);
    onResult?.(result);
    if (!result.passed) return { passed: false, results };
  }
  return { passed: results.length === descriptors.length, results };
}

export function parseVitestCorpusArguments(args) {
  if (args.length === 0) return {};
  if (args.length > 2)
    throw new Error(
      'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/4]]',
    );
  const values = new Map();
  for (const argument of args) {
    const match = argument.match(/^--(group|shard)=(.+)$/);
    if (!match || values.has(match[1]))
      throw new Error(
        'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/4]]',
      );
    values.set(match[1], match[2]);
  }
  const groupName = values.get('group');
  const shard = values.get('shard');
  if (!groupName)
    throw new Error(
      'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/4]]',
    );
  if (!VITEST_CORPUS_GROUP_NAMES.includes(groupName))
    throw new Error(`unknown Vitest corpus group '${groupName}'`);
  if (groupName === 'ordinary') {
    if (!ORDINARY_SHARD_DESCRIPTORS.some((entry) => entry.shard === shard))
      throw new Error(
        `ordinary Vitest corpus requires exactly --shard=<1-${ORDINARY_SHARD_COUNT}>/${ORDINARY_SHARD_COUNT}`,
      );
    return { groupName, shard };
  }
  if (shard) throw new Error('--shard is supported only with --group=ordinary');
  return { groupName };
}

async function main() {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    const result = await runVitestCorpus({
      ...parseVitestCorpusArguments(process.argv.slice(2)),
      signal: controller.signal,
    });
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `[vitest-corpus] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href)
  void main();
