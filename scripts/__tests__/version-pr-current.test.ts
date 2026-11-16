import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';
import {
  decideVersionPrCurrent,
  probeVersionPrCurrent,
  selectVersionPr,
} from '../version-pr-current.mjs';
import { runWorkflowShell } from './fixtures/workflow-shell.js';

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};

const makeTempDir = trackTempDirs();
const workflow = load(
  readFileSync(resolve('.github/workflows/publish-packages.yml'), 'utf8'),
) as { jobs: { publish: { steps: Step[] } } };
const steps = workflow.jobs.publish.steps;
const REPO = 'kontourai/station';
const changesetBin = resolve('node_modules/@changesets/cli/bin.js');
// The repository's own generator, so changelog lines carry the real commit
// references `changeset version` looks up in Git.
const changelog = resolve('scripts/changeset-changelog.mjs');
const versionCommand = [process.execPath, changesetBin, 'version'];

// The exact fields GitHub's REST `GET /repos/{repo}/pulls` returns for the
// version PR (captured from kontourai/station#5041), reduced to those read.
function versionPull(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 5041,
    state: 'open',
    draft: false,
    user: { login: 'station-automation[bot]', type: 'Bot' },
    head: {
      ref: 'changeset-release/main',
      sha,
      repo: { full_name: REPO },
    },
    base: { ref: 'main' },
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]) {
  return execFileSyncBounded(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const manifest = (
  name: string,
  version: string,
  deps?: Record<string, string>,
) =>
  `${JSON.stringify({ name, version, ...(deps ? { dependencies: deps } : {}) }, null, 2)}\n`;
const note = (pkg: string, summary: string) =>
  `---\n"${pkg}": patch\n---\n\n${summary}\n`;

/**
 * A two-package workspace on `main` with pending notes, and the version PR
 * head the action writes: one `changeset version` commit on that main.
 */
function fixtureRepo(notes: Record<string, string> = { 'fix-a': 'Fix a.' }) {
  const root = makeTempDir('station-version-pr-current-');
  git(root, 'init', '-q', '-b', 'main');
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'root', private: true }, null, 2)}\n`,
  );
  write(root, 'pnpm-workspace.yaml', 'packages: [packages/a, packages/b]\n');
  write(root, 'packages/a/package.json', manifest('@fixture/a', '1.0.0'));
  write(
    root,
    'packages/b/package.json',
    manifest('@fixture/b', '1.0.0', { '@fixture/a': '^1.0.0' }),
  );
  write(
    root,
    '.changeset/config.json',
    `${JSON.stringify({ changelog, commit: false, access: 'public', baseBranch: 'main', updateInternalDependencies: 'patch', fixed: [], linked: [], ignore: [] }, null, 2)}\n`,
  );
  write(root, 'src/app.txt', 'one\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  for (const [id, summary] of Object.entries(notes)) {
    write(root, `.changeset/${id}.md`, note('@fixture/a', summary));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `feat: ${id}`);
  }
  git(root, 'checkout', '-q', '-b', 'changeset-release/main');
  execFileSyncBounded(process.execPath, [changesetBin, 'version'], {
    cwd: root,
    encoding: 'utf8',
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: version packages');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  return { root, head };
}

function onMain(root: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(root, path));
    else write(root, path, content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main moves');
}

function probe(
  root: string,
  pulls: unknown,
  extra: Record<string, unknown> = {},
) {
  return probeVersionPrCurrent({
    cwd: root,
    eventName: 'push',
    ref: 'refs/heads/main',
    repository: REPO,
    listPulls: async () => pulls,
    versionCommand,
    ...extra,
  });
}

describe('version PR currency probe on real git and changesets', () => {
  test('leaves the PR alone when main moved without touching the release', async () => {
    const { root, head } = fixtureRepo();
    onMain(root, { 'src/app.txt': 'two\n' });
    const before = git(root, 'rev-parse', 'HEAD');
    const decision = await probe(root, [versionPull(head)]);
    expect(decision).toEqual({
      current: true,
      reason: 'merging the open PR yields exactly the regenerated release',
      number: 5041,
    });
    // The probe ran `changeset version` in the checkout; it must leave no trace.
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  });

  test.each([
    ['a new note', { '.changeset/fix-b.md': note('@fixture/a', 'Fix b.') }],
    [
      'a new internal dependency range the version bump must rewrite',
      {
        'pnpm-workspace.yaml':
          'packages: [packages/a, packages/b, packages/c]\n',
        'packages/c/package.json': manifest('@fixture/c', '1.0.0', {
          '@fixture/a': '1.0.0',
        }),
      },
    ],
  ] as const)('regenerates when main adds %s', async (_label, files) => {
    const { root, head } = fixtureRepo();
    onMain(root, files);
    const decision = await probe(root, [versionPull(head)]);
    expect(decision.current).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('regenerates when a consumed note is removed from main', async () => {
    const { root, head } = fixtureRepo({
      'fix-a': 'Fix a.',
      'fix-c': 'Fix c.',
    });
    onMain(root, { '.changeset/fix-c.md': null });
    const decision = await probe(root, [versionPull(head)]);
    expect(decision).toMatchObject({
      current: false,
      reason: 'regenerating would change what the PR releases',
    });
  });

  test('regenerates when a consumed note is edited in place', async () => {
    const { root, head } = fixtureRepo();
    onMain(root, {
      '.changeset/fix-a.md': note('@fixture/a', 'Fix a, reworded.'),
    });
    const decision = await probe(root, [versionPull(head)]);
    expect(decision.current).toBe(false);
  });

  test('regenerates when the PR head conflicts with main', async () => {
    const { root, head } = fixtureRepo();
    onMain(root, {
      'packages/a/package.json': manifest('@fixture/a', '1.0.7'),
    });
    const decision = await probe(root, [versionPull(head)]);
    expect(decision).toMatchObject({
      current: false,
      reason: 'PR head does not merge cleanly into main',
    });
  });

  test('regenerates when the PR head is not a commit this checkout has', async () => {
    const { root } = fixtureRepo();
    const decision = await probe(root, [versionPull('f'.repeat(40))]);
    expect(decision).toMatchObject({
      current: false,
      reason: 'local PR head differs from the listed PR head',
    });
  });

  test('regenerates when the PR listing cannot be read', async () => {
    const { root } = fixtureRepo();
    const decision = await probe(root, undefined, {
      listPulls: async () => {
        throw new Error('listing version PRs returned HTTP 502');
      },
    });
    expect(decision).toEqual({
      current: false,
      reason: 'unreadable state: listing version PRs returned HTTP 502',
    });
  });

  test('regenerates and restores the checkout when the version script fails', async () => {
    const { root, head } = fixtureRepo();
    onMain(root, { 'src/app.txt': 'two\n' });
    const decision = await probe(root, [versionPull(head)], {
      versionCommand: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('stray.txt','x');process.exit(3)",
      ],
    });
    expect(decision.current).toBe(false);
    expect(decision.reason).toContain('version command exited 3');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('regenerates on a dirty checkout and for any event but a push to main', async () => {
    const { root, head } = fixtureRepo();
    onMain(root, { 'src/app.txt': 'two\n' });
    write(root, 'src/app.txt', 'dirty\n');
    expect(await probe(root, [versionPull(head)])).toMatchObject({
      current: false,
      reason: 'checkout is not clean before the probe',
    });
    git(root, 'checkout', '--', '.');
    for (const [eventName, ref] of [
      ['workflow_dispatch', 'refs/heads/main'],
      ['push', 'refs/heads/feature'],
    ]) {
      expect(
        await probe(root, [versionPull(head)], { eventName, ref }),
      ).toMatchObject({ current: false });
    }
  });
});

describe('version PR selection and decision', () => {
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const head = { sha, parents: ['c'.repeat(40)], parentOnMain: true };
  const decide = (overrides: Record<string, unknown> = {}) =>
    decideVersionPrCurrent({
      pulls: [versionPull(sha)],
      repository: REPO,
      head,
      merge: { clean: true, tree },
      regeneratedTree: tree,
      ...overrides,
    });

  test('only an identical clean merge of the bot PR is current', () => {
    expect(decide().current).toBe(true);
    expect(decide({ regeneratedTree: 'd'.repeat(40) }).current).toBe(false);
    expect(decide({ merge: { clean: false } }).current).toBe(false);
    expect(decide({ regeneratedTree: undefined }).current).toBe(false);
    expect(decide({ merge: { clean: true, tree: '' } }).current).toBe(false);
  });

  test.each([
    [
      'a fork using the branch name',
      {
        head: {
          ref: 'changeset-release/main',
          sha,
          repo: { full_name: 'someone/station' },
        },
      },
    ],
    [
      'a deleted fork',
      { head: { ref: 'changeset-release/main', sha, repo: null } },
    ],
    [
      'another author on the branch',
      { user: { login: 'someone', type: 'User' } },
    ],
    [
      'another head branch',
      { head: { ref: 'feature', sha, repo: { full_name: REPO } } },
    ],
    ['another base', { base: { ref: 'release' } }],
    ['a closed PR', { state: 'closed' }],
  ])('refuses %s', (_label, overrides) => {
    expect(
      selectVersionPr([versionPull(sha, overrides)], REPO).pr,
    ).toBeUndefined();
    expect(decide({ pulls: [versionPull(sha, overrides)] }).current).toBe(
      false,
    );
  });

  test.each([
    ['no PR', []],
    ['two PRs', [versionPull(sha), versionPull(sha, { number: 1 })]],
    ['a non-array listing', { message: 'Bad credentials' }],
  ])('refuses %s', (_label, pulls) => {
    expect(decide({ pulls }).current).toBe(false);
  });

  test.each([
    ['a different local head', { ...head, sha: 'e'.repeat(40) }],
    [
      'a multi-commit head',
      { ...head, parents: ['c'.repeat(40), 'd'.repeat(40)] },
    ],
    ['a head not based on main', { ...head, parentOnMain: false }],
  ])('refuses %s', (_label, value) => {
    expect(decide({ head: value }).current).toBe(false);
  });
});

function evaluate(source: string, context: Record<string, unknown>) {
  const code = source
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(
      /steps\.([a-z-]+)\.(outputs|outcome)(?:\.([a-z-]+))?/g,
      (_m, step, kind, key) =>
        `(ctx.steps[${JSON.stringify(step)}]?.${kind}${key ? `?.[${JSON.stringify(key)}]` : ''} ?? '')`,
    )
    .replace(/github\.event_name/g, 'ctx.event');
  return new Function('ctx', `return (${code});`)(context);
}

describe('publish workflow wiring', () => {
  const index = (id: string) => steps.findIndex((step) => step.id === id);
  const probeStep = steps[index('version-current')];
  const action = steps[index('changesets')];
  const clean = steps.find(
    (step) => step.name === 'Require a clean checkout after the version probe',
  );

  test('probes after the credential guard and before the action, failing open', () => {
    const guard = steps.findIndex(
      (step) => step.name === 'Require version PR installation token',
    );
    expect(probeStep.run).toBe('node scripts/version-pr-current.mjs');
    expect(probeStep['continue-on-error']).toBe(true);
    expect(probeStep.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(guard).toBeLessThan(index('version-current'));
    expect(index('version-current')).toBeLessThan(steps.indexOf(clean!));
    expect(steps.indexOf(clean!)).toBeLessThan(index('changesets'));
  });

  test.each([
    ['push', 'true', true],
    ['push', 'false', false],
    ['workflow_dispatch', 'true', false],
  ])('probe runs for %s with version-pr %s: %s', (event, versionPr, runs) => {
    expect(
      evaluate(probeStep.if!, {
        event,
        steps: {
          'version-operation': { outputs: { 'version-pr': versionPr } },
        },
      }),
    ).toBe(runs);
  });

  test.each([
    ['true', false],
    ['false', true],
    ['', true],
  ])(
    'the action runs unless the probe said current (%j): %s',
    (current, runs) => {
      expect(
        evaluate(action.if!, {
          steps: { 'version-current': { outputs: { current } } },
        }),
      ).toBe(runs);
    },
  );

  test('the clean-checkout step runs whenever the probe ran, even after it failed', () => {
    for (const [outcome, runs] of [
      ['success', true],
      ['failure', true],
      ['skipped', false],
    ] as const) {
      expect(
        evaluate(clean!.if!, { steps: { 'version-current': { outcome } } }),
      ).toBe(runs);
    }
  });

  test('the clean-checkout bytes remove what a probe left behind', () => {
    const { root } = fixtureRepo();
    write(root, 'src/app.txt', 'dirty\n');
    write(root, 'stray.txt', 'stray\n');
    const result = runWorkflowShell(clean!.run!, root, {}, 10_000);
    expect(result.status).toBe(0);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('the run report names a left-alone version PR instead of a failure', () => {
    const report = steps.find(
      (step) => step.name === 'Report what this run did',
    );
    const summary = join(makeTempDir('station-version-pr-report-'), 'summary');
    const bindings = {
      PUBLISH_RUN: 'false',
      GITHUB_STEP_SUMMARY: summary,
    };
    const left = runWorkflowShell(
      report!.run!,
      process.cwd(),
      {
        ...bindings,
        OUTCOME: 'skipped',
        VERSION_PR_CURRENT: 'true',
        CURRENT_PR_NUMBER: '5041',
      },
      10_000,
    );
    expect(left.status).toBe(0);
    expect(left.stdout).toContain('version PR #5041 left unchanged');
    expect(report!.env).toMatchObject({
      VERSION_PR_CURRENT: '${{ steps.version-current.outputs.current }}',
      CURRENT_PR_NUMBER: '${{ steps.version-current.outputs.pr-number }}',
    });
  });
});
