import { describe, expect, it } from 'vitest';
import changelog from '../changeset-changelog.mjs';
import { releaseVersioningOutputs } from '../lib/release-versioning-review.mjs';
import {
  recordFile,
  serializeRecordFile,
} from '../lib/review-ledger-store.mjs';
import {
  check,
  commit,
  entryPaths,
  fixture,
  git,
  record_,
  run,
  scoped,
  strict,
} from './helpers/documentation-freshness-fixture.js';
import { forbidAmbientFreshnessMode } from './helpers/freshness-env.js';

forbidAmbientFreshnessMode();

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const NOTE =
  '---\n"@x/pkg": minor\n---\n\nAdd a thing.\n\nIts second paragraph.\n';
const PKG = {
  name: '@x/pkg',
  version: '1.0.0',
  description: 'Pkg',
  dependencies: { '@x/dep': '^1.0.0', other: '^2.0.0' },
};
const DEP = { name: '@x/dep', version: '1.0.0' };
const OLD_CHANGELOG =
  '# @x/pkg\n\n## 1.0.0\n\n### Patch Changes\n\n- Initial release.\n';
const SECTION =
  '## 1.1.0\n\n### Minor Changes\n\n- abc1234: Add a thing.\n\n  Its second paragraph.\n\n### Patch Changes\n\n- Updated dependencies [def5678]\n  - @x/dep@1.0.1\n\n';
const NEW_CHANGELOG = OLD_CHANGELOG.replace('## 1.0.0', `${SECTION}## 1.0.0`);

type Files = Record<string, string | undefined>;

/** A `changeset version` unit: one note consumed, pkg and dep bumped. */
function unit(overrides: { before?: Files; after?: Files } = {}) {
  const before: Files = {
    '.changeset/one.md': NOTE,
    'packages/pkg/package.json': json(PKG),
    'packages/dep/package.json': json(DEP),
    'packages/pkg/CHANGELOG.md': OLD_CHANGELOG,
    ...overrides.before,
  };
  const after: Files = {
    '.changeset/one.md': undefined,
    'packages/pkg/package.json': json({
      ...PKG,
      version: '1.1.0',
      dependencies: { ...PKG.dependencies, '@x/dep': '^1.0.1' },
    }),
    'packages/dep/package.json': json({ ...DEP, version: '1.0.1' }),
    'packages/pkg/CHANGELOG.md': NEW_CHANGELOG,
    ...overrides.after,
  };
  const changes = Object.keys({ ...before, ...after })
    .filter((file) => before[file] !== after[file])
    .map((file) => ({
      status:
        after[file] === undefined
          ? 'D'
          : before[file] === undefined
            ? 'A'
            : 'M',
      file,
    }));
  const result = releaseVersioningOutputs({
    changes,
    read: (side: 'before' | 'after', file: string) =>
      (side === 'before' ? before : after)[file],
  });
  return {
    manifests: [...result.manifests],
    changelogs: [...result.changelogs],
  };
}

describe('release-versioning output contract', () => {
  it('recognises the version bumps and the changelog section generated from the consumed note', () => {
    expect(unit()).toEqual({
      manifests: ['packages/pkg/package.json', 'packages/dep/package.json'],
      changelogs: ['packages/pkg/CHANGELOG.md'],
    });
  });

  it('recognises nothing when the change consumes no note', () => {
    expect(unit({ after: { '.changeset/one.md': NOTE } })).toEqual({
      manifests: [],
      changelogs: [],
    });
  });

  it('refuses a manifest with any edit beyond the version and bumped workspace ranges', () => {
    const bumped = { ...PKG, version: '1.1.0' };
    for (const after of [
      { ...bumped, description: 'Changed claim' },
      { ...bumped, dependencies: { ...PKG.dependencies, other: '^3.0.0' } },
      { ...bumped, dependencies: { ...PKG.dependencies, '@x/dep': '^9.0.0' } },
      { ...bumped, dependencies: { ...PKG.dependencies, '@x/dep': '~1.0.1' } },
      { ...bumped, name: '@x/renamed' },
    ])
      expect(
        unit({ after: { 'packages/pkg/package.json': json(after) } }).manifests,
      ).not.toContain('packages/pkg/package.json');
  });

  it('refuses a changelog section that is not exactly the consumed notes', () => {
    const refusals: [string, string][] = [
      [
        'an added sentence',
        NEW_CHANGELOG.replace('Its second', 'New claim. Its second'),
      ],
      [
        'an untraced entry',
        NEW_CHANGELOG.replace(
          '### Patch Changes\n\n',
          '### Patch Changes\n\n- Unreviewed claim.\n',
        ),
      ],
      ['a different version', NEW_CHANGELOG.replace('## 1.1.0', '## 1.2.0')],
      [
        'the wrong bump block',
        NEW_CHANGELOG.replace('### Minor Changes', '### Major Changes'),
      ],
      [
        // Same length, so only the byte-identical tail check can refuse it.
        'an edited older tail',
        NEW_CHANGELOG.replace('Initial release.', 'Altered release.'),
      ],
      [
        'a dependency at an unreleased version',
        NEW_CHANGELOG.replace('@x/dep@1.0.1', '@x/dep@7.0.0'),
      ],
      [
        'a dropped consumed note',
        NEW_CHANGELOG.replace(
          /### Minor Changes\n\n[\s\S]*?paragraph\.\n\n/,
          '',
        ),
      ],
      [
        'text above the section',
        NEW_CHANGELOG.replace('# @x/pkg\n\n', '# @x/pkg\n\nPreface.\n\n'),
      ],
    ];
    for (const [label, text] of refusals)
      expect(
        unit({ after: { 'packages/pkg/CHANGELOG.md': text } }).changelogs,
        label,
      ).toEqual([]);
  });

  it('refuses every changelog when a consumed note cannot be read', () => {
    expect(
      unit({ before: { '.changeset/one.md': 'no front matter\n' } }).changelogs,
    ).toEqual([]);
  });
});

describe('generated changelog whitespace', () => {
  it('drops the two-space indent upstream writes on a note’s blank lines', async () => {
    const changeset = {
      id: 'one',
      summary: 'Add a thing.\n\nIts second paragraph.',
      releases: [{ name: '@x/pkg', type: 'minor' as const }],
      commit: 'abc1234def',
    };
    const upstream = (await import('@changesets/cli/changelog')).default;
    // The case is reachable: upstream really writes a whitespace-only line.
    expect(await upstream.getReleaseLine(changeset, 'minor', null)).toMatch(
      /\n {2}\n/,
    );
    const line = await changelog.getReleaseLine(changeset, 'minor', null);
    expect(line).toBe('- abc1234: Add a thing.\n\n  Its second paragraph.');
    // And the contract traces that exact output to its note.
    const section = `## 1.1.0\n\n### Minor Changes\n\n${line}\n\n`;
    expect(
      unit({
        after: {
          'packages/pkg/CHANGELOG.md': OLD_CHANGELOG.replace(
            '## 1.0.0',
            `${section}## 1.0.0`,
          ),
        },
      }).changelogs,
    ).toEqual(['packages/pkg/CHANGELOG.md']);
  });
});

describe('release versioning in the documentation freshness gate', () => {
  function releaseFixture() {
    const f = fixture();
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    f.write('packages/pkg/package.json', json(PKG));
    f.write('packages/dep/package.json', json(DEP));
    f.write('packages/pkg/CHANGELOG.md', OLD_CHANGELOG);
    f.write('.changeset/one.md', NOTE);
    f.write('docs/pkgref.md', '# Pkg reference\n');
    f.write('docs/ver.md', '# Pkg is at its current version\n');
    const records = [
      {
        path: 'docs/pkgref.md',
        kind: 'current',
        state: 'source-reviewed',
        sources: ['packages/pkg/package.json'],
      },
      {
        path: 'docs/ver.md',
        kind: 'current',
        state: 'source-reviewed',
        sources: ['packages/pkg/package.json#/version'],
      },
      {
        path: 'packages/pkg/CHANGELOG.md',
        kind: 'historical',
        state: 'classified',
        sources: [],
      },
    ];
    for (const record of records)
      f.write(
        recordFile(record.path),
        serializeRecordFile({
          ...record,
          summary: 'Fixture review.',
          limits: 'Fixture only.',
          checks: [],
        }),
      );
    commit(f.root, 'add a released package');
    // Land reviews of the new pages so main starts with no review gap.
    for (const { path } of records)
      expect(
        record_(f.root, [path, '--note', 'Reviewed the fixture.', '--rereview'])
          .status,
      ).toBe(0);
    commit(f.root, 'review the released package');
    git(f.root, ['switch', '-qc', 'release']);
    const release = () => {
      git(f.root, ['rm', '-q', '.changeset/one.md']);
      f.write(
        'packages/pkg/package.json',
        json({
          ...PKG,
          version: '1.1.0',
          dependencies: { ...PKG.dependencies, '@x/dep': '^1.0.1' },
        }),
      );
      f.write('packages/dep/package.json', json({ ...DEP, version: '1.0.1' }));
      f.write('packages/pkg/CHANGELOG.md', NEW_CHANGELOG);
    };
    return { ...f, release };
  }
  const blockingPaths = (root: string, env: Record<string, string>) =>
    entryPaths(check(root, env).blocking).sort();

  it('needs no note for the generated output but still blocks a record that cites the version value', () => {
    const f = releaseFixture();
    f.release();
    commit(f.root, 'chore: version packages');
    const result = check(f.root, scoped);
    expect(result.mode).toBe('scoped');
    expect(result.blocking).toEqual([
      expect.objectContaining({
        path: 'docs/ver.md',
        changed: ['packages/pkg/package.json#/version'],
      }),
    ]);
  });

  it('still blocks the citing pages when a release edit carries another change', () => {
    const f = releaseFixture();
    f.release();
    f.write(
      'packages/pkg/package.json',
      json({
        ...PKG,
        version: '1.1.0',
        description: 'A changed claim',
        dependencies: { ...PKG.dependencies, '@x/dep': '^1.0.1' },
      }),
    );
    f.write(
      'packages/pkg/CHANGELOG.md',
      NEW_CHANGELOG.replace('Add a thing.', 'Add a thing nobody reviewed.'),
    );
    commit(f.root, 'chore: version packages, edited');
    expect(blockingPaths(f.root, scoped)).toEqual([
      'docs/pkgref.md',
      'docs/ver.md',
      'packages/pkg/CHANGELOG.md',
    ]);
  });

  it('blocks a version bump that consumes no note and an uncommitted edit to generated output', () => {
    const f = releaseFixture();
    f.release();
    git(f.root, ['checkout', 'HEAD', '--', '.changeset/one.md']);
    commit(f.root, 'bump without consuming a note');
    expect(blockingPaths(f.root, scoped)).toEqual([
      'docs/pkgref.md',
      'docs/ver.md',
      'packages/pkg/CHANGELOG.md',
    ]);

    const g = releaseFixture();
    g.release();
    commit(g.root, 'chore: version packages');
    g.write('packages/pkg/CHANGELOG.md', `${NEW_CHANGELOG}Edited.\n`);
    expect(blockingPaths(g.root, scoped)).toEqual([
      'docs/ver.md',
      'packages/pkg/CHANGELOG.md',
    ]);
  });

  it('leaves no review gap in landed history for the generated output', () => {
    const f = releaseFixture();
    git(f.root, ['switch', '-q', 'main']);
    expect(blockingPaths(f.root, strict)).toEqual([]);
    git(f.root, ['switch', '-q', 'release']);
    f.release();
    commit(f.root, 'chore: version packages');
    git(f.root, ['switch', '-q', 'main']);
    git(f.root, ['merge', '-q', '--squash', 'release']);
    commit(f.root, 'chore: version packages (#1)');
    expect(blockingPaths(f.root, strict)).toEqual(['docs/ver.md']);
  });
});
