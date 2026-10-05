// #3036: guards on the path-only review ledger (version 3). Each rejection runs
// the real script as a child process and asserts its exit status.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  parseReviewLedgerFiles,
  REVIEW_LEDGER_DIR,
  REVIEW_LEDGER_INDEX,
  REVIEW_LEDGER_PATH_BUDGET,
  recordFile,
  serializeLedgerIndex,
  serializeRecordFile,
  writeReviewFiles,
} from '../lib/review-ledger-store.mjs';
import { pinnedFreshnessEnv } from './helpers/freshness-env.js';

const makeTempDir = trackTempDirs();
const scripts = resolve(import.meta.dirname, '..');
const NOTES = `${REVIEW_LEDGER_DIR}/notes`;

const gitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
const identity = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'core.hooksPath=/dev/null',
];
function git(root: string, args: string[]) {
  return execFileSync('git', [...identity, ...args], {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
function commit(root: string, message: string) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
}

function pathOnlyRecord(path: string, sources: string[]) {
  return serializeRecordFile({
    path,
    kind: 'current',
    state: 'source-reviewed',
    summary: 'Checked the caller.',
    limits: 'Fixture review only.',
    sources,
    checks: ['Fixture evidence.'],
  });
}

/** A main branch with one path-only record: docs/a.md citing src/a.ts. */
function fixture() {
  const root = makeTempDir('station-ledger-guards-');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git(root, ['init', '-q', '-b', 'main']);
  write('docs/a.md', '# A\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  commit(root, 'content');
  write(
    REVIEW_LEDGER_INDEX,
    serializeLedgerIndex({
      version: 3,
      coverageBaseline: git(root, ['rev-parse', 'HEAD']),
    }),
  );
  write(recordFile('docs/a.md'), pathOnlyRecord('docs/a.md', ['src/a.ts']));
  commit(root, 'ledger');
  // The baseline is the commit that introduced the records, as after a migration.
  write(
    REVIEW_LEDGER_INDEX,
    serializeLedgerIndex({
      version: 3,
      coverageBaseline: git(root, ['rev-parse', 'HEAD']),
    }),
  );
  commit(root, 'baseline');
  return { root, write };
}

function run(
  root: string,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: root,
    env: pinnedFreshnessEnv(env),
    encoding: 'utf8',
    windowsHide: true,
  });
}
type Entry = { kind: string; path: string; rule: string };
const lastJson = (stdout: string) => {
  const line = stdout.trim().split('\n').at(-1);
  return line ? JSON.parse(line) : {};
};
function check(root: string, env: Record<string, string>) {
  const result = run(
    root,
    'check-documentation-freshness.mjs',
    ['--json'],
    env,
  );
  const parsed = lastJson(result.stdout);
  return {
    status: result.status,
    stderr: result.stderr,
    mode: parsed.mode as string | undefined,
    appendOnly: parsed.appendOnly as string | undefined,
    blocking: (parsed.blocking ?? []) as Entry[],
    error: parsed.error as { code: string } | undefined,
  };
}
function record(root: string, args: string[]) {
  const result = run(root, 'record-documentation-review.mjs', [
    ...args,
    '--json',
  ]);
  const parsed = lastJson(result.stdout);
  return {
    status: result.status,
    error: parsed.error as { code: string } | undefined,
  };
}

const scoped = { STATION_DOCS_FRESHNESS_BASE: 'main' };
const rules = (entries: Entry[]) => entries.map((entry) => entry.rule);
const noteFiles = (root: string) =>
  git(root, ['ls-files', NOTES]).split('\n').filter(Boolean);

/**
 * Main holds one landed note (a reviewed source edit); a `pr` branch starts
 * from it, so that note is at the PR's merge base.
 */
function prWithBaseNote() {
  const f = fixture();
  f.write('src/a.ts', 'export const a = 2;\n');
  commit(f.root, 'change source');
  const reviewed = record(f.root, ['docs/a.md', '--note', 'Checked a=2.']);
  expect(reviewed.status, JSON.stringify(reviewed.error)).toBe(0);
  commit(f.root, 'record review');
  git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
  git(f.root, ['switch', '-qc', 'pr']);
  expect(noteFiles(f.root)).toHaveLength(1);
  // The undisturbed PR is green, so a red result below is the guard.
  expect(check(f.root, scoped)).toMatchObject({
    status: 0,
    appendOnly: 'verified',
  });
  return f;
}

describe('append-only notes (#3036)', () => {
  it('blocks a PR that deletes a note the merge base holds', () => {
    const f = prWithBaseNote();
    const [note] = noteFiles(f.root);
    git(f.root, ['rm', '-q', note]);
    commit(f.root, 'delete the note');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.blocking).toEqual([
      expect.objectContaining({ rule: 'note-removed', path: note }),
    ]);
    const human = run(f.root, 'check-documentation-freshness.mjs', [], scoped);
    expect(human.status).toBe(1);
    expect(human.stderr).toContain(note);
    expect(human.stderr).toContain('notes are append-only; re-record instead');
  });

  it('blocks a deletion that is not committed', () => {
    const f = prWithBaseNote();
    const [note] = noteFiles(f.root);
    rmSync(join(f.root, note));
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(rules(result.blocking)).toEqual(['note-removed']);
  });

  it('blocks rewriting a note and renaming it to the new hash', () => {
    const f = prWithBaseNote();
    const [note] = noteFiles(f.root);
    git(f.root, ['rm', '-q', note]);
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'delete the note and edit another source');
    // A fresh review of the same document lands as a different file name.
    const again = record(f.root, ['docs/a.md', '--note', 'Rewritten note.']);
    expect(again.status, JSON.stringify(again.error)).toBe(0);
    expect(
      noteFiles(f.root).concat(
        git(f.root, ['ls-files', '-o', '--exclude-standard', NOTES])
          .split('\n')
          .filter(Boolean),
      ),
    ).not.toContain(note);
    commit(f.root, 'renamed rewrite');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.blocking).toEqual([
      expect.objectContaining({ rule: 'note-removed', path: note }),
    ]);
  });

  it('blocks deleting every note', () => {
    const f = prWithBaseNote();
    git(f.root, ['rm', '-rq', NOTES]);
    commit(f.root, 'delete all notes');
    expect(rules(check(f.root, scoped).blocking)).toEqual(['note-removed']);
  });

  it('allows adding notes, and ignores a note main landed after the merge base', () => {
    const f = prWithBaseNote();
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'pr work');
    git(f.root, ['switch', '-q', 'main']);
    f.write('src/a.ts', 'export const a = 3;\n');
    commit(f.root, 'main moves on');
    const landed = record(f.root, ['docs/a.md', '--note', 'Checked a=3.']);
    expect(landed.status, JSON.stringify(landed.error)).toBe(0);
    commit(f.root, 'main lands a second note');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-q', 'pr']);
    expect(noteFiles(f.root)).toHaveLength(1);
    expect(
      check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'origin/main' }),
    ).toMatchObject({
      status: 0,
      blocking: [],
    });
  });
});

describe('missing merge base (#3036)', () => {
  const missing = { STATION_DOCS_FRESHNESS_BASE: 'no-such-ref' };
  const prEvent = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
  };

  it('fails closed in a pull request event', () => {
    const { root } = fixture();
    const result = check(root, { ...missing, ...prEvent });
    expect(result.status).toBe(1);
    expect(result.appendOnly).toBe('NOT_VERIFIED');
    expect(rules(result.blocking)).toEqual(['append-only-unverified']);
  });

  it('fails closed when ci:fast names its base', () => {
    const { root } = fixture();
    const result = check(root, { STATION_CI_FAST_BASE: 'no-such-ref' });
    expect(result.status).toBe(1);
    expect(rules(result.blocking)).toEqual(['append-only-unverified']);
  });

  it('falls back locally but reports the guard as NOT_VERIFIED in both outputs', () => {
    const { root } = fixture();
    const json = check(root, missing);
    expect(json).toMatchObject({
      status: 0,
      mode: 'strict',
      appendOnly: 'NOT_VERIFIED',
    });
    const human = run(root, 'check-documentation-freshness.mjs', [], missing);
    expect(human.status).toBe(0);
    expect(human.stderr).toContain('NOT_VERIFIED');
  });

  it.each(['merge_group', 'push', 'schedule', 'workflow_dispatch'])(
    'resolves a %s event to advisory before any scope is computed',
    (event) => {
      const { root } = fixture();
      // Neither base exists; reaching scope computation would block or fall back.
      const result = check(root, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: event,
        STATION_CI_FAST_BASE: 'no-such-ref',
        ...missing,
      });
      expect(result).toMatchObject({
        status: 0,
        mode: 'advisory',
        blocking: [],
      });
      expect(result.appendOnly).toBe('not-checked');
    },
  );

  it('says so when the check is skipped in a pull request context', () => {
    const { root } = fixture();
    const skipped = run(root, 'check-documentation-freshness.mjs', [], {
      ...prEvent,
      STATION_DOCS_FRESHNESS: 'strict',
    });
    expect(skipped.status).toBe(0);
    expect(skipped.stderr).toContain('Append-only notes: not checked (strict)');
    const queue = run(root, 'check-documentation-freshness.mjs', [], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'merge_group',
    });
    expect(queue.stderr).not.toContain('Append-only notes');
  });
});

describe('ledger path budget (#3036)', () => {
  // Windows MAX_PATH 260 counts the NUL: 259 usable, minus an 80-character
  // checkout root and a separator, is 178. The longest ledger file on
  // c1d07db19c was a 137-character record, so 41 characters of headroom.
  const BUDGET = 178;
  const docOfRecordLength = (length: number) => {
    const fixed = recordFile('docs/.md').length;
    return `docs/${'a'.repeat(length - fixed)}.md`;
  };
  const files = (document: string) =>
    new Map([
      [REVIEW_LEDGER_INDEX, serializeLedgerIndex({ version: 3 })],
      [recordFile(document), pathOnlyRecord(document, [])],
    ]);

  it('pins the budget literal', () => {
    expect(REVIEW_LEDGER_PATH_BUDGET).toBe(178);
  });

  it('accepts a path exactly at the budget and refuses budget + 1', () => {
    const atBudget = docOfRecordLength(BUDGET);
    expect(recordFile(atBudget)).toHaveLength(178);
    expect(() => parseReviewLedgerFiles(files(atBudget))).not.toThrow();
    const over = docOfRecordLength(BUDGET + 1);
    expect(recordFile(over)).toHaveLength(179);
    expect(() => parseReviewLedgerFiles(files(over))).toThrow(
      expect.objectContaining({ code: 'path-too-long' }),
    );
  });

  it('refuses an over-budget record in the real check, and accepts the budget', () => {
    const f = fixture();
    f.write(docOfRecordLength(BUDGET), '# Long\n');
    f.write(
      recordFile(docOfRecordLength(BUDGET)),
      pathOnlyRecord(docOfRecordLength(BUDGET), ['src/a.ts']),
    );
    commit(f.root, 'a record exactly at the budget');
    const advisory = { STATION_DOCS_FRESHNESS: 'advisory' };
    const accepted = check(f.root, advisory);
    expect(accepted.status, JSON.stringify(accepted)).toBe(0);
    f.write(
      recordFile(docOfRecordLength(BUDGET + 1)),
      pathOnlyRecord(docOfRecordLength(BUDGET + 1), []),
    );
    const refused = check(f.root, advisory);
    expect(refused.stderr).toBe('');
    expect(refused.status).toBe(1);
    expect(refused.error?.code).toBe('path-too-long');
  });

  it('lets a PR delete an over-budget record that already reached the base', () => {
    const f = fixture();
    const over = docOfRecordLength(BUDGET + 1);
    f.write(over, '# Long\n');
    f.write(recordFile(over), pathOnlyRecord(over, ['src/a.ts']));
    commit(f.root, 'an over-budget record lands on main');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-qc', 'pr']);
    git(f.root, ['rm', '-q', recordFile(over)]);
    commit(f.root, 'remove the over-budget record');
    // History and merge-base reads do not enforce the budget.
    expect(check(f.root, scoped)).toMatchObject({ status: 0, blocking: [] });
  });
});

describe('write rollback (#3036)', () => {
  const canWriteProtect =
    process.platform !== 'win32' && process.getuid?.() !== 0;

  it('restores an existing file and removes a new one when a later write fails', () => {
    const root = makeTempDir('station-ledger-write-');
    mkdirSync(join(root, 'ledger'));
    writeFileSync(join(root, 'ledger/existing.json'), 'prior bytes');
    // A directory where a file belongs makes that write fail for real.
    mkdirSync(join(root, 'ledger/blocked.json'));
    const before = new Map([['ledger/existing.json', 'prior bytes']]);
    const after = new Map([
      ['ledger/existing.json', 'new bytes'],
      ['ledger/created/new.json', 'created bytes'],
      ['ledger/blocked.json', 'cannot be written'],
    ]);
    let error: any;
    try {
      writeReviewFiles(root, after, before);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'write-failed', unrestored: [] });
    expect(readFileSync(join(root, 'ledger/existing.json'), 'utf8')).toBe(
      'prior bytes',
    );
    expect(existsSync(join(root, 'ledger/created/new.json'))).toBe(false);
  });

  it('does not report a file it never wrote as unrestored when a directory cannot be made', () => {
    const root = makeTempDir('station-ledger-write-');
    mkdirSync(join(root, 'ledger'));
    writeFileSync(join(root, 'ledger/existing.json'), 'prior bytes');
    // A file where a directory belongs makes mkdir fail with ENOTDIR.
    writeFileSync(join(root, 'ledger/blocked'), 'a file');
    let error: any;
    try {
      writeReviewFiles(
        root,
        new Map([
          ['ledger/existing.json', 'new bytes'],
          ['ledger/blocked/new.json', 'cannot be written'],
        ]),
        new Map([['ledger/existing.json', 'prior bytes']]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'write-failed', unrestored: [] });
    expect(readFileSync(join(root, 'ledger/existing.json'), 'utf8')).toBe(
      'prior bytes',
    );
  });

  it('writes every changed file when nothing fails', () => {
    const root = makeTempDir('station-ledger-write-');
    const written = writeReviewFiles(
      root,
      new Map([
        ['a/one.json', '1'],
        ['b/two.json', '2'],
      ]),
      new Map(),
    );
    expect(written).toEqual(['a/one.json', 'b/two.json']);
    expect(readFileSync(join(root, 'b/two.json'), 'utf8')).toBe('2');
  });

  it.skipIf(!canWriteProtect)(
    'leaves the ledger untouched when docs:review:record fails mid-batch',
    () => {
      const f = fixture();
      const recordPath = join(f.root, recordFile('docs/a.md'));
      const prior = readFileSync(recordPath, 'utf8');
      // The record is rewritten first; creating notes/ then fails.
      const ledgerDir = join(f.root, REVIEW_LEDGER_DIR);
      chmodSync(ledgerDir, 0o555);
      try {
        const result = record(f.root, [
          'docs/a.md',
          '--note',
          'Added b.',
          '--add-source',
          'src/b.ts',
        ]);
        expect(result.status).toBe(1);
        expect(result.error?.code).toBe('write-failed');
      } finally {
        chmodSync(ledgerDir, 0o755);
      }
      expect(readFileSync(recordPath, 'utf8')).toBe(prior);
      expect(git(f.root, ['status', '--short'])).toBe('');
    },
  );
});
