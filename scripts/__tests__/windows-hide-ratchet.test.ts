import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import {
  evaluate,
  findOmissions,
  lowerBaseline,
  SCOPE_SENTINELS,
} from '../windows-hide-ratchet.mjs';

const makeTempDir = trackTempDirs();
const GATE = resolve('scripts/windows-hide-ratchet.mjs');
const FIXTURES = 'scripts/__tests__/fixtures/guardrail-known-bad/windows-hide';

function lines(source: string): number[] {
  return findOmissions(source, 'probe.ts').map(
    (row: { line: number }) => row.line,
  );
}

describe('findOmissions', () => {
  test.each([
    [
      'named import, no options',
      "import { spawn } from 'node:child_process';\nspawn('git', ['status']);",
    ],
    [
      'inline options without the key',
      "import { execFileSync } from 'child_process';\nexecFileSync('git', [], { encoding: 'utf8' });",
    ],
    [
      'renamed import',
      "import { spawnSync as run } from 'node:child_process';\nrun('ps', ['-p', '1'], {});",
    ],
    [
      'namespace import',
      "import * as cp from 'node:child_process';\ncp.execFile('git', ['log'], { cwd: '.' }, () => {});",
    ],
    [
      'default import',
      "import cp from 'node:child_process';\ncp.fork('worker.js');",
    ],
    [
      'require destructuring',
      "const { execSync } = require('child_process');\nexecSync('npm ls', { stdio: 'pipe' });",
    ],
    [
      'dynamic import plus promisify',
      "async function f() {\n  const { execFile } = await import('node:child_process');\n  const run = (await import('node:util')).promisify(execFile);\n  await run('git', ['ls-files']);\n}",
    ],
    [
      'same-file const options without the key',
      "import { spawn } from 'node:child_process';\nconst options = { stdio: 'inherit' };\nspawn('node', ['x.js'], options);",
    ],
    [
      'exec with a callback but no options',
      "import { exec } from 'node:child_process';\nexec('ls', (error) => {});",
    ],
  ])('counts %s', (_name, source) => {
    expect(lines(source)).toHaveLength(1);
  });

  test.each([
    [
      'windowsHide: true',
      "import { spawn } from 'node:child_process';\nspawn('git', [], { windowsHide: true });",
    ],
    [
      'an explicit windowsHide: false decision',
      "import { spawn } from 'node:child_process';\nspawn('git', [], { windowsHide: false });",
    ],
    [
      'a quoted key',
      "import { execSync } from 'node:child_process';\nexecSync('ls', { 'windowsHide': true });",
    ],
    [
      'a spread that may carry the key',
      "import { spawn } from 'node:child_process';\nexport function go(base) { return spawn('git', [], { ...base, cwd: '.' }); }",
    ],
    [
      'options passed in by a caller',
      "import { spawn } from 'node:child_process';\nexport function go(options) { return spawn('git', ['status'], options); }",
    ],
    [
      'an ambiguous two-argument call',
      "import { spawn } from 'node:child_process';\nexport function go(args) { return spawn('git', args); }",
    ],
    [
      'a same-file const that sets the key',
      "import { spawn } from 'node:child_process';\nconst options = { windowsHide: true };\nspawn('node', ['x.js'], options);",
    ],
    [
      'a spawn that is not child_process',
      "import { spawn } from './pty';\nspawn('git', ['status']);",
    ],
    [
      'RegExp exec and a mention in prose',
      "// child_process spawn('x') without options\nconst match = /a/.exec('a');\nexport const s = \"spawn('git')\";",
    ],
  ])('accepts %s', (_name, source) => {
    expect(lines(source)).toEqual([]);
  });

  test('reports the line of each omission', () => {
    expect(
      lines(
        "import { spawn, spawnSync } from 'node:child_process';\n\nspawn('a', [], { windowsHide: true });\nspawnSync('b');\nspawn('c', [], { cwd: '.' });",
      ),
    ).toEqual([4, 5]);
  });
});

describe('evaluate and lowerBaseline', () => {
  const files = [...SCOPE_SENTINELS, 'scripts/a.mjs'];

  test('fails only a file above its row, and a lost sentinel', () => {
    const result = evaluate({ 'scripts/a.mjs': 2, 'scripts/b.mjs': 1 }, files, {
      files: { 'scripts/a.mjs': 2, 'scripts/c.mjs': 1 },
    });
    expect(result.over).toEqual([
      { file: 'scripts/b.mjs', count: 1, ceiling: 0 },
    ]);
    expect(result.under).toEqual([
      { file: 'scripts/c.mjs', count: 0, ceiling: 1 },
    ]);
    expect(result.ok).toBe(false);
    expect(
      evaluate({}, ['scripts/a.mjs'], { files: {} }).missingSentinels,
    ).toEqual(SCOPE_SENTINELS);
  });

  test('--update lowers and removes rows but never raises or adds one', () => {
    expect(
      lowerBaseline(
        { 'scripts/a.mjs': 1 },
        { files: { 'scripts/a.mjs': 2, 'scripts/c.mjs': 1 } },
      ),
    ).toEqual({ ok: true, baseline: { files: { 'scripts/a.mjs': 1 } } });
    expect(lowerBaseline({ 'scripts/b.mjs': 1 }, { files: {} }).ok).toBe(false);
  });
});

describe('the gate as a process', () => {
  const BAD = 'src-server/services/new-launcher.ts';

  function scratch(launcher: string, baselineFiles: Record<string, number>) {
    const cwd = makeTempDir('station-windows-hide-ratchet-');
    const env = sanitizedGitEnvironment();
    const init = spawnSyncBounded('git', ['init', '--quiet'], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    expect(init.error).toBeUndefined();
    expect(init.status, init.stderr).toBe(0);
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    };
    for (const sentinel of SCOPE_SENTINELS) write(sentinel, 'export {};\n');
    write(BAD, readFileSync(join(FIXTURES, launcher), 'utf8'));
    write(
      'scripts/windows-hide-baseline.json',
      JSON.stringify({ files: baselineFiles }),
    );
    const run = (...args: string[]) => {
      const result = spawnSyncBounded(process.execPath, [GATE, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
    };
    return { cwd, run, write };
  }

  test('rejects a new launch without windowsHide, naming the line', () => {
    const { run } = scratch('launch-without-hide.ts.fixture', {});
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'FAIL: child-process calls without windowsHide rose above the baseline',
    );
    expect(result.output).toContain(`${BAD}:7: run('git'`);
  });

  test('accepts the same tree with only the violation removed', () => {
    const { run } = scratch('launch-with-hide.ts.fixture', {});
    const result = run();
    expect(result.output).toContain('OK: 0 child-process calls');
    expect(result.status).toBe(0);
  });

  test('holds an inherited call at its row, and --update only lowers', () => {
    const { cwd, run, write } = scratch('launch-without-hide.ts.fixture', {
      [BAD]: 1,
    });
    expect(run().status).toBe(0);

    write(
      BAD,
      readFileSync(join(FIXTURES, 'launch-with-hide.ts.fixture'), 'utf8'),
    );
    const lowered = run('--update');
    expect(lowered.status, lowered.output).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(cwd, 'scripts/windows-hide-baseline.json'), 'utf8'),
      ),
    ).toEqual({ files: {} });

    write(
      BAD,
      readFileSync(join(FIXTURES, 'launch-without-hide.ts.fixture'), 'utf8'),
    );
    const raised = run('--update');
    expect(raised.status).toBe(1);
    expect(raised.output).toContain('only lowers the windowsHide baseline');
  });

  test('fails when the scan no longer reaches a sentinel', () => {
    const { run, write } = scratch('launch-with-hide.ts.fixture', {});
    // The scratch tree is untracked; ignoring a sentinel drops it from scope.
    write('.gitignore', `${SCOPE_SENTINELS[0]}\n`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `windowsHide ratchet scope lost these files: ${SCOPE_SENTINELS[0]}`,
    );
  });
});
