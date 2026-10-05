import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildFreshnessReport,
  SWEEP_BODY_LIMIT,
  SWEEP_ISSUE_TITLE,
  upsertFreshnessIssue,
} from '../docs-freshness-sweep.mjs';
import {
  DOCS_FRESHNESS_ENV_KEYS,
  documentationFreshnessMode,
  freshnessBlocks,
} from '../lib/documentation-freshness.mjs';
import {
  captureReviewFile,
  LEGACY_REVIEW_LEDGER,
  REVIEW_LEDGER_DIR,
  readReviewState,
  readReviewStateAt,
  recordFile,
} from '../lib/review-ledger-store.mjs';
import {
  check,
  commit,
  compiled,
  compiledMedia,
  conflicted,
  editRecord,
  entryPaths,
  fixture,
  git,
  gitEnv,
  hash,
  ledgerTexts,
  MEDIA,
  makeTempDir,
  merge,
  notesFiles,
  pullRequest,
  queue,
  record_,
  run,
  SHARED_C,
  scoped,
  scripts,
  stale,
  strict,
} from './helpers/documentation-freshness-fixture.js';
import {
  forbidAmbientFreshnessMode,
  LEAKED_FRESHNESS_MODE,
  pinnedFreshnessEnv,
} from './helpers/freshness-env.js';

// Every check below pins its mode; an unpinned read throws (#2934).
forbidAmbientFreshnessMode();

describe('scoped documentation freshness (#2923)', () => {
  it('fails a PR that stales its own record without re-review, and passes once it records the review', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'pr-a']);
    f.write('src/a.ts', 'export const a = 2;\n');
    const changedAt = commit(f.root, 'change a source');
    for (const env of [scoped, pullRequest]) {
      const refused = check(f.root, env);
      expect(refused.status).toBe(1);
      expect(refused.blocking).toEqual([
        stale('review', 'docs/a.md', ['src/a.ts']),
      ]);
    }
    const recorded = record_(f.root, [
      'docs/a.md',
      '--note',
      'Checked the new value.',
    ]);
    expect(recorded.error).toBeUndefined();
    expect(recorded.status).toBe(0);
    expect(check(f.root, scoped).status).toBe(0);
    const a = compiled(f.root, 'docs/a.md');
    // The changed source binds the commit holding its reviewed bytes; the
    // unchanged document keeps its binding.
    expect(a.sources).toEqual([
      {
        path: 'src/a.ts',
        digest: hash('export const a = 2;\n'),
        revision: changedAt,
      },
    ]);
    expect(a.documentRevision).toBe(f.content);
    expect(a.checks.at(-1)).toBe('Checked the new value.');
    expect(a.notes.at(-1)).toMatchObject({
      note: 'Checked the new value.',
      revision: changedAt,
    });
  });

  it('never fails a change for staleness that another change introduced', () => {
    const f = fixture();
    // Another PR landed a change to B's source without re-review (for
    // example, before scoped freshness, or a combination of two merges).
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'other PR stales B');
    git(f.root, ['switch', '-qc', 'pr-a']);
    f.write('src/a.ts', 'export const a = 2;\n');
    commit(f.root, 'change a source');
    expect(record_(f.root, ['docs/a.md', '--note', 'Checked a.']).status).toBe(
      0,
    );
    const result = check(f.root, scoped);
    expect(result.advisory).toEqual([
      stale('review', 'docs/b.md', ['src/b.ts']),
    ]);
    expect(result.blocking).toEqual([]);
    expect(result.status).toBe(0);
  });

  it('lets two branches that each stale a record the other does not touch both pass the merge-queue check', () => {
    const f = fixture();
    const main = git(f.root, ['rev-parse', 'HEAD']);
    git(f.root, ['switch', '-qc', 'x']);
    f.write('src/a.ts', 'export const a = 2;\n');
    commit(f.root, 'x stales A');
    git(f.root, ['switch', '-qc', 'y', main]);
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'y stales B');
    // Each branch's own PR check fails on its own record only.
    const y = check(f.root, scoped);
    expect(y.status).toBe(1);
    expect(y.blocking).toEqual([stale('review', 'docs/b.md', ['src/b.ts'])]);
    // Synthesized queue candidates: y lands first, then x on top, and the
    // reverse order. Both stale records are present in each candidate.
    for (const [first, second] of [
      ['y', 'x'],
      ['x', 'y'],
    ]) {
      git(f.root, ['switch', '-qC', `candidate-${first}-${second}`, first]);
      expect(merge(f.root, second).status).toBe(0);
      const candidate = check(f.root, queue);
      expect(candidate.mode).toBe('advisory');
      expect(candidate.advisory).toEqual([
        stale('review', 'docs/a.md', ['src/a.ts']),
        stale('review', 'docs/b.md', ['src/b.ts']),
      ]);
      expect(candidate.status).toBe(0);
    }
  });

  it('never fails the queue when one PR removes a source another PR starts citing', () => {
    const f = fixture();
    const main = git(f.root, ['rev-parse', 'HEAD']);
    // PR G deletes src/a.ts and drops it from A's review.
    git(f.root, ['switch', '-qc', 'g']);
    f.write('src/g.ts', 'export const g = 1;\n');
    git(f.root, ['rm', '-q', 'src/a.ts']);
    commit(f.root, 'g replaces src/a.ts');
    expect(
      record_(f.root, [
        'docs/a.md',
        '--note',
        'A now reads src/g.ts.',
        '--drop-source',
        'src/a.ts',
        '--add-source',
        'src/g.ts',
      ]).status,
    ).toBe(0);
    commit(f.root, 'g records A');
    expect(check(f.root, scoped).status).toBe(0);
    // PR H makes B cite src/a.ts, which still exists on its base.
    git(f.root, ['switch', '-qc', 'h', main]);
    expect(
      record_(f.root, [
        'docs/b.md',
        '--note',
        'B also reads src/a.ts.',
        '--add-source',
        'src/a.ts',
      ]).status,
    ).toBe(0);
    commit(f.root, 'h records B');
    expect(check(f.root, scoped).status).toBe(0);
    // The queue candidate combines both: B cites a file that no longer exists.
    git(f.root, ['switch', '-qc', 'candidate', 'g']);
    expect(merge(f.root, 'h').status).toBe(0);
    const queued = check(f.root, queue);
    expect(queued.error).toBeUndefined();
    expect(queued.advisory).toEqual([
      stale('review', 'docs/b.md', ['src/a.ts']),
    ]);
    expect(queued.status).toBe(0);
    // Strict still refuses it, and so does a PR whose own diff causes it.
    expect(check(f.root, strict).status).toBe(1);
    git(f.root, ['switch', '-qc', 'own-delete', 'h']);
    git(f.root, ['rm', '-q', 'src/a.ts']);
    commit(f.root, 'delete a cited source without re-review');
    const own = check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'h' });
    expect(own.status).toBe(1);
    // Both pages that cite the deleted source are this change's to review.
    expect(own.blocking).toEqual([
      stale('review', 'docs/a.md', ['src/a.ts']),
      stale('review', 'docs/b.md', ['src/a.ts']),
    ]);
  });

  it('treats a hand-edited record as in scope even when its bytes are untouched', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'edit-record']);
    editRecord(f.root, 'docs/b.md', (data) => {
      data.sources[0].digest = 'f'.repeat(64);
    });
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.blocking).toEqual([
      stale('review', 'docs/b.md', ['src/b.ts']),
    ]);
  });

  it('fails closed when the change scope cannot be computed', () => {
    const f = fixture();
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'stale B on the only branch');
    const result = check(f.root, {
      STATION_DOCS_FRESHNESS_BASE: 'no-such-ref',
    });
    expect(result.status).toBe(1);
    expect(result.mode).toBe('strict');
    expect(result.blocking).toEqual([
      stale('review', 'docs/b.md', ['src/b.ts']),
    ]);
    const bogus = check(f.root, { STATION_DOCS_FRESHNESS: 'bogus' });
    expect(bogus.status).toBe(1);
    expect(bogus.error).toBeDefined();
  });

  it('applies the same scope to learning captures, whose review no longer rewrites media.json', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'ui']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    const changedAt = commit(f.root, 'change captured UI');
    const refused = check(f.root, scoped);
    expect(refused.status).toBe(1);
    expect(refused.blocking).toEqual([
      stale('capture', 'docs/learn/media/task.png', ['src/ui.ts']),
    ]);
    expect(check(f.root, queue).status).toBe(0);
    const before = f.read(MEDIA);
    const recorded = record_(f.root, [
      'docs/learn/media/task.png',
      '--note',
      'The change does not alter the captured pixels.',
    ]);
    expect(recorded.error).toBeUndefined();
    expect(recorded.status).toBe(0);
    // #2936: the capture review lives in the ledger directory, so recording
    // it leaves media.json and every page citing it untouched.
    expect(f.read(MEDIA)).toBe(before);
    expect(recorded.output.dependents).toEqual([]);
    expect(check(f.root, strict).status).toBe(0);
    const capture = compiledMedia(f.root).captures[0];
    expect(capture.sources).toEqual([
      {
        path: 'src/ui.ts',
        digest: hash('export const ui = 2;\n'),
        revision: changedAt,
      },
    ]);
    expect(capture.capturedRevision).toBe('a'.repeat(40));
    expect(capture.reviewNotes).toEqual([
      'The change does not alter the captured pixels.',
    ]);
    expect(f.read(MEDIA)).toContain('Task \\u2192 detail');
    expect(f.read(captureReviewFile('docs/learn/media/task.png'))).toContain(
      changedAt,
    );
  });

  it('runs with the ambient mode forbidden, and spawned checks scrub every mode variable', () => {
    // The guard is live: an unpinned read of the job's mode throws here.
    expect(process.env.STATION_DOCS_FRESHNESS).toBe(LEAKED_FRESHNESS_MODE);
    expect(() => documentationFreshnessMode()).toThrow(
      'must be scoped, advisory or strict',
    );
    const child = pinnedFreshnessEnv();
    for (const key of DOCS_FRESHNESS_ENV_KEYS)
      expect(child).not.toHaveProperty(key);
    // The fixture Git environment is built after the stub, so a spawn that
    // reused it would inherit the forbidden mode instead of a clean one.
    expect(gitEnv().STATION_DOCS_FRESHNESS).toBe(LEAKED_FRESHNESS_MODE);
    expect(DOCS_FRESHNESS_ENV_KEYS).toEqual([
      'STATION_DOCS_FRESHNESS',
      'STATION_DOCS_FRESHNESS_BASE',
      'STATION_CI_FAST_BASE',
      'GITHUB_ACTIONS',
      'GITHUB_EVENT_NAME',
    ]);
  });

  it('decides blocking from one function for every mode', () => {
    const entry = {
      kind: 'review' as const,
      path: 'd.md',
      inputs: ['d.md', 's.ts'],
    };
    const scopedPolicy = (paths: string[], edited: string[] = []) => ({
      mode: 'scoped',
      changedPaths: new Set(paths),
      changedEntries: { review: new Set(edited), capture: new Set<string>() },
    });
    expect(freshnessBlocks({ mode: 'strict' }, entry)).toBe(true);
    expect(freshnessBlocks({ mode: 'advisory' }, entry)).toBe(false);
    expect(freshnessBlocks(scopedPolicy(['s.ts']), entry)).toBe(true);
    expect(freshnessBlocks(scopedPolicy(['d.md']), entry)).toBe(true);
    expect(freshnessBlocks(scopedPolicy([], ['d.md']), entry)).toBe(true);
    expect(freshnessBlocks(scopedPolicy(['other.ts']), entry)).toBe(false);
    expect(documentationFreshnessMode({}).mode).toBe('scoped');
    expect(
      documentationFreshnessMode({
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
      }).mode,
    ).toBe('scoped');
    for (const event of [
      'merge_group',
      'push',
      'schedule',
      'workflow_dispatch',
    ])
      expect(
        documentationFreshnessMode({
          GITHUB_ACTIONS: 'true',
          GITHUB_EVENT_NAME: event,
        }).mode,
      ).toBe('advisory');
    expect(() =>
      documentationFreshnessMode({ STATION_DOCS_FRESHNESS: 'off' }),
    ).toThrow('must be scoped, advisory or strict');
  });

  it('requires a review note when a change drops a cited source it also modifies (D5)', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'escape']);
    f.write('src/c.ts', SHARED_C.replace('c1 = 1', 'c1 = 2'));
    commit(f.root, 'change a source of the shared page');
    // Hand-delete the changed citation instead of re-reviewing the page.
    editRecord(f.root, 'docs/map.md', (data) => {
      data.sources = data.sources.filter(
        (source: { path: string }) => source.path !== 'src/c.ts',
      );
    });
    // The page's remaining bytes are fresh, so only the drop rule sees it.
    expect(entryPaths(check(f.root, queue).advisory)).not.toContain(
      'docs/map.md',
    );
    const escaped = check(f.root, scoped);
    expect(escaped.status).toBe(1);
    expect(escaped.blocking).toEqual([
      {
        kind: 'review',
        path: 'docs/map.md',
        changed: ['src/c.ts'],
        rule: 'unreviewed-drop',
      },
    ]);
    // The record command's drop writes the note the rule asks for.
    git(f.root, ['checkout', '--', REVIEW_LEDGER_DIR]);
    const dropped = record_(f.root, [
      'docs/map.md',
      '--note',
      'src/c.ts no longer supports this page.',
      '--drop-source',
      'src/c.ts',
    ]);
    expect(dropped.error).toBeUndefined();
    expect(dropped.status).toBe(0);
    expect(check(f.root, scoped).status).toBe(0);
    // Deleting the whole record while its page remains is refused outright.
    commit(f.root, 'record the drop');
    rmSync(join(f.root, recordFile('docs/map.md')));
    const removed = check(f.root, scoped);
    expect(removed.status).toBe(1);
    expect(removed.blocking).toEqual([
      {
        kind: 'review',
        path: 'docs/map.md',
        changed: ['src/c.ts'],
        rule: 'record-removed',
      },
    ]);
  });
});

describe('docs:review:record (#2924, #2936)', () => {
  it('rebinds only the changed lines, adds one notes file and reports dependents', () => {
    const f = fixture();
    // Like a migrated record: the source is bound to a later commit that
    // also holds its bytes, not to the commit that last changed it.
    const later = git(f.root, ['rev-parse', 'HEAD']);
    editRecord(f.root, 'docs/a.md', (data) => {
      data.sources[0].revision = later;
    });
    commit(f.root, 'bind A to a later commit');
    f.write('docs/a.md', '# A, revised\n');
    const changedAt = commit(f.root, 'revise A');
    const file = recordFile('docs/a.md');
    const before = f.read(file);
    const result = record_(f.root, [
      'docs/a.md',
      '--note',
      'Re-read the page.',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Only the document binding line changed; the unchanged source keeps
    // its line, so another branch refreshing it merges cleanly.
    const changed = f
      .read(file)
      .split('\n')
      .filter((line) => !before.split('\n').includes(line));
    expect(changed).toEqual([
      `  "document": {"digest":"${hash('# A, revised\n')}","revision":"${changedAt}"},`,
    ]);
    expect(notesFiles(f.root)).toHaveLength(1);
    expect(result.output.notesFile).toBe(
      `${REVIEW_LEDGER_DIR}/notes/${notesFiles(f.root)[0]}`,
    );
    // docs/c.md cites docs/a.md, whose accepted bytes just changed.
    expect(result.output.dependents).toEqual([
      { path: 'docs/c.md', changed: ['docs/a.md'] },
    ]);
    expect(check(f.root, strict).blocking).toEqual([
      stale('review', 'docs/c.md', ['docs/a.md']),
    ]);
  });

  it('refuses an empty note, an unknown path, fresh or uncommitted bytes and bad source edits without writing', () => {
    const f = fixture();
    f.write('src/untracked.ts', 'export const u = 1;\n');
    const before = f.read(recordFile('docs/a.md'));
    for (const [args, code] of [
      [['docs/a.md', '--note', '   '], 'empty-note'],
      [['docs/a.md'], 'empty-note'],
      [['docs/missing.md', '--note', 'Reviewed.'], 'unknown-entry'],
      // (a) Nothing changed since the recorded review.
      [['docs/a.md', '--note', 'Reviewed.'], 'already-fresh'],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--drop-source', 'src/nope.ts'],
        'not-a-source',
      ],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--add-source', 'src/a.ts'],
        'already-a-source',
      ],
      [
        [
          'docs/a.md',
          '--note',
          'Reviewed.',
          '--add-source',
          'src/untracked.ts',
        ],
        'untracked',
      ],
      [
        [
          'docs/a.md',
          '--note',
          'Reviewed.',
          '--add-source',
          'package.json#/scripts/missing',
        ],
        'missing-value',
      ],
      [['docs/a.md', '--note', '--drop-source'], 'usage'],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--drop-source', '--note'],
        'usage',
      ],
      [['--show-delta', 'docs/a.md', '--note', 'Reviewed.'], 'usage'],
    ] as const) {
      const refused = record_(f.root, [...args]);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.error?.code, args.join(' ')).toBe(code);
    }
    // A review binds a commit that contains the reviewed bytes.
    f.write('src/a.ts', 'export const a = 2;\n');
    const uncommitted = record_(f.root, ['docs/a.md', '--note', 'Reviewed.']);
    expect(uncommitted.status).toBe(1);
    expect(uncommitted.error?.code).toBe('not-committed');
    expect(f.read(recordFile('docs/a.md'))).toBe(before);
    expect(notesFiles(f.root)).toEqual([]);

    const unborn = fixture({ commitIt: false });
    git(unborn.root, ['add', '-A']);
    const noHead = record_(unborn.root, ['docs/a.md', '--note', 'Reviewed.']);
    expect(noHead.status).toBe(1);
    expect(noHead.error?.code).toBe('no-head');
  });

  it('records a deliberate re-review of fresh bytes with --rereview and changes no binding', () => {
    const f = fixture();
    const before = f.read(recordFile('docs/a.md'));
    const result = record_(f.root, [
      'docs/a.md',
      '--note',
      'Re-read against the new caller.',
      '--rereview',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(f.read(recordFile('docs/a.md'))).toBe(before);
    expect(compiled(f.root, 'docs/a.md').checks.at(-1)).toBe(
      'Re-read against the new caller.',
    );
  });

  it('applies a batch atomically and drops removed sources', () => {
    const f = fixture();
    f.write('src/a.ts', 'export const a = 2;\n');
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'change a and b');
    const before = f.read(recordFile('docs/a.md'));
    const batch = join(f.root, 'batch.json');
    writeFileSync(
      batch,
      JSON.stringify([
        { path: 'docs/a.md', note: 'Checked a.' },
        { path: 'docs/b.md', note: '' },
      ]),
    );
    expect(record_(f.root, ['--batch', batch]).status).toBe(1);
    expect(f.read(recordFile('docs/a.md'))).toBe(before);
    expect(notesFiles(f.root)).toEqual([]);
    writeFileSync(
      batch,
      JSON.stringify([
        { path: 'docs/a.md', note: 'Checked a.' },
        {
          path: 'docs/c.md',
          note: 'A no longer supports C.',
          removedSources: ['docs/a.md'],
        },
        { path: 'docs/b.md', note: 'Checked b.' },
      ]),
    );
    // docs/c.md is classified-only once its last source is dropped; the
    // fixture's source-reviewed state must keep a source, so relax it first.
    editRecord(f.root, 'docs/c.md', (data) => {
      data.state = 'classified';
    });
    const result = record_(f.root, ['--batch', batch]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(notesFiles(f.root)).toHaveLength(1);
    expect(compiled(f.root, 'docs/c.md').sources).toEqual([]);
    const added = record_(f.root, [
      'docs/b.md',
      '--note',
      'B also reads the UI constant.',
      '--add-source',
      'src/ui.ts',
    ]);
    expect(added.status).toBe(0);
    expect(
      compiled(f.root, 'docs/b.md').sources.map(({ path, digest }) => ({
        path,
        digest,
      })),
    ).toEqual([
      { path: 'src/b.ts', digest: hash('export const b = 2;\n') },
      { path: 'src/ui.ts', digest: hash('export const ui = 1;\n') },
    ]);
    expect(check(f.root, strict).status).toBe(0);
  });

  it('prints the Git delta of each stale input since its reviewed revision (--show-delta)', () => {
    const f = fixture();
    f.write('src/a.ts', 'export const a = 2;\n');
    commit(f.root, 'change a');
    const delta = record_(f.root, ['--show-delta', 'docs/a.md', 'docs/b.md']);
    expect(delta.error).toBeUndefined();
    expect(delta.status).toBe(0);
    const [a, b] = delta.output.deltas;
    expect(a).toMatchObject({
      kind: 'review',
      path: 'docs/a.md',
      fresh: false,
    });
    expect(a.diffs).toHaveLength(1);
    expect(a.diffs[0]).toMatchObject({
      revision: f.content,
      inputs: ['src/a.ts'],
      files: ['src/a.ts'],
      lacksReviewedBytes: [],
      uncommitted: [],
      available: true,
    });
    // The diff is Git's own output for exactly that revision range.
    expect(a.diffs[0].diff).toBe(
      git(f.root, ['diff', '--no-color', f.content, 'HEAD', '--', 'src/a.ts']),
    );
    expect(a.diffs[0].diff).toContain('+export const a = 2;');
    expect(b).toEqual({ kind: 'review', path: 'docs/b.md', fresh: true });
    // Without paths it covers every stale entry and writes nothing.
    const all = record_(f.root, ['--show-delta']);
    expect(
      all.output.deltas.map((entry: { path: string }) => entry.path),
    ).toEqual(['docs/a.md']);
    expect(git(f.root, ['status', '--porcelain'])).toBe('');
  });

  it('flags a binding whose revision lacks its bytes and rebinds it on re-review', () => {
    const f = fixture();
    expect(record_(f.root, ['--verify-bindings']).status).toBe(0);
    f.write('src/a.ts', 'export const a = 2;\n');
    const changedAt = commit(f.root, 'change a');
    // A record merged from two sides, or refreshed by hand: its digest names
    // the current bytes but its revision still names the old commit.
    editRecord(f.root, 'docs/a.md', (data) => {
      data.sources[0].digest = hash('export const a = 2;\n');
    });
    commit(f.root, 'hand-merged record');
    expect(check(f.root, strict).status).toBe(0);
    const flagged = record_(f.root, ['--verify-bindings']);
    expect(flagged.status).toBe(1);
    expect(flagged.output.flagged).toEqual([
      {
        owner: 'docs/a.md',
        kind: 'review',
        path: 'src/a.ts',
        digest: hash('export const a = 2;\n'),
        revision: f.content,
        reason: 'different-bytes',
      },
    ]);
    expect(
      record_(f.root, ['docs/a.md', '--note', 'Reviewed.']).error?.code,
    ).toBe('already-fresh');
    const rebound = record_(f.root, [
      'docs/a.md',
      '--note',
      'Re-reviewed the merged record.',
      '--rereview',
    ]);
    expect(rebound.status).toBe(0);
    expect(rebound.output.recorded).toEqual([
      { kind: 'review', path: 'docs/a.md', rebound: ['src/a.ts'] },
    ]);
    expect(compiled(f.root, 'docs/a.md').sources[0].revision).toBe(changedAt);
    expect(record_(f.root, ['--verify-bindings']).status).toBe(0);
  });
});

/** The same reviews in the single-file layout that preceded #2936. */
function legacyLayout(root: string) {
  const { ledger } = readReviewState(root);
  return {
    legacyLedger: {
      version: 1,
      records: ledger.records.map((entry: any) => ({
        path: entry.path,
        documentDigest: entry.documentDigest,
        sourceRevision: entry.documentRevision,
        kind: entry.kind,
        state: entry.state,
        summary: entry.summary,
        limits: entry.limits,
        sources: entry.sources.map(({ path, digest }: any) => ({
          path,
          digest,
        })),
        checks: entry.checks,
      })),
    },
    legacyMedia: {
      version: 1,
      captures: compiledMedia(root).captures.map(
        ({ sources, reviewNotes: _r, notes: _n, ...metadata }: any) => ({
          ...metadata,
          reviewedRevision: sources[0].revision,
          sources: sources.map(({ path, digest }: any) => ({ path, digest })),
        }),
      ),
    },
  };
}

describe('merge-queue-friendly review ledger layout (#2936)', () => {
  /** Change `edits` on a new branch off `base`, commit, then record `reviews`. */
  function branch(
    f: ReturnType<typeof fixture>,
    name: string,
    base: string,
    edits: Record<string, string>,
    reviews: string[],
  ) {
    git(f.root, ['switch', '-qc', name, base]);
    for (const [path, text] of Object.entries(edits)) f.write(path, text);
    commit(f.root, `${name} changes`);
    const batch = join(f.root, '.git', `${name}-batch.json`);
    writeFileSync(
      batch,
      JSON.stringify(
        reviews.map((path) => ({ path, note: `${name} reviewed ${path}.` })),
      ),
    );
    const recorded = record_(f.root, ['--batch', batch]);
    expect(recorded.error).toBeUndefined();
    expect(recorded.status).toBe(0);
    commit(f.root, `${name} records`);
    expect(check(f.root, scoped).status).toBe(0);
  }

  it('merges branches that refresh different sources of one record, or different records, with no conflict', () => {
    const f = fixture();
    const main = git(f.root, ['rev-parse', 'HEAD']);
    // A and B refresh different sources of the shared page; C another record.
    branch(f, 'a', main, { 'src/c.ts': SHARED_C.replace('c1 = 1', 'c1 = 2') }, [
      'docs/map.md',
    ]);
    branch(f, 'b', main, { 'src/d.ts': 'export const d = 2;\n' }, [
      'docs/map.md',
    ]);
    branch(f, 'c', main, { 'src/b.ts': 'export const b = 2;\n' }, [
      'docs/b.md',
    ]);
    const pairs = [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'c'],
      ['b', 'c'],
    ];
    for (const [first, second] of pairs) {
      git(f.root, ['switch', '-qC', `m-${first}-${second}`, first]);
      const merged = merge(f.root, second);
      expect(conflicted(f.root), `${first} + ${second}`).toEqual([]);
      expect(merged.status).toBe(0);
      expect(check(f.root, strict).status).toBe(0);
    }
    git(f.root, ['switch', '-qC', 'm-all', 'a']);
    expect(merge(f.root, 'b').status).toBe(0);
    expect(merge(f.root, 'c').status).toBe(0);
    const result = check(f.root, strict);
    expect(result.blocking).toEqual([]);
    expect(result.advisory).toEqual([]);
    expect(result.status).toBe(0);
    // Both reviews and both bindings survive the merge.
    const map = compiled(f.root, 'docs/map.md');
    expect(map.checks.slice(-2).sort()).toEqual([
      'a reviewed docs/map.md.',
      'b reviewed docs/map.md.',
    ]);
    expect(map.sources.map(({ digest }) => digest)).toEqual([
      hash(SHARED_C.replace('c1 = 1', 'c1 = 2')),
      hash('export const d = 2;\n'),
    ]);
    expect(record_(f.root, ['--verify-bindings']).status).toBe(0);
  });

  it('merges two branches that review the same new bytes of a source, because both bind the commit holding them', () => {
    const f = fixture();
    // main moves a source without re-review; both branches catch up on it.
    f.write('src/c.ts', SHARED_C.replace('c2 = 1', 'c2 = 2'));
    const moved = commit(f.root, 'main moves src/c.ts');
    branch(f, 'x', moved, { 'docs/b.md': '# B, x\n' }, [
      'docs/map.md',
      'docs/b.md',
    ]);
    branch(f, 'y', moved, { 'src/d.ts': 'export const d = 2;\n' }, [
      'docs/map.md',
    ]);
    expect(compiled(f.root, 'docs/map.md').sources[0].revision).toBe(moved);
    expect(merge(f.root, 'x').status).toBe(0);
    expect(check(f.root, strict).status).toBe(0);
  });

  it('still conflicts, or fails the scoped check, when two branches review different bytes of the same source', () => {
    const f = fixture();
    const main = git(f.root, ['rev-parse', 'HEAD']);
    // The two source edits are far apart, so the source itself merges.
    branch(f, 'p', main, { 'src/c.ts': SHARED_C.replace('c1 = 1', 'c1 = 2') }, [
      'docs/map.md',
    ]);
    branch(f, 'q', main, { 'src/c.ts': SHARED_C.replace('c2 = 1', 'c2 = 2') }, [
      'docs/map.md',
    ]);
    const merged = merge(f.root, 'p');
    expect(merged.status).toBe(1);
    // Only the review conflicts; the source itself merged.
    expect(conflicted(f.root)).toEqual([recordFile('docs/map.md')]);
    // Taking one side's record leaves a review of bytes nobody reviewed,
    // which this change's own scoped check refuses.
    git(f.root, ['checkout', '--theirs', '--', recordFile('docs/map.md')]);
    commit(f.root, 'resolve by taking one side');
    const resolved = check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'main' });
    expect(resolved.status).toBe(1);
    expect(resolved.blocking).toEqual([
      stale('review', 'docs/map.md', ['src/c.ts']),
    ]);
  });

  it('refuses a reformatted record, an edited note and a stray file in the ledger directory', () => {
    const f = fixture();
    expect(
      record_(f.root, ['docs/a.md', '--note', 'Once.', '--rereview']).status,
    ).toBe(0);
    commit(f.root, 'note');
    const [note] = notesFiles(f.root);
    const noteFile = join(f.root, REVIEW_LEDGER_DIR, 'notes', note);
    const recordPath = join(f.root, recordFile('docs/b.md'));
    for (const [mutate, code, file] of [
      [
        () =>
          writeFileSync(
            recordPath,
            `${JSON.stringify(JSON.parse(readFileSync(recordPath, 'utf8')), null, 2)}\n`,
          ),
        'not-canonical',
        recordFile('docs/b.md'),
      ],
      [
        () =>
          writeFileSync(
            noteFile,
            readFileSync(noteFile, 'utf8').replace('Once.', 'Twice.'),
          ),
        'notes-edited',
        `${REVIEW_LEDGER_DIR}/notes/${note}`,
      ],
      [
        () =>
          writeFileSync(join(f.root, REVIEW_LEDGER_DIR, 'stray.json'), '{}\n'),
        'unexpected-file',
        `${REVIEW_LEDGER_DIR}/stray.json`,
      ],
    ] as const) {
      mutate();
      const refused = check(f.root, strict);
      expect(refused.status).toBe(1);
      expect(refused.error).toMatchObject({ code, file });
      git(f.root, ['checkout', '--', REVIEW_LEDGER_DIR]);
      rmSync(join(f.root, REVIEW_LEDGER_DIR, 'stray.json'), { force: true });
      expect(check(f.root, strict).status).toBe(0);
    }
  });

  it('reads the single-file layout from history, and the layout change alone puts no record in scope', () => {
    const f = fixture();
    const current = {
      ledger: readReviewState(f.root).ledger,
      media: compiledMedia(f.root),
    };
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    git(f.root, ['switch', '-qc', 'legacy-main', 'main']);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(legacyLedger, null, 2)}\n`);
    f.write(MEDIA, `${JSON.stringify(legacyMedia, null, 2)}\n`);
    // main also carries a stale record that no pull request owns.
    f.write('src/b.ts', 'export const b = 2;\n');
    const legacy = commit(f.root, 'legacy layout, B stale');
    expect(readReviewStateAt(f.root, legacy)).toEqual({
      ledger: { ...current.ledger, coverageBaseline: undefined },
      media: current.media,
    });
    // The migration branch rewrites every ledger byte but no review.
    git(f.root, ['switch', '-qc', 'migrate']);
    git(f.root, ['rm', '-rq', LEGACY_REVIEW_LEDGER, MEDIA]);
    git(f.root, ['checkout', 'main', '--', REVIEW_LEDGER_DIR, MEDIA]);
    commit(f.root, 'migrate layout');
    const migrated = check(f.root, {
      STATION_DOCS_FRESHNESS_BASE: 'legacy-main',
    });
    expect(migrated.blocking).toEqual([]);
    expect(migrated.advisory).toEqual([
      stale('review', 'docs/b.md', ['src/b.ts']),
    ]);
    expect(migrated.status).toBe(0);
  });

  it('migrates the single-file layout into the same files the record command writes', () => {
    const f = fixture();
    const expected = ledgerTexts(f.root);
    const media = f.read(MEDIA);
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(legacyLedger, null, 2)}\n`);
    f.write(MEDIA, `${JSON.stringify(legacyMedia, null, 2)}\n`);
    const migrated = run(f.root, 'migrate-review-ledger.mjs');
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(ledgerTexts(f.root)).toEqual(expected);
    expect(f.read(MEDIA)).toBe(media);
    expect(git(f.root, ['status', '--porcelain'])).toBe('');
  });

  it('folds a branch that recorded reviews in the old file into the new layout after a merge conflict', () => {
    const f = fixture();
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    // The shared base still used the single file.
    git(f.root, ['switch', '-qc', 'legacy-base', 'main']);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(legacyLedger, null, 2)}\n`);
    f.write(MEDIA, `${JSON.stringify(legacyMedia, null, 2)}\n`);
    const base = commit(f.root, 'legacy base');
    // Their branch refreshes B in the old file, rebinding every source.
    git(f.root, ['switch', '-qc', 'theirs']);
    f.write('src/b.ts', 'export const b = 2;\n');
    const changedB = commit(f.root, 'change b');
    const theirLedger = structuredClone(legacyLedger);
    const b = theirLedger.records.find(
      (entry: { path: string }) => entry.path === 'docs/b.md',
    );
    if (!b) throw new Error('The fixture reviews docs/b.md');
    b.sources[0].digest = hash('export const b = 2;\n');
    b.sourceRevision = changedB;
    b.checks.push('Their review of b.');
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(theirLedger, null, 2)}\n`);
    commit(f.root, 'record b in the old file');
    // Ours migrates the layout and records A.
    git(f.root, ['switch', '-qc', 'ours', base]);
    git(f.root, ['rm', '-rq', LEGACY_REVIEW_LEDGER, MEDIA]);
    git(f.root, ['checkout', 'main', '--', REVIEW_LEDGER_DIR, MEDIA]);
    commit(f.root, 'migrate layout');
    f.write('src/a.ts', 'export const a = 2;\n');
    commit(f.root, 'change a');
    expect(
      record_(f.root, ['docs/a.md', '--note', 'Our review of a.']).status,
    ).toBe(0);
    commit(f.root, 'record a');
    const oursTip = git(f.root, ['rev-parse', 'HEAD']);
    // Merging their branch conflicts on the removed file; keep theirs, fold.
    expect(merge(f.root, 'theirs').status).toBe(1);
    expect(conflicted(f.root)).toEqual([LEGACY_REVIEW_LEDGER]);
    git(f.root, ['checkout', '--theirs', '--', LEGACY_REVIEW_LEDGER]);
    const folded = run(f.root, 'migrate-review-ledger.mjs', ['--base', base]);
    expect(folded.status, folded.stderr).toBe(0);
    commit(f.root, 'merge theirs');
    expect(existsSync(join(f.root, LEGACY_REVIEW_LEDGER))).toBe(false);
    expect(git(f.root, ['status', '--porcelain'])).toBe('');
    const result = check(f.root, strict);
    expect(result.blocking).toEqual([]);
    expect(result.status).toBe(0);
    expect(compiled(f.root, 'docs/a.md').checks.at(-1)).toBe(
      'Our review of a.',
    );
    expect(compiled(f.root, 'docs/b.md').checks.at(-1)).toBe(
      'Their review of b.',
    );
    // The folded note keeps the revision their review was recorded at.
    expect(compiled(f.root, 'docs/b.md').notes.at(-1)).toMatchObject({
      note: 'Their review of b.',
      revision: changedB,
    });
    expect(compiled(f.root, 'docs/b.md').sources[0]).toEqual({
      path: 'src/b.ts',
      digest: hash('export const b = 2;\n'),
      revision: changedB,
    });
    const foldedState = readReviewState(f.root).ledger.records.map(
      ({ notes: _notes, ...entry }: any) => entry,
    );
    // The author's direction: their branch merges ours and keeps its own file.
    git(f.root, ['switch', '-q', 'theirs']);
    expect(merge(f.root, oursTip).status).toBe(1);
    expect(conflicted(f.root)).toEqual([LEGACY_REVIEW_LEDGER]);
    git(f.root, ['checkout', '--ours', '--', LEGACY_REVIEW_LEDGER]);
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--base', base]).status,
    ).toBe(0);
    commit(f.root, 'merge ours into theirs');
    expect(check(f.root, strict).status).toBe(0);
    expect(
      readReviewState(f.root).ledger.records.map(
        ({ notes: _notes, ...entry }: any) => entry,
      ),
    ).toEqual(foldedState);
  });

  it('carries an in-place edit to an earlier check, and reports one both sides edited', () => {
    const f = fixture();
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    // Main appended a check to C after the layout's records were written.
    const legacyC = (ledger: any) =>
      ledger.records.find(
        (entry: { path: string }) => entry.path === 'docs/c.md',
      );
    legacyC(legacyLedger).checks.push('Main appended.');
    git(f.root, ['switch', '-qc', 'legacy-base', 'main']);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(legacyLedger, null, 2)}\n`);
    f.write(MEDIA, `${JSON.stringify(legacyMedia, null, 2)}\n`);
    const base = commit(f.root, 'legacy base');
    // Their branch redacts the first check of A and of B in place.
    git(f.root, ['switch', '-qc', 'theirs']);
    const theirLedger = structuredClone(legacyLedger);
    for (const entry of theirLedger.records)
      if (['docs/a.md', 'docs/b.md'].includes(entry.path))
        entry.checks[0] = 'Redacted evidence.';
    // A text merge of the old file ordered their append before main's.
    legacyC(theirLedger).checks = [
      'Fixture evidence.',
      'Their appended.',
      'Main appended.',
    ];
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(theirLedger, null, 2)}\n`);
    commit(f.root, 'redact checks in the old file');
    // Ours migrates and edits A's first check differently.
    git(f.root, ['switch', '-qc', 'ours', base]);
    git(f.root, ['rm', '-rq', LEGACY_REVIEW_LEDGER, MEDIA]);
    git(f.root, ['checkout', 'main', '--', REVIEW_LEDGER_DIR, MEDIA]);
    commit(f.root, 'migrate layout');
    editRecord(f.root, 'docs/a.md', (data) => {
      data.checks[0] = 'Our edit.';
    });
    commit(f.root, 'edit a check');
    expect(merge(f.root, 'theirs').status).toBe(1);
    const folded = run(f.root, 'migrate-review-ledger.mjs', ['--base', base]);
    expect(folded.status, folded.stderr).toBe(0);
    expect(folded.stdout).toMatch(
      /Both sides edited or removed earlier notes of these;.*: docs\/a\.md$/m,
    );
    commit(f.root, 'merge theirs');
    expect(compiled(f.root, 'docs/b.md').checks[0]).toBe('Redacted evidence.');
    expect(compiled(f.root, 'docs/a.md').checks[0]).toBe('Our edit.');
    expect(compiled(f.root, 'docs/b.md').notes ?? []).toEqual([]);
    // Reordering is not an edit: only their own check is new.
    expect(
      compiled(f.root, 'docs/c.md').checks.filter(
        (check: string) => check === 'Their appended.',
      ),
    ).toEqual(['Their appended.']);
    expect(compiled(f.root, 'docs/c.md').checks).not.toContain(
      'Redacted evidence.',
    );
    expect(check(f.root, strict).status).toBe(0);
  });

  it('folds a branch that re-reviewed only a capture, and stops on a field both sides changed', () => {
    const f = fixture();
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    git(f.root, ['switch', '-qc', 'legacy-base', 'main']);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    f.write(LEGACY_REVIEW_LEDGER, `${JSON.stringify(legacyLedger, null, 2)}\n`);
    f.write(MEDIA, `${JSON.stringify(legacyMedia, null, 2)}\n`);
    const base = commit(f.root, 'legacy base');
    // Each branch re-reviews the capture and leaves the old ledger alone; the
    // second also edits the caption.
    for (const [branch, caption] of [
      ['capture-only', 'A task.'],
      ['caption-too', 'Their caption.'],
    ]) {
      git(f.root, ['switch', '-qc', branch, base]);
      const media = structuredClone(legacyMedia);
      media.captures[0].reviewNotes = ['Their capture review.'];
      media.captures[0].caption = caption;
      f.write(MEDIA, `${JSON.stringify(media, null, 2)}\n`);
      commit(f.root, `re-review the capture on ${branch}`);
    }
    git(f.root, ['switch', '-qc', 'ours', base]);
    git(f.root, ['rm', '-rq', LEGACY_REVIEW_LEDGER, MEDIA]);
    git(f.root, ['checkout', 'main', '--', REVIEW_LEDGER_DIR, MEDIA]);
    commit(f.root, 'migrate layout');
    f.write(MEDIA, f.read(MEDIA).replace('"A task."', '"A task, open."'));
    commit(f.root, 'edit a caption');
    expect(
      record_(f.root, ['docs/d.md', '--note', 'Our review of d.']).status,
    ).toBe(0);
    commit(f.root, 'record d');
    const oursTip = git(f.root, ['rev-parse', 'HEAD']);
    // The capture-only branch: only media.json conflicts, and it folds.
    expect(merge(f.root, 'capture-only').status).toBe(1);
    expect(conflicted(f.root)).toEqual([MEDIA]);
    // Without the merge base it stops before writing anything.
    const baseless = run(f.root, 'migrate-review-ledger.mjs');
    expect(baseless.status).toBe(1);
    expect(baseless.stderr).toContain('pass --base <merge base>');
    expect(f.read(MEDIA)).toContain('<<<<<<<');
    const folded = run(f.root, 'migrate-review-ledger.mjs', ['--base', base]);
    expect(folded.status, folded.stderr).toBe(0);
    commit(f.root, 'merge capture-only');
    expect(JSON.parse(f.read(MEDIA)).captures[0].caption).toBe('A task, open.');
    expect(compiledMedia(f.root).captures[0].reviewNotes).toContain(
      'Their capture review.',
    );
    expect(check(f.root, strict).status).toBe(0);
    // Both sides changed the caption: the command names it and stops.
    git(f.root, ['reset', '-q', '--hard', oursTip]);
    expect(merge(f.root, 'caption-too').status).toBe(1);
    const refused = run(f.root, 'migrate-review-ledger.mjs', ['--base', base]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'both sides changed docs/learn/media/task.png caption',
    );
    expect(conflicted(f.root)).toEqual([MEDIA]);
    expect(f.read(MEDIA)).toContain('<<<<<<<');
  });

  it('folds a branch that re-reviewed a capture in media.json across Git merge outcomes', () => {
    const f = fixture();
    const { legacyLedger, legacyMedia } = legacyLayout(f.root);
    const legacyText = (media: unknown) =>
      `${JSON.stringify(media, null, 2)}\n`;
    const citeMedia = (ledger: any, text: string) => {
      const d = ledger.records.find(
        (entry: { path: string }) => entry.path === 'docs/d.md',
      );
      d.sources[0].digest = hash(text);
      return d;
    };
    // The shared base: docs/d.md reviewed the old-layout media.json bytes.
    git(f.root, ['switch', '-qc', 'legacy-base', 'main']);
    rmSync(join(f.root, REVIEW_LEDGER_DIR), { recursive: true });
    const baseLedger = structuredClone(legacyLedger);
    citeMedia(baseLedger, legacyText(legacyMedia));
    f.write(LEGACY_REVIEW_LEDGER, legacyText(baseLedger));
    f.write(MEDIA, legacyText(legacyMedia));
    const base = commit(f.root, 'legacy base');
    // Their branch re-reviews the capture and rebinds its citer to those bytes.
    git(f.root, ['switch', '-qc', 'theirs']);
    const theirMedia = structuredClone(legacyMedia);
    theirMedia.captures[0].reviewNotes = ['Their capture review.'];
    f.write(MEDIA, legacyText(theirMedia));
    const theirLedger = structuredClone(baseLedger);
    citeMedia(theirLedger, legacyText(theirMedia)).checks.push(
      'Their review of d.',
    );
    f.write(LEGACY_REVIEW_LEDGER, legacyText(theirLedger));
    commit(f.root, 'review the capture in the old files');
    // Ours migrates, which rebinds the citer, then edits a caption.
    git(f.root, ['switch', '-qc', 'ours', base]);
    git(f.root, ['rm', '-rq', LEGACY_REVIEW_LEDGER, MEDIA]);
    git(f.root, ['checkout', 'main', '--', REVIEW_LEDGER_DIR, MEDIA]);
    commit(f.root, 'migrate layout');
    // It also recaptures and adds a page: edits beside the review fields.
    f.write(
      MEDIA,
      f
        .read(MEDIA)
        .replace('"A task."', '"A task, open."')
        .replace('a'.repeat(40), 'c'.repeat(40))
        .replace('"docs/a.md"', '"docs/a.md",\n        "docs/b.md"'),
    );
    commit(f.root, 'edit a caption and recapture');
    expect(
      record_(f.root, ['docs/d.md', '--note', 'Our review of d.']).status,
    ).toBe(0);
    commit(f.root, 'record d');
    const oursTip = git(f.root, ['rev-parse', 'HEAD']);
    // Both directions: the branch merged in, and the branch merging ours.
    for (const [branch, other] of [
      ['ours', 'theirs'],
      ['theirs', oursTip],
    ]) {
      git(f.root, ['switch', '-q', branch]);
      expect(merge(f.root, other).status).toBe(1);
      const conflicts = conflicted(f.root);
      expect(conflicts).toContain(LEGACY_REVIEW_LEDGER);
      // Git 2.55 can auto-merge media.json; either path must preserve the capture review.
      const folded = run(f.root, 'migrate-review-ledger.mjs', ['--base', base]);
      expect(folded.status, folded.stderr).toBe(0);
      if (conflicts.includes(MEDIA))
        expect(folded.stdout).toContain('Resolved the docs/learn/media.json');
      // Judged against the bytes it writes, the citer is not reported stale.
      expect(folded.stdout).not.toContain('Both sides rebound');
      commit(f.root, `merge into ${branch}`);
      expect(git(f.root, ['status', '--porcelain'])).toBe('');
      const media = f.read(MEDIA);
      expect(JSON.parse(media).captures[0]).toMatchObject({
        caption: 'A task, open.',
        capturedRevision: 'c'.repeat(40),
        documents: ['docs/a.md', 'docs/b.md'],
      });
      expect(media).not.toMatch(/reviewNotes|reviewedRevision|"sources"/);
      expect(compiledMedia(f.root).captures[0].reviewNotes).toContain(
        'Their capture review.',
      );
      expect(compiled(f.root, 'docs/d.md').sources[0].digest).toBe(hash(media));
      expect(compiled(f.root, 'docs/d.md').checks).toEqual(
        expect.arrayContaining(['Our review of d.', 'Their review of d.']),
      );
      const result = check(f.root, strict);
      expect(result.blocking).toEqual([]);
      expect(result.status).toBe(0);
    }
  });

  it('stales a value binding only when its cited value changes', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'scripts']);
    // An unrelated script and a reformat leave the cited value alone.
    f.write(
      'package.json',
      JSON.stringify({
        scripts: { docs: 'node docs.mjs', other: 'node other.mjs', added: 'x' },
      }),
    );
    commit(f.root, 'add an unrelated script');
    for (const env of [scoped, strict]) {
      const unrelated = check(f.root, env);
      expect(unrelated.blocking).toEqual([]);
      expect(unrelated.status).toBe(0);
    }
    // Changing the cited value stales the page that cites it.
    const changed = {
      scripts: {
        docs: 'node docs.mjs --all',
        other: 'node other.mjs',
        added: 'x',
      },
    };
    f.write('package.json', JSON.stringify(changed));
    const valueSetAt = commit(f.root, 'change the cited script');
    const stalePage = check(f.root, scoped);
    expect(stalePage.status).toBe(1);
    expect(stalePage.blocking).toEqual([
      stale('review', 'docs/pkg.md', ['package.json#/scripts/docs']),
    ]);
    // A later unrelated edit does not move the binding off the commit that
    // set the value.
    f.write(
      'package.json',
      JSON.stringify({
        ...changed,
        scripts: { ...changed.scripts, later: 'y' },
      }),
    );
    commit(f.root, 'another unrelated script');
    const recorded = record_(f.root, [
      'docs/pkg.md',
      '--note',
      'The docs script now passes --all.',
    ]);
    expect(recorded.error).toBeUndefined();
    expect(compiled(f.root, 'docs/pkg.md').sources).toEqual([
      {
        path: 'package.json#/scripts/docs',
        digest: hash(JSON.stringify('node docs.mjs --all')),
        revision: valueSetAt,
      },
    ]);
    expect(check(f.root, strict).status).toBe(0);
  });
});

describe('the real-ledger checks keep the job event through the scrub (#2922)', () => {
  const PROBE = 'scripts/__tests__/docs-freshness-job-env.probe.test.ts';
  const ROOT = resolve(scripts, '..');
  it.each([
    [
      'pull_request_target',
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request_target',
        STATION_CI_FAST_BASE: 'b'.repeat(40),
      },
      'blocks',
    ],
    [
      'pull_request',
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
      'blocks',
    ],
    [
      'merge_group',
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' },
      'advisory',
    ],
    ['a plain local run', {}, 'blocks'],
  ] as const)('%s', { timeout: 150_000 }, (_event, pins, expected) => {
    const report = join(makeTempDir('station-freshness-probe-'), 'report.json');
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/vitest/vitest.mjs'),
        'run',
        PROBE,
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: pinnedFreshnessEnv({
          ...pins,
          STATION_FRESHNESS_PROBE_EXPECT: expected,
        }),
        timeout: 140_000,
        windowsHide: true,
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    const failures = parsed.testResults.flatMap(
      (suite: {
        assertionResults: { status: string; failureMessages: string[] }[];
      }) =>
        suite.assertionResults
          .filter((assertion) => assertion.status !== 'passed')
          .map((assertion) =>
            assertion.failureMessages.join('\n').slice(0, 400),
          ),
    );
    expect(failures).toEqual([]);
    expect(result.status, output.slice(-2000)).toBe(0);
    // The probe ran: a filtered or skipped probe also exits 0.
    expect(parsed.numPassedTests).toBe(1);
  });
});

describe('Nightly freshness sweep (#2923)', () => {
  const stale = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `docs/page-${index}.md`,
      reviewedRevisions: { 'package.json': 'b'.repeat(40) },
      changedInputs: ['package.json'],
    }));
  const report = (count: number) =>
    buildFreshnessReport({
      revision: 'c'.repeat(40),
      generatedAt: '2026-09-28T00:00:00.000Z',
      staleReviews: stale(count),
      staleCaptures: [],
      removedDependencies: [],
      unmappedCount: 0,
    });

  it('keeps the issue body under the GitHub limit and says what it omitted', () => {
    const large = report(2000);
    expect(large.staleCount).toBe(2000);
    expect(large.body.length).toBeLessThanOrEqual(SWEEP_BODY_LIMIT);
    expect(large.body).toMatch(/_\d+ more entries omitted/);
    expect(report(1).body).toContain(
      '- [ ] review `docs/page-0.md`: `package.json` (reviewed bbbbbbbbbbbb)',
    );
  });

  it('creates, updates, reopens and closes one tracking issue', () => {
    const root = makeTempDir('station-doc-sweep-');
    const reportPath = join(root, 'report.md');
    const calls: string[][] = [];
    const gh = (existing: string) => (args: string[]) => {
      calls.push(args);
      return args.includes('GET') ? existing : '7';
    };
    writeFileSync(reportPath, report(2).body);
    expect(
      upsertFreshnessIssue({ repo: 'owner/repo', reportPath, gh: gh('') }),
    ).toEqual({ action: 'created', number: 7 });
    // Looked up by its stable title, so a removed label cannot fork it.
    const lookup = calls[0];
    expect(lookup).toContain('search/issues');
    expect(lookup).toContain(
      `q=repo:owner/repo is:issue in:title "${SWEEP_ISSUE_TITLE}"`,
    );
    expect(lookup.join(' ')).not.toContain('labels=');
    expect(lookup.join(' ')).toContain(
      `.title == ${JSON.stringify(SWEEP_ISSUE_TITLE)}`,
    );
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining([
        'POST',
        `title=${SWEEP_ISSUE_TITLE}`,
        'labels[]=documentation',
      ]),
    );
    expect(
      upsertFreshnessIssue({ repo: 'owner/repo', reportPath, gh: gh('9\n4') }),
    ).toEqual({ action: 'updated', number: 4 });
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining([
        'PATCH',
        'repos/owner/repo/issues/4',
        'state=open',
      ]),
    );
    writeFileSync(reportPath, report(0).body);
    expect(
      upsertFreshnessIssue({ repo: 'owner/repo', reportPath, gh: gh('4') }),
    ).toEqual({ action: 'closed', number: 4 });
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['state=closed']));
    calls.length = 0;
    expect(
      upsertFreshnessIssue({ repo: 'owner/repo', reportPath, gh: gh('') }),
    ).toEqual({ action: 'none' });
    expect(calls).toHaveLength(1);
    expect(() =>
      upsertFreshnessIssue({ repo: '--bad', reportPath, gh: gh('') }),
    ).toThrow('--repo must be owner/name');
  });

  it('runs on a schedule with read-only contents and issue writes on the sweep job alone', () => {
    const workflow = parse(
      readFileSync(
        resolve(scripts, '../.github/workflows/docs-freshness-sweep.yml'),
        'utf8',
      ),
    );
    expect(Object.keys(workflow.on)).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['sweep']);
    expect(workflow.jobs.sweep.if).toBeUndefined();
    expect(workflow.jobs.sweep.permissions).toEqual({
      contents: 'read',
      issues: 'write',
    });
    const text = JSON.stringify(workflow);
    expect(text).not.toMatch(/secrets\./);
    expect(workflow.jobs.sweep.steps[0].with['persist-credentials']).toBe(
      false,
    );
  });
});
