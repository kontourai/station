import { describe, expect, it } from 'vitest';
import { changedPathsSince, describeMatches } from '../lib/change-scope.mjs';

describe('branch-delta scoping', () => {
  it('asks git for the branch delta against the base, not the whole tree', () => {
    const calls: string[][] = [];
    const paths = changedPathsSince('origin/main', (args) => {
      calls.push(args);
      return 'src-ui/src/App.tsx\0src-server/index.ts\0';
    });
    expect(calls).toEqual([
      ['diff', '--name-only', '-z', 'origin/main...HEAD'],
    ]);
    expect(paths).toEqual(['src-ui/src/App.tsx', 'src-server/index.ts']);
  });

  it('drops the trailing empty field -z always produces', () => {
    expect(changedPathsSince('origin/main', () => 'a.ts\0')).toEqual(['a.ts']);
    expect(changedPathsSince('origin/main', () => '')).toEqual([]);
  });
});

describe('match descriptions', () => {
  it('names the matches without printing an unbounded list', () => {
    const many = [
      'src-ui/a.ts',
      'src-ui/b.ts',
      'src-ui/c.ts',
      'src-ui/d.ts',
      'src-ui/e.ts',
    ];
    expect(describeMatches(many)).toBe(
      'src-ui/a.ts, src-ui/b.ts, src-ui/c.ts, +2 more',
    );
    expect(describeMatches(['src-ui/a.ts'])).toBe('src-ui/a.ts');
  });
});
