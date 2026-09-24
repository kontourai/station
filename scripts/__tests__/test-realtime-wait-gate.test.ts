import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  addedTestLines,
  findRealtimeWaits,
} from '../test-realtime-wait-gate.mjs';

const GATE = resolve(__dirname, '../test-realtime-wait-gate.mjs');

function kindsOf(lines: string[], above: string[] = []) {
  const added = lines.map((text, index) => ({
    file: 'src/__tests__/x.test.ts',
    line: index + 2,
    text,
  }));
  return findRealtimeWaits(added, (_file: string, n: number) => above[n - 1])
    .map((finding: { kind: string }) => finding.kind);
}

describe('findRealtimeWaits', () => {
  // The four shapes that reached main and red Nightly on 2026-09-23.
  test.each([
    ['await new Promise((resolve) => setTimeout(resolve, 50));', 'promise-sleep'],
    ['await new Promise((resolve) => setTimeout(resolve, HOLD_MS * 3));', 'promise-sleep'],
    ['await sleep(90); // three hold periods', 'literal-sleep'],
    [
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
      'blocking-wait',
    ],
    ['await new Promise((r) => setTimeout(() => r(), 30));', 'promise-sleep'],
    ['await delay(1_000);', 'literal-sleep'],
  ])('flags %s', (line, kind) => {
    expect(kindsOf([line])).toEqual([kind]);
  });

  test.each([
    // A task yield, not a wait.
    'await new Promise((resolve) => setTimeout(resolve, 0));',
    'await sleep(0);',
    // A Promise.race guard resolving with a marker: load can only make it pass.
    "setTimeout(() => resolve('NOT_SETTLED_AFTER_ABORT'), 1_000),",
    // Waiting for the event, or driving time.
    'await vi.waitFor(() => expect(order).toEqual(["a"]));',
    'await vi.advanceTimersByTimeAsync(5_000);',
    'clock.sleep(10);',
    'await waitFor(() => screen.getByText("x"));',
  ])('does not flag %s', (line) => {
    expect(kindsOf([line])).toEqual([]);
  });

  test('a real-time: reason on the line, or on the line above, waives it', () => {
    expect(
      kindsOf([
        'await sleep(50); // real-time: nothing may arrive within 50ms',
      ]),
    ).toEqual([]);
    // The line above is read from the new file, so an unchanged comment
    // above a newly added wait counts too.
    expect(
      kindsOf(
        ['await sleep(50);'],
        ['// real-time: proves the listener stays quiet'],
      ),
    ).toEqual([]);
    // A bare marker with no reason does not.
    expect(kindsOf(['await sleep(50); // real-time:'])).toEqual([
      'literal-sleep',
    ]);
  });
});

describe('addedTestLines', () => {
  test('keeps only added lines of test files, numbered in the new file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+await sleep(90);',
      'diff --git a/src/__tests__/a.test.ts b/src/__tests__/a.test.ts',
      '+++ b/src/__tests__/a.test.ts',
      '@@ -10,2 +12,3 @@',
      '-removed();',
      '+await sleep(90);',
      '+ok();',
      'diff --git a/docs/x.md b/docs/x.md',
      '+++ b/docs/x.md',
      '@@ -1,0 +1,1 @@',
      '+sleep(5)',
    ].join('\n');
    expect(addedTestLines(diff)).toEqual([
      { file: 'src/__tests__/a.test.ts', line: 12, text: 'await sleep(90);' },
      { file: 'src/__tests__/a.test.ts', line: 13, text: 'ok();' },
    ]);
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
      'src/__tests__/a.test.ts':
        "import { test } from 'vitest';\n\ntest('x', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 50));\n});\n",
    });
    const result = runGate(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(
      'src/__tests__/a.test.ts:4 [promise-sleep]',
    );
  });

  test('exits 0 when the added wait says why it needs real time', () => {
    const root = repoWith({
      'src/__tests__/a.test.ts':
        "test('x', async () => {\n  // real-time: proves nothing arrives within 50ms\n  await new Promise((resolve) => setTimeout(resolve, 50));\n});\n",
    });
    const result = runGate(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('OK:');
  });

  test('says it checked nothing, and exits 0, when no test line was added', () => {
    const root = repoWith({ 'src/a.ts': 'await sleep(90);\n' });
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
