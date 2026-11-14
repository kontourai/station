import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

/**
 * A merge group runs the workflow YAML of its own candidate commit, so a pull
 * request that edits .github/ could redefine the merge-group CodeQL context.
 * The base-controlled `gate-change` job decides whether such a pull request
 * gets the base-defined analysis before it can be queued. These tests run
 * that job's real script (read from the workflow) against fixture Git
 * repositories, and evaluate the real CodeQL job condition.
 */

const root = resolve(import.meta.dirname, '../..');
type Step = { id?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; needs?: string; steps?: Step[] };
const workflow = load(
  readFileSync(
    resolve(root, '.github/workflows/security-analysis.yml'),
    'utf8',
  ),
) as { jobs: Record<string, Job> };
const classifyScript = workflow.jobs['gate-change'].steps?.find(
  (step) => step.id === 'classify',
)?.run;
const tempDir = trackTempDirs();

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSyncBounded('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout).trim();
}

/** A served repository whose `main` has one commit touching src/ and .github/. */
function fixtureRemote() {
  const remote = tempDir('gate-change-remote-');
  git(remote, 'init', '-q', '-b', 'main');
  // GitHub serves partial clones and fetches by commit SHA; a local
  // file:// remote must opt in to both.
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFiles(remote, {
    'src/app.ts': 'export const app = 1;\n',
    '.github/workflows/security-analysis.yml': 'name: base\n',
    '.github/workflows/ci.yml': 'name: ci\n',
  });
  commit(remote, 'base');
  return remote;
}

function writeFiles(directory: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function commit(directory: string, message: string) {
  git(directory, 'add', '-A');
  git(directory, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

/** Branch `pr` off `main`, apply `files`, and return the PR head SHA. */
function pullRequest(
  remote: string,
  files: Record<string, string>,
  { remove = [] as string[] } = {},
) {
  git(remote, 'checkout', '-q', '-B', 'pr', 'main');
  writeFiles(remote, files);
  for (const path of remove) git(remote, 'rm', '-q', path);
  const head = commit(remote, 'pr');
  git(remote, 'checkout', '-q', 'main');
  return head;
}

function classify(env: Record<string, string>) {
  if (!classifyScript) throw new Error('Expected the gate-change script.');
  const work = tempDir('gate-change-run-');
  const output = join(work, 'github-output');
  writeFileSync(output, '');
  // GitHub runs `run:` steps on Linux as `bash --noprofile --norc -eo pipefail`.
  const result = spawnSyncBounded(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', classifyScript],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...GIT_ENV,
        GIT_TERMINAL_PROMPT: '0',
        TMPDIR: work,
        GITHUB_OUTPUT: output,
        ...env,
      },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    outputs: readFileSync(output, 'utf8'),
  };
}

const run = (remote: string, base: string, head: string) =>
  classify({
    BASE_SHA: base,
    HEAD_SHA: head,
    REPOSITORY_URL: `file://${remote}`,
  });

describe('CodeQL gate-change classification (real workflow script)', () => {
  test('skips the PR-level analysis when only src/ changed', () => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    const head = pullRequest(remote, {
      'src/app.ts': 'export const app = 2;\n',
    });
    const result = run(remote, base, head);
    expect(result.status).toBe(0);
    expect(result.outputs).toBe('analyse=false\n');
  });

  test.each([
    [
      'the security-analysis workflow',
      '.github/workflows/security-analysis.yml',
    ],
    ['another workflow', '.github/workflows/ci.yml'],
    ['a new workflow', '.github/workflows/impersonate-codeql.yml'],
    ['a local action', '.github/actions/setup/action.yml'],
  ])('runs the PR-level analysis when the PR changes %s', (_name, path) => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    const head = pullRequest(remote, { [path]: 'name: changed\n' });
    const result = run(remote, base, head);
    expect(result.status).toBe(0);
    expect(result.outputs).toBe('analyse=true\n');
    expect(result.stdout).toContain('changes .github/');
  });

  test('a workflow moved out of .github/ still counts as a .github/ change', () => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    const head = pullRequest(
      remote,
      { 'docs/old-ci.yml': 'name: ci\n' },
      { remove: ['.github/workflows/ci.yml'] },
    );
    expect(run(remote, base, head).outputs).toBe('analyse=true\n');
  });

  test('diffs from the merge base: a .github/ change on the moved base is not the PR’s', () => {
    const remote = fixtureRemote();
    const head = pullRequest(remote, {
      'src/app.ts': 'export const app = 3;\n',
    });
    writeFiles(remote, { '.github/workflows/ci.yml': 'name: ci moved\n' });
    const movedBase = commit(remote, 'main moves');
    expect(run(remote, movedBase, head).outputs).toBe('analyse=false\n');

    // The PR then merges the moved base: still only its own src/ change.
    git(remote, 'checkout', '-q', 'pr');
    git(
      remote,
      '-c',
      'commit.gpgsign=false',
      'merge',
      '-q',
      '--no-edit',
      'main',
    );
    const merged = git(remote, 'rev-parse', 'HEAD');
    git(remote, 'checkout', '-q', 'main');
    expect(run(remote, movedBase, merged).outputs).toBe('analyse=false\n');
  });

  test('handles a diff far beyond the REST files API limit', () => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    const many = Object.fromEntries(
      Array.from({ length: 320 }, (_, index) => [
        `src/generated/file-${index}.ts`,
        `export const value${index} = ${index};\n`,
      ]),
    );
    expect(run(remote, base, pullRequest(remote, many)).outputs).toBe(
      'analyse=false\n',
    );
    const withWorkflow = pullRequest(remote, {
      ...many,
      '.github/workflows/zz-last.yml': 'name: last\n',
    });
    expect(run(remote, base, withWorkflow).outputs).toBe('analyse=true\n');
  });

  test.each([
    ['an unknown base SHA', () => ({ BASE_SHA: 'f'.repeat(40) })],
    ['a missing base SHA', () => ({ BASE_SHA: '' })],
    ['a malformed head SHA', (head: string) => ({ HEAD_SHA: `${head}; true` })],
    [
      'an unreachable repository',
      () => ({ REPOSITORY_URL: 'file:///nonexistent/station' }),
    ],
  ])('fails closed (analyse=true) on %s', (_name, override) => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    const head = pullRequest(remote, {
      'src/app.ts': 'export const app = 4;\n',
    });
    const env: Record<string, string> = override(head);
    const result = classify({
      BASE_SHA: base,
      HEAD_SHA: head,
      REPOSITORY_URL: `file://${remote}`,
      ...env,
    });
    expect(result.status).toBe(0);
    expect(result.outputs).toBe('analyse=true\n');
    expect(result.stdout).toContain('failed closed');
  });

  test('fails closed when the fetched history has no common merge base', () => {
    const remote = fixtureRemote();
    const base = git(remote, 'rev-parse', 'main');
    git(remote, 'checkout', '-q', '--orphan', 'unrelated');
    writeFiles(remote, { 'src/app.ts': 'export const app = 5;\n' });
    const head = commit(remote, 'unrelated root');
    git(remote, 'checkout', '-q', 'main');
    const result = run(remote, base, head);
    expect(result.outputs).toBe('analyse=true\n');
    expect(result.stdout).toContain('failed closed');
  });
});

/** The GitHub expression subset these job conditions use. */
function evaluate(
  source: string,
  lookup: (path: string[]) => unknown,
  functions: Record<string, () => boolean>,
): unknown {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const list = (
    expression.match(
      /\s*(?:'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|\.|[A-Za-z_][A-Za-z0-9_-]*|\S)/g,
    ) ?? []
  )
    .map((token) => token.trim())
    .filter(Boolean);
  let position = 0;
  const next = () => list[position++];
  const peek = () => list[position];
  const primary = (): unknown => {
    const token = next();
    if (token === '(') {
      const value = or();
      if (next() !== ')') throw new Error(`expected ) in ${source}`);
      return value;
    }
    if (token === '!') return !primary();
    if (token?.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (token && /^[A-Za-z_]/.test(token)) {
      if (peek() === '(') {
        next();
        if (next() !== ')') throw new Error(`unsupported call in ${source}`);
        const fn = functions[token];
        if (!fn) throw new Error(`unknown function ${token}`);
        return fn();
      }
      const path = [token];
      while (peek() === '.') {
        next();
        path.push(next() as string);
      }
      return lookup(path);
    }
    throw new Error(`unexpected ${token} in ${source}`);
  };
  const comparison = (): unknown => {
    const left = primary();
    if (peek() === '==' || peek() === '!=') {
      const operator = next();
      const right = primary();
      const equal = String(left ?? '') === String(right ?? '');
      return operator === '==' ? equal : !equal;
    }
    return left;
  };
  const and = (): unknown => {
    let value = comparison();
    while (peek() === '&&') {
      next();
      const right = comparison();
      value = value && right;
    }
    return value;
  };
  const or = (): unknown => {
    let value = and();
    while (peek() === '||') {
      next();
      const right = and();
      value = value || right;
    }
    return value;
  };
  const value = or();
  if (position !== list.length) throw new Error(`trailing tokens in ${source}`);
  return value;
}

function codeqlRuns({
  event,
  gateChange,
  analyse,
  runCancelled = false,
}: {
  event: string;
  gateChange: 'success' | 'failure' | 'cancelled' | 'skipped';
  analyse?: string;
  runCancelled?: boolean;
}) {
  const condition = workflow.jobs.codeql.if;
  if (!condition) throw new Error('Expected a CodeQL job condition.');
  // A condition with no status function is implicitly `success() && (...)`,
  // which a skipped `needs` job turns false; this one must carry its own.
  expect(condition).toMatch(/\b(always|cancelled|success|failure)\(\)/);
  expect(workflow.jobs.codeql.needs).toBe('gate-change');
  return Boolean(
    evaluate(
      condition,
      (path) => {
        const key = path.join('.');
        if (key === 'github.event_name') return event;
        if (key === 'needs.gate-change.result') return gateChange;
        if (key === 'needs.gate-change.outputs.analyse') return analyse ?? '';
        throw new Error(`unexpected context ${key}`);
      },
      {
        always: () => true,
        cancelled: () => runCancelled,
        success: () => !runCancelled && gateChange === 'success',
        failure: () => gateChange === 'failure',
      },
    ),
  );
}

describe('the CodeQL job condition (real workflow expression)', () => {
  test('the classifier itself runs only for pull_request_target', () => {
    const condition = workflow.jobs['gate-change'].if as string;
    const on = (event: string) =>
      evaluate(
        condition,
        (path) => (path.join('.') === 'github.event_name' ? event : undefined),
        {},
      );
    expect(on('pull_request_target')).toBe(true);
    for (const event of ['merge_group', 'schedule', 'workflow_dispatch'])
      expect(on(event), event).toBe(false);
  });

  test.each(['merge_group', 'schedule', 'workflow_dispatch'])(
    'always analyses on %s, where the classifier is skipped',
    (event) => {
      expect(codeqlRuns({ event, gateChange: 'skipped' })).toBe(true);
    },
  );

  test('skips an ordinary PR only on a successful, explicit analyse=false', () => {
    expect(
      codeqlRuns({
        event: 'pull_request_target',
        gateChange: 'success',
        analyse: 'false',
      }),
    ).toBe(false);
  });

  test.each([
    ['a .github/ change', 'success', 'true'],
    ['a classifier that wrote no output', 'success', undefined],
    ['a failed classifier', 'failure', undefined],
    ['a failed classifier that still wrote false', 'failure', 'false'],
    ['a cancelled or timed-out classifier', 'cancelled', undefined],
    ['a skipped classifier', 'skipped', undefined],
  ] as const)('analyses on the PR for %s', (_name, gateChange, analyse) => {
    expect(
      codeqlRuns({ event: 'pull_request_target', gateChange, analyse }),
    ).toBe(true);
  });

  // A not-yet-started job in a cancelled run is evaluated with cancelled()
  // true and, when false, ends `cancelled` (run 36301149467,
  // ci-fast-checks-job-graph.test.ts), which does not satisfy the required
  // context. It does not start a 10-minute analysis for a superseded run.
  test('does not start in a cancelled run', () => {
    expect(
      codeqlRuns({
        event: 'pull_request_target',
        gateChange: 'cancelled',
        runCancelled: true,
      }),
    ).toBe(false);
    expect(
      codeqlRuns({
        event: 'merge_group',
        gateChange: 'skipped',
        runCancelled: true,
      }),
    ).toBe(false);
  });
});
