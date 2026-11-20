import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  REVIEW_LEDGER_DIR,
  recordFile,
  serializeNotesFile,
} from '../lib/review-ledger-store.mjs';
import {
  check,
  commit,
  compiled,
  conflicted,
  editRecord,
  entryPaths,
  fixture,
  fixtureAt,
  git,
  gitEnv,
  hash,
  identity,
  ledgerTexts,
  MEDIA,
  makeTempDir,
  merge,
  notesFiles,
  record_,
  run,
  SHARED_C,
  scoped,
  stale,
  strict,
} from './helpers/documentation-freshness-fixture.js';
import {
  forbidAmbientFreshnessMode,
  pinnedFreshnessEnv,
} from './helpers/freshness-env.js';

// Every check below pins its mode; an unpinned read throws (#2934).
forbidAmbientFreshnessMode();
const makeFileTempDir = trackTempDirs({ lifetime: 'file' });

// Built once per file and copied per test: the migration child dominated
// each test's setup, and every test starts from the same commits.
let template: { root: string; content: string } | undefined;
function pathOnlyFixture() {
  if (!template) {
    const f = fixture({ makeDir: makeFileTempDir });
    // Two documents depend on the same source, as broad hubs do in Station.
    editRecord(f.root, 'docs/c.md', (data) => {
      data.sources.push({
        path: 'src/c.ts',
        digest: hash(SHARED_C),
        revision: f.content,
      });
    });
    commit(f.root, 'add a shared dependency');
    const migrated = run(f.root, 'migrate-review-ledger.mjs', ['--path-only']);
    expect(migrated.status, migrated.stderr).toBe(0);
    commit(f.root, 'migrate path-only decisions');
    template = { root: f.root, content: f.content };
  }
  const root = makeTempDir('station-review-notes-');
  cpSync(template.root, root, { recursive: true });
  return fixtureAt(root, template.content);
}

describe('append-only review notes and Git history (#3101)', () => {
  function reviewShared(f: ReturnType<typeof fixture>, message: string) {
    for (const path of ['docs/map.md', 'docs/c.md']) {
      const result = record_(f.root, [path, '--note', message]);
      expect(result.status, JSON.stringify(result.error)).toBe(0);
    }
  }

  it('blocks and names documents when a PR touches a source without a note; recording writes only notes', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'change shared source');
    const missing = check(f.root, scoped);
    expect(missing.status).toBe(1);
    expect(entryPaths(missing.blocking)).toEqual(['docs/c.md', 'docs/map.md']);
    const before = ledgerTexts(f.root);
    reviewShared(f, 'Inspected both callers.');
    expect(check(f.root, scoped).status).toBe(0);
    for (const [file, text] of Object.entries(before))
      expect(f.read(file)).toBe(text);
    expect(notesFiles(f.root)).toHaveLength(2);
    commit(f.root, 'record reviews');
    expect(check(f.root, strict).status).toBe(0);
  });

  it('names rewritten note revisions after amend and passes after re-recording', () => {
    const f = pathOnlyFixture();
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-qc', 'pr']);
    for (const source of ['a', 'b'])
      f.write(`src/${source}.ts`, `export const ${source} = 2;\n`);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    const revision = commit(f.root, 'source before recording');
    const paths = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/map.md'];
    const recordAll = (note: string) => {
      f.write(
        '.git/reviews.json',
        JSON.stringify(paths.map((path) => ({ path, note }))),
      );
      const result = record_(f.root, ['--batch', '.git/reviews.json']);
      expect(result.status, JSON.stringify(result.error)).toBe(0);
    };
    recordAll('Checked source.');
    expect(check(f.root, scoped).status).toBe(0);
    const notes = notesFiles(f.root).map((file) => ({
      file: `${REVIEW_LEDGER_DIR}/notes/${file}`,
      data: JSON.parse(f.read(`${REVIEW_LEDGER_DIR}/notes/${file}`)),
    }));
    git(f.root, [...identity, 'commit', '--amend', '-qm', 'reword source']);
    commit(f.root, 'commit notes after rewrite');
    const rejected = run(
      f.root,
      'check-documentation-freshness.mjs',
      [],
      scoped,
    );
    expect(rejected.status).toBe(1);
    for (const path of paths) {
      const line = rejected.stderr
        .split('\n')
        .find((line) => line.includes(`review ${path};`));
      const note = notes.find(({ data }) =>
        data.notes.some((entry: { path: string }) => entry.path === path),
      );
      expect(line).toContain(note?.file);
      expect(line).toContain(revision);
      expect(line).toContain('history was rewritten after recording');
      expect(line).toContain(
        `npm run docs:review:record -- ${path} --note "<what you checked>"`,
      );
    }
    recordAll('Checked rewritten source.');
    expect(check(f.root, scoped).status).toBe(0);
    commit(f.root, 're-record after rewrite');
    expect(check(f.root, scoped).status).toBe(0);
  });

  it('does not label an uncommitted in-range note as rewritten after an unrelated commit', () => {
    const f = pathOnlyFixture();
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    const revision = commit(f.root, 'source before recording');
    reviewShared(f, 'Checked this source.');
    f.write('unrelated.txt', 'unrelated work');
    git(f.root, ['add', 'unrelated.txt']);
    git(f.root, [...identity, 'commit', '-qm', 'unrelated commit']);
    expect(git(f.root, ['rev-list', 'main..HEAD']).split('\n')).toContain(
      revision,
    );
    const rejected = run(
      f.root,
      'check-documentation-freshness.mjs',
      [],
      scoped,
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).not.toContain(
      'history was rewritten after recording',
    );
    expect(rejected.stderr).not.toContain(
      "note revision outside this change's range",
    );
    commit(f.root, 'commit valid in-range notes');
    expect(check(f.root, scoped).status).toBe(0);
  });

  it('does not accept a landed commit without a covering note, even if bytes are restored', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'landed change without review');
    f.write('src/c.ts', SHARED_C);
    commit(f.root, 'restore source without review');
    const result = check(f.root, strict);
    expect(result.status).toBe(1);
    expect(entryPaths(result.blocking)).toEqual(['docs/c.md', 'docs/map.md']);
    reviewShared(f, 'Reviewed change and restoration.');
    commit(f.root, 'catch up deliberately');
    expect(check(f.root, strict).status).toBe(0);
    // Four CLI children by design: two records and two checks.
  }, 90_000);

  it('merges two branches changing the same source with no ledger conflict and both documents fresh', () => {
    const f = pathOnlyFixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    for (const [branch, from, to] of [
      ['one', 'c1 = 1', 'c1 = 2'],
      ['two', 'c2 = 1', 'c2 = 2'],
    ]) {
      git(f.root, ['switch', '-qc', branch, base]);
      f.write('src/c.ts', SHARED_C.replace(from, to));
      commit(f.root, `${branch} changes shared source`);
      reviewShared(f, `${branch} checked the changed caller.`);
      commit(f.root, `${branch} adds review notes`);
      expect(check(f.root, scoped).status).toBe(0);
    }
    const result = merge(f.root, 'one');
    expect(result.status, result.stderr).toBe(0);
    expect(conflicted(f.root)).toEqual([]);
    expect(
      git(f.root, [
        'diff',
        '--name-only',
        base,
        'HEAD',
        '--',
        `${REVIEW_LEDGER_DIR}/records`,
      ]),
    ).toBe('');
    expect(check(f.root, strict).status).toBe(0);
    expect(compiled(f.root, 'docs/map.md').state).toBe('source-reviewed');
    expect(compiled(f.root, 'docs/c.md').historyChanges).toEqual([]);
    // Seven CLI children by design: four records and three checks.
  }, 90_000);

  it('keeps branch review valid when another PR lands on main, including another edit of the shared source', () => {
    const f = pathOnlyFixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'PR source');
    reviewShared(f, 'PR caller review.');
    commit(f.root, 'PR notes');
    git(f.root, ['switch', '-q', 'main']);
    f.write('unrelated.txt', 'another PR');
    f.write('src/c.ts', SHARED_C.replace('c2 = 1', 'c2 = 2'));
    commit(f.root, 'other PR source');
    reviewShared(f, 'Other PR caller review.');
    commit(f.root, 'other PR notes');
    git(f.root, ['switch', '-q', 'pr']);
    expect(check(f.root, scoped).status).toBe(0);
    expect(merge(f.root, 'main').status).toBe(0);
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
    expect(git(f.root, ['merge-base', base, 'HEAD'])).toBe(base);
    // Seven CLI children by design: four records and three checks.
  }, 90_000);

  it('judges squash commits by the note landed with the source, without requiring the original revision', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'PR source');
    reviewShared(f, 'Squash review.');
    commit(f.root, 'PR notes');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '--squash', 'pr']);
    commit(f.root, 'squash PR');
    expect(check(f.root, strict).status).toBe(0);
  });

  it('requires review when a modified source is removed from a record, then accepts the explicit drop', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'source change');
    editRecord(f.root, 'docs/map.md', (data) => {
      data.sources = ['src/d.ts'];
    });
    expect(check(f.root, scoped).status).toBe(1);
    git(f.root, ['restore', '--', recordFile('docs/map.md')]);
    expect(
      record_(f.root, [
        'docs/map.md',
        '--note',
        'This source no longer supports the map.',
        '--drop-source',
        'src/c.ts',
      ]).status,
    ).toBe(0);
    expect(record_(f.root, ['docs/c.md', '--note', 'Checked C.']).status).toBe(
      0,
    );
    commit(f.root, 'review and drop dependency');
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
    expect(compiled(f.root, 'docs/map.md').sources).toEqual([
      { path: 'src/d.ts' },
    ]);
  });

  it('folds old binding conflicts and carries the branch note with one deterministic migration command', () => {
    const f = fixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    git(f.root, ['switch', '-qc', 'old-pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'old PR source');
    expect(
      record_(f.root, ['docs/map.md', '--note', 'Reviewed on the old branch.'])
        .status,
    ).toBe(0);
    commit(f.root, 'old PR bindings and note');
    git(f.root, ['switch', '-q', 'main']);
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    commit(f.root, 'main migrates');
    git(f.root, ['switch', '-q', 'old-pr']);
    expect(merge(f.root, 'main').status).toBe(1);
    const migrated = run(f.root, 'migrate-review-ledger.mjs', ['--path-only']);
    expect(migrated.status, migrated.stderr).toBe(0);
    const once = ledgerTexts(f.root);
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    expect(ledgerTexts(f.root)).toEqual(once);
    commit(f.root, 'finish merge');
    expect(conflicted(f.root)).toEqual([]);
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
    expect(compiled(f.root, 'docs/map.md').sources).toEqual([
      { path: 'src/c.ts' },
      { path: 'src/d.ts' },
    ]);
    expect(git(f.root, ['merge-base', base, 'HEAD'])).toBe(base);
  });

  it('fails strict on a real depth-one clone while scoped remains advisory', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'unreviewed source');
    const shallow = makeTempDir('station-doc-shallow-');
    git(shallow, ['clone', '-q', '--depth=1', `file://${f.root}`, '.']);
    expect(check(shallow, scoped).mode).toBe('advisory');
    expect(check(shallow, scoped).status).toBe(0);
    const result = run(
      shallow,
      'check-documentation-freshness.mjs',
      [],
      strict,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Strict documentation freshness cannot judge freshness',
    );
    expect(result.stderr).toContain('shallow checkout');
  });

  it('fails strict on missing, invalid, absent and unreachable baselines', () => {
    const f = pathOnlyFixture();
    const index = `${REVIEW_LEDGER_DIR}/ledger.json`;
    const original = f.read(index);
    git(f.root, ['switch', '--orphan', 'unreachable']);
    f.write('orphan.txt', 'orphan');
    const unreachable = commit(f.root, 'orphan baseline');
    git(f.root, ['switch', 'main']);
    for (const baseline of [null, 'invalid', 'a'.repeat(40), unreachable]) {
      f.write(
        index,
        original.replace(
          /"coverageBaseline": "[a-f0-9]+"/,
          `"coverageBaseline": ${JSON.stringify(baseline)}`,
        ),
      );
      expect(check(f.root, strict).status).toBe(1);
    }
  });

  it('scoped checks never walk the main-history baseline', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'PR change');
    const trace = join(f.root, '.git', 'scoped.trace');
    const result = check(f.root, { ...scoped, GIT_TRACE: trace });
    expect(entryPaths(result.blocking)).toEqual(['docs/c.md', 'docs/map.md']);
    expect(readFileSync(trace, 'utf8')).not.toMatch(
      /(?:log|rev-list) --first-parent/,
    );
  });

  it('main-history Git invocation count stays constant as landing commits grow', () => {
    const f = pathOnlyFixture();
    const count = () => {
      const trace = join(f.root, '.git', 'history.trace');
      rmSync(trace, { force: true });
      expect(check(f.root, { ...strict, GIT_TRACE: trace }).status).toBe(0);
      return readFileSync(trace, 'utf8')
        .split('\n')
        .filter((line) => line.includes('built-in: git ')).length;
    };
    f.write('unrelated.txt', '1');
    commit(f.root, 'one landing');
    const one = count();
    for (let n = 2; n <= 15; n++) {
      f.write('unrelated.txt', String(n));
      commit(f.root, `landing ${n}`);
    }
    expect(count()).toBe(one);
    expect(one).toBeLessThanOrEqual(16);
  });

  it('copied notes from outside the PR range do not cover a change; genuine notes do', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'main source review context');
    reviewShared(f, 'Existing main review.');
    commit(f.root, 'main review');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    const old = notesFiles(f.root);
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 3'));
    commit(f.root, 'PR source');
    for (const file of old)
      f.write(
        `${REVIEW_LEDGER_DIR}/notes/${file.replace(/^.{20}/, '20990101T000000.000Z')}`,
        f.read(`${REVIEW_LEDGER_DIR}/notes/${file}`),
      );
    commit(f.root, 'copy unrelated notes');
    expect(entryPaths(check(f.root, scoped).blocking)).toEqual([
      'docs/c.md',
      'docs/map.md',
    ]);
    reviewShared(f, 'Inspected this PR source.');
    commit(f.root, 'genuine review');
    expect(check(f.root, scoped).status).toBe(0);
  });

  it('refuses baseline advancement on a PR-only commit and names a missing remote main', () => {
    const f = pathOnlyFixture();
    const index = `${REVIEW_LEDGER_DIR}/ledger.json`;
    const original = f.read(index);
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('unrelated.txt', 'PR-only commit');
    commit(f.root, 'PR-only work');
    expect(check(f.root, strict).status).toBe(0);
    const refused = run(f.root, 'record-documentation-review.mjs', [
      '--advance-baseline',
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('HEAD is not reachable from origin/main');
    expect(f.read(index)).toBe(original);
    git(f.root, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const missing = run(f.root, 'record-documentation-review.mjs', [
      '--advance-baseline',
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('origin/main is missing');
    expect(missing.stderr).toContain('git fetch origin main');
    expect(f.read(index)).toBe(original);
  });

  it('advances the baseline only after every accumulated input is covered', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'unreviewed landing');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(
      run(f.root, 'record-documentation-review.mjs', ['--advance-baseline'])
        .status,
    ).toBe(1);
    reviewShared(f, 'Catch-up review.');
    commit(f.root, 'cover gaps');
    git(f.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const head = git(f.root, ['rev-parse', 'HEAD']);
    expect(
      run(f.root, 'record-documentation-review.mjs', ['--advance-baseline'])
        .status,
    ).toBe(0);
    expect(
      JSON.parse(f.read(`${REVIEW_LEDGER_DIR}/ledger.json`)).coverageBaseline,
    ).toBe(head);
    commit(f.root, 'advance baseline');
    expect(check(f.root, strict).status).toBe(0);
  });

  describe('a PR that hand-edits coverageBaseline (#3101)', () => {
    const index = `${REVIEW_LEDGER_DIR}/ledger.json`;
    const setBaseline = (f: ReturnType<typeof fixture>, sha: string) =>
      f.write(
        index,
        f
          .read(index)
          .replace(
            /"coverageBaseline": "[a-f0-9]+"/,
            `"coverageBaseline": "${sha}"`,
          ),
      );
    /** Main holds an uncovered source landing, then a later commit. */
    function uncoveredMain() {
      const f = pathOnlyFixture();
      f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
      commit(f.root, 'unreviewed landing');
      f.write('unrelated.txt', 'later main commit');
      const later = commit(f.root, 'later main commit');
      git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
      git(f.root, ['switch', '-qc', 'pr']);
      return { f, later };
    }

    it('blocks a baseline moved past an uncovered main commit and names --advance-baseline', () => {
      const { f, later } = uncoveredMain();
      expect(check(f.root, strict).status).toBe(1);
      setBaseline(f, later);
      commit(f.root, 'hand-edit baseline');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking.map((entry) => entry.kind)).toEqual(['baseline']);
      const blocked = run(
        f.root,
        'check-documentation-freshness.mjs',
        [],
        scoped,
      );
      expect(blocked.stderr).toContain('--advance-baseline');
      // The strict gate after the squash would otherwise pass vacuously.
      git(f.root, ['switch', 'main']);
      git(f.root, ['merge', '-q', '--ff-only', 'pr']);
      expect(check(f.root, strict).status).toBe(0);
    });

    it('allows a hand edit to a covered main commit and a baseline set by the command', () => {
      const f = pathOnlyFixture();
      f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
      commit(f.root, 'unreviewed landing');
      reviewShared(f, 'Catch-up review.');
      const covered = commit(f.root, 'cover gaps');
      f.write('unrelated.txt', 'later main commit');
      commit(f.root, 'later main commit');
      git(f.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
      git(f.root, ['switch', '-qc', 'pr']);
      setBaseline(f, covered);
      commit(f.root, 'hand-edit to a covered commit');
      expect(check(f.root, scoped).status).toBe(0);
      git(f.root, ['reset', '-q', '--hard', 'main']);
      git(f.root, ['switch', 'main']);
      const advanced = run(f.root, 'record-documentation-review.mjs', [
        '--advance-baseline',
      ]);
      expect(advanced.status, advanced.stderr).toBe(0);
      git(f.root, ['switch', '-qc', 'pr2']);
      commit(f.root, 'advance baseline');
      expect(check(f.root, scoped).status).toBe(0);
    });

    it('blocks a baseline that is not reachable from the merge base', () => {
      const { f } = uncoveredMain();
      f.write('pr-only.txt', 'PR work');
      const prOnly = commit(f.root, 'PR-only commit');
      setBaseline(f, prOnly);
      commit(f.root, 'point the baseline at a PR commit');
      const result = check(f.root, scoped);
      expect(result.status).toBe(1);
      expect(result.blocking.map((entry) => entry.kind)).toEqual(['baseline']);
    });
  });

  it('legacy conversion covers only reviewed binding lines and leaves another changed source blocking', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'old-pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'reviewed source');
    expect(
      record_(f.root, ['docs/map.md', '--note', 'Reviewed C only.']).status,
    ).toBe(0);
    commit(f.root, 'old bindings review C');
    f.write('src/d.ts', 'export const d = 2;\n');
    commit(f.root, 'unreviewed D');
    git(f.root, ['switch', '-q', 'main']);
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    commit(f.root, 'main migrates');
    git(f.root, ['switch', '-q', 'old-pr']);
    expect(merge(f.root, 'main').status).toBe(1);
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    commit(f.root, 'finish merge');
    const record = compiled(f.root, 'docs/map.md');
    expect(
      record.notes.filter((note) => note.note === 'Reviewed C only.'),
    ).toHaveLength(1);
    expect(
      record.notes.find((note) => note.note === 'Reviewed C only.')?.inputs,
    ).toEqual(['src/c.ts']);
    expect(
      record.checks.filter((note) => note === 'Reviewed C only.'),
    ).toHaveLength(1);
    expect(check(f.root, scoped).blocking).toContainEqual(
      stale('review', 'docs/map.md', ['src/d.ts']),
    );
  });

  it('uses notes for capture source review while preserving image identity and metadata', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    commit(f.root, 'change capture source');
    expect(check(f.root, scoped).blocking).toEqual([
      stale('capture', 'docs/learn/media/task.png', ['src/ui.ts']),
    ]);
    const before = ledgerTexts(f.root);
    const metadata = f.read(MEDIA);
    expect(
      record_(f.root, [
        'docs/learn/media/task.png',
        '--note',
        'Pixels still describe the UI.',
      ]).status,
    ).toBe(0);
    for (const [file, text] of Object.entries(before))
      expect(f.read(file)).toBe(text);
    expect(f.read(MEDIA)).toBe(metadata);
    expect(check(f.root, scoped).status).toBe(0);
    commit(f.root, 'capture note');
    expect(check(f.root, strict).status).toBe(0);
  });

  it('preserves JSON value precision before and after recording a note', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write(
      'package.json',
      JSON.stringify({
        scripts: { docs: 'node docs.mjs --all', other: 'node other.mjs' },
      }),
    );
    commit(f.root, 'change cited value');
    expect(check(f.root, scoped).status).toBe(1);
    expect(
      record_(f.root, ['docs/pkg.md', '--note', 'Reviewed the new command.'])
        .status,
    ).toBe(0);
    commit(f.root, 'review cited value');
    f.write(
      'package.json',
      JSON.stringify({
        scripts: { docs: 'node docs.mjs --all', other: 'unrelated command' },
      }),
    );
    commit(f.root, 'change unrelated value after review');
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
  });

  it('does not let a note cover a later edit on the same PR', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'first change');
    reviewShared(f, 'Reviewed first change.');
    commit(f.root, 'first notes');
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 3'));
    commit(f.root, 'later unreviewed change');
    expect(check(f.root, scoped).status).toBe(1);
    expect(check(f.root, strict).status).toBe(1);
  });

  it('does not let a note cover a source moved away after it', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'first change');
    reviewShared(f, 'Reviewed first change.');
    commit(f.root, 'first notes');
    // An unchanged move is a pure rename to Git's default log.
    git(f.root, ['mv', 'src/c.ts', 'src/moved.ts']);
    commit(f.root, 'later unreviewed move');
    expect(check(f.root, scoped).status).toBe(1);
  });
});

// `--input` records one reviewed note for a changed input as ordinary notes,
// one per record or capture that cites it, each covering only that input.
describe('input review notes', () => {
  const NOTES_DIR = `${REVIEW_LEDGER_DIR}/notes`;
  const C_CHANGED = SHARED_C.replace('c1 = 1', 'c1 = 2');
  const recordInput = (f: { root: string }, input: string, note: string) => {
    const result = record_(f.root, ['--input', input, '--note', note]);
    expect(result.status, JSON.stringify(result.error)).toBe(0);
    return result.output;
  };
  const noteText = (f: { read: (path: string) => string }, file: string) =>
    f.read(`${NOTES_DIR}/${file}`);
  const blockedChanges = (result: ReturnType<typeof check>) =>
    Object.fromEntries(
      result.blocking.map((entry) => [entry.path, entry.changed]),
    );
  const packageJson = (docs: string, other: string) =>
    `${JSON.stringify({ scripts: { docs, other } }, null, 2)}\n`;

  it('writes one ordinary note per citing document, sorted, and nothing for a page that does not cite the input', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'change shared source');
    expect(entryPaths(check(f.root, scoped).blocking)).toEqual([
      'docs/c.md',
      'docs/map.md',
    ]);
    const before = ledgerTexts(f.root);
    const output = recordInput(f, 'src/c.ts', 'Neither page states c1.');
    expect(output.recorded).toEqual([
      {
        kind: 'input',
        path: 'src/c.ts',
        paths: ['docs/c.md', 'docs/map.md'],
        rebound: [],
      },
    ]);
    for (const [file, text] of Object.entries(before))
      expect(f.read(file)).toBe(text);
    expect(notesFiles(f.root)).toHaveLength(1);
    const [file] = notesFiles(f.root);
    expect(JSON.parse(noteText(f, file)).notes).toEqual([
      {
        path: 'docs/c.md',
        note: 'Neither page states c1.',
        inputs: ['src/c.ts'],
      },
      {
        path: 'docs/map.md',
        note: 'Neither page states c1.',
        inputs: ['src/c.ts'],
      },
    ]);
    expect(check(f.root, scoped).status).toBe(0);
    commit(f.root, 'record input note');
    expect(check(f.root, scoped).status).toBe(0);
    expect(compiled(f.root, 'docs/map.md').notes.at(-1)).toMatchObject({
      file: `${NOTES_DIR}/${file}`,
      inputs: ['src/c.ts'],
      note: 'Neither page states c1.',
    });
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '--squash', 'pr']);
    commit(f.root, 'squash PR');
    expect(check(f.root, strict).status).toBe(0);
  });

  it('lets a later catch-up input note cover a landing that had none', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'unreviewed landing');
    const missing = check(f.root, strict);
    expect(missing.status).toBe(1);
    expect(blockedChanges(missing)).toEqual({
      'docs/c.md': ['src/c.ts'],
      'docs/map.md': ['src/c.ts'],
    });
    recordInput(f, 'src/c.ts', 'Catch-up: no documented claim changed.');
    commit(f.root, 'catch up deliberately');
    expect(check(f.root, strict).status).toBe(0);
  });

  it('does not cover an edited document that cites the input, in scoped or strict replay', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    f.write('docs/map.md', '# Map cites C and D, edited\n');
    commit(f.root, 'change source and one citing page');
    recordInput(f, 'src/c.ts', 'Checked c1 against both pages.');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(blockedChanges(result)).toEqual({ 'docs/map.md': ['docs/map.md'] });
    commit(f.root, 'input note');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '--squash', 'pr']);
    commit(f.root, 'squash without a page note');
    const replay = check(f.root, strict);
    expect(replay.status).toBe(1);
    expect(blockedChanges(replay)).toEqual({ 'docs/map.md': ['docs/map.md'] });
  });

  it('does not cover a different changed input, and the closing report matches the check', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    f.write('src/d.ts', 'export const d = 2;\n');
    commit(f.root, 'change two sources');
    const output = recordInput(f, 'src/c.ts', 'Checked c1.');
    expect(output.dependents).toEqual([
      { path: 'docs/map.md', changed: ['src/d.ts'] },
    ]);
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(blockedChanges(result)).toEqual({ 'docs/map.md': ['src/d.ts'] });
    recordInput(f, 'src/d.ts', 'Checked d.');
    expect(check(f.root, scoped).status).toBe(0);
  });

  it('reports a cited value still stale when another value in its file is uncommitted, as the check does', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write(
      'package.json',
      packageJson('node docs.mjs --all', 'node other.mjs'),
    );
    commit(f.root, 'change the cited value');
    // An uncommitted edit to another value in the same file.
    f.write('package.json', packageJson('node docs.mjs --all', 'dirty'));
    const result = record_(f.root, ['docs/pkg.md', '--note', 'Checked docs.']);
    expect(result.status, JSON.stringify(result.error)).toBe(0);
    expect(result.output.dependents).toEqual([
      { path: 'docs/pkg.md', changed: ['package.json#/scripts/docs'] },
    ]);
    expect(blockedChanges(check(f.root, scoped))).toEqual({
      'docs/pkg.md': ['package.json#/scripts/docs'],
    });
  });

  it('does not cover a record edit', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    editRecord(f.root, 'docs/map.md', (data) => {
      data.summary = 'A changed human decision.';
    });
    commit(f.root, 'change source and a record decision');
    recordInput(f, 'src/c.ts', 'Checked c1.');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(blockedChanges(result)).toEqual({ 'docs/map.md': ['docs/map.md'] });
  });

  it('does not cover a document that starts citing the input after the note, in scoped or strict replay', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'change shared source');
    recordInput(f, 'src/c.ts', 'Checked c1 on its citing pages.');
    commit(f.root, 'input note');
    editRecord(f.root, 'docs/b.md', (data) => {
      data.sources.push('src/c.ts');
    });
    commit(f.root, 'docs/b.md starts citing the changed source');
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(blockedChanges(result)['docs/b.md']).toContain('src/c.ts');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '--squash', 'pr']);
    commit(f.root, 'squash');
    const replay = check(f.root, strict);
    expect(replay.status).toBe(1);
    expect(blockedChanges(replay)['docs/b.md']).toContain('src/c.ts');
    expect(blockedChanges(replay)['docs/c.md']).toBeUndefined();
  });

  it('covers only the exact cited value, not another value or the whole file, in scoped or strict replay', () => {
    const f = pathOnlyFixture();
    // Both pages also cite the reviewed value, so each receives a note for
    // it that must not stand for the other binding into the same file.
    editRecord(f.root, 'docs/b.md', (data) => {
      data.sources.push(
        'package.json#/scripts/docs',
        'package.json#/scripts/other',
      );
    });
    editRecord(f.root, 'docs/a.md', (data) => {
      data.sources.push('package.json', 'package.json#/scripts/docs');
    });
    commit(f.root, 'cite another value and the whole file');
    for (const path of ['docs/a.md', 'docs/b.md'])
      expect(
        record_(f.root, [path, '--note', 'Added the citation.']).status,
      ).toBe(0);
    commit(f.root, 'review the new citations');
    expect(check(f.root, strict).status).toBe(0);
    git(f.root, ['switch', '-qc', 'pr']);
    f.write(
      'package.json',
      packageJson('node docs.mjs --all', 'node other.mjs --all'),
    );
    commit(f.root, 'change two cited values');
    expect(
      recordInput(f, 'package.json#/scripts/docs', 'Checked the docs script.')
        .recorded[0].paths,
    ).toEqual(['docs/a.md', 'docs/b.md', 'docs/pkg.md']);
    const expected = {
      'docs/a.md': ['package.json'],
      'docs/b.md': ['package.json#/scripts/other'],
    };
    expect(blockedChanges(check(f.root, scoped))).toEqual(expected);
    commit(f.root, 'value note');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '--squash', 'pr']);
    commit(f.root, 'squash');
    expect(blockedChanges(check(f.root, strict))).toEqual(expected);
  });

  it('covers a capture citing the input but not a change to the capture itself', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    const media = JSON.parse(f.read(MEDIA));
    media.captures[0].caption = 'A task, recaptioned.';
    f.write(MEDIA, `${JSON.stringify(media, null, 2)}\n`);
    commit(f.root, 'change the capture source and the capture');
    expect(
      recordInput(f, 'src/ui.ts', 'Pixels unaffected.').recorded[0].paths,
    ).toEqual(['docs/learn/media/task.png']);
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(blockedChanges(result)['docs/learn/media/task.png']).toEqual([
      'docs/learn/media/task.png',
    ]);
  });

  it('leaves a document whose citation was dropped needing its own note', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'change shared source');
    // In one batch the page's own entry drops the citation; the input entry
    // then lists only the pages that still cite it.
    f.write(
      '.git/reviews.json',
      JSON.stringify([
        {
          path: 'docs/map.md',
          note: 'c1 no longer belongs on the map.',
          removedSources: ['src/c.ts'],
        },
        { input: 'src/c.ts', note: 'Checked c1.' },
      ]),
    );
    const batch = record_(f.root, ['--batch', '.git/reviews.json']);
    expect(batch.status, JSON.stringify(batch.error)).toBe(0);
    expect(batch.output.recorded.at(-1).paths).toEqual(['docs/c.md']);
    expect(check(f.root, scoped).status).toBe(0);
    // A hand-edited drop gets no coverage from the input note.
    git(f.root, ['reset', '-q', '--hard', 'HEAD']);
    git(f.root, ['clean', '-qfd', NOTES_DIR]);
    editRecord(f.root, 'docs/map.md', (data) => {
      data.sources = data.sources.filter(
        (source: string) => source !== 'src/c.ts',
      );
    });
    commit(f.root, 'drop the citation by hand');
    expect(recordInput(f, 'src/c.ts', 'Checked c1.').recorded[0].paths).toEqual(
      ['docs/c.md'],
    );
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(entryPaths(result.blocking)).toContain('docs/map.md');
  });

  it('refuses a renamed input by either name until records cite the new one', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    git(f.root, ['mv', 'src/c.ts', 'src/moved.ts']);
    commit(f.root, 'move the shared source');
    expect(
      record_(f.root, ['--input', 'src/moved.ts', '--note', 'x']).error?.code,
    ).toBe('not-cited');
    expect(
      record_(f.root, ['--input', 'src/c.ts', '--note', 'x']).error?.code,
    ).toBe('untracked');
    expect(notesFiles(f.root)).toEqual([]);
  });

  it('names one input per note and refuses bad entries by code, before writing anything', () => {
    const f = pathOnlyFixture();
    git(f.root, ['switch', '-qc', 'pr']);
    f.write('src/c.ts', C_CHANGED);
    f.write('src/d.ts', 'export const d = 2;\n');
    commit(f.root, 'change two sources');
    const before = ledgerTexts(f.root);
    expect(
      record_(f.root, [
        '--input',
        'src/c.ts',
        '--input',
        'src/d.ts',
        '--note',
        'One note for both.',
      ]).error?.code,
    ).toBe('usage');
    expect(
      record_(f.root, ['--input', 'src/none.ts', '--note', 'x']).error?.code,
    ).toBe('not-cited');
    // A whole-file input does not stand for a cited value inside that file.
    const value = run(f.root, 'record-documentation-review.mjs', [
      '--input',
      'package.json',
      '--note',
      'x',
    ]);
    expect(value.status).toBe(1);
    expect(value.stderr).toContain('package.json#/scripts/docs');
    for (const [entries, code] of [
      [[{ input: ['src/c.ts', 'src/d.ts'], note: 'Both.' }], 'invalid-path'],
      [
        [{ input: 'src/c.ts', paths: ['docs/a.md'], note: 'Chosen pages.' }],
        'invalid-batch',
      ],
      [
        [
          { input: 'src/c.ts', note: 'Once.' },
          { input: 'src/c.ts', note: 'Twice.' },
        ],
        'duplicate-entry',
      ],
      [
        [
          { path: 'docs/map.md', note: 'Valid page entry.' },
          { input: 'src/none.ts', note: 'Nothing cites this.' },
        ],
        'not-cited',
      ],
    ] as const) {
      f.write('.git/reviews.json', JSON.stringify(entries));
      const refused = record_(f.root, ['--batch', '.git/reviews.json']);
      expect(refused.status).toBe(1);
      expect(refused.error?.code).toBe(code);
    }
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 9'));
    expect(
      record_(f.root, ['--input', 'src/c.ts', '--note', 'Uncommitted.']).error
        ?.code,
    ).toBe('not-committed');
    expect(ledgerTexts(f.root)).toEqual(before);
  });

  it('keeps the notes it writes append-only and accepts only their exact privacy redaction', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'main source change');
    recordInput(f, 'src/c.ts', 'Checked c1 on proxy.example.internal.');
    commit(f.root, 'main input note');
    const [file] = notesFiles(f.root);
    const path = `${NOTES_DIR}/${file}`;
    const original = f.read(path);
    git(f.root, ['switch', '-qc', 'pr']);
    rmSync(join(f.root, path));
    commit(f.root, 'delete the input note');
    const deleted = check(f.root, scoped);
    expect(deleted.status).toBe(1);
    expect(deleted.blocking).toContainEqual(
      expect.objectContaining({ path, rule: 'note-removed' }),
    );
    // Dropping one page's entry under a new hash name is a removal too.
    const parsed = JSON.parse(original);
    const narrowed = serializeNotesFile({
      revision: parsed.revision,
      notes: parsed.notes.filter(
        (entry: { path: string }) => entry.path !== 'docs/c.md',
      ),
    });
    expect(JSON.parse(narrowed).notes).toHaveLength(1);
    f.write(
      `${NOTES_DIR}/${file.slice(0, 21)}${hash(narrowed).slice(0, 12)}.json`,
      narrowed,
    );
    commit(f.root, 'rewrite the input note');
    expect(check(f.root, scoped).blocking).toContainEqual(
      expect.objectContaining({ path, rule: 'note-removed' }),
    );
    git(f.root, ['reset', '-q', '--hard', 'main']);
    const redacted = run(f.root, 'record-documentation-review.mjs', [
      '--redact-private-hosts',
      path,
    ]);
    expect(redacted.status, redacted.stderr).toBe(0);
    commit(f.root, 'redact the input note');
    expect(check(f.root, scoped).status).toBe(0);
    const [kept] = notesFiles(f.root);
    expect(JSON.parse(noteText(f, kept)).notes[0]).toEqual({
      path: 'docs/c.md',
      note: 'Checked c1 on [private host].',
      inputs: ['src/c.ts'],
    });
  });

  it('archives the notes it writes byte for byte at compaction and still compiles them', () => {
    const f = pathOnlyFixture();
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'main source change');
    recordInput(f, 'src/c.ts', 'Checked c1.');
    commit(f.root, 'main input note');
    const [file] = notesFiles(f.root);
    const bytes = f.read(`${NOTES_DIR}/${file}`);
    const advance = () => {
      git(f.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      const result = run(f.root, 'record-documentation-review.mjs', [
        '--advance-baseline',
      ]);
      expect(result.status, result.stderr).toBe(0);
    };
    advance();
    commit(f.root, 'advance once');
    expect(notesFiles(f.root)).toContain(file);
    const previous = git(f.root, ['rev-parse', 'HEAD~1']);
    advance();
    git(f.root, ['switch', '-qc', 'compact']);
    commit(f.root, 'advance and compact');
    expect(notesFiles(f.root)).not.toContain(file);
    const archive = JSON.parse(f.read(`${NOTES_DIR}/archive/${previous}.json`));
    expect(archive.notes[file]).toBe(bytes);
    expect(check(f.root, scoped).status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
    expect(compiled(f.root, 'docs/map.md').notes).toContainEqual(
      expect.objectContaining({
        file: `${NOTES_DIR}/${file}`,
        inputs: ['src/c.ts'],
        note: 'Checked c1.',
      }),
    );
  });

  it('serializes document notes exactly as before input notes existed', () => {
    const revision = 'a'.repeat(40);
    // The serializer's JSDoc names only path and note, though it writes inputs.
    const notes = [
      { path: 'docs/a.md', note: 'Old form.' },
      { path: 'docs/c.md', note: 'With inputs.', inputs: ['src/c.ts'] },
    ];
    expect(serializeNotesFile({ revision, notes })).toBe(
      `{\n  "revision": "${revision}",\n\n  "notes": [\n    {"path":"docs/a.md","note":"Old form."},\n\n    {"path":"docs/c.md","note":"With inputs.","inputs":["src/c.ts"]}\n  ]\n}\n`,
    );
  });

  // The property this storage rests on: freshness scripts from before input
  // notes existed read what --input writes. Their code is taken from Git at
  // the commit this lane started from, not copied into the repository. That
  // reader is the one main had at that commit; the serialization pin above is
  // what covers readers older than it.
  it('is read by the freshness check as it was before input notes existed', () => {
    const OLD = 'e75a9e7947e5';
    const repo = join(import.meta.dirname, '../..');
    // A shallow clone lacks the commit. Say so, instead of failing later on
    // an unexplained `git show` error; this never becomes a pass.
    const present = spawnSync(
      'git',
      ['-C', repo, 'cat-file', '-e', `${OLD}^{commit}`],
      { env: gitEnv(), windowsHide: true },
    );
    if (present.status !== 0)
      throw new Error(
        `this test needs full history (fetch-depth: 0): commit ${OLD} is absent from this checkout`,
      );
    const show = (path: string) =>
      execFileSync('git', ['-C', repo, 'show', `${OLD}:${path}`], {
        env: gitEnv(),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
    const old = realpathSync(makeTempDir('station-old-freshness-'));
    const files = [
      ...execFileSync(
        'git',
        ['-C', repo, 'ls-tree', '-r', '--name-only', OLD, 'scripts/lib'],
        { env: gitEnv(), encoding: 'utf8', windowsHide: true },
      )
        .split('\n')
        .filter((file) => file.endsWith('.mjs')),
      // The rest of the old check's import graph outside scripts/lib.
      'scripts/check-documentation-freshness.mjs',
      'scripts/documentation-impact.mjs',
      'scripts/generate-station-docs.mjs',
      'scripts/build-github-pages.mjs',
      'scripts/deploy-ledger.mjs',
      'scripts/deploy-changelog.mjs',
      'scripts/public-docs-hygiene.mjs',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(old, file)), { recursive: true });
      writeFileSync(join(old, file), show(file));
    }
    symlinkSync(join(repo, 'node_modules'), join(old, 'node_modules'), 'dir');
    const oldCheck = (root: string, env: Record<string, string>) => {
      const result = spawnSync(
        process.execPath,
        [join(old, 'scripts/check-documentation-freshness.mjs'), '--json'],
        {
          cwd: root,
          env: pinnedFreshnessEnv(env),
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const f = pathOnlyFixture();
    const base = git(f.root, ['rev-parse', 'HEAD']);
    f.write('src/c.ts', C_CHANGED);
    commit(f.root, 'main source change');
    recordInput(f, 'src/c.ts', 'Checked c1.');
    commit(f.root, 'main input note');
    expect(oldCheck(f.root, strict)).toMatchObject({ status: 0 });
    // A branch cut before the note, judged by its own old scripts against main.
    git(f.root, ['switch', '-qc', 'stale', base]);
    f.write('src/a.ts', 'export const a = 2;\n');
    commit(f.root, 'stale branch change');
    expect(record_(f.root, ['docs/a.md', '--note', 'Checked a.']).status).toBe(
      0,
    );
    commit(f.root, 'stale branch note');
    const stale = oldCheck(f.root, scoped);
    expect(stale.status, stale.out).toBe(0);
    // Control: the removed entry form breaks that same stale branch.
    git(f.root, ['switch', '-q', 'main']);
    const head = git(f.root, ['rev-parse', 'HEAD']);
    const text = `{\n  "revision": "${head}",\n\n  "notes": [\n    {"input":"src/c.ts","paths":["docs/c.md"],"note":"x"}\n  ]\n}\n`;
    f.write(
      `${NOTES_DIR}/20990101T000000.000Z-${hash(text).slice(0, 12)}.json`,
      text,
    );
    commit(f.root, 'a note in the removed form');
    git(f.root, ['switch', '-q', 'stale']);
    expect(oldCheck(f.root, scoped).status).toBe(1);
  });
});
