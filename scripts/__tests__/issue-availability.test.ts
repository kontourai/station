import { describe, expect, test } from 'vitest';
import { reduceIssueAvailability } from '../issue-availability.mjs';
import {
  commitsInRange,
  mergedIssueFacts,
} from '../lib/github-merged-issue-facts.mjs';

type GitRunner = NonNullable<Parameters<typeof commitsInRange>[2]>;
const gitOutput = (value: string) => (() => value) as unknown as GitRunner;

describe('source availability', () => {
  test('is monotonic and fails closed on conflicting stages', () => {
    expect(reduceIssueAvailability([])).toEqual({
      kind: 'source',
      add: ['stage:source'],
      remove: [],
    });
    expect(reduceIssueAvailability(['stage:source'])).toMatchObject({
      kind: 'unchanged',
    });
    expect(reduceIssueAvailability(['stage:preview'])).toMatchObject({
      kind: 'unchanged',
    });
    expect(
      reduceIssueAvailability(['stage:source', 'stage:stable']),
    ).toMatchObject({ kind: 'conflict' });
  });
  test('derives only exact same-repo merged PR closing facts', () => {
    expect(
      mergedIssueFacts({
        owner: 'kontourai',
        repo: 'station',
        main: 'main',
        commits: ['a'.repeat(40)],
        pulls: [
          {
            merged_at: 'x',
            merge_commit_sha: 'a'.repeat(40),
            base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
            closingIssues: [
              {
                number: 12,
                repository: { full_name: 'kontourai/station' },
              },
            ],
          },
        ],
      }),
    ).toEqual([12]);
    expect(
      mergedIssueFacts({
        owner: 'kontourai',
        repo: 'station',
        main: 'main',
        commits: ['a'.repeat(40)],
        pulls: [
          {
            merged_at: 'x',
            merge_commit_sha: 'a'.repeat(40),
            base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
            closingIssues: [
              {
                number: 9,
                repository: { full_name: 'evil/repo' },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
  test('bounds commit range and rejects malformed facts', () => {
    expect(commitsInRange('bad', 'a'.repeat(40))).toBeNull();
    expect(
      commitsInRange('b'.repeat(40), 'a'.repeat(40), gitOutput('a'.repeat(40))),
    ).toEqual(['a'.repeat(40)]);
    expect(
      commitsInRange(
        'b'.repeat(40),
        'a'.repeat(40),
        gitOutput(`${'a'.repeat(40)}\nmalformed`),
      ),
    ).toBeNull();
  });
});
