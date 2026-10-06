import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { renderLedgerMarkdown } from '../deploy-ledger.mjs';
import {
  collectDocumentationChanges,
  documentationCatchUp,
  documentationImpact,
  formatDocumentationImpact,
  readDocumentationImpact,
} from '../documentation-impact.mjs';
import {
  listReviewLedgerFiles,
  parseRecordFile,
  REVIEW_LEDGER_INDEX,
  readReviewStateAt,
  recordFile,
  serializeRecordFile,
} from '../lib/review-ledger-store.mjs';
import { forbidAmbientFreshnessMode } from './helpers/freshness-env.js';
import { writeReviewLedger } from './helpers/review-ledger-fixture.js';

const makeTempDir = trackTempDirs();
// Impact and catch-up must not depend on the freshness mode (#2934).
forbidAmbientFreshnessMode();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ledger = (records: unknown[]) => ({ version: 2, records });
const record = (path: string, sources: string[]) => ({
  path,
  kind: 'current',
  state: 'source-reviewed',
  summary: 'Checked caller.',
  limits: 'Fixture source review only.',
  checks: ['Fixture evidence.'],
  sources: sources.map((path) => ({ path })),
});
/** Every ledger file's bytes, so a test can prove the report edited none. */
const ledgerFiles = (root: string) =>
  Object.fromEntries(
    listReviewLedgerFiles(root).map((file: string) => [
      file,
      readFileSync(join(root, file), 'utf8'),
    ]),
  );
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    env: cleanEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
}
function fixture() {
  const root = makeTempDir('station-doc-impact-');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('code.ts', 'export const value = 1;\n');
  write('guide.md', '# Guide\n');
  write('docs/reference/station-docs.md', '# Manual\n\n## Start\nRead this.\n');
  write(
    'docs/architecture/module-map.md',
    '# Modules\n\n## Owner\nOwns the behavior.\n',
  );
  write(
    'docs/learn/mcp-topics.json',
    JSON.stringify({
      version: 1,
      source: 'docs/reference/station-docs.md',
      topics: [
        {
          id: 'start',
          section: 'Start',
          title: 'Start',
          summary: 'Read.',
          tags: [],
        },
      ],
    }),
  );
  write(
    'docs/learn/atlas.json',
    JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'work',
          title: 'Work',
          summary: 'Work.',
          docs: ['guide.md'],
          modules: ['Owner'],
          questions: ['Why?'],
        },
      ],
    }),
  );
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'fixture baseline',
  ]);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  const records = [
    {
      ...record('guide.md', ['code.ts']),
      documentRevision: base,
      documentDigest: hash('# Guide\n'),
      sources: [{ path: 'code.ts', digest: hash('export const value = 1;\n') }],
    },
  ];
  writeReviewLedger(root, records, { coverageBaseline: base });
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'record review',
  ]);
  return { root, write, base, records };
}

function generatedFixture() {
  const f = fixture();
  const markdownPath = 'docs/reference/deploy-ledger.md';
  const dataPath = 'docs/reference/deploy-ledger.json';
  const owners = [
    'scripts/deploy-ledger.mjs',
    'scripts/lib/documentation-review.mjs',
  ];
  const markdown = renderLedgerMarkdown({
    entries: [],
    githubRepo: 'kontourai/station',
  });
  f.write(markdownPath, markdown);
  f.write(dataPath, '[]\n');
  for (const owner of owners) f.write(owner, readFileSync(owner, 'utf8'));
  const generated = {
    ...record(markdownPath, []),
    kind: 'generated',
    documentRevision: f.base,
    documentDigest: hash(markdown),
    sources: [dataPath, ...owners].map((path) => ({
      path,
      digest: hash(readFileSync(join(f.root, path), 'utf8')),
    })),
  };
  writeReviewLedger(f.root, [...f.records, generated], {
    coverageBaseline: f.base,
  });
  git(f.root, ['add', '.']);
  git(f.root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'generated review',
  ]);
  const entry = {
    timestampUtc: '2026-08-20T09:00:00Z',
    channel: 'nightly-android',
    version: '0.1.2-nightly.2431',
    sha: 'a'.repeat(40),
    workflowRunUrl: null,
    artifacts: ['fixture artifact, not a release observation'],
    gateResult: 'fixture gate claim',
    notes: null,
  };
  const update = () => {
    f.write(dataPath, JSON.stringify([entry]));
    f.write(
      markdownPath,
      renderLedgerMarkdown({
        entries: [entry],
        githubRepo: 'kontourai/station',
      }),
    );
  };
  return { ...f, generated, markdownPath, dataPath, owners, update };
}

function catchUpCli(root: string) {
  return spawnSync(
    process.execPath,
    [resolve('scripts/documentation-impact.mjs'), '--catch-up', '--json'],
    { cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true },
  );
}

describe('documentation impact', () => {
  it('follows recorded dependencies through documents, terminates cycles and keeps unknown coverage explicit', () => {
    const report = documentationImpact({
      changedPaths: ['code.ts', 'new.ts'],
      ledgers: [
        ledger([
          record('guide.md', ['code.ts', 'README.md']),
          record('README.md', ['guide.md']),
        ]),
      ],
      topics: [],
    });
    expect(report.documents.map((doc) => doc.path)).toEqual([
      'guide.md',
      'README.md',
    ]);
    expect(
      report.documents.every((doc) => doc.changedBy.includes('code.ts')),
    ).toBe(true);
    expect(report.unmappedPaths).toEqual(['new.ts']);
  });
  it('retains removed baseline dependencies and selects exact generated topic inputs', () => {
    const report = documentationImpact({
      changedPaths: ['old.ts'],
      ledgers: [
        ledger([record('docs/architecture/module-map.md', ['old.ts'])]),
        ledger([]),
      ],
      topics: [
        {
          id: 'architecture-owner',
          sourcePath: 'docs/architecture/module-map.md',
        },
        { id: 'manual', sourcePath: 'manual.md' },
      ],
    });
    expect(report.documents[0].path).toBe('docs/architecture/module-map.md');
    expect(report.mcpTopics.map((topic) => topic.id)).toEqual([
      'architecture-owner',
    ]);
    expect(report.actions.join('\n')).toContain('docs:mcp:generate');
  });
  it('rejects malformed dependency metadata rather than reporting no impact', () => {
    expect(() =>
      documentationImpact({
        changedPaths: ['x'],
        ledgers: [{ version: 2, records: [{}] }],
        topics: [],
      }),
    ).toThrow('Invalid documentation impact');
  });
  it('collects branch, staged, unstaged, untracked and both sides of renames in a real checkout', () => {
    const { root, write, base } = fixture();
    git(root, ['mv', 'code.ts', 'renamed.ts']);
    write('guide.md', '# Changed\n');
    write('new.ts', 'new');
    const selected = collectDocumentationChanges(root, base);
    expect(selected.paths).toEqual(
      expect.arrayContaining([
        'code.ts',
        'renamed.ts',
        'guide.md',
        'new.ts',
        recordFile('guide.md'),
      ]),
    );
    expect(() => collectDocumentationChanges(root, 'missing-base')).toThrow();
  });
  it('catches source-only drift since review, distinguishes edit and review commits, then accepts exact restoration', async () => {
    const { root, write, base } = fixture();
    const initial = await documentationCatchUp({ root });
    expect(initial.catchUp.staleReviews).toEqual([]);
    write('code.ts', 'export const value = 2;\n');
    const changed = await documentationCatchUp({ root });
    expect(changed.catchUp.staleReviews).toEqual([
      {
        path: 'guide.md',
        reviewedRevisions: { 'code.ts': base },
        unavailableRevisions: [],
        lastCommittedEdit: base,
        changedInputs: ['code.ts'],
      },
    ]);
    expect(changed.documents.map((doc) => doc.path)).toContain('guide.md');
    write('code.ts', 'export const value = 1;\n');
    expect((await documentationCatchUp({ root })).catchUp.staleReviews).toEqual(
      [],
    );
  });
  it('keeps a deleted dependency visible and refuses unreadable metadata in the real CLI', async () => {
    const { root } = fixture();
    rmSync(join(root, 'code.ts'));
    expect(
      (await documentationCatchUp({ root })).catchUp.staleReviews[0]
        .changedInputs,
    ).toEqual(['code.ts']);
    writeFileSync(join(root, REVIEW_LEDGER_INDEX), '{broken');
    const run = spawnSync(
      process.execPath,
      [resolve('scripts/documentation-impact.mjs'), '--catch-up', '--json'],
      { cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('documentation-impact:');
    expect(run.stdout).toBe('');
  });
  it('reports removed committed review links even when the original audit baseline had no ledger', async () => {
    const { root, records, base, write } = fixture();
    writeReviewLedger(
      root,
      [{ ...records[0], state: 'classified', sources: [] }],
      { coverageBaseline: base },
    );
    write('code.ts', 'changed');
    const report = await documentationCatchUp({ root });
    expect(report.catchUp.removedDependencies).toEqual([
      { path: 'guide.md', recordRemoved: false, sourcesRemoved: ['code.ts'] },
    ]);
  });
  it.each(['canonical', 'reformatted'] as const)(
    'keeps removed %s historical dependencies through the real CLI without relaxing current records',
    (layout) => {
      const { root, records, base, write } = fixture();
      if (layout === 'reformatted') {
        const file = recordFile('guide.md');
        write(
          file,
          `${JSON.stringify(
            JSON.parse(readFileSync(join(root, file), 'utf8')),
            null,
            2,
          )}\n`,
        );
        git(root, ['add', '.']);
        git(root, [
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '-qm',
          'reformat historical record',
        ]);
        const revision = git(root, ['rev-parse', 'HEAD']).trim();
        expect(() => readReviewStateAt(root, revision)).toThrow(
          'canonical layout',
        );
      }
      write('code.ts', 'changed after review');
      writeReviewLedger(
        root,
        [{ ...records[0], state: 'classified', sources: [] }],
        { coverageBaseline: base },
      );
      git(root, ['add', '.']);
      git(root, [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'drop recorded dependency',
      ]);
      const run = spawnSync(
        process.execPath,
        [resolve('scripts/documentation-impact.mjs'), '--catch-up', '--json'],
        { cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true },
      );
      expect(run.status).toBe(0);
      const report: Awaited<ReturnType<typeof documentationCatchUp>> =
        JSON.parse(run.stdout);
      expect(report.catchUp.removedDependencies).toEqual([
        { path: 'guide.md', recordRemoved: false, sourcesRemoved: ['code.ts'] },
      ]);
      expect(report.documents.map((doc) => doc.path)).toContain('guide.md');
      const before = ledgerFiles(root);
      const file = recordFile('guide.md');
      write(
        file,
        `${JSON.stringify(
          JSON.parse(readFileSync(join(root, file), 'utf8')),
          null,
          2,
        )}\n`,
      );
      const current = catchUpCli(root);
      expect(current.status).toBe(2);
      expect(current.stderr).toContain('canonical layout');
      write(file, before[file]);
      expect(ledgerFiles(root)).toEqual(before);
    },
  );
  it.each([
    'json',
    'unknown-key',
    'source-path',
    'source-digest',
    'source-revision',
    'source-digest-array',
    'source-revision-array',
    'document-digest-array',
    'document-revision-array',
  ] as const)(
    'refuses malformed %s historical records instead of losing dependency leads',
    (corruption) => {
      const f = fixture();
      const file = recordFile('guide.md');
      const value = JSON.parse(readFileSync(join(f.root, file), 'utf8'));
      if (corruption === 'unknown-key') value.unrecognized = true;
      if (corruption === 'source-path') value.sources[0].path = '../outside.ts';
      if (corruption === 'source-digest') value.sources[0].digest = 'bad';
      if (corruption === 'source-revision') value.sources[0].revision = 'bad';
      if (corruption === 'source-digest-array')
        value.sources[0].digest = [value.sources[0].digest];
      if (corruption === 'source-revision-array')
        value.sources[0].revision = [value.sources[0].revision];
      if (corruption === 'document-digest-array')
        value.document.digest = [value.document.digest];
      if (corruption === 'document-revision-array')
        value.document.revision = [value.document.revision];
      if (corruption.endsWith('-array')) {
        const canonical = serializeRecordFile(value);
        expect(() => parseRecordFile(file, canonical)).toThrow('binding');
        expect(() =>
          parseRecordFile(file, canonical, 'advisory-dependency-history'),
        ).toThrow('binding');
      }
      f.write(
        file,
        corruption === 'json'
          ? '{broken'
          : `${JSON.stringify(value, null, 2)}\n`,
      );
      git(f.root, ['add', '.']);
      git(f.root, [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'malformed historical record',
      ]);
      writeReviewLedger(f.root, f.records, { coverageBaseline: f.base });
      const run = catchUpCli(f.root);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('documentation-impact:');
    },
  );
  it('uses the actual generator catalog and refuses a missing canonical input', () => {
    const { root } = fixture();
    const report = readDocumentationImpact({
      root,
      changedPaths: ['docs/architecture/module-map.md'],
    });
    expect(report.mcpTopics).toEqual([
      {
        id: 'architecture-owner',
        sourcePath: 'docs/architecture/module-map.md',
      },
    ]);
    rmSync(join(root, 'docs/learn/atlas.json'));
    expect(() =>
      readDocumentationImpact({ root, changedPaths: ['code.ts'] }),
    ).toThrow();
  });
  it('runs the real CLI catch-up against changed code without editing evidence', () => {
    const { root, write } = fixture();
    const before = ledgerFiles(root);
    write('code.ts', 'changed');
    const run = spawnSync(
      process.execPath,
      [resolve('scripts/documentation-impact.mjs'), '--catch-up', '--json'],
      { cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true },
    );
    expect(run.status).toBe(0);
    expect(
      JSON.parse(run.stdout).catchUp.staleReviews[0].changedInputs,
    ).toEqual(['code.ts']);
    expect(ledgerFiles(root)).toEqual(before);
  });

  it('reports shared generated validation separately while keeping ordinary drift, unknown paths and baseline through the CLI', async () => {
    const f = generatedFixture();
    const before = ledgerFiles(f.root);
    f.update();
    f.write('code.ts', 'changed ordinary source');
    f.write('unknown.ts', 'unmapped');
    const collected = await documentationCatchUp({ root: f.root });
    expect(collected.catchUp.generatedValidated).toEqual([
      expect.objectContaining({
        path: f.markdownPath,
        state: 'generated-validated',
        recordedState: 'source-reviewed',
        observedChanges: [f.markdownPath, f.dataPath],
        validation: expect.objectContaining({
          kind: 'deploy-ledger-projection',
          entryCount: 1,
        }),
      }),
    ]);
    expect(collected.catchUp.staleReviews).toEqual([
      expect.objectContaining({ path: 'guide.md', changedInputs: ['code.ts'] }),
    ]);
    expect(collected.catchUp.unchangedReviews).toBe(0);
    expect(collected.catchUp.coverageBase).toBe(f.base);
    expect(collected.unmappedPaths).toContain('unknown.ts');
    const run = catchUpCli(f.root);
    expect(run.status, run.stderr).toBe(0);
    const emitted: Awaited<ReturnType<typeof documentationCatchUp>> =
      JSON.parse(run.stdout);
    expect(emitted.catchUp).toEqual(collected.catchUp);
    expect(formatDocumentationImpact(emitted)).toContain(
      'Generated validation:',
    );
    expect(formatDocumentationImpact(emitted)).toContain('not human-reviewed');
    expect(ledgerFiles(f.root)).toEqual(before);
  });

  it.each(['data', 'projection'] as const)(
    'refuses invalid generated %s through the real CLI',
    async (corruption) => {
      const f = generatedFixture();
      f.update();
      if (corruption === 'data') f.write(f.dataPath, '{broken');
      else f.write(f.markdownPath, '# Not the captured projection\n');
      await expect(documentationCatchUp({ root: f.root })).rejects.toThrow();
      const run = catchUpCli(f.root);
      expect(run.status).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('documentation-impact:');
    },
  );

  it.each([
    'scripts/deploy-ledger.mjs',
    'scripts/lib/documentation-review.mjs',
  ])('keeps changed generator owner %s stale', async (owner) => {
    const f = generatedFixture();
    f.update();
    f.write(
      owner,
      `${readFileSync(join(f.root, owner), 'utf8')}\n// changed owner\n`,
    );
    const report = await documentationCatchUp({ root: f.root });
    expect(report.catchUp.generatedValidated).toEqual([]);
    expect(report.catchUp.staleReviews).toEqual([
      expect.objectContaining({ path: f.markdownPath, changedInputs: [owner] }),
    ]);
  });

  it('never validates generated data whose recorded input is missing', async () => {
    const f = generatedFixture();
    rmSync(join(f.root, f.dataPath));
    const report = await documentationCatchUp({ root: f.root });
    expect(report.catchUp.generatedValidated).toEqual([]);
    expect(report.catchUp.staleReviews).toEqual([
      expect.objectContaining({
        path: f.markdownPath,
        changedInputs: [f.dataPath],
      }),
    ]);
  });

  it('distinguishes an absent classified changeset from a deleted current guide through the real CLI', () => {
    const f = fixture();
    const note = '.changeset/consumed.md';
    const text = '# Historical release note\n';
    f.write(note, text);
    const historical = {
      ...record(note, []),
      kind: 'release-note',
      state: 'classified',
      checks: [],
      documentRevision: f.base,
      documentDigest: hash(text),
      sources: [],
    };
    writeReviewLedger(f.root, [...f.records, historical], {
      coverageBaseline: f.base,
    });
    git(f.root, ['add', '.']);
    git(f.root, [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'classified release note',
    ]);
    git(f.root, ['rm', note, 'guide.md']);
    const run = catchUpCli(f.root);
    expect(run.status, run.stderr).toBe(0);
    const report: Awaited<ReturnType<typeof documentationCatchUp>> = JSON.parse(
      run.stdout,
    );
    expect(report.catchUp.absentHistorical).toEqual([
      expect.objectContaining({
        path: note,
        state: 'absent-historical',
        recordedState: 'classified',
      }),
    ]);
    expect(report.catchUp.staleReviews).toEqual([
      expect.objectContaining({
        path: 'guide.md',
        changedInputs: ['guide.md'],
      }),
    ]);
    expect(report.documents.map((doc) => doc.path)).toContain('guide.md');
    expect(report.catchUp.unchangedReviews).toBe(0);
    expect(formatDocumentationImpact(report)).toContain(
      'publication is not established',
    );
  });

  it('keeps a missing changeset README and arbitrary generated guide stale', async () => {
    const f = fixture();
    const readme = '.changeset/README.md';
    f.write(readme, '# Release instructions\n');
    writeReviewLedger(
      f.root,
      [
        { ...f.records[0], kind: 'generated' },
        {
          ...record(readme, []),
          kind: 'release-note',
          state: 'classified',
          checks: [],
          sources: [],
          documentRevision: f.base,
          documentDigest: hash('# Release instructions\n'),
        },
      ],
      { coverageBaseline: f.base },
    );
    git(f.root, ['add', '.']);
    git(f.root, [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'classified instructions',
    ]);
    git(f.root, ['rm', readme]);
    f.write('guide.md', '# Changed generated-labelled guide\n');
    const report = await documentationCatchUp({ root: f.root });
    expect(report.catchUp.absentHistorical).toEqual([]);
    expect(report.catchUp.generatedValidated).toEqual([]);
    // Records compile in path order (#2936).
    expect(report.catchUp.staleReviews.map((review) => review.path)).toEqual([
      readme,
      'guide.md',
    ]);
  });
});

describe('review record layouts', () => {
  const file = recordFile('guide.md');
  const codeOf = (text: string, layout?: string) => {
    try {
      parseRecordFile(file, text, layout);
      return 'accepted';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };

  it('reports malformed record JSON as a review error in both read modes', () => {
    for (const layout of ['canonical', 'advisory-dependency-history'])
      expect(codeOf('{broken', layout)).toBe('invalid-json');
  });

  it('does not read a present but empty document as a path-only record', () => {
    const value = {
      path: 'guide.md',
      kind: 'current',
      state: 'partial',
      summary: 'Reviewed.',
      limits: 'None.',
      document: null,
      sources: ['src/a.ts'],
      checks: [],
    };
    expect(
      codeOf(
        `${JSON.stringify(value, null, 2)}\n`,
        'advisory-dependency-history',
      ),
    ).toBe('invalid-shape');
  });
});
