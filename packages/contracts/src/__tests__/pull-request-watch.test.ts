import { describe, expect, it } from 'vitest';
import type { PullRequestFeedbackObservation } from '../pull-request-feedback.js';
import {
  DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
  parseProjectPullRequestWatchSettings,
  pullRequestReadyForPerson,
  resolveTaskPullRequestWatch,
} from '../pull-request-watch.js';
import { deriveTaskLane } from '../task-lane.js';

function observation(
  overrides: Partial<PullRequestFeedbackObservation> = {},
): PullRequestFeedbackObservation {
  return {
    identity: {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'acme', name: 'widgets' },
      ref: '42',
    },
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'OPEN',
    draft: false,
    headSha: 'a1b2c3d',
    baseSha: 'b2c3d4e',
    headRefName: 'topic',
    baseRefName: 'main',
    mergeable: 'mergeable',
    checks: [
      { name: 'ci', conclusion: 'SUCCESS', completed: true, required: true },
    ],
    checksTruncated: false,
    threads: [],
    threadsTotal: 0,
    reviews: [],
    observedAt: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('pull request watch settings', () => {
  it('parses a Project setting and defaults the fix attempts', () => {
    expect(parseProjectPullRequestWatchSettings({ enabled: true })).toEqual({
      enabled: true,
      maxFixAttempts: DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
    });
    expect(
      parseProjectPullRequestWatchSettings({
        enabled: false,
        maxFixAttempts: 5,
      }),
    ).toEqual({ enabled: false, maxFixAttempts: 5 });
    for (const bad of [
      null,
      [],
      {},
      { enabled: 'yes' },
      { enabled: true, maxFixAttempts: 0 },
      { enabled: true, maxFixAttempts: 11 },
      { enabled: true, maxFixAttempts: 1.5 },
      { enabled: true, extra: 1 },
    ])
      expect(parseProjectPullRequestWatchSettings(bad)).toBeUndefined();
  });

  it('a Task’s own choice overrides its Project; an ended Task watches nothing', () => {
    const project = { pullRequestWatch: { enabled: true, maxFixAttempts: 4 } };
    expect(
      resolveTaskPullRequestWatch(project, { status: 'in_progress' }),
    ).toEqual({ watching: true, source: 'project', maxFixAttempts: 4 });
    expect(
      resolveTaskPullRequestWatch(project, {
        status: 'in_progress',
        pullRequestWatch: 'off',
      }),
    ).toEqual({ watching: false, source: 'task', maxFixAttempts: 4 });
    expect(
      resolveTaskPullRequestWatch(undefined, {
        status: 'review',
        pullRequestWatch: 'on',
      }),
    ).toEqual({
      watching: true,
      source: 'task',
      maxFixAttempts: DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
    });
    expect(
      resolveTaskPullRequestWatch(project, { status: 'done' }).watching,
    ).toBe(false);
  });
});

describe('ready for the person', () => {
  it('is open, passing, answered and mergeable', () => {
    expect(pullRequestReadyForPerson(observation())).toBe(true);
    // Unknown mergeability is not a conflict.
    expect(
      pullRequestReadyForPerson(observation({ mergeable: 'unknown' })),
    ).toBe(true);
  });

  it.each([
    ['a draft', { draft: true }],
    ['merged', { state: 'MERGED' as const }],
    ['conflicting', { mergeable: 'conflicting' as const }],
    [
      'a check running',
      {
        checks: [
          { name: 'ci', conclusion: null, completed: false, required: true },
        ],
      },
    ],
    [
      'a check failing',
      {
        checks: [
          {
            name: 'ci',
            conclusion: 'FAILURE',
            completed: true,
            required: false,
          },
        ],
      },
    ],
    ['checks not all read', { checksTruncated: true }],
    ['a change request', { reviewDecision: 'CHANGES_REQUESTED' }],
    [
      'an unresolved thread',
      {
        threads: [
          {
            id: 't',
            resolved: false,
            outdated: false,
            path: 'a.ts',
            line: 1,
            subject: 'line' as const,
            totalComments: 1,
            comments: [],
          },
        ],
        threadsTotal: 1,
      },
    ],
    ['threads not all read', { threadsTotal: 3 }],
  ])('is not ready with %s', (_name, overrides) => {
    expect(pullRequestReadyForPerson(observation(overrides))).toBe(false);
  });
});

describe('a Task held for its person', () => {
  it('reads as Needs you with the failing checks named', () => {
    const derived = deriveTaskLane({
      task: {
        id: 't',
        projectId: 'p',
        title: 'Work',
        description: '',
        priority: 'normal',
        status: 'blocked',
        createdBy: 'u',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z',
        pullRequestWatchHold: {
          checks: ['ci / unit-tests', 'lint'],
          pullRequest: 'acme/widgets#42',
          at: '2026-11-10T12:00:00.000Z',
        },
      },
      session: undefined,
      pullRequests: [],
    });
    expect(derived).toMatchObject({
      placement: { kind: 'lane', lane: 'needs_you' },
      rung: 'fixAttemptsUsed',
      word: 'Fix attempts used',
      detail: 'ci / unit-tests, lint',
    });
  });
});
