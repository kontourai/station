import { describe, expect, it } from 'vitest';
import {
  findSupersededCandidates,
  parseClosingIssues,
} from '../pr-duplicate-sweep.mjs';

describe('findSupersededCandidates', () => {
  const merged = {
    files: [
      'src-server/a.ts',
      'src-server/b.ts',
      'src-server/c.ts',
      'docs/x.md',
    ],
    closingIssueNumbers: new Set([10, 11]),
  };

  it('catches a sibling linked to the same issue (known-bad)', () => {
    const [candidate] = findSupersededCandidates(merged, [
      {
        number: 2,
        files: ['unrelated/other.ts'],
        closingIssueNumbers: new Set([11]),
      },
    ]);
    expect(candidate).toMatchObject({
      number: 2,
      reason: 'shared-linked-issue',
    });
    expect(candidate.evidence).toContain('#11');
  });

  it('catches heavy file overlap (known-bad)', () => {
    const [candidate] = findSupersededCandidates(merged, [
      {
        number: 3,
        files: [
          'src-server/a.ts',
          'src-server/b.ts',
          'src-server/c.ts',
          'src-server/d.ts',
        ],
        closingIssueNumbers: new Set([]),
      },
    ]);
    expect(candidate).toMatchObject({ number: 3, reason: 'file-overlap' });
    expect(candidate.evidence).toContain('src-server/a.ts');
  });

  it('stays silent for light overlap (false-positive control)', () => {
    expect(
      findSupersededCandidates(merged, [
        {
          number: 4,
          files: [
            'src-server/a.ts',
            'unrelated/zz.ts',
            'unrelated/yy.ts',
            'unrelated/xx.ts',
          ],
          closingIssueNumbers: new Set([99]),
        },
      ]),
    ).toEqual([]);
  });

  it('stays silent when only two files are shared below the floor', () => {
    expect(
      findSupersededCandidates(merged, [
        {
          number: 5,
          files: ['src-server/a.ts', 'src-server/b.ts'],
          closingIssueNumbers: new Set([]),
        },
      ]),
    ).toEqual([]);
  });
});

describe('parseClosingIssues', () => {
  it('reads closing verbs and ignores prose references (false-positive control)', () => {
    const numbers = parseClosingIssues(
      'Closes #10, fixes #11. See also #12 and archive#13.',
    );
    expect([...numbers].sort()).toEqual([10, 11]);
  });
});
