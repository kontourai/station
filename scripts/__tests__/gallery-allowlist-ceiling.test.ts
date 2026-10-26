import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

// Runs the PR workflow's own "Refuse allowlist growth" step text under bash,
// against a fork-like checkout that lacks upstream's base commit.

type Step = { name?: string; run?: string };
const workflow = load(
  readFileSync('.github/workflows/gallery-pr-check.yml', 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const STEP = workflow.jobs['allowlist-ceiling'].steps.find(
  (step) => step.name === 'Refuse allowlist growth',
)?.run;
if (!STEP) throw new Error('allowlist-ceiling step not found');

const makeTempDir = trackTempDirs();
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function repo(prefix: string) {
  const root = makeTempDir(prefix);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: ENV,
      windowsHide: true,
    }).trim();
  git('init', '-q');
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'scripts'));
  return { root, git };
}

const writeScreenMap = (root: string, names: string[]) =>
  writeFileSync(
    join(root, 'tests/gallery-screen-sources.json'),
    JSON.stringify({
      schemaVersion: 1,
      shell: [],
      screens: Object.fromEntries(names.map((name) => [name, []])),
    }),
  );

const writeAllowlist = (root: string, screens: Record<string, string[]>) =>
  writeFileSync(
    join(root, 'tests/gallery-ui-findings.allowlist.json'),
    JSON.stringify({ schemaVersion: 1, screens }),
  );

/** Upstream: a base commit, with or without the judge. */
function upstream(withJudge: boolean) {
  const { root, git } = repo('gallery-ceiling-upstream-');
  writeAllowlist(root, { home: ['overflow:document'] });
  writeScreenMap(root, ['home']);
  if (withJudge)
    copyFileSync(
      resolve('scripts/gallery-ui-findings.mjs'),
      join(root, 'scripts/gallery-ui-findings.mjs'),
    );
  else writeFileSync(join(root, 'README'), 'before the judge');
  git('add', '.');
  git('commit', '-qm', 'base');
  // GitHub serves a reachable commit by id; a local upstream must be told to.
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { root, base: git('rev-parse', 'HEAD') };
}

/** A fork's head: unrelated history, so the base is not in its checkout. */
function forkHead(screens: Record<string, string[]>, names = ['home']) {
  const { root, git } = repo('gallery-ceiling-head-');
  writeAllowlist(root, screens);
  writeScreenMap(root, names);
  git('add', '.');
  git('commit', '-qm', 'head');
  return root;
}

function runStep(cwd: string, baseSha: string, upstreamUrl: string) {
  const runner = makeTempDir('gallery-ceiling-runner-');
  const summaryPath = join(runner, 'summary.md');
  writeFileSync(summaryPath, '');
  const run = spawnSync('bash', ['-c', STEP as string], {
    cwd,
    encoding: 'utf8',
    env: {
      ...ENV,
      BASE_SHA: baseSha,
      UPSTREAM_URL: upstreamUrl,
      RUNNER_TEMP: runner,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    status: run.status,
    out: run.stdout + run.stderr,
    summary: readFileSync(summaryPath, 'utf8'),
  };
}

describe('allowlist ceiling step (child process)', { timeout: 120_000 }, () => {
  it('fails when the base commit cannot be resolved, instead of passing', () => {
    const { base } = upstream(true);
    const head = forkHead({ home: ['overflow:document', 'axe:x:y'] });
    const run = runStep(head, base, join(makeTempDir('missing-'), 'nowhere'));
    expect(run.status).toBe(1);
    expect(run.out).toContain(`Cannot resolve base commit ${base}`);
  });

  it("fetches a fork's missing base from upstream and fails growth there", () => {
    const { root, base } = upstream(true);
    const run = runStep(
      forkHead({ home: ['overflow:document', 'axe:x:y'] }),
      base,
      root,
    );
    expect(run.status).toBe(1);
    expect(run.out).toContain('GROWTH home: axe:x:y');
  });

  it('accepts a new screen through the same fetched base', () => {
    const { root, base } = upstream(true);
    const run = runStep(
      forkHead({ home: ['overflow:document'], added: ['axe:x:y'] }, [
        'home',
        'added',
      ]),
      base,
      root,
    );
    expect(run.status).toBe(0);
    // Accepted, and visible: an annotation per new screen, and the listed
    // findings themselves in the run summary.
    expect(run.out).toContain(
      '::warning title=Gallery screen arrived with listed findings::NEW SCREEN added: 1 finding(s)',
    );
    expect(run.summary).toContain('NEW SCREEN added: 1 finding(s)');
    expect(run.summary).toContain('  + axe:x:y');
  });

  it('fails a renamed screen through the same fetched base', () => {
    const { root, base } = upstream(true);
    const run = runStep(
      forkHead({ renamed: ['overflow:document', 'axe:x:y'] }, ['renamed']),
      base,
      root,
    );
    expect(run.status).toBe(1);
    expect(run.out).toContain('REMOVED SCREEN home');
  });

  it('treats a resolvable base without the judge as the bootstrap', () => {
    const { root, base } = upstream(false);
    const run = runStep(forkHead({ home: ['axe:x:y'] }), base, root);
    expect(run.status).toBe(0);
    expect(run.out).toContain('introduces the allowlist ceiling');
  });
});
