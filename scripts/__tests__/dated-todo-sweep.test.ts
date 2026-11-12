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
// on PATH that records each call. The step goes through the shared tracking-
// issue protocol (`lib/tracking-issue.mjs`): one title search, answered here
// with `existing` — the issue numbers that search's own `--jq` filter prints
// for an exact-title match — then at most one REST write.
function runUpsert({
  dueEntries,
  existing,
}: {
  dueEntries: number;
  existing: number[];
}) {
  const root = makeTempRoot('dated-todo-upsert-');
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(root, 'numbers.txt'),
    existing.map((number) => `${number}\n`).join(''),
  );
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$0.calls"',
      'case "$*" in',
      '  *search/issues*) cat "$FAKE_GH_NUMBERS" ;;',
      // A created issue answers with its number; a PATCH's output is unused.
      '  *) echo 1 ;;',
      'esac',
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
        FAKE_GH_NUMBERS: join(root, 'numbers.txt'),
        GITHUB_REPOSITORY: 'owner/repo',
      },
      windowsHide: true,
    },
  );
  const callsPath = join(bin, 'gh.calls');
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n')
    : [];
  const searches = calls.filter((call) => call.includes('search/issues'));
  // Exactly one lookup, by the stable title, before any write.
  expect(searches).toHaveLength(1);
  expect(calls[0]).toBe(searches[0]);
  expect(searches[0]).toContain(
    'q=repo:owner/repo is:issue in:title "Dated TODO sweep"',
  );
  // The lookup is not a mutation; return only the writes.
  return calls.filter((call) => !call.includes('search/issues'));
}

const ISSUE = 2908;

describe.runIf(process.platform !== 'win32')('upsert step', () => {
  it('closes the issue instead of reopening it when nothing is due (known-bad)', () => {
    const writes = runUpsert({ dueEntries: 0, existing: [ISSUE] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^api --method PATCH repos\/owner\/repo\/issues\/2908 -F body=@.+ -f state=closed -f state_reason=completed /,
    );
  });

  it('creates no issue when nothing is due and none exists (known-bad)', () => {
    expect(runUpsert({ dueEntries: 0, existing: [] })).toEqual([]);
  });

  it('refreshes the issue and holds it open when something is due', () => {
    const writes = runUpsert({ dueEntries: 1, existing: [ISSUE] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^api --method PATCH repos\/owner\/repo\/issues\/2908 -F body=@.+ -f state=open /,
    );
    expect(writes[0]).not.toContain('state_reason');
  });

  it('creates the P2 issue when something is due and none exists', () => {
    const writes = runUpsert({ dueEntries: 2, existing: [] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^api --method POST repos\/owner\/repo\/issues -f title=Dated TODO sweep -F body=@.+ -f labels\[\]=P2 /,
    );
  });

  it('writes to the lowest-numbered issue when more than one carries the title', () => {
    const writes = runUpsert({ dueEntries: 1, existing: [3100, ISSUE] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('repos/owner/repo/issues/2908 ');
  });
});
