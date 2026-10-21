import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_ITEM_OBSERVATION_LIMITS } from '@kontourai/station-contracts/work-item-provider';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { GitHubWorkItemObserver } from '../github-work-item-observer.js';
import * as fakeGh from './fixtures/fake-gh.js';
import { comment, issue } from './fixtures/fake-gh.js';

/** The observer against a fake `gh` at the process seam (`fixtures/fake-gh.ts`). */

const temp = trackTempDirs();
let dir: string;
let gh: string;

const REF = 'github:acme/widgets#42';
const ISSUE = 'repos/acme/widgets/issues/42';

const answer = (endpoint: string, payload: unknown) =>
  fakeGh.answer(dir, endpoint, payload);
const fail = (endpoint: string, status: number, message: string) =>
  fakeGh.fail(dir, endpoint, status, message);
const calls = () => fakeGh.calls(dir);

const observer = (
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
) =>
  new GitHubWorkItemObserver({
    command: gh,
    now: () => new Date('2026-10-21T10:00:00.000Z'),
    // A host GH_HOST must not redirect the read: --hostname wins.
    env: { GH_HOST: 'ghe.example.com', FAKE_GH_DIR: dir },
    ...options,
  });

describe.skipIf(process.platform === 'win32')('GitHubWorkItemObserver', () => {
  beforeEach(() => {
    dir = temp('station-fake-gh-');
    gh = fakeGh.installFakeGh(dir);
  });

  test('observes an issue through gh api on github.com, from an empty directory, without prompting', async () => {
    answer(ISSUE, issue({ state: 'closed', state_reason: 'completed' }));
    const result = await observer().observeWorkItem(REF);
    expect(result).toEqual({
      status: 'observed',
      observation: {
        workItemRef: REF,
        url: 'https://github.com/acme/widgets/issues/42',
        title: 'Widgets jam on Tuesdays',
        state: 'closed',
        stateReason: 'completed',
        labels: ['bug', 'P1'],
        updatedAt: '2026-10-20T12:00:00Z',
        observedAt: '2026-10-21T10:00:00.000Z',
        body: 'Steps:\n1. Wait for Tuesday.\n2. Observe the jam.',
      },
    });
    const [call, ...rest] = calls();
    expect(rest).toEqual([]);
    const [cwd, promptDisabled, ghHost, args] = call.split('|');
    expect(cwd).toContain('station-git-tool-');
    expect(cwd).not.toBe(dir);
    expect(promptDisabled).toBe('1');
    // The environment still carries GH_HOST, so only --hostname pins github.com.
    expect(ghHost).toBe('ghe.example.com');
    expect(args).toBe(
      `api --hostname github.com -H Accept: application/vnd.github+json ${ISSUE}`,
    );
  });

  test('a pull request number is unsupported, not observed as an issue', async () => {
    answer(
      ISSUE,
      issue({
        html_url: 'https://github.com/acme/widgets/pull/42',
        draft: false,
        pull_request: {
          url: 'https://api.github.com/repos/acme/widgets/pulls/42',
          html_url: 'https://github.com/acme/widgets/pull/42',
          diff_url: 'https://github.com/acme/widgets/pull/42.diff',
          patch_url: 'https://github.com/acme/widgets/pull/42.patch',
          merged_at: null,
        },
      }),
    );
    expect(await observer().observeWorkItem(REF)).toEqual({
      status: 'unsupported',
      reason: `${REF} is a pull request, not an issue.`,
    });
  });

  test('no gh login is unauthenticated with a gh auth login hint', async () => {
    writeFileSync(join(dir, 'nologin'), '');
    const result = await observer().observeWorkItem(REF);
    expect(result.status).toBe('unauthenticated');
    expect(result.status !== 'observed' && result.reason).toContain(
      'gh auth login',
    );
  });

  test('a rejected token (HTTP 401) is unauthenticated', async () => {
    fail(ISSUE, 401, 'Bad credentials');
    expect((await observer().observeWorkItem(REF)).status).toBe(
      'unauthenticated',
    );
  });

  test.each([
    [404, 'Not Found', 'not-found'],
    [410, 'This issue was deleted', 'not-found'],
    [403, 'API rate limit exceeded for user ID 1001.', 'unavailable'],
    [502, 'Server Error', 'unavailable'],
  ])('HTTP %i is %s', async (status, message, expected) => {
    fail(ISSUE, status, message);
    const result = await observer().observeWorkItem(REF);
    expect(result.status).toBe(expected);
    if (expected === 'unavailable')
      expect(result.status !== 'observed' && result.reason).toContain(message);
  });

  test.each([
    'github:acme/widgets',
    'https://github.com/acme/widgets/issues/42',
    'github:ghe.example.com/acme/widgets#42',
    'gitlab:acme/widgets#42',
  ])('refuses %j without starting gh', async (ref) => {
    expect((await observer().observeWorkItem(ref)).status).toBe('unsupported');
    expect(calls()).toEqual([]);
  });

  test('a missing gh is unavailable', async () => {
    const missing = new GitHubWorkItemObserver({
      command: join(dir, 'no-such-gh'),
    });
    const result = await missing.observeWorkItem(REF);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'The GitHub CLI (gh) is not installed or not on PATH.',
    });
  });

  test('a slow gh is stopped at the deadline', async () => {
    writeFileSync(join(dir, 'sleep'), '');
    const result = await observer({ timeoutMs: 200 }).observeWorkItem(REF);
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'GitHub did not answer within 200 ms.',
    });
  });

  test('an answer over the output bound is refused, not cut', async () => {
    answer(ISSUE, issue({ body: 'x'.repeat(20_000) }));
    const result = await observer({ maxOutputBytes: 8_000 }).observeWorkItem(
      REF,
    );
    expect(result.status).toBe('unavailable');
  });

  test('an incomplete issue payload is unavailable', async () => {
    answer(ISSUE, issue({ number: 43 }));
    expect((await observer().observeWorkItem(REF)).status).toBe('unavailable');
  });

  test('bounds the body with a visible marker', async () => {
    answer(ISSUE, issue({ body: 'y'.repeat(9_000) }));
    const result = await observer().observeWorkItem(REF);
    if (result.status !== 'observed') throw new Error(result.reason);
    expect(result.observation.body).toBe(
      `${'y'.repeat(WORK_ITEM_OBSERVATION_LIMITS.bodyChars)}\n\n[truncated]`,
    );
  });

  test('reads the newest comments from the last two pages, newest last', async () => {
    answer(ISSUE, issue({ comments: 45 }));
    const base = Date.parse('2026-10-02T00:00:00Z');
    const at = (index: number) =>
      new Date(base + index * 60_000).toISOString().replace('.000', '');
    const all = Array.from({ length: 45 }, (_, index) =>
      comment(index + 1, at(index + 1)),
    );
    answer(`${ISSUE}/comments?per_page=30&page=1`, all.slice(0, 30));
    answer(`${ISSUE}/comments?per_page=30&page=2`, all.slice(30));
    const result = await observer().observeWorkItem(REF);
    if (result.status !== 'observed') throw new Error(result.reason);
    const comments = result.observation.comments!;
    expect(comments).toHaveLength(30);
    expect(comments[0]).toEqual({
      author: 'commenter16',
      createdAt: at(16),
      excerpt: 'comment 16',
    });
    expect(comments.at(-1)?.author).toBe('commenter45');

    // Since a known instant: only later comments, still newest last.
    const since = await observer().observeWorkItem(REF, {
      commentsSince: at(42),
    });
    if (since.status !== 'observed') throw new Error(since.reason);
    expect(since.observation.comments?.map((c) => c.author)).toEqual([
      'commenter43',
      'commenter44',
      'commenter45',
    ]);
  });

  test('cuts a long comment to its excerpt bound', async () => {
    answer(ISSUE, issue({ comments: 1 }));
    answer(`${ISSUE}/comments?per_page=30&page=1`, [
      comment(1, '2026-10-03T00:00:00Z', 'z'.repeat(5_000)),
    ]);
    const result = await observer().observeWorkItem(REF);
    if (result.status !== 'observed') throw new Error(result.reason);
    expect(result.observation.comments?.[0].excerpt).toBe(
      `${'z'.repeat(WORK_ITEM_OBSERVATION_LIMITS.commentExcerptChars)}…`,
    );
  });

  test('no comments since the mark is an empty list, not an absent one', async () => {
    answer(ISSUE, issue({ comments: 0 }));
    const result = await observer().observeWorkItem(REF, {
      commentsSince: '2026-10-01T00:00:00Z',
    });
    if (result.status !== 'observed') throw new Error(result.reason);
    expect(result.observation.comments).toEqual([]);
  });
});
