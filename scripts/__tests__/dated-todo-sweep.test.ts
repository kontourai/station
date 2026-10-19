import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // Pinned as a literal: the writer and the validator share one constant, so
    // a marker format change on both sides would otherwise round-trip green.
    expect(report.split('\n')[0]).toBe('<!-- dated-todo-sweep 2026-09-25 -->');
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

const SCRIPT = fileURLToPath(
  new URL('../dated-todo-sweep.mjs', import.meta.url),
);

// Runs the workflow's real `--upsert` step as a child process with a fake `gh`
// on PATH that records each call and answers `issue list` with `listing`.
function runUpsert({
  dueEntries,
  listing,
}: {
  dueEntries: number;
  listing: Array<{ number: number; title: string; state: string }>;
}) {
  const root = makeTempRoot('dated-todo-upsert-');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'listing.json'), JSON.stringify(listing));
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$0.calls"',
      'if [ "$1 $2" = "issue list" ]; then cat "$FAKE_GH_LISTING"; fi',
      'if [ "$1 $2" = "issue create" ]; then echo https://example.test/issues/1; fi',
    ].join('\n') + '\n',
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const entries = Array.from({ length: dueEntries }, (_, index) => ({
    file: 'a.ts',
    line: index + 1,
    date: '2026-01-01',
    due: true,
    text: 'x',
  }));
  entries.push({
    file: 'b.ts',
    line: 1,
    date: '2099-01-01',
    due: false,
    text: 'y',
  });
  const reportPath = join(root, 'report.md');
  writeFileSync(
    reportPath,
    buildSweepReport(entries, { today: TODAY, generatedAt: 'now' }),
  );
  execFileSync(
    process.execPath,
    [SCRIPT, '--upsert', '--report', reportPath, '--date', TODAY],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_GH_LISTING: join(root, 'listing.json'),
        GITHUB_REPOSITORY: 'owner/repo',
      },
      windowsHide: true,
    },
  );
  const callsPath = join(bin, 'gh.calls');
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n')
    : [];
  // The listing query is not a mutation; return only the writes.
  return calls.filter((call) => !call.startsWith('issue list'));
}

const ISSUE = { number: 2908, title: 'Dated TODO sweep' };

describe.runIf(process.platform !== 'win32')('upsert step', () => {
  it('closes an open issue instead of reopening it when nothing is due (known-bad)', () => {
    const writes = runUpsert({
      dueEntries: 0,
      listing: [{ ...ISSUE, state: 'OPEN' }],
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^issue edit 2908 --body-file /);
    expect(writes[1]).toMatch(
      /^issue close 2908 --comment No dated TODOs are due/,
    );
  });

  it('leaves a closed issue alone and creates none when nothing is due (known-bad)', () => {
    expect(
      runUpsert({ dueEntries: 0, listing: [{ ...ISSUE, state: 'CLOSED' }] }),
    ).toEqual([]);
    expect(runUpsert({ dueEntries: 0, listing: [] })).toEqual([]);
  });

  it('reopens a closed issue when something is due', () => {
    const writes = runUpsert({
      dueEntries: 1,
      listing: [{ ...ISSUE, state: 'CLOSED' }],
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^issue edit 2908 --body-file /);
    expect(writes[1]).toBe('issue reopen 2908 --repo owner/repo');
  });

  it('creates the P2 issue when something is due and none exists', () => {
    const writes = runUpsert({ dueEntries: 2, listing: [] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^issue create --title Dated TODO sweep .* --label P2 /,
    );
  });
});
