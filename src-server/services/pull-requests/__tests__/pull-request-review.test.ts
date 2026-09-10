import type {
  PullRequest,
  PullRequestRepositoryContext,
} from '@kontourai/station-contracts/pull-request-provider';
import { describe, expect, test, vi } from 'vitest';
import {
  readPullRequestReview,
  writePullRequestReview,
} from '../pull-request-review.js';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  changed = 'c'.repeat(40);
const context: PullRequestRepositoryContext = {
  repository: {
    owner: 'group/nested',
    name: 'repo',
    remote: 'https://forge.test/group/nested/repo.git',
  },
  workingDirectory: '/unused',
  branch: 'feature',
  baseRef: 'main',
};
const normalized: PullRequest = {
  provider: 'github',
  host: 'forge.test',
  ref: '17',
  url: 'https://forge.test/group/nested/repo/pull/17',
  repository: { owner: '', name: '' },
  title: 'Change',
  body: null,
  state: 'OPEN',
  author: { login: 'author' },
  sourceBranch: 'feature',
  targetBranch: 'main',
  commits: 1,
  reviewStatus: 'NONE',
  comments: 0,
  nativeId: '17',
  mergeability: 'unknown',
};
const raw = (forge: 'github' | 'gitlab', revision = head) =>
  forge === 'github'
    ? { headRefOid: revision, baseRefOid: base, comments: [], reviews: [] }
    : { diff_refs: { head_sha: revision, base_sha: base } };
const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
for (const forge of ['github', 'gitlab'] as const)
  describe(forge, () => {
    test('reads only the named forge and refuses a diff whose head changed mid-read', async () => {
      let reads = 0;
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'view')
          return json(raw(forge, ++reads === 1 ? head : changed));
        if (args[1].includes('notes?')) return json([]);
        return {
          stdout:
            'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n',
        };
      });
      await expect(
        readPullRequestReview(forge, 'forge.test', context, '17', run, () => ({
          ...normalized,
          provider: forge,
        })),
      ).rejects.toThrow('changed during');
      expect(
        run.mock.calls.every(
          ([args]) =>
            args.includes('forge.test') ||
            args.some((a) => a.includes('forge.test/')),
        ),
      ).toBe(true);
    });
    test('keeps discussion readable when a bounded diff is unavailable', async () => {
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'view') return json(raw(forge));
        if (args[1].includes('notes?')) return json([]);
        return { stdout: 'x'.repeat(262145) };
      });
      const result = await readPullRequestReview(
        forge,
        'forge.test',
        context,
        '17',
        run,
        () => ({ ...normalized, provider: forge }),
      );
      expect(result.diff).toMatchObject({ state: 'unavailable' });
      expect(result).toMatchObject({
        headSha: head,
        baseSha: base,
        pullRequest: {
          repository: context.repository.owner
            ? { owner: 'group/nested', name: 'repo' }
            : {},
        },
      });
    });
    test('changed revision refuses before any provider write', async () => {
      const run = vi.fn(async (args: string[]) =>
        json(
          args[1] === 'user'
            ? { id: 7, login: 'operator', username: 'operator' }
            : raw(forge, changed),
        ),
      );
      await expect(
        writePullRequestReview(
          forge,
          'forge.test',
          context,
          '17',
          { action: 'approve', expectedHeadSha: head },
          run,
        ),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('head changed'),
      });
      expect(run.mock.calls.some(([args]) => args.includes('POST'))).toBe(
        false,
      );
    });
    test('approval binds the provider write to the inspected SHA and verifies the actor', async () => {
      const run = vi.fn(async (args: string[]) => {
        if (args[1] === 'user')
          return json({ id: 7, login: 'operator', username: 'operator' });
        if (args[1] === 'view') return json(raw(forge));
        return json(
          forge === 'github'
            ? {
                id: 80,
                user: { id: 7, login: 'operator' },
                commit_id: head,
                state: 'APPROVED',
              }
            : { id: 80, approved_by: [{ user: { id: 7 } }] },
        );
      });
      await expect(
        writePullRequestReview(
          forge,
          'forge.test',
          context,
          '17',
          { action: 'approve', expectedHeadSha: head },
          run,
        ),
      ).resolves.toEqual({
        status: 'confirmed',
        nativeId: '80',
        actor: 'operator',
        headSha: head,
      });
      const write = run.mock.calls.find(([args]) => args.includes('POST'))![0];
      expect(write).toContain(
        `${forge === 'github' ? 'commit_id' : 'sha'}=${head}`,
      );
    });
    test('lost acknowledgement and wrong actor remain indeterminate', async () => {
      for (const failure of ['lost', 'actor']) {
        const run = vi.fn(async (args: string[]) => {
          if (args[1] === 'user')
            return json({ id: 7, login: 'operator', username: 'operator' });
          if (args[1] === 'view') return json(raw(forge));
          if (failure === 'lost') throw Error('response lost');
          return json(
            forge === 'github'
              ? { id: 80, user: { id: 8 }, commit_id: head, state: 'APPROVED' }
              : { id: 80, approved_by: [{ user: { id: 8 } }] },
          );
        });
        await expect(
          writePullRequestReview(
            forge,
            'forge.test',
            context,
            '17',
            { action: 'approve', expectedHeadSha: head },
            run,
          ),
        ).resolves.toMatchObject({ status: 'indeterminate' });
        expect(
          run.mock.calls.filter(([args]) => args.includes('POST')),
        ).toHaveLength(1);
      }
    });
  });

test('both provider merge transports carry the inspected SHA and observe completion', async () => {
  const { GitHubPullRequestProvider } = await import(
    '../github-pull-request-provider.js'
  );
  const { GitLabPullRequestProvider } = await import(
    '../gitlab-pull-request-provider.js'
  );
  for (const [Constructor, flag, state] of [
    [GitHubPullRequestProvider, '--match-head-commit', 'MERGED'],
    [GitLabPullRequestProvider, '--sha', 'merged'],
  ] as const) {
    const run = vi.fn(async (args: string[]) =>
      args[1] === 'view' ? json({ state }) : { stdout: '' },
    );
    const provider = new Constructor(run);
    const result = await provider.mergePullRequest(context, '17', {
      method: 'merge',
      expectedHeadSha: head,
    });
    expect(result.data).toEqual({ status: 'merged' });
    const call = run.mock.calls.find(([args]) => args[1] === 'merge')![0];
    expect(call).toContain(flag);
    expect(call[call.indexOf(flag) + 1]).toBe(head);
  }
});
test('a lost revision-bound merge acknowledgement is not reported as refusal or success', async () => {
  const { GitHubPullRequestProvider } = await import(
    '../github-pull-request-provider.js'
  );
  const { GitLabPullRequestProvider } = await import(
    '../gitlab-pull-request-provider.js'
  );
  for (const Constructor of [
    GitHubPullRequestProvider,
    GitLabPullRequestProvider,
  ]) {
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'merge') throw Error('connection lost');
      return { stdout: '' };
    });
    const result = await new Constructor(run).mergePullRequest(context, '17', {
      method: 'merge',
      expectedHeadSha: head,
    });
    expect(result.data).toMatchObject({ status: 'indeterminate' });
    expect(run.mock.calls.filter(([args]) => args[1] === 'merge')).toHaveLength(
      1,
    );
  }
});
