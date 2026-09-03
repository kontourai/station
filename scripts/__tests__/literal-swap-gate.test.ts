import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const GATE = resolve(process.cwd(), 'scripts/literal-swap-gate.mjs');
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repo whose HEAD commit edits `source` and `test` from `before` to `after`. */
function repoWithEdit(
  source: string,
  test: string,
  before: string,
  after: string,
) {
  const dir = mkdtempSync(join(tmpdir(), 'literal-swap-'));
  made.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'src/__tests__'), { recursive: true });
  writeFileSync(join(dir, 'src/chip.ts'), source.replace('@@', before));
  writeFileSync(
    join(dir, 'src/__tests__/chip.test.ts'),
    test.replace('@@', before),
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  writeFileSync(join(dir, 'src/chip.ts'), source.replace('@@', after));
  writeFileSync(
    join(dir, 'src/__tests__/chip.test.ts'),
    test.replace('@@', after),
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'edit']);
  return dir;
}

function runGate(cwd: string, args: string[]) {
  try {
    return {
      status: 0,
      out: execFileSync('node', [GATE, ...args], { cwd, encoding: 'utf8' }),
    };
  } catch (error) {
    const e = error as { status: number; stdout: string };
    return { status: e.status, out: e.stdout };
  }
}

describe('literal-swap-gate', () => {
  // dc3eb7988's shape: the source side is a template and the test side is a
  // concrete string, so the two literals are never equal. Only the SHARED EDIT
  // links them, which is what this gate matches on.
  test('reports a separator swapped in source and in the test asserting it', () => {
    const dir = repoWithEdit(
      'export const label = `${name}@@${model}`;\n',
      "expect(label).toBe('OpenCode@@GLM-4.7');\n",
      ' · ',
      ' - ',
    );
    const { out } = runGate(dir, ['--range', 'HEAD']);
    expect(out).toContain('"·" -> "-"');
    expect(out).toContain('src/chip.ts');
    expect(out).toContain('src/__tests__/chip.test.ts');
  });

  test('stays silent when only the source literal changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'literal-swap-'));
    made.push(dir);
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/chip.ts'), "export const l = 'a · b';\n");
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'src/chip.ts'), "export const l = 'a - b';\n");
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'edit']);
    const { out } = runGate(dir, ['--range', 'HEAD']);
    expect(out).toContain('OK:');
  });

  // Report-only is the point: a deliberate copy change lands in this exact
  // shape, so the default must not fail a build.
  test('exits 0 by default and 1 only under --strict', () => {
    const dir = repoWithEdit(
      'export const label = `${name}@@${model}`;\n',
      "expect(label).toBe('OpenCode@@GLM-4.7');\n",
      ' · ',
      ' - ',
    );
    expect(runGate(dir, ['--range', 'HEAD']).status).toBe(0);
    expect(runGate(dir, ['--range', 'HEAD', '--strict']).status).toBe(1);
  });
});
