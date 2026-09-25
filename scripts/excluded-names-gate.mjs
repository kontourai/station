#!/usr/bin/env node
// Excluded-names gate: fails when any tracked file names a product Station
// must not reference or borrow from (owner directive, 2026-09-25). Station's
// code, comments, docs, tests and fixtures state their own reasons; a
// reference to that product in any of them is a regression.
//
// The pattern is assembled from pieces below so that this file, and the
// gate's own test, do not match it. That keeps the scan free of exemptions:
// every tracked file, including this one, is in scope.
//
// Scope: `git grep -I` over TRACKED files. Binary assets are skipped; a text
// file that became binary through a stray control byte is caught separately
// by content-integrity-gate.mjs, which scans without -I.
import { execFileSync } from 'node:child_process';

const NAME = ['t', '3'].join('');
const ORG = ['ping', 'dotgg'].join('');

/**
 * PCRE, matched case-insensitively, one alternative per form:
 * - the product and company names, however they are joined (`X code`,
 *   `X-code`, `X_code`, `X.code`, `Xcode`, `X  tools`, `XTools`, …);
 * - the product's per-user directory `.X` as a path segment (`~/.X`,
 *   `$HOME/.X`, `'.X'` in a path-join call, `\.X\` on Windows);
 * - its web domain;
 * - the short possessive and adjective forms (`X's`, `X-style`), kept narrow
 *   so an EC2 instance family or a `T1/T2/T3` test-row label does not match;
 * - its source organisation.
 */
const QUOTES_AND_SEPARATORS = `\\\\/'"\``;
export const EXCLUDED_NAMES_PATTERN = [
  `${NAME}[\\s._-]*(?:code|tools)`,
  `(?:^|[~${QUOTES_AND_SEPARATORS}])\\.${NAME}(?:[${QUOTES_AND_SEPARATORS}]|$)`,
  `${NAME}\\.gg`,
  `\\b${NAME}(?:-style|'s)\\b`,
  ORG,
].join('|');

/** Raised when the scan could not run, as distinct from finding nothing. */
export class ExcludedNamesScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExcludedNamesScanError';
  }
}

/**
 * `path:line:text` for every match in tracked text files. `git grep` exits 1
 * for "no matches"; any other failure means nothing was scanned, and is
 * raised rather than read as clean.
 */
export function findExcludedNames(cwd = process.cwd()) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-I', '-i', '-P', EXCLUDED_NAMES_PATTERN, '--', '.'],
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split('\n').filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    const detail =
      (typeof error?.stderr === 'string' ? error.stderr.trim() : '') ||
      error?.message ||
      String(error);
    throw new ExcludedNamesScanError(
      `git grep could not run (exit ${error?.status ?? 'unknown'}): ${detail}`,
    );
  }
}

export function runGate({
  cwd = process.cwd(),
  log = console.log,
  error = console.error,
} = {}) {
  let matches;
  try {
    matches = findExcludedNames(cwd);
  } catch (scanError) {
    error('FAIL: the excluded-names gate could not scan this repository.');
    error(`  ${scanError.message}`);
    return 1;
  }
  if (matches.length === 0) {
    log('OK: no excluded product names in tracked files.');
    return 0;
  }
  error(`FAIL: ${matches.length} line(s) name an excluded product:\n`);
  for (const match of matches) error(`  ${match}`);
  error(
    "\nState Station's own reason instead of naming or crediting that product, " +
      'and write replacements independently rather than from its source.',
  );
  return 1;
}

// Run only as a script, not when the gate's own test imports it.
if (process.argv[1]?.endsWith('excluded-names-gate.mjs')) {
  process.exit(runGate());
}
