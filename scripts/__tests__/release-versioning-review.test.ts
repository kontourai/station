import { join } from 'node:path';
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
  scripts,
  strict,
} from './helpers/documentation-freshness-fixture.js';
import { forbidAmbientFreshnessMode } from './helpers/freshness-env.js';

forbidAmbientFreshnessMode();

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const WRAPPER = join(scripts, 'changeset-changelog.mjs');
const CONFIG = json({
  changelog: WRAPPER,
  commit: false,
  fixed: [],
  linked: [],
  access: 'public',
  baseBranch: 'main',
  updateInternalDependencies: 'patch',
  ignore: [],
  privatePackages: { version: false, tag: false },
});
const WORKSPACE = 'packages:\n  - packages/pkg\n  - packages/dep\n';
const NOTE_PKG =
  '---\n"@x/pkg": minor\n---\n\nAdd a thing.\n\nIts second paragraph.\n';
const NOTE_DEP = '---\n"@x/dep": patch\n---\n\nFix the dep.\n';
const PKG = {
  name: '@x/pkg',
  version: '1.0.0',
  description: 'Pkg',
  dependencies: { '@x/dep': '^1.0.0', other: '^2.0.0' },
};
const DEP = { name: '@x/dep', version: '1.0.0' };
const changelogOf = (name: string) =>
  `# ${name}\n\n## 1.0.0\n\n### Patch Changes\n\n- Initial release.\n`;
// The bytes `changeset version` writes for this workspace (commit ids fixed).
const PKG_SECTION =
  '## 1.1.0\n\n### Minor Changes\n\n- abc1234: Add a thing.\n\n  Its second paragraph.\n\n### Patch Changes\n\n- Updated dependencies [def5678]\n  - @x/dep@1.0.1\n\n';
const DEP_SECTION =
  '## 1.0.1\n\n### Patch Changes\n\n- def5678: Fix the dep.\n\n';
const prepend = (name: string, section: string) =>
  changelogOf(name).replace('## 1.0.0', `${section}## 1.0.0`);
const PKG_AFTER = json({
  ...PKG,
  version: '1.1.0',
  dependencies: { ...PKG.dependencies, '@x/dep': '^1.0.1' },
});

type Files = Record<string, string | undefined>;

/** One `changeset version` unit over a two-package workspace. */
// The commits that added each note, as `git log --diff-filter=AC` names them.
const ADDED_BY: Record<string, string | undefined | null> = {
  '.changeset/one.md': `abc1234${'0'.repeat(33)}`,
  '.changeset/two.md': `def5678${'0'.repeat(33)}`,
  '.changeset/three.md': `aaa1111${'0'.repeat(33)}`,
};

function unit(
  overrides: {
    before?: Files;
    after?: Files;
    addedBy?: Record<string, string | undefined | null>;
  } = {},
) {
  const before: Files = {
    'package.json': json({ name: 'root', private: true }),
    'pnpm-workspace.yaml': WORKSPACE,
    '.changeset/config.json': CONFIG,
    '.changeset/README.md': '# Changesets\n',
    '.changeset/one.md': NOTE_PKG,
    '.changeset/two.md': NOTE_DEP,
    'packages/pkg/package.json': json(PKG),
    'packages/dep/package.json': json(DEP),
    'packages/pkg/CHANGELOG.md': changelogOf('@x/pkg'),
    'packages/dep/CHANGELOG.md': changelogOf('@x/dep'),
    ...overrides.before,
  };
  const after: Files = {
    ...before,
    '.changeset/one.md': undefined,
    '.changeset/two.md': undefined,
    'packages/pkg/package.json': PKG_AFTER,
    'packages/dep/package.json': json({ ...DEP, version: '1.0.1' }),
    'packages/pkg/CHANGELOG.md': prepend('@x/pkg', PKG_SECTION),
    'packages/dep/CHANGELOG.md': prepend('@x/dep', DEP_SECTION),
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
    listBefore: (dir: string) =>
      Object.keys(before).filter(
        (file) => file.startsWith(dir) && before[file] !== undefined,
      ),
    addedBy: (files: string[]) =>
      files.map((file) => [file, { ...ADDED_BY, ...overrides.addedBy }[file]]),
  });
  return {
    manifests: [...result.manifests].sort(),
    changelogs: [...result.changelogs].sort(),
    refused: result.refused as string | undefined,
  };
}
const ALL = {
  manifests: ['packages/dep/package.json', 'packages/pkg/package.json'],
  changelogs: ['packages/dep/CHANGELOG.md', 'packages/pkg/CHANGELOG.md'],
};
const refused = (reason: RegExp) => ({
  manifests: [],
  changelogs: [],
  refused: expect.stringMatching(reason),
});

describe('release-versioning output contract', () => {
  it('recognises the complete planned output of consuming every pending note', () => {
    expect(unit()).toEqual({ ...ALL, refused: undefined });
  });

  it('recognises nothing unless the change is exactly `changeset version` on its starting tree', () => {
    const NOT_CONSUMED = /not the set changeset version deletes/;
    const SHAPE = /contract owner or a non-note/;
    const MISSING = /missing its exact planned/;
    const refusals: [string, ReturnType<typeof unit>, RegExp][] = [
      [
        'no note consumed',
        unit({
          after: {
            '.changeset/one.md': NOTE_PKG,
            '.changeset/two.md': NOTE_DEP,
          },
        }),
        /consumes no pending note/,
      ],
      [
        'a pending note kept',
        unit({ after: { '.changeset/two.md': NOTE_DEP } }),
        NOT_CONSUMED,
      ],
      [
        'a note renamed, not consumed',
        unit({ after: { '.changeset/moved.md': NOTE_PKG } }),
        SHAPE,
      ],
      [
        'a note added',
        unit({ after: { '.changeset/three.md': NOTE_DEP } }),
        SHAPE,
      ],
      [
        'a non-note .changeset file removed',
        unit({ after: { '.changeset/README.md': undefined } }),
        SHAPE,
      ],
      [
        'a malformed note',
        unit({ before: { '.changeset/one.md': 'no front matter\n' } }),
        /does not parse/,
      ],
      [
        'an empty file as a note',
        unit({ before: { '.changeset/one.md': '' } }),
        /does not parse/,
      ],
      [
        'a note naming a package outside the workspace',
        unit({
          before: {
            '.changeset/one.md': '---\n"@x/ghost": minor\n---\n\nGhost.\n',
          },
        }),
        /outside the workspace/,
      ],
      [
        'the config edited in the same change',
        unit({
          after: {
            '.changeset/config.json': CONFIG.replace('"patch"', '"minor"'),
          },
        }),
        SHAPE,
      ],
      [
        'the contract owner edited in the same change',
        unit({
          before: { 'scripts/lib/release-versioning-review.mjs': 'a' },
          after: { 'scripts/lib/release-versioning-review.mjs': 'b' },
        }),
        SHAPE,
      ],
      [
        'pre mode',
        unit({ before: { '.changeset/pre.json': '{}' } }),
        /pre mode/,
      ],
      [
        'a downgrade',
        unit({
          after: {
            'packages/pkg/package.json': PKG_AFTER.replace('1.1.0', '0.0.1'),
            'packages/pkg/CHANGELOG.md': prepend(
              '@x/pkg',
              PKG_SECTION.replace('1.1.0', '0.0.1'),
            ),
          },
        }),
        MISSING,
      ],
      [
        'a major bump for a minor note',
        unit({
          after: {
            'packages/pkg/package.json': PKG_AFTER.replace('1.1.0', '2.0.0'),
            'packages/pkg/CHANGELOG.md': prepend(
              '@x/pkg',
              PKG_SECTION.replace('1.1.0', '2.0.0'),
            ),
          },
        }),
        MISSING,
      ],
      [
        'a planned package left unversioned',
        unit({
          after: {
            'packages/dep/package.json': json(DEP),
            'packages/dep/CHANGELOG.md': changelogOf('@x/dep'),
          },
        }),
        MISSING,
      ],
      [
        'a planned changelog missing',
        unit({ after: { 'packages/dep/CHANGELOG.md': changelogOf('@x/dep') } }),
        MISSING,
      ],
    ];
    for (const [label, result, reason] of refusals)
      expect(result, label).toEqual(refused(reason));
  });

  it('accepts the dependency list changesets writes when the dependency has no note', () => {
    // Real `changeset version` bytes for a fixed group where only pkg has a note.
    const config = json({
      ...JSON.parse(CONFIG),
      fixed: [['@x/pkg', '@x/dep']],
    });
    const pkgSection =
      '## 1.1.0\n\n### Minor Changes\n\n- abc1234: Add a thing.\n\n  Its second paragraph.\n\n### Patch Changes\n\n- @x/dep@1.1.0\n\n';
    const result = unit({
      before: {
        '.changeset/config.json': config,
        '.changeset/two.md': undefined,
      },
      after: {
        'packages/pkg/package.json': PKG_AFTER.replace('^1.0.1', '^1.1.0'),
        'packages/dep/package.json': json({ ...DEP, version: '1.1.0' }),
        'packages/pkg/CHANGELOG.md': prepend('@x/pkg', pkgSection),
        'packages/dep/CHANGELOG.md': prepend(
          '@x/dep',
          '## 1.1.0\n\nNo changes in this release.\n\n',
        ),
      },
    });
    expect(result).toEqual({ ...ALL, refused: undefined });
  });

  it('recognises nothing under a config whose range rules are not reproduced', () => {
    const configs: [string, Record<string, unknown>][] = [
      [
        'updateInternalDependencies minor',
        { updateInternalDependencies: 'minor' },
      ],
      [
        'onlyUpdatePeerDependentsWhenOutOfRange',
        {
          ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: {
            onlyUpdatePeerDependentsWhenOutOfRange: true,
          },
        },
      ],
      [
        'bumpVersionsWithWorkspaceProtocolOnly',
        { bumpVersionsWithWorkspaceProtocolOnly: true },
      ],
    ];
    for (const [label, change] of configs)
      expect(
        unit({
          before: {
            '.changeset/config.json': json({
              ...JSON.parse(CONFIG),
              ...change,
            }),
          },
        }),
        label,
      ).toEqual(refused(/unsupported changesets config/));
  });

  it('keeps a note’s own heading indented, as the CLI writes it', () => {
    const note =
      '---\n"@x/pkg": minor\n---\n\nAdd a thing.\n\n## 9.9.9\n\nMore.\n';
    const section = (heading: string) =>
      `## 1.1.0\n\n### Minor Changes\n\n- abc1234: Add a thing.\n\n${heading}\n\n  More.\n\n### Patch Changes\n\n- Updated dependencies [def5678]\n  - @x/dep@1.0.1\n\n`;
    const attempt = (heading: string) =>
      unit({
        before: { '.changeset/one.md': note },
        after: {
          'packages/pkg/CHANGELOG.md': prepend('@x/pkg', section(heading)),
        },
      });
    expect(attempt('  ## 9.9.9')).toEqual({ ...ALL, refused: undefined });
    // Unindented, the note line would read as a second release section.
    expect(attempt('## 9.9.9')).toEqual(
      refused(/@x\/pkg is missing its exact planned/),
    );
  });

  it('requires each entry’s commit prefix to name the commit that added its note', () => {
    const PKG_CHANGELOG = prepend('@x/pkg', PKG_SECTION);
    expect(
      unit({
        after: {
          'packages/pkg/CHANGELOG.md': PKG_CHANGELOG.replace(
            'abc1234',
            '0000000',
          ),
        },
      }),
    ).toEqual(refused(/@x\/pkg is missing its exact planned/));
    // A note no commit added gets no prefix, as the CLI writes it.
    const unprefixed = {
      'packages/pkg/CHANGELOG.md': PKG_CHANGELOG.replace('abc1234: ', ''),
    };
    expect(
      unit({ after: unprefixed, addedBy: { '.changeset/one.md': undefined } }),
    ).toEqual({
      ...ALL,
      refused: undefined,
    });
    expect(unit({ after: unprefixed })).toEqual(refused(/@x\/pkg is missing/));
    expect(unit({ addedBy: { '.changeset/one.md': null } })).toEqual(
      refused(/adding commit cannot be resolved/),
    );
  });

  it('requires entries in the order the CLI emits them and only the dependents the plan gives', () => {
    const three = '---\n"@x/dep": patch\n---\n\nSecond dep fix.\n';
    const depSection = (entries: string) =>
      `## 1.0.1\n\n### Patch Changes\n\n${entries}\n\n`;
    const pkgSection = PKG_SECTION.replace(
      '- Updated dependencies [def5678]',
      '- Updated dependencies [def5678]\n- Updated dependencies [aaa1111]',
    );
    // Notes are read in sorted file order: one, three, two; this is the
    // wrong (unsorted) dependency link order.
    const ordered = '- aaa1111: Second dep fix.\n- def5678: Fix the dep.';
    const pkgOrdered = PKG_SECTION.replace(
      '- Updated dependencies [def5678]',
      '- Updated dependencies [aaa1111]\n- Updated dependencies [def5678]',
    );
    const attempt = (depEntries: string, pkg = pkgOrdered) =>
      unit({
        before: { '.changeset/three.md': three },
        after: {
          '.changeset/three.md': undefined,
          'packages/dep/CHANGELOG.md': prepend(
            '@x/dep',
            depSection(depEntries),
          ),
          'packages/pkg/CHANGELOG.md': prepend('@x/pkg', pkg),
        },
      });
    expect(attempt(ordered)).toEqual({ ...ALL, refused: undefined });
    expect(
      attempt('- def5678: Fix the dep.\n- aaa1111: Second dep fix.'),
    ).toEqual(refused(/@x\/dep is missing/));
    expect(attempt(ordered, pkgSection)).toEqual(refused(/@x\/pkg is missing/));
    expect(attempt(`${ordered}\n- @x/pkg@1.1.0`)).toEqual(
      refused(/@x\/dep is missing/),
    );
    expect(
      attempt(
        ordered,
        pkgOrdered.replace(
          '  - @x/dep@1.0.1',
          '  - @x/dep@1.0.1\n  - @x/pkg@1.1.0',
        ),
      ),
    ).toEqual(refused(/@x\/pkg is missing/));
  });

  it('orders entries by byte order of note file names, as libuv’s sorted scandir lists them', () => {
    // Byte order and locale order disagree on case, digits, `-` and `_`.
    const ids = ['alpha', 'a_b', 'Zeta', 'a-b', '9x'];
    const hash = (index: number) =>
      `${String(index + 1).repeat(7)}${'0'.repeat(33)}`;
    const before: Files = {};
    const addedBy: Record<string, string> = {};
    ids.forEach((id, index) => {
      before[`.changeset/${id}.md`] =
        `---\n"@x/dep": patch\n---\n\nFix ${id}.\n`;
      addedBy[`.changeset/${id}.md`] = hash(index);
    });
    const deleted = Object.fromEntries(
      Object.keys(before).map((file) => [file, undefined]),
    );
    const entry = (file: string) => {
      if (file === 'two.md')
        return { line: '- def5678: Fix the dep.', short: 'def5678' };
      const id = file.replace(/\.md$/, '');
      const short = hash(ids.indexOf(id)).slice(0, 7);
      return { line: `- ${short}: Fix ${id}.`, short };
    };
    const outputFor = (files: string[]) => ({
      ...deleted,
      'packages/dep/CHANGELOG.md': prepend(
        '@x/dep',
        `## 1.0.1\n\n### Patch Changes\n\n${files.map((file) => entry(file).line).join('\n')}\n\n`,
      ),
      'packages/pkg/CHANGELOG.md': prepend(
        '@x/pkg',
        PKG_SECTION.replace(
          '- Updated dependencies [def5678]',
          files
            .map((file) => `- Updated dependencies [${entry(file).short}]`)
            .join('\n'),
        ),
      ),
    });
    const files = [...ids.map((id) => `${id}.md`), 'two.md'];
    const byteOrder = [...files].sort((x, y) =>
      Buffer.compare(Buffer.from(x), Buffer.from(y)),
    );
    const localeOrder = [...files].sort((x, y) => x.localeCompare(y));
    // The case is reachable: the two orders really differ for these names.
    expect(byteOrder).toEqual([
      '9x.md',
      'Zeta.md',
      'a-b.md',
      'a_b.md',
      'alpha.md',
      'two.md',
    ]);
    expect(localeOrder).not.toEqual(byteOrder);
    expect(unit({ before, after: outputFor(byteOrder), addedBy })).toEqual({
      ...ALL,
      refused: undefined,
    });
    expect(unit({ before, after: outputFor(localeOrder), addedBy })).toEqual(
      refused(/is missing its exact planned/),
    );
  });

  it('requires a note for a skipped private package to be kept, as changesets keeps it', () => {
    const before = {
      'pnpm-workspace.yaml': `${WORKSPACE}  - packages/private\n`,
      'packages/private/package.json': json({
        name: '@x/private',
        private: true,
        version: '0.1.0',
      }),
      '.changeset/three.md':
        '---\n"@x/private": minor\n---\n\nPrivate change.\n',
    };
    expect(unit({ before })).toEqual({ ...ALL, refused: undefined });
    expect(
      unit({ before, after: { '.changeset/three.md': undefined } }),
    ).toEqual(refused(/not the set changeset version deletes/));
  });

  it('refuses every manifest edit other than the planned version and planned ranges, byte for byte', () => {
    const bumped = {
      ...PKG,
      version: '1.1.0',
      dependencies: { ...PKG.dependencies, '@x/dep': '^1.0.1' },
    };
    const refusals: [string, string][] = [
      ['a description edit', json({ ...bumped, description: 'Changed claim' })],
      [
        'an unplanned version',
        PKG_AFTER.replace('"version": "1.1.0"', '"version": "1.2.0"'),
      ],
      [
        'the version left unbumped while a range moves',
        PKG_AFTER.replace('"version": "1.1.0"', '"version": "1.0.0"'),
      ],
      [
        'an external range',
        json({
          ...bumped,
          dependencies: { ...bumped.dependencies, other: '^3.0.0' },
        }),
      ],
      [
        'a range to an unplanned version',
        json({
          ...bumped,
          dependencies: { ...bumped.dependencies, '@x/dep': '^9.0.0' },
        }),
      ],
      [
        'a range operator change',
        json({
          ...bumped,
          dependencies: { ...bumped.dependencies, '@x/dep': '~1.0.1' },
        }),
      ],
      ['a rename', json({ ...bumped, name: '@x/renamed' })],
      [
        'reordered keys',
        json({
          version: '1.1.0',
          name: '@x/pkg',
          description: 'Pkg',
          dependencies: bumped.dependencies,
        }),
      ],
      ['reformatting', `${JSON.stringify(bumped)}\n`],
      [
        'a duplicate key hiding text',
        PKG_AFTER.replace(
          '"description": "Pkg",',
          '"description": "EVIL", "description": "Pkg",',
        ),
      ],
    ];
    for (const [label, text] of refusals)
      expect(
        unit({ after: { 'packages/pkg/package.json': text } }),
        label,
      ).toEqual(refused(/@x\/pkg is missing its exact planned/));
  });

  it('gives no exemption to a manifest outside the planned release set', () => {
    // A same-named manifest outside the workspace and a private one beside it.
    const result = unit({
      before: {
        'tools/dep/package.json': json({
          name: '@x/dep',
          version: '1.0.0',
          dependencies: { other: '^2.0.0' },
        }),
        'tools/private/package.json': json({
          name: '@x/tool',
          private: true,
          version: '1.0.0',
        }),
      },
      after: {
        'tools/dep/package.json': json({
          name: '@x/dep',
          version: '1.0.1',
          dependencies: { other: '^3.0.0' },
        }),
        'tools/private/package.json': json({
          name: '@x/tool',
          private: true,
          version: '1.0.1',
        }),
      },
    });
    expect(result).toEqual({ ...ALL, refused: undefined });
  });

  it('refuses a changelog section that is not exactly the planned notes', () => {
    const PKG_CHANGELOG = prepend('@x/pkg', PKG_SECTION);
    const refusals: [string, string][] = [
      [
        'an added sentence',
        PKG_CHANGELOG.replace('Its second', 'New claim. Its second'),
      ],
      [
        'an untraced entry',
        PKG_CHANGELOG.replace(
          '### Patch Changes\n\n',
          '### Patch Changes\n\n- Unreviewed claim.\n',
        ),
      ],
      ['a different version', PKG_CHANGELOG.replace('## 1.1.0', '## 1.2.0')],
      [
        'the wrong bump block',
        PKG_CHANGELOG.replace('### Minor Changes', '### Major Changes'),
      ],
      // Same length, so only the byte-identical tail check can refuse it.
      [
        'an edited older tail',
        PKG_CHANGELOG.replace('Initial release.', 'Altered release.'),
      ],
      [
        'a dependency at an unplanned version',
        PKG_CHANGELOG.replace('@x/dep@1.0.1', '@x/dep@7.0.0'),
      ],
      [
        'prose disguised as a dependency item',
        PKG_CHANGELOG.replace(
          '  - @x/dep@1.0.1',
          '  - @x/dep@1.0.1\n  - Unreviewed prose',
        ),
      ],
      [
        'a dropped planned note',
        PKG_CHANGELOG.replace(
          /### Minor Changes\n\n[\s\S]*?paragraph\.\n\n/,
          '',
        ),
      ],
      [
        'text above the section',
        PKG_CHANGELOG.replace('# @x/pkg\n\n', '# @x/pkg\n\nPreface.\n\n'),
      ],
      [
        'a second section',
        PKG_CHANGELOG.replace(
          '## 1.0.0',
          '## 1.0.5\n\n### Patch Changes\n\n- Updated dependencies\n  - @x/dep@1.0.1\n\n## 1.0.0',
        ),
      ],
      [
        'another package’s note',
        PKG_CHANGELOG.replace(
          'Add a thing.\n\n  Its second paragraph.',
          'Fix the dep.',
        ),
      ],
      [
        'no changes, though notes were planned',
        prepend('@x/pkg', '## 1.1.0\n\nNo changes in this release.\n\n'),
      ],
    ];
    // All or nothing: one unrecognised planned output voids the rest.
    for (const [label, text] of refusals)
      expect(
        unit({ after: { 'packages/pkg/CHANGELOG.md': text } }),
        label,
      ).toEqual(refused(/@x\/pkg is missing its exact planned/));
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
    expect(await changelog.getReleaseLine(changeset, 'minor', null)).toBe(
      '- abc1234: Add a thing.\n\n  Its second paragraph.',
    );
  });
});

describe('release versioning in the documentation freshness gate', () => {
  /** A repository whose release output comes from the real `changeset version`. */
  function releaseFixture() {
    const f = fixture();
    expect(
      run(f.root, 'migrate-review-ledger.mjs', ['--path-only']).status,
    ).toBe(0);
    f.write(
      'package.json',
      json({
        name: 'root',
        private: true,
        scripts: { docs: 'node docs.mjs', other: 'node other.mjs' },
      }),
    );
    f.write('pnpm-workspace.yaml', WORKSPACE);
    f.write('.changeset/config.json', CONFIG);
    f.write('.changeset/one.md', NOTE_PKG);
    f.write('.changeset/two.md', NOTE_DEP);
    f.write('packages/pkg/package.json', json(PKG));
    f.write('packages/dep/package.json', json(DEP));
    f.write('packages/pkg/CHANGELOG.md', changelogOf('@x/pkg'));
    f.write('packages/dep/CHANGELOG.md', changelogOf('@x/dep'));
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
      {
        path: 'packages/dep/CHANGELOG.md',
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
    commit(f.root, 'add released packages');
    // Land reviews of the new pages so main starts with no review gap.
    for (const { path } of records)
      expect(
        record_(f.root, [path, '--note', 'Reviewed the fixture.', '--rereview'])
          .status,
      ).toBe(0);
    commit(f.root, 'review the released packages');
    git(f.root, ['switch', '-qc', 'release']);
    const release = () => {
      // The real CLI, through the fixture's node runner.
      const result = run(f.root, '../node_modules/@changesets/cli/bin.js', [
        'version',
      ]);
      expect(result.status, result.stderr).toBe(0);
    };
    return { ...f, release };
  }
  const blockingPaths = (root: string, env: Record<string, string>) =>
    entryPaths(check(root, env).blocking).sort();

  it('needs no note for real `changeset version` output but still blocks a record that cites the version value', () => {
    const f = releaseFixture();
    f.release();
    expect(f.read('packages/pkg/CHANGELOG.md')).not.toMatch(/[ \t]$/m);
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

  it('blocks every citing page when the release carries another edit', () => {
    const f = releaseFixture();
    f.release();
    f.write(
      'packages/pkg/CHANGELOG.md',
      f
        .read('packages/pkg/CHANGELOG.md')
        .replace('Add a thing.', 'Add a thing nobody reviewed.'),
    );
    commit(f.root, 'chore: version packages, edited');
    expect(blockingPaths(f.root, scoped)).toEqual([
      'docs/pkgref.md',
      'docs/ver.md',
      'packages/dep/CHANGELOG.md',
      'packages/pkg/CHANGELOG.md',
    ]);
  });

  it('blocks an uncommitted edit to committed release output', () => {
    const f = releaseFixture();
    f.release();
    commit(f.root, 'chore: version packages');
    f.write(
      'packages/pkg/CHANGELOG.md',
      `${f.read('packages/pkg/CHANGELOG.md')}Edited.\n`,
    );
    expect(blockingPaths(f.root, scoped)).toEqual([
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
