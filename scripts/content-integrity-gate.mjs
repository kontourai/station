#!/usr/bin/env node
// Zero-tolerance content-integrity gate for tracked source.
//
// Control characters in tracked text (station#1398 security review, M-5;
// second live instance that cycle). A literal control byte — a NUL inside
// a template literal was the real one — makes the whole file `data` to
// file(1) and BINARY to `git grep -I`, so the file silently opts out of
// every text scanner in this repo. That is the hazard: not the byte itself,
// but a source file the gates can no longer see. This scan therefore runs
// WITHOUT `-I`, so it reports such a file instead of skipping it. Write
// control characters as escapes. TAB, LF and CR are permitted — they are
// ordinary text.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * C0 controls minus TAB (0x09), LF (0x0A) and CR (0x0D), plus DEL (0x7F).
 * A PCRE class string rather than a JS RegExp because it is handed to
 * `git grep -P`; the gate's test drives the same string.
 */
export const CONTROL_CHARACTER_CLASS =
  '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]';

// DERIVED from `CONTROL_CHARACTER_CLASS` (a `\xHH`-escaped JS RegExp class is
// also valid PCRE), not a second hand-maintained byte range: one source of
// truth for "which single byte is forbidden," reused by `git grep -P` above
// for FILE discovery and by `locateControlCharacter` below for the exact
// position within a file `git grep -l` already found.
const CONTROL_CHARACTER_BYTE_TEST = new RegExp(CONTROL_CHARACTER_CLASS);
export function isForbiddenByte(byte) {
  return CONTROL_CHARACTER_BYTE_TEST.test(String.fromCharCode(byte));
}

function byteLabel(byte) {
  const hex = `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  if (byte === 0x00) return `${hex} (NUL)`;
  if (byte === 0x7f) return `${hex} (DEL)`;
  return hex;
}

/**
 * `findControlCharacters()` only proves a file contains SOME forbidden byte
 * (station#3465 review: `git grep -l` was already the fast, `-I`-free
 * discovery step, and stayed that way rather than re-deriving discovery from
 * a slower full-repo byte scan). This locates the first one, for the person
 * who has to find it: reads the file's real bytes off the working tree (the
 * same content `git grep` without `--cached` searches) rather than trusting
 * any text decoding, since a forbidden byte is exactly what can make a naive
 * decode lie.
 */
export function locateControlCharacter(filePath) {
  const buffer = readFileSync(filePath);
  let line = 1;
  let col = 1;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (isForbiddenByte(byte)) return { line, col, byte };
    if (byte === 0x0a) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return null;
}

/**
 * Paths that are binary BY CONTENT, where control bytes are the format rather
 * than a mistake. Deliberately an extension allowlist and not `-I`: `-I` would
 * re-hide exactly the text files this check exists to find.
 *
 * Exported so the gate's own regression suite can cross-check it against an
 * INDEPENDENT oracle (station#3465 review) rather than only against this
 * scan's own control-byte detection — the same tautology class
 * station#3435 review MEDIUM-1 named on `test-import-existence-gate.mjs`:
 * a scope predicate checked only against its own re-derivation cannot catch
 * itself narrowing (or, here, missing a binary format entirely).
 * `git ls-files --eol` is that independent oracle: with this repo's
 * `.gitattributes` (`* text=auto eol=lf`, no per-extension `binary` rules —
 * see the gate's own test for a fixture proving this is content-derived, not
 * config-derived), git inspects each tracked blob's actual bytes and reports
 * `i/-text w/-text` for anything IT judges binary — a separate
 * implementation from this file's byte scan entirely.
 */
export const BINARY_EXCLUDES = [
  ':!*.png',
  ':!*.jpg',
  ':!*.jpeg',
  ':!*.gif',
  ':!*.webp',
  ':!*.ico',
  ':!*.icns',
  ':!*.woff',
  ':!*.woff2',
  ':!*.ttf',
  ':!*.otf',
  ':!*.eot',
  ':!*.pdf',
  ':!*.zip',
  ':!*.gz',
  ':!*.tgz',
  ':!*.wasm',
  ':!*.node',
  ':!*.keystore',
  ':!*.jar',
  ':!*.mp3',
  ':!*.mp4',
  ':!*.wav',
  ':!*.webm',
  ':!*.svgz',
  ':!*.class',
  ':!*.dylib',
  ':!*.so',
  ':!*.dll',
];

/**
 * Raised when the scan could not RUN. Distinct from "the scan ran and found
 * nothing", which is the clean case (station#1398 security review round 2,
 * L-3).
 */
export class ContentGateScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentGateScanError';
  }
}

/**
 * `git grep` exits 1 for "no matches" and something else entirely for "could
 * not run" — a `git` built without PCRE rejects `-P` with exit 128, a bad
 * pathspec exits 128, an unreadable index exits 128. The first cut caught
 * every one of those and returned `[]`, so the gate reported a clean repo
 * when it had in fact scanned nothing.
 *
 * That is a fail-OPEN in the gate whose entire reason for existing is that a
 * scanner silently skipped a file. Exit 1 is clean; anything else is a gate
 * failure with git's own stderr surfaced, because "the scan did not run" and
 * "the scan found nothing" must never look the same from the outside.
 */
function gitGrep(args) {
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    const detail =
      (typeof error?.stderr === 'string' ? error.stderr.trim() : '') ||
      error?.message ||
      String(error);
    throw new ContentGateScanError(
      `git ${args.slice(0, 2).join(' ')} could not run (exit ${error?.status ?? 'unknown'}): ${detail}`,
    );
  }
}

/**
 * `-l` (names only), never `-n`: a matching LINE from a file containing
 * control bytes is not something to write to a terminal.
 */
export function findControlCharacters(pathspec = '.') {
  return gitGrep([
    'grep',
    '-l',
    '-P',
    CONTROL_CHARACTER_CLASS,
    '--',
    pathspec,
    ...BINARY_EXCLUDES,
  ]);
}

export function runGate({ log = console.log, error = console.error } = {}) {
  log('Zero-tolerance content-integrity gate (control bytes).\n');
  let control;
  try {
    control = findControlCharacters();
  } catch (scanError) {
    // A gate that cannot scan reports that, loudly, instead of passing.
    error(`FAIL: the content gate could not scan this repository.\n`);
    error(`  ${scanError.message}`);
    return 1;
  }

  if (control.length === 0) {
    log('OK: no control characters in tracked text.');
    return 0;
  }
  error(
    `FAIL: ${control.length} tracked file(s) contain control characters:\n`,
  );
  for (const file of control) {
    // `locateControlCharacter` re-reads a file `git grep -l` already
    // proved contains a forbidden byte; a read failure here (permissions,
    // a path deleted between the two calls) still names the file rather
    // than losing the finding.
    let located = null;
    try {
      located = locateControlCharacter(file);
    } catch {
      located = null;
    }
    if (located) {
      error(
        `  ${file}:${located.line}:${located.col}: byte ${byteLabel(located.byte)}`,
      );
    } else {
      error(`  ${file}`);
    }
  }
  error(
    '\nWrite control characters as escapes. A literal one makes the file binary\n' +
      'to git grep and file(1), so it silently opts out of this gate and every\n' +
      'other text scanner in the repo.',
  );
  return 1;
}

// Run only as a script, not when the gate's own test imports it.
if (process.argv[1]?.endsWith('content-integrity-gate.mjs')) {
  process.exit(runGate());
}
