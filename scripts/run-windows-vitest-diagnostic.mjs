#!/usr/bin/env node

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactVerificationValue } from './lib/verification-redaction.mjs';

export const WINDOWS_VITEST_REPORT_MAX_BYTES = 32 * 1024 * 1024;
const PROCESS_OUTPUT_MAX_BYTES = 256 * 1024;

export function buildWindowsVitestDiagnosticCommand({
  root = process.cwd(),
  outputFile,
} = {}) {
  if (!outputFile)
    throw new Error('Windows Vitest diagnostic needs an output file');
  return [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--reporter=json',
    `--outputFile=${outputFile}`,
  ];
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function summarizeWindowsVitestReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Windows Vitest diagnostic report is not an object');
  const counts = {
    total: integer(report.numTotalTests),
    passed: integer(report.numPassedTests),
    failed: integer(report.numFailedTests),
    pending: integer(report.numPendingTests),
    todo: integer(report.numTodoTests) ?? 0,
  };
  if (Object.values(counts).some((value) => value === null))
    throw new Error('Windows Vitest diagnostic report has incomplete counts');
  if (
    counts.total !==
    counts.passed + counts.failed + counts.pending + counts.todo
  )
    throw new Error('Windows Vitest diagnostic report counts do not reconcile');
  const testResults = Array.isArray(report.testResults)
    ? report.testResults
    : null;
  if (!testResults)
    throw new Error('Windows Vitest diagnostic report has no file inventory');
  return {
    schemaVersion: 1,
    complete: true,
    success: report.success === true,
    counts,
    files: {
      total: testResults.length,
      failed: testResults.filter((result) => result?.status === 'failed')
        .length,
    },
  };
}

function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function runWindowsVitestDiagnostic({
  root = process.cwd(),
  spawnSync = defaultSpawnSync,
} = {}) {
  const reportDirectory = resolve(root, '.kontourai/windows-vitest');
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const rawReport = join(reportDirectory, `.vitest-raw-${randomUUID()}.json`);
  const reportPath = join(reportDirectory, 'vitest.json');
  const summaryPath = join(reportDirectory, 'summary.json');
  rmSync(reportPath, { force: true });
  rmSync(summaryPath, { force: true });
  try {
    const args = buildWindowsVitestDiagnosticCommand({
      root,
      outputFile: rawReport,
    });
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: PROCESS_OUTPUT_MAX_BYTES,
    });
    if (result.error) throw result.error;
    const info = lstatSync(rawReport, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink())
      throw new Error(
        'Windows Vitest diagnostic did not produce a regular JSON report',
      );
    if (info.size < 2 || info.size > WINDOWS_VITEST_REPORT_MAX_BYTES)
      throw new Error(
        'Windows Vitest diagnostic JSON exceeds its byte contract',
      );
    const parsed = JSON.parse(readFileSync(rawReport, 'utf8'));
    const redacted = redactVerificationValue(parsed);
    const summary = {
      ...summarizeWindowsVitestReport(redacted),
      exitCode: result.status,
      reportBytes: Buffer.byteLength(JSON.stringify(redacted)),
    };
    writePrivateJson(reportPath, redacted);
    writePrivateJson(summaryPath, summary);
    process.stdout.write(
      `[windows-vitest] ${summary.counts.passed}/${summary.counts.total} passed; ${summary.counts.failed} failed; ${summary.files.failed}/${summary.files.total} files failed\n`,
    );
    return {
      exitCode: result.status === 0 && summary.success ? 0 : 1,
      summary,
    };
  } finally {
    rmSync(rawReport, { force: true });
  }
}

function main() {
  try {
    process.exitCode = runWindowsVitestDiagnostic().exitCode;
  } catch (error) {
    process.stderr.write(
      `[windows-vitest] infrastructure error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
