import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildSweepReport,
  collectDatedTodos,
  validateDatedTodoReport,
} from '../dated-todo-sweep.mjs';

const TODAY = '2026-09-25';

function seedSample(root: string) {
  mkdirSync(join(root, 'src-shared'), { recursive: true });
  writeFileSync(
    join(root, 'src-shared', 'sample.ts'),
    [
      '// TODO(2026-01-01): overdue comment',
      'export const ok = 1;',
      '// TODO(2099-01-01): future comment',
      '// TODO: undated comment stays invisible',
      '// TODO(2099-01-01): second future comment',
    ].join('\n'),
  );
}

const makeTempRoot = trackTempDirs({ lifetime: 'file' });

describe('collectDatedTodos', () => {
  it('finds dated TODOs and splits due from upcoming (known-bad)', () => {
    const root = makeTempRoot('dated-todo-');
    seedSample(root);
    const entries = collectDatedTodos({ root, today: TODAY });
    expect(entries).toHaveLength(3);
    expect(
      entries.filter((entry) => entry.due).map((entry) => entry.date),
    ).toEqual(['2026-01-01']);
    expect(entries.filter((entry) => !entry.due)).toHaveLength(2);
  });
});

describe('buildSweepReport and validateDatedTodoReport', () => {
  it('report round-trips through validation', () => {
    const report = buildSweepReport(
      [{ file: 'a.ts', line: 1, date: '2026-01-01', due: true, text: 'x' }],
      { today: TODAY, generatedAt: '2026-09-25T00:00:00Z' },
    );
    expect(validateDatedTodoReport(report, { expectedDate: TODAY })).toBe(
      TODAY,
    );
  });

  it('rejects a report whose marker date does not match (known-bad)', () => {
    const report = buildSweepReport([], {
      today: '2026-09-24',
      generatedAt: '2026-09-24T00:00:00Z',
    });
    expect(() =>
      validateDatedTodoReport(report, { expectedDate: TODAY }),
    ).toThrow(/does not match expected/);
  });

  it('rejects a report missing the marker (known-bad)', () => {
    expect(() =>
      validateDatedTodoReport('no marker here', { expectedDate: TODAY }),
    ).toThrow(/marker/);
  });
});
