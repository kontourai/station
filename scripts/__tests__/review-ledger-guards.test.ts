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
  compileReviewState,
  noteArchiveFile,
  parseNoteArchive,
  parseReviewLedgerFiles,
  REVIEW_LEDGER_DIR,
  REVIEW_LEDGER_INDEX,
  REVIEW_LEDGER_PATH_BUDGET,
  recordFile,
  serializeLedgerIndex,
  serializeNoteArchive,
  serializeRecordFile,
  writeReviewFiles,
} from '../lib/review-ledger-store.mjs';
import { appendOnlyNoteProblems } from '../lib/documentation-freshness.mjs';
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

// #3394: landed notes move into immutable archives at each baseline advance.
// Every fixture archive below is written by the real advance-baseline command,
// or by serializeNoteArchive, the function that command uses.
describe('note archives (#3394)', () => {
  const ARCHIVE_DIR = `${NOTES}/archive`;
  const looseNotes = (root: string) =>
    noteFiles(root).filter((file) => !file.startsWith(`${ARCHIVE_DIR}/`));
  const archives = (root: string) =>
    git(root, ['ls-files', ARCHIVE_DIR]).split('\n').filter(Boolean);
  const baseline = (root: string) =>
    JSON.parse(readFileSync(join(root, REVIEW_LEDGER_INDEX), 'utf8'))
      .coverageBaseline as string;
  const bytes = (root: string, file: string) =>
    readFileSync(join(root, file), 'utf8');
  const advance = (root: string) => {
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return run(root, 'record-documentation-review.mjs', ['--advance-baseline']);
  };
  function reviewEdit(
    f: ReturnType<typeof fixture>,
    value: number,
    message = `review a=${value}`,
  ) {
    f.write('src/a.ts', `export const a = ${value};\n`);
    commit(f.root, `change a=${value}`);
    const reviewed = record(f.root, [
      'docs/a.md',
      '--note',
      `Checked a=${value}.`,
    ]);
    expect(reviewed.status, JSON.stringify(reviewed.error)).toBe(0);
    commit(f.root, message);
  }

  /**
   * Main after one advance: note n1 landed before that advance's baseline,
   * note n2 after it. `compaction` holds the second advance, uncommitted.
   */
  function compactionFixture() {
    const f = fixture();
    reviewEdit(f, 2);
    const [n1] = looseNotes(f.root);
    const first = advance(f.root);
    expect(first.status, first.stderr).toBe(0);
    // The fixture's first baseline predates every note: nothing to archive.
    expect(first.stdout).not.toContain('archived');
    commit(f.root, 'advance 1');
    const previous = baseline(f.root);
    reviewEdit(f, 3);
    const n2 = looseNotes(f.root).find((file) => file !== n1) as string;
    const n1Bytes = bytes(f.root, n1);
    const compiledBefore = run(
      f.root,
      'check-documentation-freshness.mjs',
      ['--json'],
      { STATION_DOCS_FRESHNESS: 'strict' },
    );
    git(f.root, ['switch', '-qc', 'compaction']);
    const second = advance(f.root);
    expect(second.status, second.stderr).toBe(0);
    return { ...f, n1, n2, n1Bytes, previous, compiledBefore };
  }

  it('archives exactly the notes the previous baseline held, byte for byte', () => {
    const f = compactionFixture();
    const archive = noteArchiveFile(f.previous);
    expect(archive).toBe(`${ARCHIVE_DIR}/${f.previous}.json`);
    expect(archive.length).toBeLessThanOrEqual(REVIEW_LEDGER_PATH_BUDGET);
    expect(existsSync(join(f.root, f.n1))).toBe(false);
    expect(existsSync(join(f.root, f.n2))).toBe(true);
    expect([...parseNoteArchive(archive, bytes(f.root, archive))]).toEqual([
      [f.n1, f.n1Bytes],
    ]);
    expect(baseline(f.root)).toBe(git(f.root, ['rev-parse', 'HEAD']));
    commit(f.root, 'compact');
    expect(looseNotes(f.root)).toEqual([f.n2]);
    expect(archives(f.root)).toEqual([archive]);
    // The compaction change itself passes the scoped check (negative control
    // for note-removed) and strict coverage is unchanged.
    expect(check(f.root, scoped)).toMatchObject({
      status: 0,
      blocking: [],
      appendOnly: 'verified',
    });
    const after = check(f.root, { STATION_DOCS_FRESHNESS: 'strict' });
    expect(after.status).toBe(0);
    expect(lastJson(f.compiledBefore.stdout).reviews).toBe(
      lastJson(
        run(f.root, 'check-documentation-freshness.mjs', ['--json'], {
          STATION_DOCS_FRESHNESS: 'strict',
        }).stdout,
      ).reviews,
    );
  });

  it('keeps an archived note committed, so it never covers a later edit', () => {
    const f = compactionFixture();
    commit(f.root, 'compact');
    // An unreviewed edit to the source every archived note covered.
    f.write('src/a.ts', 'export const a = 99;\n');
    commit(f.root, 'unreviewed edit');
    const strict = check(f.root, { STATION_DOCS_FRESHNESS: 'strict' });
    expect(strict.status).toBe(1);
    expect(strict.blocking).toEqual([
      expect.objectContaining({ path: 'docs/a.md', rule: 'stale' }),
    ]);
  });

  it('accepts a removal only into an archive this change adds', () => {
    const f = compactionFixture();
    // Known bad: the archive the command wrote, minus the note it moved.
    const archive = noteArchiveFile(f.previous);
    rmSync(join(f.root, archive));
    commit(f.root, 'compaction that lost its archive');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.blocking).toEqual([
      expect.objectContaining({ rule: 'note-removed', path: f.n1 }),
    ]);
  });

  it('still refuses a removal the added archive does not carry', () => {
    const f = compactionFixture();
    // Known bad: the command's compaction plus one note it left loose.
    git(f.root, ['rm', '-q', f.n2]);
    commit(f.root, 'compaction that also drops a later note');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    // n1 left into the archive; only n2 is refused.
    expect(result.blocking).toEqual([
      expect.objectContaining({ rule: 'note-removed', path: f.n2 }),
    ]);
  });

  it('refuses a removal into an archive that already existed at the merge base', () => {
    const f = compactionFixture();
    commit(f.root, 'compact');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '-q', '--ff-only', 'compaction']);
    reviewEdit(f, 4);
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-qc', 'pr']);
    // Move n2 into the landed archive instead of adding one.
    const archive = noteArchiveFile(f.previous);
    const moved = parseNoteArchive(archive, bytes(f.root, archive));
    moved.set(f.n2, bytes(f.root, f.n2));
    f.write(archive, serializeNoteArchive(moved));
    git(f.root, ['rm', '-q', f.n2]);
    commit(f.root, 'grow a landed archive');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(rules(result.blocking).sort()).toEqual([
      'archive-changed',
      'note-removed',
    ]);
    expect(result.blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'note-removed', path: f.n2 }),
        expect.objectContaining({ rule: 'archive-changed', path: archive }),
      ]),
    );
  });

  describe('archive immutability', () => {
    function landedArchive() {
      const f = compactionFixture();
      commit(f.root, 'compact');
      git(f.root, ['switch', '-q', 'main']);
      git(f.root, ['merge', '-q', '--ff-only', 'compaction']);
      git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
      git(f.root, ['switch', '-qc', 'pr']);
      const archive = noteArchiveFile(f.previous);
      // Negative control: a PR that adds a review leaves the archive alone.
      f.write('src/a.ts', 'export const a = 5;\n');
      commit(f.root, 'pr edit');
      const reviewed = record(f.root, ['docs/a.md', '--note', 'Checked a=5.']);
      expect(reviewed.status, JSON.stringify(reviewed.error)).toBe(0);
      commit(f.root, 'pr review');
      expect(check(f.root, scoped)).toMatchObject({ status: 0, blocking: [] });
      return { ...f, archive };
    }

    it('blocks removing a landed archive', () => {
      const f = landedArchive();
      git(f.root, ['rm', '-q', f.archive]);
      commit(f.root, 'remove the archive');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking).toEqual([
        expect.objectContaining({ rule: 'archive-changed', path: f.archive }),
      ]);
      const human = run(
        f.root,
        'check-documentation-freshness.mjs',
        [],
        scoped,
      );
      expect(human.status).toBe(1);
      expect(human.stderr).toContain('archives are immutable');
    });

    it('blocks an uncommitted removal of a landed archive', () => {
      const f = landedArchive();
      rmSync(join(f.root, f.archive));
      expect(rules(check(f.root, scoped).blocking)).toEqual([
        'archive-changed',
      ]);
    });

    it('blocks moving archived notes back to loose files', () => {
      const f = landedArchive();
      f.write(f.n1, f.n1Bytes);
      git(f.root, ['rm', '-q', f.archive]);
      commit(f.root, 'unarchive n1');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(rules(result.blocking)).toEqual(['archive-changed']);
    });

    it('blocks a canonical edit that adds a note to a landed archive', () => {
      const f = landedArchive();
      const own = looseNotes(f.root).at(-1) as string;
      const grown = parseNoteArchive(f.archive, bytes(f.root, f.archive));
      grown.set(own, bytes(f.root, own));
      f.write(f.archive, serializeNoteArchive(grown));
      git(f.root, ['rm', '-q', own]);
      commit(f.root, 'archive the PR note in a landed archive');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking).toEqual([
        expect.objectContaining({ rule: 'archive-changed', path: f.archive }),
      ]);
    });
  });

  it('refuses an added archive holding a note the merge base never had', () => {
    const f = fixture();
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-qc', 'pr']);
    reviewEdit(f, 6);
    const [own] = looseNotes(f.root);
    const archive = noteArchiveFile('b'.repeat(40));
    f.write(
      archive,
      serializeNoteArchive(new Map([[own, bytes(f.root, own)]])),
    );
    git(f.root, ['rm', '-q', own]);
    commit(f.root, 'archive its own note');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.blocking).toEqual([
      expect.objectContaining({ rule: 'archive-unbacked', path: archive }),
    ]);
  });

  it('refuses a note stored both loose and archived, and a non-canonical archive', () => {
    const f = compactionFixture();
    f.write(f.n1, f.n1Bytes);
    const twice = check(f.root, { STATION_DOCS_FRESHNESS: 'advisory' });
    expect(twice.status).toBe(1);
    expect(twice.error?.code).toBe('duplicate-note');
    rmSync(join(f.root, f.n1));
    const archive = noteArchiveFile(f.previous);
    f.write(archive, JSON.stringify(JSON.parse(bytes(f.root, archive))));
    const reformatted = check(f.root, { STATION_DOCS_FRESHNESS: 'advisory' });
    expect(reformatted.status).toBe(1);
    expect(reformatted.error?.code).toBe('not-canonical');
    const edited = new Map([[f.n1, f.n1Bytes.replace('Checked', 'Edited')]]);
    f.write(archive, serializeNoteArchive(edited));
    const tampered = check(f.root, { STATION_DOCS_FRESHNESS: 'advisory' });
    expect(tampered.status).toBe(1);
    expect(tampered.error?.code).toBe('notes-edited');
  });

  it('lets a branch cut before compaction merge main cleanly and pass', () => {
    const f = compactionFixture();
    commit(f.root, 'compact');
    // A feature branch cut from main before the compaction landed.
    git(f.root, ['switch', '-qc', 'feature', 'main']);
    expect(looseNotes(f.root)).toContain(f.n1);
    f.write('docs/a.md', '# A\n\nMore.\n');
    commit(f.root, 'feature edit');
    const reviewed = record(f.root, ['docs/a.md', '--note', 'Feature review.']);
    expect(reviewed.status, JSON.stringify(reviewed.error)).toBe(0);
    commit(f.root, 'feature review');
    // Unmerged, the branch still passes against the compacted main.
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '-q', '--ff-only', 'compaction']);
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-q', 'feature']);
    expect(
      check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'origin/main' }),
    ).toMatchObject({
      status: 0,
      blocking: [],
    });
    const merged = spawnSync(
      'git',
      [...identity, 'merge', '-q', '--no-edit', 'origin/main'],
      { cwd: f.root, env: gitEnv(), encoding: 'utf8', windowsHide: true },
    );
    expect(merged.status, merged.stderr + merged.stdout).toBe(0);
    expect(git(f.root, ['status', '--short'])).toBe('');
    expect(existsSync(join(f.root, f.n1))).toBe(false);
    expect(looseNotes(f.root)).toHaveLength(2);
    expect(
      check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'origin/main' }),
    ).toMatchObject({ status: 0, blocking: [], appendOnly: 'verified' });
  });

  it('removes a file mapped to undefined and restores it on rollback', () => {
    const root = makeTempDir('station-ledger-write-');
    mkdirSync(join(root, 'ledger'));
    writeFileSync(join(root, 'ledger/note.json'), 'note bytes');
    mkdirSync(join(root, 'ledger/blocked.json'));
    let error: any;
    try {
      writeReviewFiles(
        root,
        new Map<string, string | undefined>([
          ['ledger/archive.json', 'archive bytes'],
          ['ledger/note.json', undefined],
          ['ledger/blocked.json', 'cannot be written'],
        ]),
        new Map([['ledger/note.json', 'note bytes']]),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'write-failed', unrestored: [] });
    expect(readFileSync(join(root, 'ledger/note.json'), 'utf8')).toBe(
      'note bytes',
    );
    expect(existsSync(join(root, 'ledger/archive.json'))).toBe(false);
    expect(
      writeReviewFiles(
        root,
        new Map<string, string | undefined>([
          ['ledger/note.json', undefined],
          ['ledger/gone.json', undefined],
        ]),
        new Map(),
      ),
    ).toEqual(['ledger/note.json']);
    expect(existsSync(join(root, 'ledger/note.json'))).toBe(false);
  });

  // F1: an archive is fully determined by the merge base. Only the archive the
  // advance writes (named for the merge base's baseline, in a change that moves
  // the baseline, holding exactly that baseline's still-loose notes) passes.
  describe('only the advancing baseline archive is accepted', () => {
    /** Main holds two notes that were in the tree at its coverage baseline. */
    function landedBaseline() {
      const f = fixture();
      reviewEdit(f, 2);
      reviewEdit(f, 7);
      const notes = looseNotes(f.root);
      expect(notes).toHaveLength(2);
      const first = advance(f.root);
      expect(first.status, first.stderr).toBe(0);
      commit(f.root, 'advance 1');
      git(f.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      const previous = baseline(f.root);
      git(f.root, ['switch', '-qc', 'pr']);
      return { ...f, notes, previous };
    }
    const handArchive = (
      f: ReturnType<typeof landedBaseline>,
      files: string[],
      name = f.previous,
    ) => {
      f.write(
        noteArchiveFile(name),
        serializeNoteArchive(
          new Map(files.map((file) => [file, bytes(f.root, file)])),
        ),
      );
      for (const file of files) git(f.root, ['rm', '-q', file]);
    };

    it('refuses a partial baseline archive in a change that does not advance (reviewer probe)', () => {
      const f = landedBaseline();
      handArchive(f, [f.notes[0]]);
      commit(f.root, 'hand-made partial archive');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking).toEqual([
        expect.objectContaining({
          rule: 'archive-unbacked',
          path: noteArchiveFile(f.previous),
        }),
        expect.objectContaining({ rule: 'note-removed', path: f.notes[0] }),
      ]);
    });

    it('refuses a complete baseline archive in a change that does not advance', () => {
      const f = landedBaseline();
      handArchive(f, f.notes);
      commit(f.root, 'hand-made complete archive');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(rules(result.blocking)).toEqual([
        'archive-unbacked',
        'note-removed',
        'note-removed',
      ]);
    });

    it('refuses the advance output stored under another archive name', () => {
      const f = landedBaseline();
      expect(advance(f.root).status).toBe(0);
      const other = noteArchiveFile('e'.repeat(40));
      f.write(other, bytes(f.root, noteArchiveFile(f.previous)));
      rmSync(join(f.root, noteArchiveFile(f.previous)));
      commit(f.root, 'advance with a renamed archive');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking).toEqual([
        expect.objectContaining({ rule: 'archive-unbacked', path: other }),
        expect.objectContaining({ rule: 'note-removed' }),
        expect.objectContaining({ rule: 'note-removed' }),
      ]);
    });

    it('refuses an advancing archive that leaves one baseline note loose', () => {
      const f = landedBaseline();
      const kept = bytes(f.root, f.notes[1]);
      expect(advance(f.root).status).toBe(0);
      const archive = noteArchiveFile(f.previous);
      const partial = parseNoteArchive(archive, bytes(f.root, archive));
      partial.delete(f.notes[1]);
      f.write(archive, serializeNoteArchive(partial));
      f.write(f.notes[1], kept);
      commit(f.root, 'advance that archives only part of the baseline');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      // A refused archive moves nothing, so the note it took is removed.
      expect(result.blocking).toEqual([
        expect.objectContaining({ rule: 'archive-unbacked', path: archive }),
        expect.objectContaining({ rule: 'note-removed', path: f.notes[0] }),
      ]);
    });

    it('accepts the archive the advance writes (negative control)', () => {
      const f = landedBaseline();
      const out = advance(f.root);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout).toContain('archived 2 landed note(s)');
      commit(f.root, 'advance 2');
      expect(check(f.root, scoped)).toMatchObject({
        status: 0,
        blocking: [],
        appendOnly: 'verified',
      });
    });
  });

  // F2: the guard itself, called directly. The CLI parses every note first,
  // so changed bytes under an old name fail as notes-edited before the guard
  // runs; these fixtures skip that parse to pin the guard's own comparisons.
  describe('the guard function, past the name-hash check', () => {
    const name = (n: number) =>
      `${NOTES}/2026010${n}T000000.000Z-${String(n).repeat(12)}.json`;
    /** A baseline commit with note 1, then a merge base that adds note 2. */
    function repo() {
      const root = makeTempDir('station-archive-guard-');
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      git(root, ['init', '-q', '-b', 'main']);
      write(name(1), 'note one\n');
      commit(root, 'baseline');
      const from = git(root, ['rev-parse', 'HEAD']);
      write(name(2), 'note two\n');
      commit(root, 'merge base');
      const mergeBase = git(root, ['rev-parse', 'HEAD']);
      const compact = (notes: Record<string, string>) => {
        write(
          noteArchiveFile(from),
          serializeNoteArchive(new Map(Object.entries(notes))),
        );
        for (const file of Object.keys(notes)) git(root, ['rm', '-q', file]);
        commit(root, 'compaction');
        return appendOnlyNoteProblems(root, mergeBase, {
          from,
          to: 'f'.repeat(40),
        }).map(({ rule, path }: Entry) => [rule, path]);
      };
      return { from, compact };
    }

    it('accepts the archive that carries the baseline note byte for byte', () => {
      expect(repo().compact({ [name(1)]: 'note one\n' })).toEqual([]);
    });

    it('refuses other bytes under the same name, and the removal with it', () => {
      const f = repo();
      expect(f.compact({ [name(1)]: 'note one, edited\n' })).toEqual([
        ['archive-unbacked', noteArchiveFile(f.from)],
        ['note-removed', name(1)],
      ]);
    });

    it('refuses a note added after the baseline', () => {
      const f = repo();
      expect(
        f.compact({ [name(1)]: 'note one\n', [name(2)]: 'note two\n' }),
      ).toEqual([
        ['archive-unbacked', noteArchiveFile(f.from)],
        ['note-removed', name(1)],
        ['note-removed', name(2)],
      ]);
    });
  });

  it("tracks archives under the repository's real ignore rules", () => {
    const repo = resolve(scripts, '..');
    const ignored = (path: string) =>
      spawnSync('git', ['check-ignore', '-q', '--no-index', path], {
        cwd: repo,
        env: gitEnv(),
        windowsHide: true,
      }).status;
    // The root .gitignore drops every other archive/ directory (exit 0).
    expect(ignored('tmp/archive/x.json')).toBe(0);
    expect(ignored(noteArchiveFile('d'.repeat(40)))).toBe(1);
  });

  it("compiles the repository's real notes identically once archived", () => {
    const repo = resolve(scripts, '..');
    const files = new Map(
      git(repo, ['ls-files', '-z', REVIEW_LEDGER_DIR])
        .split('\0')
        .filter(Boolean)
        .map((file) => [file, readFileSync(join(repo, file), 'utf8')]),
    );
    const manifest = JSON.parse(
      readFileSync(join(repo, 'docs/learn/media.json'), 'utf8'),
    );
    const loose = [...files.keys()].filter(
      (file) =>
        file.startsWith(`${NOTES}/`) && !file.startsWith(`${ARCHIVE_DIR}/`),
    );
    // A real store has hundreds of notes; the split needs at least three.
    expect(loose.length).toBeGreaterThan(100);
    const compacted = new Map(files);
    // Two archives and a loose remainder, as after two advances.
    const cut = [
      Math.floor(loose.length / 3),
      Math.floor((2 * loose.length) / 3),
    ];
    const groups = [loose.slice(0, cut[0]), loose.slice(cut[0], cut[1])];
    groups.forEach((group, index) => {
      for (const file of group) compacted.delete(file);
      const archive = noteArchiveFile(String(index + 1).repeat(40));
      const text = serializeNoteArchive(
        new Map(group.map((file) => [file, files.get(file) as string])),
      );
      compacted.set(archive, text);
      // Exact bytes survive the round trip.
      for (const [file, archived] of parseNoteArchive(archive, text))
        expect(archived).toBe(files.get(file));
    });
    const compile = (input: Map<string, string>) =>
      JSON.stringify(
        compileReviewState(parseReviewLedgerFiles(input), manifest),
      );
    expect(compile(compacted)).toBe(compile(files));
  });
});
