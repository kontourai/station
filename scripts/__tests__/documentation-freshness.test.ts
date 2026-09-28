import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  forbidAmbientFreshnessMode,
  LEAKED_FRESHNESS_MODE,
  pinnedFreshnessEnv,
} from './helpers/freshness-env.js';

const makeTempDir = trackTempDirs();
const scripts = resolve(import.meta.dirname, '..');
const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=',
  'base64',
);
const LEDGER = 'docs/learn/review-ledger.json';
const MEDIA = 'docs/learn/media.json';

// Fixture Git commands must not inherit this checkout's Git location.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
// Every check below pins its mode; an unpinned read throws (#2934).
forbidAmbientFreshnessMode();

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    env: baseEnv,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function commit(root: string, message: string) {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    message,
  ]);
}

function record(path: string, sources: [string, string][], doc: string) {
  return {
    path,
    documentDigest: hash(doc),
    sourceRevision: 'a'.repeat(40),
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

/** A main branch whose three records and one capture are fresh. */
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
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/ui.ts': 'export const ui = 1;\n',
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  write('docs/learn/media/task.png', image);
  const mediaText = `${JSON.stringify(
    {
      version: 1,
      captures: [
        {
          path: 'docs/learn/media/task.png',
          kind: 'image',
          digest: hash(image),
          alt: 'A task',
          caption: 'A task.',
          scenario: 'Task → detail',
          evidence: 'Fixture capture.',
          capturedRevision: 'a'.repeat(40),
          reviewedRevision: 'a'.repeat(40),
          documents: ['docs/a.md'],
          sources: [{ path: 'src/ui.ts', digest: hash(files['src/ui.ts']) }],
        },
      ],
    },
    null,
    2,
  ).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`;
  write(MEDIA, mediaText);
  write(
    LEDGER,
    `${JSON.stringify(
      {
        version: 1,
        records: [
          record(
            'docs/a.md',
            [['src/a.ts', files['src/a.ts']]],
            files['docs/a.md'],
          ),
          record(
            'docs/b.md',
            [['src/b.ts', files['src/b.ts']]],
            files['docs/b.md'],
          ),
          record(
            'docs/c.md',
            [['docs/a.md', files['docs/a.md']]],
            files['docs/c.md'],
          ),
          // A page that cites the capture manifest itself.
          record('docs/d.md', [[MEDIA, mediaText]], files['docs/d.md']),
        ],
      },
      null,
      2,
    )}\n`,
  );
  git(root, ['init', '-q', '-b', 'main']);
  if (commitIt) commit(root, 'fresh main');
  return {
    root,
    write,
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
  };
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
const check = (root: string, env: Record<string, string>) =>
  run(root, 'check-documentation-freshness.mjs', [], env);
const record_ = (root: string, args: string[]) =>
  run(root, 'record-documentation-review.mjs', args);
const scoped = { STATION_DOCS_FRESHNESS_BASE: 'main' };
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
    commit(f.root, 'change a source');
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
    const a = JSON.parse(f.read(LEDGER)).records[0];
    expect(a.sourceRevision).toBe(git(f.root, ['rev-parse', 'HEAD']));
    expect(a.checks.at(-1)).toBe('Checked the new value.');
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
      git(f.root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'merge',
        '-q',
        '--no-edit',
        second,
      ]);
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
    git(f.root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'merge',
      '-q',
      '--no-edit',
      'h',
    ]);
    const queued = check(f.root, queue);
    expect(queued.stderr).toContain('review docs/b.md; changed: src/a.ts');
    expect(queued.stderr).not.toContain('Invalid review source');
    expect(queued.status).toBe(0);
    // Strict still refuses it, and so does a PR whose own diff causes it.
    expect(check(f.root, { STATION_DOCS_FRESHNESS: 'strict' }).status).toBe(1);
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
    const ledger = JSON.parse(f.read(LEDGER));
    ledger.records[1].sources[0].digest = 'f'.repeat(64);
    f.write(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
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

  it('applies the same scope to learning captures, which the record command refreshes', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'ui']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    commit(f.root, 'change captured UI');
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
    expect(recorded.status).toBe(0);
    // The command rewrote media.json, so the page citing it is a dependent.
    expect(recorded.stdout).toContain(
      'docs/d.md; changed: docs/learn/media.json',
    );
    const dependent = check(f.root, scoped);
    expect(dependent.status).toBe(1);
    expect(dependent.stderr).toContain(
      'review docs/d.md; changed: docs/learn/media.json',
    );
    expect(
      record_(f.root, ['docs/d.md', '--note', 'Manifest delta reviewed.'])
        .status,
    ).toBe(0);
    expect(check(f.root, scoped).status).toBe(0);
    const capture = JSON.parse(f.read(MEDIA)).captures[0];
    expect(capture.reviewedRevision).toBe(git(f.root, ['rev-parse', 'HEAD']));
    expect(capture.capturedRevision).toBe('a'.repeat(40));
    expect(capture.reviewNotes).toEqual([
      'The change does not alter the captured pixels.',
    ]);
    // Only the refreshed lines change; the escaped arrow stays escaped.
    expect(f.read(MEDIA)).toContain('Task \\u2192 detail');
    expect(before).toContain('Task \\u2192 detail');
  });

  it('digests a review citing media.json over the manifest bytes the same batch writes', () => {
    const f = fixture();
    git(f.root, ['switch', '-qc', 'ui']);
    f.write('src/ui.ts', 'export const ui = 2;\n');
    commit(f.root, 'change captured UI');
    const batch = join(f.root, 'batch.json');
    writeFileSync(
      batch,
      JSON.stringify([
        { path: 'docs/d.md', note: 'Manifest delta reviewed.' },
        { path: 'docs/learn/media/task.png', note: 'Pixels unchanged.' },
      ]),
    );
    const result = record_(f.root, ['--batch', batch]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Still stale');
    expect(check(f.root, { STATION_DOCS_FRESHNESS: 'strict' }).status).toBe(0);
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
});

describe('docs:review:record (#2924)', () => {
  it('binds the review to HEAD, recomputes digests, keeps unrelated lines and reports dependents', () => {
    const f = fixture();
    f.write('docs/a.md', '# A, revised\n');
    const before = f.read(LEDGER);
    const result = record_(f.root, [
      'docs/a.md',
      '--note',
      'Re-read the page.',
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const after = f.read(LEDGER);
    const ledger = JSON.parse(after);
    expect(ledger.records[0]).toMatchObject({
      documentDigest: hash('# A, revised\n'),
      sourceRevision: git(f.root, ['rev-parse', 'HEAD']),
    });
    // Only record A's lines changed: document digest, revision, the previous
    // last check (which gains a comma) and the new note.
    const changed = after
      .split('\n')
      .filter((line) => !before.split('\n').includes(line));
    expect(changed).toEqual([
      `      "documentDigest": "${hash('# A, revised\n')}",`,
      `      "sourceRevision": "${git(f.root, ['rev-parse', 'HEAD'])}",`,
      '        "Fixture evidence.",',
      '        "Re-read the page."',
    ]);
    // docs/c.md cites docs/a.md, whose accepted bytes just changed.
    expect(result.stdout).toContain('docs/c.md; changed: docs/a.md');
    expect(
      check(f.root, { STATION_DOCS_FRESHNESS: 'strict' }).stderr,
    ).toContain('review docs/c.md');
  });

  it('refuses an empty note, an unknown path, an invalid revision and a bad drop without writing', () => {
    const f = fixture();
    f.write('src/a.ts', 'export const a = 2;\n');
    const before = f.read(LEDGER);
    f.write('src/untracked.ts', 'export const u = 1;\n');
    for (const [args, reason] of [
      [['docs/a.md', '--note', '   '], 'Review note is empty: docs/a.md'],
      [['docs/a.md'], 'Review note is empty: docs/a.md'],
      [
        ['docs/missing.md', '--note', 'Reviewed.'],
        'No review record or capture for docs/missing.md',
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
    ] as const) {
      const refused = record_(f.root, [...args]);
      expect(refused.status, args.join(' ')).toBe(1);
      expect(refused.stderr).toMatch(/^docs:review:record: /);
      expect(refused.stderr).toContain(reason);
    }
    expect(f.read(LEDGER)).toBe(before);

    const unborn = fixture({ commitIt: false });
    git(unborn.root, ['add', '-A']);
    const noHead = record_(unborn.root, ['docs/a.md', '--note', 'Reviewed.']);
    expect(noHead.status).toBe(1);
    expect(noHead.stderr).toContain('Cannot bind the review to HEAD');
  });

  it('applies a batch atomically and drops removed sources', () => {
    const f = fixture();
    f.write('src/a.ts', 'export const a = 2;\n');
    f.write('src/b.ts', 'export const b = 2;\n');
    const before = f.read(LEDGER);
    const batch = join(f.root, 'batch.json');
    writeFileSync(
      batch,
      JSON.stringify([
        { path: 'docs/a.md', note: 'Checked a.' },
        { path: 'docs/b.md', note: '' },
      ]),
    );
    expect(record_(f.root, ['--batch', batch]).status).toBe(1);
    expect(f.read(LEDGER)).toBe(before);
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
    const ledger = JSON.parse(before);
    ledger.records[2].state = 'classified';
    f.write(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
    const result = record_(f.root, ['--batch', batch]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(f.read(LEDGER)).records[2].sources).toEqual([]);
    const added = record_(f.root, [
      'docs/b.md',
      '--note',
      'B also reads the UI constant.',
      '--add-source',
      'src/ui.ts',
    ]);
    expect(added.status).toBe(0);
    expect(JSON.parse(f.read(LEDGER)).records[1].sources).toEqual([
      { path: 'src/b.ts', digest: hash('export const b = 2;\n') },
      { path: 'src/ui.ts', digest: hash('export const ui = 1;\n') },
    ]);
    expect(check(f.root, { STATION_DOCS_FRESHNESS: 'strict' }).status).toBe(0);
  });
});

describe('Nightly freshness sweep (#2923)', () => {
  const stale = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `docs/page-${index}.md`,
      reviewSourceRevision: 'b'.repeat(40),
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
    expect(report(1).body).toContain('review `docs/page-0.md`');
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
