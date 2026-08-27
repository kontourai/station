/**
 * station#1398 security review, M-5 — the content gate's own coverage.
 *
 * The gate had none, which is part of why a literal NUL byte sat in a tracked
 * TypeScript file for a whole slice: the byte made that file binary to
 * `git grep -I`, so the legacy-name half of this very gate skipped it, and
 * nothing else looked. The test that matters is therefore not "does a pattern
 * match a control character" but "does the scan still SEE a file the control
 * character made binary" — a check written with `-I` would pass every
 * assertion below except the one named THE REGRESSION.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BINARY_EXCLUDES,
  CONTROL_CHARACTER_CLASS,
  ContentGateScanError,
  findControlCharacters,
  isForbiddenByte,
  locateControlCharacter,
  runGate,
} from '../content-integrity-gate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * A NUL composed from its char code. This test file must not itself contain a
 * literal control character: it would trip the very gate it covers, and the
 * tempting "fix" would be to exclude the test from the gate. Every fixture
 * below builds the byte instead of embedding it.
 */
const NUL = String.fromCharCode(0);

/**
 * The banned legacy spelling, composed rather than written out — for the same
 * reason `NUL` above is composed. A test that embeds the literal string would
 * trip the gate it covers, and the tempting "fix" is to exclude this file from
 * the scan, which would blind the gate to a real regression anywhere in it.
 * (The gate caught this file on the first run; composing is the honest fix.)
 */

/**
 * A throwaway git repo, because both halves of the gate are `git grep` over
 * TRACKED files — running them against a loose scratch directory would prove
 * nothing about the thing that actually runs in CI.
 */
function scratchRepo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-content-gate-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
  git('init', '-q');
  git('config', 'user.email', 'gate@test.invalid');
  git('config', 'user.name', 'gate');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

function inRepo<T>(dir: string, run: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

describe('the content-integrity gate sees files a control character would hide', () => {
  it('reports a tracked source file containing a literal NUL', () => {
    // The exact shape of the real defect: a NUL inside a template literal in
    // an otherwise ordinary TypeScript file.
    const dir = scratchRepo({
      'key.ts': `export const k = (a: string, b: string) => "a${NUL}b";\n`,
      'clean.ts': 'export const ok = 1;\n',
    });
    expect(inRepo(dir, () => findControlCharacters())).toEqual(['key.ts']);
  });

  it('is silent on ordinary text — TAB, LF and CR are not control bytes here', () => {
    const dir = scratchRepo({
      'tabs.ts': 'export const a = 1;\n\tconst b = 2;\r\n',
      'unicode.md': 'Em dashes, curly quotes and emoji are all fine.\n',
    });
    expect(inRepo(dir, () => findControlCharacters())).toEqual([]);
  });

  it('sees a file that -I-based text scanners skip as binary', () => {
    // The founding hazard: a NUL makes the file BINARY to `git grep -I`, so
    // every -I-based scanner silently skips it. This scan runs without -I and
    // must still see it.
    const dir = scratchRepo({
      'plain.ts': 'export const ok = 1;\n',
      'hidden.ts': `export const k = "a${NUL}b";\n`,
    });
    expect(inRepo(dir, () => findControlCharacters())).toEqual(['hidden.ts']);
  });

  it('excludes binary-by-content paths rather than flagging every asset', () => {
    const dir = scratchRepo({
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
      'note.txt': 'plain\n',
    });
    expect(inRepo(dir, () => findControlCharacters())).toEqual([]);
  });

  it('permits TAB/LF/CR by construction, not by accident', () => {
    // Pins the class itself: an edit that folded 0x09/0x0A/0x0D back into the
    // range would make the gate fire on every file in the repo, and the
    // obvious "fix" would be to weaken the gate. Fail here instead.
    for (const allowed of ['\\x09', '\\x0A', '\\x0D']) {
      expect(CONTROL_CHARACTER_CLASS).not.toContain(allowed);
    }
    expect(CONTROL_CHARACTER_CLASS).toContain('\\x00');
    expect(CONTROL_CHARACTER_CLASS).toContain('\\x7F');
  });
});

describe('the gate fails CLOSED when it cannot scan (round 2, L-3)', () => {
  it('treats "ran, found nothing" (exit 1) as clean', () => {
    // The clean case must stay clean, or the fix below would just make the
    // gate permanently red.
    const dir = scratchRepo({ 'clean.ts': 'export const ok = 1;\n' });
    expect(inRepo(dir, () => findControlCharacters())).toEqual([]);
    const errors: string[] = [];
    expect(
      inRepo(dir, () =>
        runGate({ log: () => {}, error: (m) => errors.push(m) }),
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  });

  it('raises rather than returning [] when the scan could not RUN', () => {
    // Not a repository at all: git exits 128, which the first cut caught
    // alongside exit 1 and reported as "no matches" — a fail-OPEN in the gate
    // whose whole reason for existing is that a scanner silently skipped a
    // file.
    const notARepo = mkdtempSync(
      join(tmpdir(), 'station-content-gate-norepo-'),
    );
    expect(() => inRepo(notARepo, () => findControlCharacters())).toThrow(
      ContentGateScanError,
    );
    expect(() => inRepo(notARepo, () => findControlCharacters())).toThrow(
      /could not run/,
    );
  });

  it('reports a scan failure as a gate FAILURE, with git’s own message', () => {
    const notARepo = mkdtempSync(
      join(tmpdir(), 'station-content-gate-norepo-'),
    );
    const errors: string[] = [];
    const code = inRepo(notARepo, () =>
      runGate({
        log: () => {},
        error: (message) => errors.push(String(message)),
      }),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('could not scan this repository');
    // The underlying cause is surfaced, not swallowed into a generic message.
    expect(errors.join('\n')).toContain('could not run');
  });
});

describe('isForbiddenByte — derived from CONTROL_CHARACTER_CLASS, pinned against an explicit expectation', () => {
  it('agrees with CONTROL_CHARACTER_CLASS for every byte value (0-255)', () => {
    // Not a comparison against itself: CONTROL_CHARACTER_CLASS is the fixed
    // string `git grep -P` actually runs against, and this independently
    // re-implements "does byte b fall in that class" via a fresh RegExp over
    // every possible byte, rather than trusting `isForbiddenByte`'s own
    // construction.
    const classTest = new RegExp(CONTROL_CHARACTER_CLASS);
    for (let byte = 0; byte <= 0xff; byte++) {
      expect(isForbiddenByte(byte)).toBe(
        classTest.test(String.fromCharCode(byte)),
      );
    }
  });

  it('rejects exactly the C0 controls minus TAB/LF/CR, plus DEL — an explicit expected set', () => {
    const expectedForbidden = new Set<number>();
    for (let byte = 0x00; byte <= 0x1f; byte++) expectedForbidden.add(byte);
    expectedForbidden.delete(0x09);
    expectedForbidden.delete(0x0a);
    expectedForbidden.delete(0x0d);
    expectedForbidden.add(0x7f);

    for (let byte = 0; byte <= 0xff; byte++) {
      expect(isForbiddenByte(byte)).toBe(expectedForbidden.has(byte));
    }
  });
});

describe('locateControlCharacter — names the position and the byte, not just the file', () => {
  it('finds the first forbidden byte at its exact line and column', () => {
    const dir = scratchRepo({
      'multi-line.ts': `line one\nline ${NUL}two\n`,
    });
    const located = inRepo(dir, () =>
      locateControlCharacter(join(dir, 'multi-line.ts')),
    );
    expect(located).toEqual({ line: 2, col: 6, byte: 0x00 });
  });

  it('the enriched gate failure output names file:line:col and the byte, not just the file', () => {
    const dir = scratchRepo({
      'positioned.ts': `export const k = "a${NUL}b";\n`,
    });
    const errors: string[] = [];
    const code = inRepo(dir, () =>
      runGate({ log: () => {}, error: (m) => errors.push(String(m)) }),
    );
    expect(code).toBe(1);
    const joined = errors.join('\n');
    expect(joined).toContain('positioned.ts:1:20: byte 0x00 (NUL)');
  });
});

// The independent cross-check (station#3465 review): `BINARY_EXCLUDES` must
// not be validated only against this gate's own control-byte scan — that is
// the exact tautology station#3435 review MEDIUM-1 named on the sibling
// test-import-existence gate. `git ls-files --eol` is a real, pre-existing,
// independently implemented oracle: with this repo's `.gitattributes`
// (`* text=auto eol=lf`), git inspects each tracked blob's own content and
// reports `i/-text w/-text` for anything IT judges binary. Bidirectional on
// purpose: a `BINARY_EXCLUDES` entry that isn't actually binary per git is a
// live blind spot (case 1); a file git calls binary that the list doesn't
// cover would make the gate spuriously fail on an ordinary asset commit
// (case 2).
describe('BINARY_EXCLUDES cross-checked against the independent git-binary-detection oracle', () => {
  function binaryExcludeExtensions(): string[] {
    return BINARY_EXCLUDES.map((entry) => {
      const match = entry.match(/^:!\*(\.[a-zA-Z0-9]+)$/);
      if (!match) {
        throw new Error(`unexpected BINARY_EXCLUDES entry shape: ${entry}`);
      }
      return match[1];
    });
  }

  function isCoveredByBinaryExcludes(file: string): boolean {
    return binaryExcludeExtensions().includes(extname(file).toLowerCase());
  }

  function gitEolClassification(): Map<string, boolean> {
    const out = execFileSync('git', ['ls-files', '--eol'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const classification = new Map<string, boolean>();
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      const tabIndex = line.indexOf('\t');
      const meta = line.slice(0, tabIndex);
      const file = line.slice(tabIndex + 1);
      classification.set(file, meta.includes('-text'));
    }
    return classification;
  }

  // Exact oracle, not a floor (station#3465 review, second pass): a floor
  // like `> 1000` cannot notice most of the tracked tree vanishing from
  // `--eol`'s own output, which would silently shrink both cases' reach — the
  // same shape as the repo's own `> 300`-vs-420-leaves precedent. `git
  // ls-files` (plain, no `--eol`) is a second, independent git invocation
  // enumerating the identical tracked-file universe, so this equality is
  // self-maintaining: both sides move together as files are added or
  // removed, with no number to hand-update, ever.
  function trackedFileCount(): number {
    return execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean).length;
  }

  it('case 1: every BINARY_EXCLUDES-covered tracked file is one git independently classifies as binary', () => {
    const classification = gitEolClassification();
    expect(classification.size).toBe(trackedFileCount());

    const excludedButNotGitBinary = [...classification.entries()]
      .filter(
        ([file, isGitBinary]) =>
          isCoveredByBinaryExcludes(file) && !isGitBinary,
      )
      .map(([file]) => file);
    expect(excludedButNotGitBinary).toEqual([]);
  });

  it('case 2: every file git independently classifies as binary is covered by BINARY_EXCLUDES', () => {
    const classification = gitEolClassification();
    expect(classification.size).toBe(trackedFileCount());

    const gitBinaryButNotExcluded = [...classification.entries()]
      .filter(
        ([file, isGitBinary]) =>
          isGitBinary && !isCoveredByBinaryExcludes(file),
      )
      .map(([file]) => file);
    expect(gitBinaryButNotExcluded).toEqual([]);
  });

  it('the oracle is content-derived, not extension-derived: an ASCII file named ".png" reads text, a NUL-bearing ".ts" reads binary', () => {
    // Proves the independence the cross-check above relies on: if
    // `git ls-files --eol` merely read the extension back, it would agree
    // with BINARY_EXCLUDES by construction and the cross-check above would
    // be exactly the tautology it exists to avoid. This repo's own
    // `.gitattributes` policy (`* text=auto eol=lf`, no per-extension
    // `binary`/`-text` overrides) is reproduced in the fixture repo so the
    // behavior matches what actually governs the real tree.
    const dir = scratchRepo({
      '.gitattributes': '* text=auto eol=lf\n',
      'lookalike.png': 'plain ASCII content, misleadingly named\n',
      'not-really-binary.ts': `export const k = "a${NUL}b";\n`,
    });
    const out = execFileSync('git', ['ls-files', '--eol'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const classification = new Map<string, boolean>();
    for (const line of out.trim().split('\n')) {
      const tabIndex = line.indexOf('\t');
      classification.set(
        line.slice(tabIndex + 1),
        line.slice(0, tabIndex).includes('-text'),
      );
    }
    expect(classification.get('lookalike.png')).toBe(false);
    expect(classification.get('not-really-binary.ts')).toBe(true);
  });
});
