import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { evaluateCodeHealthAudit } from '../code-health-gate.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-code-health-'));
  roots.add(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: sanitizedGitEnvironment(),
    }).trim();
  mkdirSync(join(root, 'hooks'));
  mkdirSync(join(root, 'fallow-baselines'));
  for (const name of ['dead-code.json', 'health.json', 'dupes.json'])
    copyFileSync(
      join(repo, 'fallow-baselines', name),
      join(root, 'fallow-baselines', name),
    );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'gate-fixture',
      private: true,
      type: 'module',
      main: './index.ts',
    }),
  );
  writeFileSync(join(root, '.gitignore'), '.kontourai/\n.fallow/\n');
  writeFileSync(
    join(root, 'index.ts'),
    "import { read } from './shared'; console.log(read());\n",
  );
  writeFileSync(
    join(root, 'shared.ts'),
    'export const inherited = 1;\nexport function read() { return 2; }\n',
  );
  git('init', '-q');
  git('config', 'user.email', 'code-health@test.invalid');
  git('config', 'user.name', 'code-health');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(root, 'hooks'));
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  };
  commit();
  const base = git('rev-parse', 'HEAD');
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'scripts/code-health-gate.mjs'), `--base=${base}`],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: { ...sanitizedGitEnvironment(), GITHUB_STEP_SUMMARY: '' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  };
  return { root, commit, run };
}

test('the real gate permits inherited findings but catches a new unused export even when candidate baselines hide it', () => {
  const { root, commit, run } = fixture();
  const source = join(root, 'shared.ts');
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace('return 2', 'return 3'),
  );
  commit();
  const inherited = run();
  expect(inherited.output).toContain('"dead_code": 0');
  expect(inherited.status).toBe(0);

  writeFileSync(
    source,
    `${readFileSync(source, 'utf8')}export const orphan = 2;\nexport type OrphanType = { value: string };\n`,
  );
  const baselinePath = join(root, 'fallow-baselines/dead-code.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  baseline.unused_exports.push('shared.ts:orphan');
  baseline.unused_types.push('shared.ts:OrphanType');
  writeFileSync(baselinePath, JSON.stringify(baseline));
  commit();
  const broken = run();
  expect(broken.status).toBe(1);
  expect(broken.output).toContain('"export_name": "orphan"');
  expect(broken.output).toContain('"kind": "unused_types"');
  expect(broken.output).toContain('"introduced": true');

  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace(
      'export const orphan = 2;\nexport type OrphanType = { value: string };\n',
      '',
    ),
  );
  commit();
  expect(run().status).toBe(0);
}, 90_000);

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
function report() {
  return {
    kind: 'audit',
    verdict: 'fail',
    base_ref: base,
    head_sha: head.slice(0, 9),
    changed_files_count: 1,
    summary: {
      dead_code_issues: 0,
      complexity_findings: 1,
      duplication_clone_groups: 0,
    },
    attribution: {
      gate: 'new-only',
      dead_code_introduced: 0,
      dead_code_inherited: 0,
      complexity_introduced: 1,
      complexity_inherited: 0,
      duplication_introduced: 0,
      duplication_inherited: 0,
    },
    dead_code: { unused_exports: [], unused_types: [] },
  };
}

test('estimated-coverage and complexity verdicts remain review evidence, not forced refactors', () => {
  expect(evaluateCodeHealthAudit(report(), base, head).passed).toBe(true);
});

test.each(['base', 'head', 'attribution', 'metrics', 'findings'])(
  'missing or mismatched %s cannot become a passing code-health check',
  (kind) => {
    const value: any = report();
    if (kind === 'base') value.base_ref = 'other';
    if (kind === 'head') value.head_sha = '123456789';
    if (kind === 'attribution') delete value.attribution.complexity_introduced;
    if (kind === 'metrics') delete value.summary;
    if (kind === 'findings') delete value.dead_code.unused_types;
    expect(() => evaluateCodeHealthAudit(value, base, head)).toThrow();
  },
);
