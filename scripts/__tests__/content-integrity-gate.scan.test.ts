/**
 * The real-tree half of `content-integrity-gate.test.ts`, moved here
 * unchanged (#2176) so the `repo-scans` pull-request job can run it: both
 * cases enumerate every tracked file with `git ls-files`, which no import edge
 * connects to this test. The fixture-repo control that proves the oracle is
 * content-derived stays in the original file.
 */
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BINARY_EXCLUDES } from '../content-integrity-gate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

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
});
