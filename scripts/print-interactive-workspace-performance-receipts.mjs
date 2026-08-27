#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceReportReceipt } from './interactive-workspace-performance.mjs';

const MAX_PERFORMANCE_RECEIPT_FILES = 16;
const MAX_PERFORMANCE_REPORT_BYTES = 20 * 1024 * 1024;
const SAFE_PERFORMANCE_REPORT_FILE = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/u;

/**
 * @typedef {object} PerformanceReceiptFilesystem
 * @property {(directory: string) => string[]} [readDirectory]
 * @property {(path: string) => {
 *   isFile: () => boolean,
 *   isSymbolicLink: () => boolean,
 *   size: number,
 * }} [stat]
 * @property {(path: string) => string} [readFile]
 */

function safePerformanceReportFileName(value) {
  return typeof value === 'string' && SAFE_PERFORMANCE_REPORT_FILE.test(value);
}

function readPerformanceReceiptDirectory(directory) {
  return readdirSync(directory);
}

function readPerformanceReceiptMetadata(path) {
  return lstatSync(path);
}

function readPerformanceReceiptFile(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Return bounded log lines instead of copying raw performance evidence into
 * Actions output. Entries must be regular, non-symlink JSON files with a
 * closed basename before this helper even attempts to read them.
 *
 * @param {string} directory
 * @param {PerformanceReceiptFilesystem} [filesystem]
 */
export function performanceReceiptLogLines(
  directory,
  {
    readDirectory = readPerformanceReceiptDirectory,
    stat = readPerformanceReceiptMetadata,
    readFile = readPerformanceReceiptFile,
  } = {},
) {
  let files = [];
  try {
    files = readDirectory(directory)
      .filter(safePerformanceReportFileName)
      .sort()
      .slice(0, MAX_PERFORMANCE_RECEIPT_FILES);
  } catch {
    return ['[interactive-workspace-performance] receipt=NO_REPORTS_FOUND'];
  }

  const lines = [];
  for (const file of files) {
    const path = resolve(directory, file);
    try {
      const metadata = stat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > MAX_PERFORMANCE_REPORT_BYTES) {
        lines.push(
          `[interactive-workspace-performance] report=${file} receipt=UNREADABLE_REPORT`,
        );
        continue;
      }
      const report = JSON.parse(readFile(path, 'utf8'));
      lines.push(
        `[interactive-workspace-performance] report=${file} receipt=${JSON.stringify(performanceReportReceipt(report))}`,
      );
    } catch {
      lines.push(
        `[interactive-workspace-performance] report=${file} receipt=UNREADABLE_REPORT`,
      );
    }
  }
  return lines.length > 0
    ? lines
    : ['[interactive-workspace-performance] receipt=NO_REPORTS_FOUND'];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = resolve(process.argv[2] ?? '.kontourai/performance');
  for (const line of performanceReceiptLogLines(directory)) console.log(line);
}
