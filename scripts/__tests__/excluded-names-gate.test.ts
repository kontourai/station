/**
 * The excluded-names gate, run the way CI runs it: as a child process over a
 * throwaway git repository, asserting the real exit status. The scan is
 * `git grep` over TRACKED files, so fixtures are committed, not just written.
 *
 * Fixture text is assembled from pieces for the same reason the gate's
 * pattern is: a literal name in this file would trip the gate over this
 * repository, and the tempting fix — exempting the test — would blind the
 * gate to a real regression here.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { EXCLUDED_NAMES_PATTERN } from '../excluded-names-gate.mjs';

const gate = fileURLToPath(
  new URL('../excluded-names-gate.mjs', import.meta.url),
);
const NAME = ['T', '3'].join('');
const makeTempDir = trackTempDirs();

function scratchRepo(files: Record<string, string>): string {
  const dir = makeTempDir('station-excluded-names-');
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
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

function runGate(cwd: string) {
  return spawnSync(process.execPath, [gate], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

describe('excluded-names gate', () => {
  it('exits non-zero and names the file and line for each spelling it bans', () => {
    const spellings = [
      `${NAME} Code`,
      `${NAME.toLowerCase()}code`,
      `${NAME} Tools Inc.`,
      `/home/me/.${NAME.toLowerCase()}/worktrees`,
      `github.com/${['ping', 'dotgg'].join('')}/repo`,
    ];
    for (const spelling of spellings) {
      const dir = scratchRepo({
        'clean.ts': 'export const ok = 1;\n',
        'note.md': `intro\nAdapted from ${spelling}.\n`,
      });
      const result = runGate(dir);
      expect(result.status, spelling).toBe(1);
      expect(result.stderr).toContain('FAIL: 1 line(s)');
      expect(result.stderr).toContain('note.md:2:');
      expect(result.stderr).not.toContain('clean.ts');
    }
  });

  it('exits zero on a repository without the names', () => {
    const dir = scratchRepo({
      'a.ts': `export const size = 'm${NAME.toLowerCase()}.micro';\n`,
      'b.md': `The ${NAME} instance family and T1/T2/${NAME} test rows are fine.\n`,
    });
    const result = runGate(dir);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: no excluded product names');
  });

  it('ignores an untracked file: the scan covers what is committed', () => {
    const dir = scratchRepo({ 'a.ts': 'export const ok = 1;\n' });
    writeFileSync(join(dir, 'scratch.md'), `${NAME} Code\n`);
    expect(runGate(dir).status).toBe(0);
  });

  it('fails closed when it cannot scan', () => {
    const notARepo = makeTempDir('station-excluded-names-');
    const result = runGate(notARepo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not scan');
  });

  it('does not match its own source or this test, so neither needs an exemption', () => {
    const pattern = new RegExp(EXCLUDED_NAMES_PATTERN, 'i');
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const result = runGate(repoRoot);
    expect(result.stderr).not.toContain('excluded-names-gate');
    expect(pattern.test(`${NAME} Code`)).toBe(true);
  });
});
