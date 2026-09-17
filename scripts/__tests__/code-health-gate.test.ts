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
import { delimiter, join } from 'node:path';
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
  const run = (ref = base) => {
    const result = spawnSync(
      process.execPath,
      [join(repo, 'scripts/code-health-gate.mjs'), `--base=${ref}`],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...sanitizedGitEnvironment(),
          GITHUB_STEP_SUMMARY: '',
          // Direct CLI use must resolve the pinned analyzer, even outside
          // npm's injected PATH and without a globally installed fallow.
          PATH: (process.env.PATH ?? '')
            .split(delimiter)
            .filter(
              (path) =>
                !path.replaceAll('\\', '/').endsWith('/node_modules/.bin'),
            )
            .join(delimiter),
        },
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

/**
 * #2094, reproduced end to end rather than asserted about: the analyzer is
 * asked for everything changed since the commit it is standing on, finds no
 * changed file, and emits no `dead_code` section at all. The gate used to
 * refuse that shape with `Missing unused_exports findings` -- a message two
 * steps from its cause, and the reason a CI dispatch on `main` could never be
 * all-green.
 */
test('a base that is the head reports an empty comparison, not a missing finding', () => {
  const { run } = fixture();

  const degenerate = run('HEAD');

  expect(degenerate.status).toBe(0);
  expect(degenerate.output).toContain(
    'no changed file, so nothing was analyzed',
  );
  // The zeroes must not be read as a verdict on the tree.
  expect(degenerate.output).toContain("not a statement about the tree's");
  expect(degenerate.output).not.toContain('Missing unused_exports findings');
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
    complexity: {
      findings: [
        {
          path: 'index.ts',
          name: 'read',
          exceeded: 'cognitive',
          introduced: true,
        },
      ],
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

test('complexity summaries count rows while attribution counts distinct path/name/metric keys', () => {
  const value = report();
  const inherited = {
    path: 'index.ts',
    name: '<arrow>',
    exceeded: 'all',
    introduced: false,
  };
  value.complexity.findings = [
    inherited,
    { ...inherited },
    { ...inherited, exceeded: 'cognitive' },
  ];
  value.summary.complexity_findings = 3;
  value.attribution.complexity_introduced = 0;
  value.attribution.complexity_inherited = 2;
  expect(evaluateCodeHealthAudit(value, base, head)).toMatchObject({
    passed: true,
    introduced: { complexity: 0 },
    summary: { complexity_findings: 3 },
  });
});

test.each([
  'missing-row-attribution',
  'conflicting-key-attribution',
  'wrong-row-count',
  'wrong-unique-count',
  'missing-key',
])('deduplicating complexity keys still refuses %s', (kind) => {
  const value: any = report();
  if (kind === 'missing-row-attribution')
    delete value.complexity.findings[0].introduced;
  if (kind === 'conflicting-key-attribution') {
    value.complexity.findings.push({
      ...value.complexity.findings[0],
      introduced: false,
    });
    value.summary.complexity_findings = 2;
    value.attribution.complexity_inherited = 1;
  }
  if (kind === 'wrong-row-count') value.summary.complexity_findings = 2;
  if (kind === 'wrong-unique-count')
    value.attribution.complexity_introduced = 0;
  if (kind === 'missing-key') delete value.complexity.findings[0].exceeded;
  expect(() => evaluateCodeHealthAudit(value, base, head)).toThrow();
});

/**
 * The pair the old message could not tell apart. Only `changed_files_count`
 * differs between these two: an absent `dead_code` section is a report about
 * nothing when the comparison was empty, and a fault when it was not.
 */
test('an absent dead_code section is a fault only when something did change', () => {
  const empty: any = report();
  delete empty.dead_code;
  delete empty.complexity;
  empty.changed_files_count = 0;
  empty.summary.complexity_findings = 0;
  empty.attribution.complexity_introduced = 0;

  expect(evaluateCodeHealthAudit(empty, base, head)).toMatchObject({
    passed: true,
    emptyComparison: true,
  });

  const changed = { ...empty, changed_files_count: 1 };
  expect(() => evaluateCodeHealthAudit(changed, base, head)).toThrow(
    'Code-health report has no unused_exports attribution for 1 changed file(s)',
  );
});

/**
 * A report cannot buy the empty-comparison exemption by claiming no changed
 * file while also claiming findings; that combination is malformed, and
 * accepting it would turn a real analysis into a silent pass.
 */
test('claiming findings while reporting no changed file is still refused', () => {
  const value: any = report();
  delete value.dead_code;
  value.changed_files_count = 0;
  expect(() => evaluateCodeHealthAudit(value, base, head)).toThrow();
});

/** A normal comparison still reports that it compared something. */
test('a comparison with changed files is not an empty comparison', () => {
  expect(evaluateCodeHealthAudit(report(), base, head).emptyComparison).toBe(
    false,
  );
});
