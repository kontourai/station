#!/usr/bin/env node

import {
  spawnSync as defaultSpawnSync,
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  clipText,
  GROUP_MANIFEST_DIR_ENV,
  groupExplained,
  MANIFEST_BOUNDS,
  replaceManifestFile,
  takeManifestDirectory,
  withoutManifestLocations,
} from './lib/qualification-failure-manifest.mjs';
import { FULL_REGRESSION_PHASES } from './verification-lanes.mjs';
import { FAILURE_REPORT_OUTPUT_KEY } from './vitest-failure-reporter.mjs';
import {
  discoverVitestResourceGroups,
  ORDINARY_MAX_WORKERS,
  ordinaryVitestExcludes,
  QUARANTINED_VITEST_FILES,
  quarantinedVitestFiles,
  vitestQuarantineErrors,
} from './vitest-resource-manifest.mjs';

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const FAILURE_LOG_TAIL_BYTES = 16 * 1024;
const SETTLEMENT_MS = 5_000;
export const PROCESS_HEAVY_MAX_WORKERS = 2;
// Vitest's native hash partitioning is deterministic, but four slices left a
// passing-only hosted slice alive past its 20-minute fence (#1156). Eight
// slices preserve the exact same corpus while making every bounded terminal
// result independently observable.
export const ORDINARY_SHARD_COUNT = 8;

export const VITEST_CORPUS_GROUPS = Object.freeze([
  Object.freeze({ name: 'ordinary', maxWorkers: ORDINARY_MAX_WORKERS }),
  // Direct child-process use requires isolation from the ordinary worker
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
    name: 'coordinator-exclusive',
    maxWorkers: 1,
    noFileParallelism: true,
  }),
  Object.freeze({
    name: 'credential-ledger-exclusive',
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

/**
 * The process-heavy group can be split across machines (full qualification
 * runs it as three hosted matrix legs). Each slice keeps the
 * group's own per-machine worker bound; only the file list is partitioned.
 * The canonical `full:regression` never passes a shard and still runs the
 * whole group in one invocation.
 */
export const PROCESS_HEAVY_MAX_SHARD_COUNT = 8;

function parseProcessHeavyShard(shard) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(shard ?? ''));
  const index = match ? Number(match[1]) : Number.NaN;
  const count = match ? Number(match[2]) : Number.NaN;
  if (
    !match ||
    count < 2 ||
    count > PROCESS_HEAVY_MAX_SHARD_COUNT ||
    index > count
  )
    throw new Error(
      `process-heavy Vitest corpus accepts only --shard=<k>/<n> with 2 <= n <= ${PROCESS_HEAVY_MAX_SHARD_COUNT} and 1 <= k <= n`,
    );
  return { index, count };
}

/**
 * Deterministic, disjoint, exhaustive partition: files are sorted, then dealt
 * round-robin, so every file lands in exactly one slice and the union of all
 * slices is the group. An empty slice is an error rather than a vacuous pass.
 */
export function partitionShardFiles(files, shard) {
  const { index, count } = parseProcessHeavyShard(shard);
  const selected = [...files]
    .sort()
    .filter((_, position) => position % count === index - 1);
  if (selected.length === 0)
    throw new Error(
      `process-heavy shard ${shard} selected no files from ${files.length} discovered`,
    );
  return selected;
}

function processHeavyShardDescriptor(shard) {
  const { index, count } = parseProcessHeavyShard(shard);
  return Object.freeze({
    ...VITEST_CORPUS_GROUPS[1],
    shard: `${index}/${count}`,
    resultName: `process-heavy-${index}-of-${count}`,
  });
}

/** The files one descriptor runs: the whole group, or its partitioned slice. */
export function descriptorFiles(groups, descriptor) {
  const files = groupFiles(groups, descriptor.name);
  return descriptor.name === 'process-heavy' && descriptor.shard
    ? partitionShardFiles(files, descriptor.shard)
    : files;
}

/**
 * The resource-profiled execution plan: every ordinary hash shard, then each
 * serialized group, in canonical order. With no selector this is the whole
 * corpus, each file reached by exactly one entry (the groups are an exact
 * partition, and the ordinary shards are Vitest's own exhaustive hash split).
 *
 * @param {string} [groupName]
 * @param {string} [shard]
 * @returns {ReadonlyArray<{ name: string; maxWorkers: number; noFileParallelism?: boolean; shard?: string; resultName?: string }>}
 */
export function corpusDescriptors(groupName, shard) {
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
  if (groupName === 'process-heavy' && shard)
    return [processHeavyShardDescriptor(shard)];
  if (shard)
    throw new Error(
      '--shard is supported only with --group=ordinary or --group=process-heavy',
    );
  const selected = VITEST_CORPUS_GROUPS.find(
    (descriptor) => descriptor.name === groupName,
  );
  if (!selected) throw new Error(`unknown Vitest corpus group '${groupName}'`);
  return [selected];
}

export function groupFiles(groups, name) {
  const keys = {
    ordinary: 'ordinary',
    'process-heavy': 'processHeavy',
    'process-exclusive': 'processExclusive',
    'coordinator-exclusive': 'coordinatorExclusive',
    'credential-ledger-exclusive': 'credentialLedgerExclusive',
    'shared-output': 'sharedOutput',
    'dogfood-reconcile': 'dogfoodReconcile',
  };
  return groups[keys[name]];
}

/**
 * Merge-queue only (`--exclude-quarantined`): the resource groups with every
 * quarantined file removed. The canonical lane never calls this, so Nightly
 * still runs quarantined files.
 *
 * Fails closed instead of excluding anything when the quarantine policy does
 * not hold at run time, most importantly an EXPIRED entry: the policy gate
 * checks expiry only when a pull request or queue candidate runs it, and an
 * entry that expires between those runs must turn the queue phase itself
 * red rather than keep hiding its file. A quarantined path missing from the
 * groups also fails: an entry that excludes nothing is a stale record.
 */
export function withoutQuarantinedFiles(
  groups,
  quarantine,
  { now = new Date() } = {},
) {
  const policyErrors = vitestQuarantineErrors(quarantine, { now });
  if (policyErrors.length > 0)
    throw new Error(
      `test quarantine does not hold; nothing was excluded:\n${policyErrors.join('\n')}`,
    );
  const excluded = new Set(quarantinedVitestFiles(quarantine));
  const present = new Set(Object.values(groups).flat());
  for (const file of excluded)
    if (!present.has(file))
      throw new Error(
        `quarantined file is not in the discovered Vitest corpus: ${file}`,
      );
  return Object.freeze(
    Object.fromEntries(
      Object.entries(groups).map(([name, files]) => [
        name,
        Object.freeze(files.filter((file) => !excluded.has(file))),
      ]),
    ),
  );
}

function escapeWorkflowCommandData(text) {
  return String(text)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

/**
 * What one queue run excluded, as GitHub annotations (one `::notice::` per
 * file, visible on the run page) and step-summary lines. A skipped test must
 * never be silent: a partially quarantined group otherwise passes with no
 * sign that part of it did not run.
 */
export function quarantineExclusionReport(runName, entries) {
  return {
    annotations: entries.map(
      ({ file, issue, expires }) =>
        `::notice title=Quarantined test excluded::${escapeWorkflowCommandData(
          `${file} was excluded from merge-queue run ${runName} (quarantined until ${expires}, ${issue}); Nightly still runs it.`,
        )}`,
    ),
    summary: entries.map(
      ({ file, issue, expires }) =>
        `- \`${file}\` excluded from \`${runName}\` (quarantined until ${expires}, ${issue}); Nightly still runs it.`,
    ),
  };
}

/** Default reporter: annotations to stdout, lines to the job step summary. */
export function reportQuarantineExclusions(
  report,
  {
    env = process.env,
    write = (text) => process.stdout.write(text),
    append = appendFileSync,
  } = {},
) {
  for (const annotation of report.annotations) write(`${annotation}\n`);
  if (env.GITHUB_STEP_SUMMARY && report.summary.length > 0)
    append(env.GITHUB_STEP_SUMMARY, `${report.summary.join('\n')}\n`);
}

/**
 * Coverage arguments for one corpus slice. Each slice writes only istanbul
 * JSON into its own directory, and the configured thresholds are neutralised
 * here because one slice exercises a fraction of the code: they are enforced
 * once, on the merged report (scripts/run-coverage-corpus.mjs). Vitest's
 * default `reportOnFailure: false` stays in force, so a slice whose tests
 * failed leaves no report and the merge refuses it.
 */
export function coverageSliceArguments(reportsDirectory) {
  if (typeof reportsDirectory !== 'string' || reportsDirectory.length === 0)
    throw new Error('coverage slice requires a reports directory');
  return [
    '--coverage.enabled=true',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${reportsDirectory}`,
    '--coverage.clean=true',
    '--coverage.thresholds.lines=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.statements=0',
  ];
}

/**
 * @param {{ name: string; maxWorkers: number; noFileParallelism?: boolean; shard?: string }} group
 * @param {readonly string[]} files
 * @param {{ root?: string; ordinaryExcludes?: readonly string[]; coverageDirectory?: string; failureReportJson?: string; failureReport?: string; env?: NodeJS.ProcessEnv }} [options]
 */
export function buildVitestCommand(
  group,
  files,
  {
    root = process.cwd(),
    ordinaryExcludes = ordinaryVitestExcludes(),
    coverageDirectory,
    // Set only when a qualification failure manifest is requested: adds
    // Vitest's own JSON reporter (writing to this file, not the terminal)
    // and the failure-identity reporter beside the group's usual reporters.
    // Both report paths travel as Vitest options, never as environment, so
    // test workers and anything they spawn cannot see or overwrite them.
    failureReportJson,
    failureReport,
    env = process.env,
  } = {},
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Vitest group '${group.name}' has no discovered tests`);
  }
  const command = [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    `--maxWorkers=${group.maxWorkers}`,
    ...(coverageDirectory === undefined
      ? []
      : coverageSliceArguments(coverageDirectory)),
  ];
  const manifestReporters =
    failureReportJson === undefined
      ? []
      : [
          '--reporter=json',
          `--outputFile.json=${failureReportJson}`,
          `--reporter=${resolve(root, 'scripts/vitest-failure-reporter.mjs')}`,
          ...(failureReport === undefined
            ? []
            : [`--outputFile.${FAILURE_REPORT_OUTPUT_KEY}=${failureReport}`]),
        ];
  if (group.name === 'ordinary') {
    if (!ORDINARY_SHARD_DESCRIPTORS.some(({ shard }) => shard === group.shard))
      throw new Error(
        `ordinary Vitest corpus requires exactly one of ${ORDINARY_SHARD_DESCRIPTORS.map(({ shard }) => `--shard=${shard}`).join(', ')}`,
      );
    return [
      ...command,
      '--reporter=default',
      `--reporter=${resolve(root, 'scripts/vitest-inflight-reporter.mjs')}`,
      ...manifestReporters,
      ...ordinaryExcludes.map((pattern) => `--exclude=${pattern}`),
      `--shard=${group.shard}`,
      ...(group.noFileParallelism ? ['--no-file-parallelism'] : []),
    ];
  }
  // A --reporter flag replaces Vitest's defaults. When the manifest adds
  // reporters to a group that names none, keep the defaults Vitest would
  // otherwise choose (default, plus github-actions inside GitHub Actions).
  const defaultReporters =
    manifestReporters.length === 0
      ? []
      : [
          '--reporter=default',
          ...(env.GITHUB_ACTIONS === 'true'
            ? ['--reporter=github-actions']
            : []),
        ];
  return [
    ...command,
    ...(group.name === 'process-exclusive'
      ? [
          '--reporter=default',
          `--reporter=${resolve(root, 'scripts/vitest-inflight-reporter.mjs')}`,
        ]
      : defaultReporters),
    ...manifestReporters,
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
  timeoutMs,
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
        descriptorFiles(
          groups ?? discoverVitestResourceGroups({ root }),
          selected,
        ),
        { root },
      )
    : buildWindowsSerializedCommand({ root });
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
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
    signal: result.signal ?? null,
    outputTruncated: result.error?.code === 'ENOBUFS',
    passed: result.status === 0 && !error,
    ...(result.signal || result.error?.code === 'ETIMEDOUT'
      ? { cancelled: true }
      : {}),
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

function terminalFailure(name, reason, { cancelled = false } = {}) {
  return {
    name,
    status: null,
    signal: null,
    passed: false,
    cancelled,
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
async function runVitestGroupOnce(
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
    coverageDirectory,
    ordinaryExcludes,
    failureReportJson,
    failureReport,
    extraEnv = {},
  } = {},
) {
  const resultName = group.resultName ?? group.name;
  if (signal?.aborted) {
    return terminalFailure(
      resultName,
      `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
    );
  }
  const args = buildVitestCommand(group, files, {
    root,
    coverageDirectory,
    failureReportJson,
    failureReport,
    ...(ordinaryExcludes ? { ordinaryExcludes } : {}),
  });
  const label = `Vitest corpus ${resultName}`;
  let execution;
  try {
    execution = execute(process.execPath, args, spawnProcess, label, {
      cwd: root,
      // No test process has any reason to know where a qualification
      // manifest goes: a runner a test spawns would otherwise write its
      // fixture entries into the real job's directory.
      env: withoutManifestLocations({
        ...process.env,
        ...extraEnv,
        STATION_VITEST_CORPUS_GROUP: group.name,
      }),
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
  // Only an EXTERNAL abort (the coordinator's deadline, or SIGINT/SIGTERM) is
  // a cancellation. The other paths through `cancel` -- an output-limit
  // overflow, a runner error, a process tree that would not settle -- are real
  // failures of this group, and reporting them as "cancelled" would excuse a
  // genuine defect. Track which one fired rather than inferring from the
  // reason string.
  let signalAborted = false;
  const abort = () => {
    signalAborted = true;
    void cancel(signal?.reason ?? 'aborted');
  };
  signal?.addEventListener?.('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      signalAborted = true;
      await cancel(signal.reason ?? 'aborted');
    }
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
        signal: null,
        outputTruncated: captured.truncated,
        passed: false,
        cancelled: signalAborted,
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
      signal: result.signal ?? null,
      outputTruncated: captured.truncated,
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

function readReport(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { missing: true };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

/** Classify the corpus runner's own failure of a group, not its tests. */
function runnerErrorKind(result) {
  const error = result.error ?? '';
  if (
    result.cleanup?.settled === false ||
    /process tree (?:remained|alive)/.test(error)
  )
    return 'process-tree-alive';
  if (result.outputTruncated || /output exceeded/.test(error))
    return 'output-limit';
  if (result.cancelled || /\bcancelled\b/.test(result.error ?? ''))
    return 'cancelled';
  return 'runner-error';
}

/**
 * The failure-manifest entry for one group invocation. Test identities come
 * from the failure reporter; the counts they are reconciled against come
 * from Vitest's own JSON reporter, a separate implementation. Everything the
 * runner itself saw go wrong is a runner error, which leaves the group
 * unexplained.
 */
export function vitestGroupManifest(
  result,
  { failureReport, jsonReport, setupError = null },
) {
  const runnerErrors = [];
  const fail = (kind, message) =>
    runnerErrors.push({ kind, message: clipText(message) });
  if (setupError) fail('failure-reporter-unavailable', setupError);
  if (result.error) fail(runnerErrorKind(result), result.error);
  if (
    result.status !== null &&
    result.status !== undefined &&
    result.status !== 0 &&
    result.status !== 1
  )
    fail(
      'unexpected-exit-status',
      `Vitest exited with status ${result.status}`,
    );
  const failures = readReport(failureReport);
  const json = readReport(jsonReport);
  if (failures.missing)
    fail(
      'failure-report-missing',
      'the failure-identity reporter wrote no report',
    );
  if (failures.invalid !== undefined)
    fail('failure-report-invalid', failures.invalid);
  if (json.missing)
    fail('json-report-missing', 'the Vitest JSON reporter wrote no report');
  if (json.invalid !== undefined) fail('json-report-invalid', json.invalid);
  const report = failures.value ?? {};
  if (failures.value && report.reporterError !== undefined)
    fail('failure-reporter-error', report.reporterError);
  else if (
    failures.value &&
    report.reason !== 'passed' &&
    report.reason !== 'failed'
  )
    fail('run-interrupted', `Vitest ended its run as ${report.reason}`);
  const valid = (list) => (Array.isArray(list) ? list : []);
  let failedTests = valid(report.failedTests).map((test) => ({
    file: clipText(test.file),
    titlePath: valid(test.titlePath)
      .slice(0, MANIFEST_BOUNDS.titlePathDepth)
      .map(clipText),
  }));
  if (failedTests.length > MANIFEST_BOUNDS.failedTestsPerGroup) {
    fail(
      'failed-tests-over-bound',
      `${failedTests.length} failed tests exceed the manifest bound`,
    );
    failedTests = failedTests.slice(0, MANIFEST_BOUNDS.failedTestsPerGroup);
  }
  let failedFiles = valid(report.failedFiles).map((file) => ({
    file: clipText(file.file),
    reason: file.reason === 'load' ? 'load' : 'suite',
  }));
  if (failedFiles.length > MANIFEST_BOUNDS.failedFilesPerGroup) {
    fail(
      'failed-files-over-bound',
      `${failedFiles.length} failed files exceed the manifest bound`,
    );
    failedFiles = failedFiles.slice(0, MANIFEST_BOUNDS.failedFilesPerGroup);
  }
  const counts = {
    reporterFailedTests: Number.isSafeInteger(json.value?.numFailedTests)
      ? json.value.numFailedTests
      : null,
    reporterFailedFiles: Array.isArray(json.value?.testResults)
      ? json.value.testResults.filter((entry) => entry?.status === 'failed')
          .length
      : null,
    unhandledErrors: Number.isSafeInteger(report.unhandledErrors)
      ? report.unhandledErrors
      : null,
  };
  const group = {
    group: clipText(result.name),
    exitStatus: Number.isSafeInteger(result.status) ? result.status : null,
    signal: result.signal ? clipText(result.signal) : null,
    failedTests,
    failedFiles,
    runnerErrors: runnerErrors.slice(0, MANIFEST_BOUNDS.runnerErrorsPerGroup),
    counts,
    explained: false,
  };
  group.explained = groupExplained(group);
  return group;
}

/**
 * Run one group, and when a manifest directory is given, write its manifest
 * entry there whatever happens. Vitest's reports go to a temporary directory
 * outside the workspace, so the phase driver's workspace check is unaffected.
 */
export async function runVitestGroup(group, files, options = {}) {
  const { manifestDirectory, ...rest } = options;
  if (!manifestDirectory) return runVitestGroupOnce(group, files, rest);
  // The manifest is evidence about a run and must never change one: if its
  // machinery fails, the group runs and reports exactly as it would without
  // it, and the missing or unexplained entry makes the job alert.
  let reports;
  try {
    reports = mkdtempSync(resolve(tmpdir(), 'station-vitest-manifest-'));
  } catch (error) {
    process.stderr.write(
      `[vitest-corpus] failure manifest unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return runVitestGroupOnce(group, files, rest);
  }
  const failureReport = resolve(reports, 'failures.json');
  const jsonReport = resolve(reports, 'vitest.json');
  // A reporter Vitest cannot load fails the whole run, so load it here
  // first. If it cannot be loaded the group runs exactly as with the gate
  // off and its entry records why, which leaves it unexplained.
  let setupError = null;
  try {
    const reporter = await import(
      pathToFileURL(
        resolve(
          rest.root ?? process.cwd(),
          'scripts/vitest-failure-reporter.mjs',
        ),
      ).href
    );
    if (typeof reporter.default !== 'function')
      throw new Error('the failure reporter has no default export');
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }
  let result;
  try {
    result = setupError
      ? await runVitestGroupOnce(group, files, rest)
      : await runVitestGroupOnce(group, files, {
          ...rest,
          failureReportJson: jsonReport,
          failureReport,
        });
    return result;
  } catch (error) {
    result = terminalFailure(group.resultName ?? group.name, error);
    throw error;
  } finally {
    try {
      const entry = vitestGroupManifest(result, {
        failureReport,
        jsonReport,
        setupError,
      });
      mkdirSync(manifestDirectory, { recursive: true });
      replaceManifestFile(
        resolve(manifestDirectory, `${basename(entry.group)}.json`),
        `${JSON.stringify(entry, null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `[vitest-corpus] could not write the failure manifest: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      rmSync(reports, { recursive: true, force: true });
    }
  }
}

export function emitResult(result, { diagnosticDirectory } = {}) {
  // FAIL is a claim about the tests. A cancelled group made no such claim: it
  // was killed by the coordinator's deadline or a signal, so its suite never
  // reached a verdict and the captured bytes are a partial transcript rather
  // than a result. Printing FAIL there sent readers hunting for a broken test
  // that does not exist -- it cost this repository eight consecutive releases,
  // where a 45-minute phase deadline was reported as a test failure whose
  // names were, necessarily, nowhere in the receipt.
  const cancelled = !result.passed && result.cancelled === true;
  const state = result.passed ? 'PASS' : cancelled ? 'CANCELLED' : 'FAIL';
  process.stdout.write(
    `[vitest-corpus] ${result.name}: ${state}; ${result.outputBytes ?? 0} byte(s) captured\n`,
  );
  if (!cancelled) {
    const totals = stripVTControlCharacters(result.stdout ?? '')
      .split('\n')
      .filter((line) => /^\s*(?:Test Files|Tests)\s/.test(line));
    for (const line of totals)
      process.stdout.write(`[vitest-corpus] ${result.name}: ${line.trim()}\n`);
  }
  if (cancelled)
    process.stdout.write(
      `[vitest-corpus] ${result.name}: no test results were produced — the run did not complete, so the capture below is a partial transcript and names no failing test.\n`,
    );
  if (result.skipped)
    process.stdout.write(`[vitest-corpus] ${result.name}: ${result.skipped}\n`);
  if (!result.passed) {
    process.stderr.write(
      `[vitest-corpus] ${result.name}: status=${result.status ?? 'null'}; signal=${result.signal ?? 'none'}\n`,
    );
    process.stderr.write(
      `[vitest-corpus] ${result.name}: ${result.error ?? 'non-zero Vitest status'}\n`,
    );
    const headings = stripVTControlCharacters(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
      .split('\n')
      .filter((line) =>
        /^\s*FAIL\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s+>|\s*$)/.test(line),
      );
    if (headings.length)
      process.stderr.write(
        `[vitest-corpus] ${result.name} failure headings:\n${headings
          .slice(0, 32)
          .map((line) => line.slice(0, 1_024))
          .join('\n')}\n`,
      );
    process.stdout.write(
      `[vitest-corpus] ${result.name} stdout tail:\n${tail(result.stdout ?? '') || '<empty>'}\n`,
    );
    process.stderr.write(
      `[vitest-corpus] ${result.name} stderr tail:\n${tail(result.stderr ?? '') || '<empty>'}\n`,
    );
    if (diagnosticDirectory) {
      mkdirSync(diagnosticDirectory, { recursive: true });
      const directory = mkdtempSync(
        resolve(diagnosticDirectory, `${result.name}-`),
      );
      writeFileSync(resolve(directory, 'stdout.log'), result.stdout ?? '');
      writeFileSync(resolve(directory, 'stderr.log'), result.stderr ?? '');
      writeFileSync(
        resolve(directory, 'receipt.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            invocationId: basename(directory),
            group: result.name,
            passed: false,
            status: result.status ?? null,
            signal: result.signal ?? null,
            cancelled: result.cancelled === true,
            outputTruncated: result.outputTruncated === true,
            stdoutBytes: result.stdoutBytes ?? 0,
            stderrBytes: result.stderrBytes ?? 0,
            error: result.error ?? null,
            cleanup: result.cleanup ?? null,
          },
          null,
          2,
        ),
      );
      process.stderr.write(
        `[vitest-corpus] ${result.name} retained diagnostics: ${directory}\n`,
      );
    }
  }
}

/** Default fail-fast; audits can collect independent failures without claiming a pass. */
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
  keepGoing = false,
  // Coverage mode: each slice writes its istanbul JSON under
  // `<coverageRoot>/<result name>/`. There is no Windows coverage path; the
  // serialized fallback runs one undifferentiated corpus.
  coverageRoot,
  // Multiplies each cataloged group deadline in keep-going mode, for work
  // (coverage instrumentation) that is slower than the canonical phase.
  timeoutScale = 1,
  excludeQuarantined = false,
  quarantine = QUARANTINED_VITEST_FILES,
  now = new Date(),
  reportExclusions = reportQuarantineExclusions,
  // Where each group writes its qualification failure-manifest entry; unset
  // outside hosted qualification, where no manifest is written.
  manifestDirectory,
} = {}) {
  if (coverageRoot !== undefined && platform === 'win32')
    throw new Error('Vitest corpus coverage is not supported on Windows');
  if (!(Number.isFinite(timeoutScale) && timeoutScale >= 1))
    throw new Error('Vitest corpus timeoutScale must be a finite number >= 1');
  if (signal?.aborted) {
    const result = terminalFailure(
      'vitest-corpus',
      `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
      { cancelled: true },
    );
    onResult?.(result);
    return { passed: false, results: [result] };
  }
  if (excludeQuarantined && platform === 'win32')
    throw new Error(
      '--exclude-quarantined is supported only by the owned (non-Windows) runner',
    );
  const discoveredGroups = groups ?? discoverVitestResourceGroups({ root });
  const resolvedGroups = excludeQuarantined
    ? withoutQuarantinedFiles(discoveredGroups, quarantine, { now })
    : discoveredGroups;
  const quarantined = quarantinedVitestFiles(quarantine);
  const quarantineOptions =
    excludeQuarantined && quarantined.length > 0
      ? {
          ordinaryExcludes: Object.freeze([
            ...ordinaryVitestExcludes(),
            ...quarantined,
          ]),
        }
      : {};
  const descriptors = corpusDescriptors(groupName, shard);
  const results = [];
  for (const descriptor of descriptors) {
    if (signal?.aborted) {
      const result = terminalFailure(
        descriptor.resultName ?? descriptor.name,
        `Vitest corpus cancelled: ${signal.reason ?? 'aborted'}`,
        { cancelled: true },
      );
      results.push(result);
      onResult?.(result);
      return { passed: false, results };
    }
    if (excludeQuarantined) {
      const excludedHere = new Set(
        groupFiles(discoveredGroups, descriptor.name),
      );
      const excludedEntries = quarantine.filter(({ file }) =>
        excludedHere.has(file),
      );
      if (excludedEntries.length > 0)
        reportExclusions(
          quarantineExclusionReport(
            descriptor.resultName ?? descriptor.name,
            excludedEntries,
          ),
        );
    }
    if (
      excludeQuarantined &&
      (groupFiles(resolvedGroups, descriptor.name) ?? []).length === 0 &&
      (groupFiles(discoveredGroups, descriptor.name) ?? []).length > 0
    ) {
      const result = {
        name: descriptor.resultName ?? descriptor.name,
        status: 0,
        passed: true,
        error: null,
        skipped:
          'every file in this group is quarantined; Nightly still runs them',
        stdout: '',
        stderr: '',
        output: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        outputBytes: 0,
      };
      results.push(result);
      onResult?.(result);
      continue;
    }
    const files = descriptorFiles(resolvedGroups, descriptor);
    // A process-heavy slice has no phase of its own, so each slice gets the
    // whole group's phase budget. The budget applies per slice, not shared
    // across the slices of one run.
    const phase =
      FULL_REGRESSION_PHASES.find(
        (entry) =>
          entry.id === `test-full-${descriptor.resultName ?? descriptor.name}`,
      ) ??
      (descriptor.name === 'process-heavy'
        ? FULL_REGRESSION_PHASES.find(
            (entry) => entry.id === 'test-full-process-heavy',
          )
        : undefined);
    if (keepGoing && !phase)
      throw new Error('Audit group has no declared execution budget');
    const groupController = keepGoing ? new AbortController() : null;
    const abortGroup = () => groupController?.abort(signal?.reason);
    signal?.addEventListener('abort', abortGroup, { once: true });
    const timer = groupController
      ? setTimeout(
          () => groupController.abort('group execution deadline'),
          phase.timeoutMs * timeoutScale,
        )
      : null;
    let result;
    try {
      result =
        platform === 'win32'
          ? runWindowsSerialized({
              root,
              signal: groupController?.signal ?? signal,
              groupName: descriptor.name,
              shard: descriptor.shard,
              groups: resolvedGroups,
              ...(keepGoing ? { timeoutMs: phase.timeoutMs } : {}),
            })
          : await runGroup(descriptor, files, {
              root,
              signal: groupController?.signal ?? signal,
              ...(manifestDirectory ? { manifestDirectory } : {}),
              ...(coverageRoot === undefined
                ? {}
                : {
                    coverageDirectory: resolve(
                      coverageRoot,
                      descriptor.resultName ?? descriptor.name,
                    ),
                  }),
              ...quarantineOptions,
            });
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', abortGroup);
    }
    results.push(result);
    onResult?.(result);
    if (
      !result.passed &&
      (!keepGoing || result.cancelled || result.error || result.status !== 1)
    ) {
      return { passed: false, results };
    }
  }
  return {
    passed:
      results.length === descriptors.length &&
      results.every((result) => result.passed),
    results,
  };
}

export function parseVitestCorpusArguments(args) {
  if (args.includes('--exclude-quarantined')) {
    if (
      args.filter((argument) => argument === '--exclude-quarantined').length !==
      1
    )
      throw new Error('usage: --exclude-quarantined may be supplied once');
    const rest = parseVitestCorpusArguments(
      args.filter((argument) => argument !== '--exclude-quarantined'),
    );
    if (!rest.groupName)
      throw new Error('--exclude-quarantined requires --group=<name>');
    return { ...rest, excludeQuarantined: true };
  }
  if (args.includes('--keep-going')) {
    if (args.filter((argument) => argument === '--keep-going').length !== 1)
      throw new Error('usage: --keep-going may be supplied once');
    return {
      ...parseVitestCorpusArguments(
        args.filter((argument) => argument !== '--keep-going'),
      ),
      keepGoing: true,
    };
  }
  if (args.length === 0) return {};
  if (args.length > 3)
    throw new Error(
      'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/<count>]] [--coverage-root=<dir>]',
    );
  const values = new Map();
  for (const argument of args) {
    const match = argument.match(/^--(group|shard|coverage-root)=(.+)$/);
    if (!match || values.has(match[1]))
      throw new Error(
        'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/<count>]] [--coverage-root=<dir>]',
      );
    values.set(match[1], match[2]);
  }
  const groupName = values.get('group');
  const shard = values.get('shard');
  const coverageRoot = values.get('coverage-root');
  // Hosted parallel coverage shards (#2416): one job runs exactly one
  // descriptor with coverage enabled, so this flag is only meaningful next
  // to --group. It is never required by the canonical, uninstrumented lane.
  if (coverageRoot !== undefined && !groupName)
    throw new Error('--coverage-root requires --group=<name>');
  if (!groupName)
    throw new Error(
      'usage: node scripts/run-vitest-corpus.mjs [--group=<name> [--shard=<index>/<count>]] [--coverage-root=<dir>]',
    );
  if (!VITEST_CORPUS_GROUP_NAMES.includes(groupName))
    throw new Error(`unknown Vitest corpus group '${groupName}'`);
  const withCoverageRoot = (result) =>
    coverageRoot === undefined ? result : { ...result, coverageRoot };
  if (groupName === 'ordinary') {
    if (!ORDINARY_SHARD_DESCRIPTORS.some((entry) => entry.shard === shard))
      throw new Error(
        `ordinary Vitest corpus requires exactly --shard=<1-${ORDINARY_SHARD_COUNT}>/${ORDINARY_SHARD_COUNT}`,
      );
    return withCoverageRoot({ groupName, shard });
  }
  if (groupName === 'process-heavy' && shard) {
    parseProcessHeavyShard(shard);
    return withCoverageRoot({ groupName, shard });
  }
  if (shard)
    throw new Error(
      '--shard is supported only with --group=ordinary or --group=process-heavy',
    );
  return withCoverageRoot({ groupName });
}

/**
 * The group entries a corpus invocation with these arguments writes, one per
 * descriptor it runs. The phase driver accepts exactly these from a phase.
 */
export function plannedCorpusGroupNames(args) {
  const { groupName, shard } = parseVitestCorpusArguments(args);
  return corpusDescriptors(groupName, shard).map(
    (descriptor) => descriptor.resultName ?? descriptor.name,
  );
}

async function main() {
  // Handed over by the phase driver for this phase only, and removed from
  // this process's environment before anything is spawned.
  const manifestDirectory = takeManifestDirectory(
    process.env,
    GROUP_MANIFEST_DIR_ENV,
  );
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    const options = parseVitestCorpusArguments(process.argv.slice(2));
    const result = await runVitestCorpus({
      ...options,
      signal: controller.signal,
      manifestDirectory,
      onResult: (group) =>
        emitResult(group, {
          diagnosticDirectory: resolve(
            process.env.RUNNER_TEMP ?? '.kontourai/verification-output',
            'vitest-corpus',
          ),
        }),
    });
    if (options.keepGoing) {
      const directory = resolve('.kontourai/vitest-corpus-audit');
      mkdirSync(directory, { recursive: true });
      const path = resolve(directory, `${Date.now()}-${process.pid}.json`);
      writeFileSync(
        path,
        JSON.stringify(
          {
            schemaVersion: 1,
            revision: execFileSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
              windowsHide: true,
            }).trim(),
            selection: options,
            passed: result.passed,
            groups: result.results.map(
              ({
                name,
                passed,
                status,
                error,
                cancelled,
                outputBytes,
                cleanup,
              }) => ({
                name,
                passed,
                status,
                error,
                cancelled,
                outputBytes,
                cleanup,
              }),
            ),
          },
          null,
          2,
        ),
      );
      process.stdout.write(`[vitest-corpus] audit matrix: ${path}\n`);
    }
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

if (invokedDirectly(import.meta.url)) void main();
