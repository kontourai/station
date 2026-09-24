import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  addedTestLines,
  findRealtimeWaits,
} from '../test-realtime-wait-gate.mjs';

const GATE = resolve(__dirname, '../test-realtime-wait-gate.mjs');
// The sample lines live in JSON: they are the shapes the gate flags, and it
// scans added lines of test source files, this one included.
const SAMPLES = JSON.parse(
  readFileSync(
    resolve(__dirname, 'fixtures/realtime-wait-samples.json'),
    'utf8',
  ),
);

function kindsOf(lines: string[], above: string[] = []) {
  const added = lines.map((text, index) => ({
    file: 'src/__tests__/x.test.ts',
    line: index + 2,
    text,
  }));
  return findRealtimeWaits(
    added,
    (_file: string, n: number) => above[n - 1],
  ).map((finding: { kind: string }) => finding.kind);
}

describe('findRealtimeWaits', () => {
  // The first four are the shapes that reached main and red Nightly on
  // 2026-09-23.
  test.each(SAMPLES.flagged as [string, string][])('flags %s', (line, kind) => {
    expect(kindsOf([line])).toEqual([kind]);
  });

  test.each(SAMPLES.unflagged as string[])('does not flag %s', (line) => {
    expect(kindsOf([line])).toEqual([]);
  });

  test('a real-time: reason on the line, or on the line above, waives it', () => {
    expect(kindsOf([SAMPLES.waivedOnLine])).toEqual([]);
    // The line above is read from the new file, so an unchanged comment
    // above a newly added wait counts too.
    expect(kindsOf([SAMPLES.bareWait], [SAMPLES.waiverAbove])).toEqual([]);
    // A bare marker with no reason does not.
    expect(kindsOf([SAMPLES.bareMarker])).toEqual(['literal-sleep']);
  });
});

describe('addedTestLines', () => {
  test('keeps only added lines of test files, numbered in the new file', () => {
    expect(addedTestLines(SAMPLES.diff.join('\n'))).toEqual(SAMPLES.diffAdded);
  });
});

describe('the gate as a process', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function repoWith(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'realtime-wait-gate-'));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'gate@example.com');
    git('config', 'user.name', 'gate');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', 'base');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git('add', '-A');
    git('commit', '-qm', 'change');
    return root;
  }

  function runGate(root: string) {
    return spawnSync(process.execPath, [GATE, '--base=base'], {
      cwd: root,
      encoding: 'utf8',
    });
  }

  test('exits 1 and names the line when a change adds a real-time wait', () => {
    const root = repoWith({
      'src/__tests__/a.test.ts': SAMPLES.unwaivedTestFile,
    });
    const result = runGate(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(
      'src/__tests__/a.test.ts:4 [promise-sleep]',
    );
  });

  test('exits 0 when the added wait says why it needs real time', () => {
    const root = repoWith({
      'src/__tests__/a.test.ts': SAMPLES.waivedTestFile,
    });
    const result = runGate(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('OK:');
  });

  test('says it checked nothing, and exits 0, when no test line was added', () => {
    const root = repoWith({ 'src/a.ts': SAMPLES.sourceFileWithWait });
    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no test lines added');
  });

  test('exits 2, not 0, when the base cannot be compared', () => {
    const root = repoWith({ 'src/__tests__/a.test.ts': 'ok();\n' });
    const result = spawnSync(process.execPath, [GATE, '--base=no-such-ref'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
  });
});
