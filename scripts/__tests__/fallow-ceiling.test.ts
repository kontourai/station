import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  CEILING_FILE,
  compareWithCeiling,
  headroom,
} from '../fallow-ceiling.mjs';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

// The ceiling CLI runs as a child with the real fallow analyzer against a
// small project, so a change in fallow's report shape or in how counts are
// read fails here rather than reading as zero findings.

const SCRIPT = resolve('scripts/fallow-ceiling.mjs');
const makeTemp = trackTempDirs({ lifetime: 'test' });

function project() {
  const root = makeTemp('fallow-ceiling-');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'ceiling-fixture',
      version: '1.0.0',
      type: 'module',
      main: 'src/index.js',
    }),
  );
  write(
    'src/index.js',
    "import { used } from './lib.js';\nconsole.log(used);\n",
  );
  // One unused export and one unused file: total 2.
  write('src/lib.js', 'export const used = 1;\nexport const spare = 2;\n');
  write('src/orphan.js', 'export const orphan = 3;\n');
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true });
  return { root, write };
}

function run(root: string, args: string[] = []) {
  const child = spawnSyncBounded(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

describe('dead-code ceiling headroom', () => {
  it('allows max(3, 5%) over the recorded count', () => {
    // Literals beside the formula: 0 -> 3, 60 -> 3, 61 -> 4, 400 -> 20.
    expect([0, 60, 61, 400].map(headroom)).toEqual([3, 3, 4, 20]);
    expect(
      compareWithCeiling(
        { total_issues: 424, unused_files: 4, unused_exports: 300 },
        { total_issues: 400, unused_files: 1, unused_exports: 310 },
      ),
    ).toEqual({
      grown: [
        { category: 'total_issues', count: 424, recorded: 400, ceiling: 420 },
      ],
      lowered: [{ category: 'unused_exports', count: 300, recorded: 310 }],
    });
    // A category the ceiling never recorded is held at zero plus headroom.
    expect(compareWithCeiling({ new_kind: 4 }, {}).grown).toEqual([
      { category: 'new_kind', count: 4, recorded: 0, ceiling: 3 },
    ]);
  });
});

describe('dead-code ceiling CLI', () => {
  it('records counts, never paths, and passes an unchanged or moved tree', () => {
    const { root } = project();
    const written = run(root, ['--write']);
    expect(written.status, written.out).toBe(0);
    const ceiling = JSON.parse(readFileSync(join(root, CEILING_FILE), 'utf8'));
    expect(ceiling.counts).toEqual({
      total_issues: 2,
      unused_files: 1,
      unused_exports: 1,
    });
    expect(JSON.stringify(ceiling)).not.toContain('orphan');
    expect(ceiling.fallow).toMatch(/^fallow \d+\.\d+\.\d+$/);
    expect(run(root).status).toBe(0);
    // Moving a file that carries a finding keeps the count: no failure.
    mkdirSync(join(root, 'src/moved'));
    renameSync(join(root, 'src/orphan.js'), join(root, 'src/moved/orphan.js'));
    execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true });
    const moved = run(root);
    expect(moved.status, moved.out).toBe(0);
    expect(moved.out).toContain('[fallow-ceiling] OK: 2 dead-code findings');
  });

  it('accepts growth within headroom and fails growth past it', () => {
    const { root, write } = project();
    expect(run(root, ['--write']).status).toBe(0);
    for (const n of [1, 2, 3])
      write(`src/extra-${n}.js`, 'export const x = 1;\n');
    const within = run(root);
    expect(within.status, within.out).toBe(0);
    write('src/extra-4.js', 'export const x = 1;\n');
    const grown = run(root);
    expect(grown.status, grown.out).toBe(1);
    expect(grown.out).toContain(
      '[fallow-ceiling] GROWN unused_files: 5 > ceiling 4 (recorded 1 + headroom)',
    );
    expect(grown.out).toContain(
      '[fallow-ceiling] GROWN total_issues: 6 > ceiling 5',
    );
  });

  it('reports a lowered count so the ceiling can be recorded down', () => {
    const { root } = project();
    expect(run(root, ['--write']).status).toBe(0);
    rmSync(join(root, 'src/orphan.js'));
    execFileSync('git', ['add', '-A'], { cwd: root, windowsHide: true });
    const lowered = run(root);
    expect(lowered.status).toBe(0);
    expect(lowered.out).toContain(
      'lowered unused_files: 0 < recorded 1; record it with npm run fallow:baseline',
    );
  });

  it('reports NOT_VERIFIED, never a pass, for a report without counts', () => {
    const { root, write } = project();
    expect(run(root, ['--write']).status).toBe(0);
    write('broken.json', JSON.stringify({ kind: 'dead-code' }));
    const broken = run(root, ['--report', 'broken.json']);
    expect(broken.status).toBe(2);
    expect(broken.out).toContain(
      'fallow-ceiling: NOT_VERIFIED: the fallow report has no summary',
    );
  });

  it('reports NOT_VERIFIED when there is no recorded ceiling', () => {
    const { root } = project();
    const missing = run(root);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('fallow-ceiling: NOT_VERIFIED:');
  });
});
