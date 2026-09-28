import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
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
  serializeRecordFile,
} from '../lib/review-ledger-store.mjs';
import {
  forbidAmbientFreshnessMode,
  LEAKED_FRESHNESS_MODE,
  pinnedFreshnessEnv,
} from './helpers/freshness-env.js';
import {
  type FixtureRecord,
  writeLearningMedia,
  writeReviewLedger,
} from './helpers/review-ledger-fixture.js';

const makeTempDir = trackTempDirs();
const scripts = resolve(import.meta.dirname, '..');
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=',
  'base64',
);
const MEDIA = 'docs/learn/media.json';

// Every check below pins its mode; an unpinned read throws (#2934).
forbidAmbientFreshnessMode();

/**
 * Fixture Git commands must not inherit this checkout's Git location. Built at
 * call time, after the ambient mode is stubbed, so reusing it for a spawned
 * check leaks the forbidden mode and fails on every host.
 */
const gitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

const identity = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'core.hooksPath=/dev/null',
];

function commit(root: string, message: string) {
  git(root, ['add', '-A']);
  git(root, [...identity, 'commit', '-qm', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** `git merge` with the default driver and no custom configuration. */
function merge(root: string, ref: string) {
  return spawnSync('git', [...identity, 'merge', '--no-edit', ref], {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function record(
  path: string,
  sources: [string, string][],
  doc: string,
): FixtureRecord {
  return {
    path,
    documentDigest: hash(doc),
    kind: 'current',
    state: 'source-reviewed',
    summary: 'Checked the caller.',
    limits: 'Fixture review only.',
    sources: sources.map(([source, text]) => ({
      path: source,
      digest: hash(text),
    })),
    checks: ['Fixture evidence.'],
  };
}

// src/c.ts and src/d.ts are cited only by docs/map.md, a shared page like the
// module map. src/c.ts has room between its lines, so edits at either end
// merge cleanly as source while their reviews must still meet.
const SHARED_C =
  'export const c1 = 1;\n// one\n// two\n// three\nexport const c2 = 1;\n';

/** A main branch whose records and one capture are fresh and verifiable. */
function fixture({ commitIt = true } = {}) {
  const root = makeTempDir('station-doc-freshness-');
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const files: Record<string, string> = {
    'docs/a.md': '# A\n',
    'docs/b.md': '# B\n',
    'docs/c.md': '# C cites A\n',
    'docs/d.md': '# D cites the capture manifest\n',
    'docs/map.md': '# Map cites C and D\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': SHARED_C,
    'src/d.ts': 'export const d = 1;\n',
    'src/ui.ts': 'export const ui = 1;\n',
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  write('docs/learn/media/task.png', image);
  const capture = {
    path: 'docs/learn/media/task.png',
    kind: 'image',
    digest: hash(image),
    alt: 'A task',
    caption: 'A task.',
    scenario: 'Task → detail',
    evidence: 'Fixture capture.',
    capturedRevision: 'a'.repeat(40),
    documents: ['docs/a.md'],
    sources: [{ path: 'src/ui.ts', digest: hash(files['src/ui.ts']) }],
  };
  const mediaText = writeLearningMedia(root, [capture]);
  const records = [
    record('docs/a.md', [['src/a.ts', files['src/a.ts']]], files['docs/a.md']),
    record('docs/b.md', [['src/b.ts', files['src/b.ts']]], files['docs/b.md']),
    record(
      'docs/c.md',
      [['docs/a.md', files['docs/a.md']]],
      files['docs/c.md'],
    ),
    // A page that cites the capture manifest itself.
    record('docs/d.md', [[MEDIA, mediaText]], files['docs/d.md']),
    record(
      'docs/map.md',
      [
        ['src/c.ts', files['src/c.ts']],
        ['src/d.ts', files['src/d.ts']],
      ],
      files['docs/map.md'],
    ),
  ];
  git(root, ['init', '-q', '-b', 'main']);
  if (!commitIt) {
    writeReviewLedger(root, records);
    return {
      root,
      write,
      read: (p: string) => readFileSync(join(root, p), 'utf8'),
    };
  }
  // Bind every record to the commit that holds its reviewed bytes, exactly as
  // the record command does.
  const content = commit(root, 'content');
  writeReviewLedger(
    root,
    records.map((entry) => ({ ...entry, documentRevision: content })),
  );
  writeLearningMedia(root, [capture], content);
  commit(root, 'fresh main');
  return {
    root,
    content,
    write,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
}

function compiled(root: string, path: string) {
  const found = readReviewState(root).ledger.records.find(
    (entry: { path: string }) => entry.path === path,
  );
  if (!found) throw new Error(`No compiled review record: ${path}`);
  return found;
}

function compiledMedia(root: string) {
  const { media } = readReviewState(root);
  if (!media) throw new Error('No compiled capture manifest');
  return media;
}

/** Hand-edit one record file, keeping the canonical layout. */
function editRecord(root: string, path: string, edit: (data: any) => void) {
  const file = join(root, recordFile(path));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  edit(data);
  writeFileSync(file, serializeRecordFile(data));
}

const notesFiles = (root: string) => {
  try {
    return readdirSync(join(root, REVIEW_LEDGER_DIR, 'notes')).sort();
  } catch {
    return [];
  }
};

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
const check = (root: string, env: Record<string, string>) =>
  run(root, 'check-documentation-freshness.mjs', [], env);
const record_ = (root: string, args: string[]) =>
  run(root, 'record-documentation-review.mjs', args);
const scoped = { STATION_DOCS_FRESHNESS_BASE: 'main' };
const strict = { STATION_DOCS_FRESHNESS: 'strict' };
const queue = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' };
const pullRequest = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'pull_request_target',
  STATION_CI_FAST_BASE: 'main',
};

describe('scoped documentation freshness (#2923)', () => {
  it('fails a PR that stales its own record without re-review, and passes once it records the review', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'pr-a']);
    f.write('src/a.ts', 'export const a = 2;\n');
    const changedAt = commit(f.root, 'change a source');
    for (const env of [scoped, pullRequest]) {
      const refused = check(f.root, env);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('review docs/a.md; changed: src/a.ts');
      expect(refused.stderr).not.toContain('docs/b.md');
    }
    const recorded = record_(f.root, [
      'docs/a.md',
      '--note',
      'Checked the new value.',
    ]);
    expect(recorded.stderr).toBe('');
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
    expect(result.stderr).toContain('advisory');
    expect(result.stderr).toContain('review docs/b.md; changed: src/b.ts');
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
    expect(y.stderr).toContain('docs/b.md');
    expect(y.stderr).not.toContain('docs/a.md');
    // Synthesized queue candidates: y lands first, then x on top, and the
    // reverse order. Both stale records are present in each candidate.
    for (const [first, second] of [
      ['y', 'x'],
      ['x', 'y'],
    ]) {
      git(f.root, ['switch', '-qC', `candidate-${first}-${second}`, first]);
      expect(merge(f.root, second).status).toBe(0);
      const candidate = check(f.root, queue);
      expect(candidate.stderr).toContain('review docs/a.md; changed: src/a.ts');
      expect(candidate.stderr).toContain('review docs/b.md; changed: src/b.ts');
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
    expect(queued.stderr).toContain('review docs/b.md; changed: src/a.ts');
    expect(queued.stderr).not.toContain('Invalid review source');
    expect(queued.status).toBe(0);
    // Strict still refuses it, and so does a PR whose own diff causes it.
    expect(check(f.root, strict).status).toBe(1);
    git(f.root, ['switch', '-qc', 'own-delete', 'h']);
    git(f.root, ['rm', '-q', 'src/a.ts']);
    commit(f.root, 'delete a cited source without re-review');
    const own = check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'h' });
    expect(own.status).toBe(1);
    expect(own.stderr).toContain('review docs/b.md; changed: src/a.ts');
  });

  it('treats a hand-edited record as in scope even when its bytes are untouched', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'edit-record']);
    editRecord(f.root, 'docs/b.md', (data) => {
      data.sources[0].digest = 'f'.repeat(64);
    });
    const result = check(f.root, scoped);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('review docs/b.md; changed: src/b.ts');
  });

  it('fails closed when the change scope cannot be computed', () => {
    const f = fixture();
    f.write('src/b.ts', 'export const b = 2;\n');
    commit(f.root, 'stale B on the only branch');
    const result = check(f.root, {
      STATION_DOCS_FRESHNESS_BASE: 'no-such-ref',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('strict: cannot compute');
    expect(result.stderr).toContain('docs/b.md');
    expect(check(f.root, { STATION_DOCS_FRESHNESS: 'bogus' }).status).toBe(1);
  });

  it('applies the same scope to learning captures, whose review no longer rewrites media.json', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'ui']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    const changedAt = commit(f.root, 'change captured UI');
    const refused = check(f.root, scoped);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'capture docs/learn/media/task.png; changed: src/ui.ts',
    );
    expect(check(f.root, queue).status).toBe(0);
    const before = f.read(MEDIA);
    const recorded = record_(f.root, [
      'docs/learn/media/task.png',
      '--note',
      'The change does not alter the captured pixels.',
    ]);
    expect(recorded.stderr).toBe('');
    expect(recorded.status).toBe(0);
    // #2936: the capture review lives in the ledger directory, so recording
    // it leaves media.json and every page citing it untouched.
    expect(f.read(MEDIA)).toBe(before);
    expect(recorded.stdout).not.toContain('Still stale');
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
    expect(check(f.root, queue).stderr).not.toContain('docs/map.md');
    const escaped = check(f.root, scoped);
    expect(escaped.status).toBe(1);
    expect(escaped.stderr).toContain(
      'review docs/map.md; dropped cited sources this change modifies without a review note: src/c.ts',
    );
    // The record command's drop writes the note the rule asks for.
    git(f.root, ['checkout', '--', REVIEW_LEDGER_DIR]);
    const dropped = record_(f.root, [
      'docs/map.md',
      '--note',
      'src/c.ts no longer supports this page.',
      '--drop-source',
      'src/c.ts',
    ]);
    expect(dropped.stderr).toBe('');
    expect(dropped.status).toBe(0);
    expect(check(f.root, scoped).status).toBe(0);
    // Deleting the whole record while its page remains is refused outright.
    commit(f.root, 'record the drop');
    rmSync(join(f.root, recordFile('docs/map.md')));
    const removed = check(f.root, scoped);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(
      'review docs/map.md; record removed while this change modifies its cited sources: src/c.ts',
    );
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
    expect(result.stderr).toBe('');
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
    expect(result.stdout).toContain(
      `in ${REVIEW_LEDGER_DIR}/notes/${notesFiles(f.root)[0]}`,
    );
    // docs/c.md cites docs/a.md, whose accepted bytes just changed.
    expect(result.stdout).toContain('docs/c.md; changed: docs/a.md');
    expect(check(f.root, strict).stderr).toContain('review docs/c.md');
  });

  it('refuses an empty note, an unknown path, fresh or uncommitted bytes and bad source edits without writing', () => {
    const f = fixture();
    f.write('src/untracked.ts', 'export const u = 1;\n');
    const before = f.read(recordFile('docs/a.md'));
    for (const [args, reason] of [
      [['docs/a.md', '--note', '   '], 'Review note is empty: docs/a.md'],
      [['docs/a.md'], 'Review note is empty: docs/a.md'],
      [
        ['docs/missing.md', '--note', 'Reviewed.'],
        'No review record or capture for docs/missing.md',
      ],
      // (a) Nothing changed since the recorded review.
      [
        ['docs/a.md', '--note', 'Reviewed.'],
        'Already fresh: docs/a.md; its recorded bytes are unchanged. Pass --rereview',
      ],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--drop-source', 'src/nope.ts'],
        'Not a recorded source of docs/a.md: src/nope.ts',
      ],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--add-source', 'src/a.ts'],
        'Already a recorded source of docs/a.md: src/a.ts',
      ],
      [
        [
          'docs/a.md',
          '--note',
          'Reviewed.',
          '--add-source',
          'src/untracked.ts',
        ],
        'Recorded source is not tracked: docs/a.md -> src/untracked.ts',
      ],
      [['docs/a.md', '--note', '--drop-source'], '--note requires a value'],
      [
        ['docs/a.md', '--note', 'Reviewed.', '--drop-source', '--note'],
        '--drop-source requires a value',
      ],
      [
        ['--show-delta', 'docs/a.md', '--note', 'Reviewed.'],
        '--show-delta reads the ledger and records nothing',
      ],
    ] as const) {
      const refused = record_(f.root, [...args]);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(/^docs:review:record: /);
      expect(refused.stderr).toContain(reason);
    }
    // A review binds a commit that contains the reviewed bytes.
    f.write('src/a.ts', 'export const a = 2;\n');
    const uncommitted = record_(f.root, ['docs/a.md', '--note', 'Reviewed.']);
    expect(uncommitted.status).toBe(1);
    expect(uncommitted.stderr).toContain(
      'Reviewed bytes are not committed: src/a.ts',
    );
    expect(f.read(recordFile('docs/a.md'))).toBe(before);
    expect(notesFiles(f.root)).toEqual([]);

    const unborn = fixture({ commitIt: false });
    git(unborn.root, ['add', '-A']);
    const noHead = record_(unborn.root, ['docs/a.md', '--note', 'Reviewed.']);
    expect(noHead.status).toBe(1);
    expect(noHead.stderr).toContain('Cannot bind the review to HEAD');
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
    expect(result.stderr).toBe('');
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
    expect(result.stderr).toBe('');
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
      compiled(f.root, 'docs/b.md').sources.map(
        ({ path, digest }: { path: string; digest: string }) => ({
          path,
          digest,
        }),
      ),
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
    expect(delta.stderr).toBe('');
    expect(delta.status).toBe(0);
    expect(delta.stdout).toContain(
      `== review docs/a.md: git diff ${f.content} HEAD -- src/a.ts`,
    );
    expect(delta.stdout).toContain('-export const a = 1;');
    expect(delta.stdout).toContain('+export const a = 2;');
    expect(delta.stdout).toContain('review docs/b.md is fresh.');
    // Without paths it covers every stale entry and writes nothing.
    const all = record_(f.root, ['--show-delta']);
    expect(all.stdout).toContain('== review docs/a.md');
    expect(all.stdout).not.toContain('docs/b.md');
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
    expect(flagged.stdout).toContain(
      `review docs/a.md -> src/a.ts @ ${f.content}: the revision holds different bytes`,
    );
    expect(
      record_(f.root, ['docs/a.md', '--note', 'Reviewed.']).stderr,
    ).toContain('Already fresh: docs/a.md');
    const rebound = record_(f.root, [
      'docs/a.md',
      '--note',
      'Re-reviewed the merged record.',
      '--rereview',
    ]);
    expect(rebound.status).toBe(0);
    expect(rebound.stdout).toContain(
      'rebound to a revision that contains its bytes: src/a.ts',
    );
    expect(compiled(f.root, 'docs/a.md').sources[0].revision).toBe(changedAt);
    expect(record_(f.root, ['--verify-bindings']).status).toBe(0);
  });
});

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
    expect(recorded.stderr).toBe('');
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
      expect(merged.status, `${first} + ${second}: ${merged.stdout}`).toBe(0);
      expect(merged.stdout).not.toContain('CONFLICT');
      expect(check(f.root, strict).status).toBe(0);
    }
    git(f.root, ['switch', '-qC', 'm-all', 'a']);
    expect(merge(f.root, 'b').status).toBe(0);
    expect(merge(f.root, 'c').status).toBe(0);
    const result = check(f.root, strict);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // Both reviews and both bindings survive the merge.
    const map = compiled(f.root, 'docs/map.md');
    expect(map.checks.slice(-2).sort()).toEqual([
      'a reviewed docs/map.md.',
      'b reviewed docs/map.md.',
    ]);
    expect(map.sources.map(({ digest }: { digest: string }) => digest)).toEqual(
      [
        hash(SHARED_C.replace('c1 = 1', 'c1 = 2')),
        hash('export const d = 2;\n'),
      ],
    );
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
    expect(merged.stdout).toContain(
      `CONFLICT (content): Merge conflict in ${recordFile('docs/map.md')}`,
    );
    expect(merged.stdout).not.toContain('Merge conflict in src/c.ts');
    // Taking one side's record leaves a review of bytes nobody reviewed,
    // which this change's own scoped check refuses.
    git(f.root, ['checkout', '--theirs', '--', recordFile('docs/map.md')]);
    commit(f.root, 'resolve by taking one side');
    const resolved = check(f.root, { STATION_DOCS_FRESHNESS_BASE: 'main' });
    expect(resolved.status).toBe(1);
    expect(resolved.stderr).toContain('review docs/map.md; changed: src/c.ts');
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
    for (const [mutate, reason] of [
      [
        () =>
          writeFileSync(
            recordPath,
            `${JSON.stringify(JSON.parse(readFileSync(recordPath, 'utf8')), null, 2)}\n`,
          ),
        `Review ledger file is not in its canonical layout: ${recordFile('docs/b.md')}`,
      ],
      [
        () =>
          writeFileSync(
            noteFile,
            readFileSync(noteFile, 'utf8').replace('Once.', 'Twice.'),
          ),
        'Review notes are append-only',
      ],
      [
        () =>
          writeFileSync(join(f.root, REVIEW_LEDGER_DIR, 'stray.json'), '{}\n'),
        `Unexpected file in the review ledger: ${REVIEW_LEDGER_DIR}/stray.json`,
      ],
    ] as const) {
      mutate();
      const refused = check(f.root, strict);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(reason);
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
    // Rebuild the pre-#2936 layout from the same reviews.
    const legacyLedger = {
      version: 1,
      records: current.ledger.records.map((entry: any) => ({
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
    };
    const legacyMedia = {
      version: 1,
      captures: current.media.captures.map(
        ({ sources, reviewNotes: _r, notes: _n, ...metadata }: any) => ({
          ...metadata,
          reviewedRevision: sources[0].revision,
          sources: sources.map(({ path, digest }: any) => ({ path, digest })),
        }),
      ),
    };
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
    expect(migrated.stderr).toContain('advisory');
    expect(migrated.stderr).toContain('review docs/b.md; changed: src/b.ts');
    expect(migrated.status).toBe(0);
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
