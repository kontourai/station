import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestReviewSnapshot } from '@kontourai/station-contracts/pull-request-provider';
import type { PullRequestReviewGuideStop } from '@kontourai/station-contracts/pull-request-review-guide';
import { afterEach, expect, test, vi } from 'vitest';
import { execGit } from '../../../utils/git-exec.js';
import { PullRequestReviewGuideService } from '../pull-request-review-guide.js';
import {
  normalizeReviewGuide,
  readGuideChange,
} from '../pull-request-review-guide-normalize.js';
import { PullRequestReviewGuideStore } from '../pull-request-review-guide-store.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const identity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'team', name: 'repo' },
  ref: '17',
};
const stop = (): PullRequestReviewGuideStop => ({
  title: 'Use the new contract',
  summary: 'The caller now receives the new value.',
  attention: null,
  excerpts: [
    { path: 'a.ts', side: 'new', start: 1, end: 1, caption: 'New contract' },
  ],
  files: [],
  notes: [],
  questions: [],
});
const patch =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

test('normalization covers every changed file and rejects hallucinated, reversed, oversized and missing-line excerpts', () => {
  const change = readGuideChange(['a.ts', 'image.png'], patch);
  expect(
    normalizeReviewGuide({ stops: [stop()] }, change).flatMap((s) => [
      ...s.excerpts.map((e) => e.path),
      ...s.files.map((f) => f.path),
    ]),
  ).toEqual(['a.ts', 'image.png']);
  for (const excerpt of [
    { path: 'missing.ts', start: 1, end: 1 },
    { path: 'a.ts', start: 2, end: 1 },
    { path: 'a.ts', start: 1, end: 26 },
    { path: 'a.ts', start: 1, end: 2 },
  ])
    expect(() =>
      normalizeReviewGuide(
        {
          stops: [
            { ...stop(), excerpts: [{ ...stop().excerpts[0], ...excerpt }] },
          ],
        },
        change,
      ),
    ).toThrow(/excerpt/);
});

test('rejects a range spanning adjacent distinct hunks', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -2 +2 @@\n-two\n+second\n';
  const s = stop();
  s.excerpts[0]!.end = 2;
  expect(() =>
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], patch)),
  ).toThrow(/excerpt/);
});

test('deleted files and source lines resembling headers retain their actual side and file', () => {
  const deleted =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n---- source\n-+++ source\n';
  const s = stop();
  s.excerpts = [{ path: 'a.ts', side: 'old', start: 1, end: 2, caption: '' }];
  expect(
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], deleted))[0]
      ?.excerpts,
  ).toHaveLength(1);
  s.excerpts[0]!.side = 'new';
  expect(() =>
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], deleted)),
  ).toThrow(/excerpt/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'station-guide-test-'));
  roots.push(root);
  const git = async (...args: string[]) =>
    (
      await execGit(args, { cwd: root, timeout: 10_000, maxBuffer: 100_000 })
    ).stdout.trim();
  await git('init');
  await writeFile(join(root, 'a.ts'), 'old\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Guide Test',
    '-c',
    'user.email=guide@example.test',
    'commit',
    '-m',
    'base',
  );
  const baseSha = await git('rev-parse', 'HEAD');
  await writeFile(join(root, 'a.ts'), 'new\n');
  await writeFile(join(root, 'extra.txt'), 'mechanical\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Guide Test',
    '-c',
    'user.email=guide@example.test',
    'commit',
    '-m',
    'change',
  );
  const headSha = await git('rev-parse', 'HEAD');
  const snapshot: PullRequestReviewSnapshot = {
    headSha,
    baseSha,
    observedAt: new Date().toISOString(),
    pullRequest: {
      provider: 'github',
      host: 'github.com',
      ref: '17',
      title: 'Change value',
      body: '',
      url: 'https://github.com/team/repo/pull/17',
      repository: identity.repository,
      sourceBranch: 'feature',
      targetBranch: 'main',
      state: 'OPEN',
      mergeability: 'unknown',
      author: { login: 'author' },
      commits: 1,
      reviewStatus: '',
      comments: 0,
      nativeId: '17',
    },
    diff: {
      state: 'available',
      patch: (await execGit(['diff', `${baseSha}...${headSha}`], { cwd: root }))
        .stdout,
      completeness: 'provider-output',
    },
    discussion: [],
    discussionPartial: false,
    checks: { state: 'available', checks: [], partial: false },
  };
  const store = new PullRequestReviewGuideStore(join(root, 'home'));
  const context = {
    workingDirectory: root,
    repository: {
      ...identity.repository,
      remote: 'https://github.com/team/repo.git',
    },
  };
  return { root, git, snapshot, store, context };
}

test('generation creates and cleans a temporary checkout, persists coverage across restart and hides stale anchors after a push', async () => {
  const f = await fixture();
  const before = await f.git('worktree', 'list', '--porcelain');
  const generate = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('extra.txt');
    expect(prompt).toContain('new\\n');
    expect(await f.git('worktree', 'list', '--porcelain')).toContain(
      'station-review-guide-',
    );
    return { stops: [stop()] };
  });
  const errors: unknown[] = [];
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({
      enabled: true,
      model: 'configured-model',
      instructions: 'Contracts first',
    }),
    generate,
    (error) => errors.push(error),
  );
  expect(
    service.start({ identity, context: f.context, snapshot: f.snapshot }).run
      ?.state,
  ).toBe('Running');
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  await vi.waitFor(
    () => expect(service.read(identity, f.snapshot.headSha).run).toBeNull(),
    { timeout: 15_000 },
  );
  expect(errors).toEqual([]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(await f.git('worktree', 'list', '--porcelain')).toBe(before);
  expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('new\n');
  const restarted = new PullRequestReviewGuideService(
    new PullRequestReviewGuideStore(join(f.root, 'home')),
    () => ({ enabled: true, model: 'other', instructions: '' }),
    generate,
    () => {},
  );
  const current = restarted.read(
    identity,
    f.snapshot.headSha,
    f.snapshot.diff.state === 'available' ? f.snapshot.diff.patch : '',
  );
  expect(current.guide?.modelSelection).toBe('configured-model');
  expect(
    current.guide?.stops.flatMap((s) => s.files).map((f) => f.path),
  ).toContain('extra.txt');
  expect(current.excerptContents[0]?.lines).toEqual(['new']);
  const stale = restarted.read(identity, 'b'.repeat(40), patch);
  expect(stale.guide?.headSha).toBe(f.snapshot.headSha);
  expect(stale.currentHeadSha).toBe('b'.repeat(40));
  expect(stale.guide?.stops.flatMap((s) => s.excerpts)).toEqual([]);
  expect(stale.excerptContents).toEqual([]);
}, 20_000);

test('invalid model anchors fail the run without publishing a guide and still remove the checkout', async () => {
  const f = await fixture();
  const broken = stop();
  broken.excerpts[0]!.start = 900;
  broken.excerpts[0]!.end = 900;
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    async () => ({ stops: [broken] }),
    () => {},
  );
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  await vi.waitFor(
    () =>
      expect(service.read(identity, f.snapshot.headSha).run?.state).toBe(
        'Failed',
      ),
    { timeout: 15_000 },
  );
  expect(f.store.latest(identity)).toBeNull();
  expect(await f.git('worktree', 'list', '--porcelain')).not.toContain(
    'station-review-guide-',
  );
}, 20_000);
