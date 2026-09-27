import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectDocumentationChanges,
  documentationCatchUp,
  documentationImpact,
  readDocumentationImpact,
} from '../documentation-impact.mjs';

const roots: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ledger = (records: unknown[]) => ({ version: 1, records });
const record = (path: string, sources: string[]) => ({
  path,
  state: 'source-reviewed',
  summary: 'Checked caller.',
  sources: sources.map((path) => ({ path })),
});
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
  const root = mkdtempSync(join(tmpdir(), 'station-doc-impact-'));
  roots.push(root);
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
      sourceRevision: base,
      documentDigest: hash('# Guide\n'),
      sources: [{ path: 'code.ts', digest: hash('export const value = 1;\n') }],
    },
  ];
  write(
    'docs/learn/review-ledger.json',
    JSON.stringify({ ...ledger(records), coverageBaseline: base }),
  );
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
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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
        ledgers: [{ version: 1, records: [{}] }],
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
        'docs/learn/review-ledger.json',
      ]),
    );
    expect(() => collectDocumentationChanges(root, 'missing-base')).toThrow();
  });
  it('catches source-only drift since review, distinguishes edit and review commits, then accepts exact restoration', () => {
    const { root, write, base } = fixture();
    const initial = documentationCatchUp({ root });
    expect(initial.catchUp.staleReviews).toEqual([]);
    write('code.ts', 'export const value = 2;\n');
    const changed = documentationCatchUp({ root });
    expect(changed.catchUp.staleReviews).toEqual([
      {
        path: 'guide.md',
        reviewSourceRevision: base,
        reviewRevisionAvailable: true,
        lastCommittedEdit: base,
        changedInputs: ['code.ts'],
      },
    ]);
    expect(changed.documents.map((doc) => doc.path)).toContain('guide.md');
    write('code.ts', 'export const value = 1;\n');
    expect(documentationCatchUp({ root }).catchUp.staleReviews).toEqual([]);
  });
  it('keeps a deleted dependency visible and refuses unreadable metadata in the real CLI', () => {
    const { root } = fixture();
    rmSync(join(root, 'code.ts'));
    expect(
      documentationCatchUp({ root }).catchUp.staleReviews[0].changedInputs,
    ).toEqual(['code.ts']);
    writeFileSync(join(root, 'docs/learn/review-ledger.json'), '{broken');
    const run = spawnSync(
      process.execPath,
      [resolve('scripts/documentation-impact.mjs'), '--catch-up', '--json'],
      { cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('documentation-impact:');
    expect(run.stdout).toBe('');
  });
  it('reports removed committed review links even when the original audit baseline had no ledger', () => {
    const { root, records, base, write } = fixture();
    write(
      'docs/learn/review-ledger.json',
      JSON.stringify({
        ...ledger([{ ...records[0], sources: [] }]),
        coverageBaseline: base,
      }),
    );
    write('code.ts', 'changed');
    const report = documentationCatchUp({ root });
    expect(report.catchUp.removedDependencies).toEqual([
      { path: 'guide.md', recordRemoved: false, sourcesRemoved: ['code.ts'] },
    ]);
  });
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
    const before = readFileSync(
      join(root, 'docs/learn/review-ledger.json'),
      'utf8',
    );
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
    expect(
      readFileSync(join(root, 'docs/learn/review-ledger.json'), 'utf8'),
    ).toBe(before);
  });
});
