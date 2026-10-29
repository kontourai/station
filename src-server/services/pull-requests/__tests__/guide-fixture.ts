import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequestReviewSnapshot } from '@kontourai/station-contracts/pull-request-provider';
import { execGit } from '../../../utils/git-exec.js';
import { PullRequestReviewGuideStore } from '../pull-request-review-guide-store.js';
export async function guideFixture(
  makeTempDir: (prefix: string) => string,
  fileName = 'a.ts',
  attributes = false,
) {
  const root = makeTempDir('station-guide-test-');
  const git = async (...args: string[]) =>
    (
      await execGit(args, { cwd: root, timeout: 10_000, maxBuffer: 100_000 })
    ).stdout.trim();
  await git('init');
  if (attributes)
    await writeFile(join(root, '.gitattributes'), '*.ts filter=probe\n');
  await writeFile(join(root, fileName), 'old\n');
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
  await writeFile(join(root, fileName), 'new\n');
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
      repository: { owner: 'team', name: 'repo' },
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
      patch: (
        await execGit(
          ['-c', 'core.quotePath=false', 'diff', `${baseSha}...${headSha}`],
          { cwd: root },
        )
      ).stdout,
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
      owner: 'team',
      name: 'repo',
      remote: 'https://github.com/team/repo.git',
    },
  };
  return { root, git, snapshot, store, context };
}
