import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  findOpenCodeProjectCode,
  OPENCODE_CONFIG_SCAN_MAX_BYTES,
  openCodeEditNeedsPerson,
  openCodeEditTargets,
} from '../opencode-project-config.js';

const makeTempDir = trackTempDirs();

/** A git project with a nested session directory, outside any home. */
function project() {
  const root = realpathSync(makeTempDir('opencode-project-config-'));
  const repo = join(root, 'repo');
  const cwd = join(repo, 'packages', 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, repo, cwd, home: join(root, 'home') };
}

function put(path: string, content = '') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('#3924 openCodeEditTargets (the metadata OpenCode sends)', () => {
  test('edit and write send an absolute filepath', () => {
    expect(openCodeEditTargets({ filepath: '/p/a.ts', diff: '' })).toEqual([
      '/p/a.ts',
    ]);
  });

  test('apply_patch sends files with filePath and movePath; its joined filepath is not used', () => {
    expect(
      openCodeEditTargets({
        filepath: 'a.ts, b.ts',
        files: [
          { filePath: '/p/a.ts', relativePath: 'a.ts', type: 'update' },
          {
            filePath: '/p/b.ts',
            movePath: '/p/.opencode/plugin/b.ts',
            type: 'move',
          },
        ],
      }),
    ).toEqual(['/p/a.ts', '/p/b.ts', '/p/.opencode/plugin/b.ts']);
  });

  test.each([
    ['nothing', undefined],
    ['a relative filepath', { filepath: 'a.ts' }],
    ['a file without a path', { files: [{ relativePath: 'a.ts' }] }],
    ['an empty file list', { files: [] }],
  ])('%s yields no targets', (_label, input) => {
    expect(openCodeEditTargets(input)).toBeUndefined();
  });
});

describe('#3924 openCodeEditNeedsPerson', () => {
  test.each([
    ['.opencode/plugin/p.ts', true],
    ['packages/app/.opencode/tool/t.ts', true],
    ['opencode.json', true],
    ['packages/opencode.jsonc', true],
    ['.OPENCODE/plugins/p.ts', true],
    ['src/index.ts', false],
    ['docs/opencode.json.md', false],
  ])('%s in the project: %s', (relative, expected) => {
    const { repo, cwd } = project();
    expect(
      openCodeEditNeedsPerson({ filepath: join(repo, relative) }, cwd),
    ).toBe(expected);
  });

  test('a file outside the project (the git root) asks', () => {
    const { root, cwd, repo } = project();
    expect(
      openCodeEditNeedsPerson({ filepath: join(root, 'elsewhere.ts') }, cwd),
    ).toBe(true);
    // Elsewhere in the same repository is in the project.
    expect(
      openCodeEditNeedsPerson({ filepath: join(repo, 'lib', 'x.ts') }, cwd),
    ).toBe(false);
  });

  test('a link into .opencode is resolved', () => {
    const { repo, cwd } = project();
    mkdirSync(join(repo, '.opencode'));
    symlinkSync(join(repo, '.opencode'), join(repo, 'cfg'));
    expect(
      openCodeEditNeedsPerson(
        { filepath: join(repo, 'cfg', 'plugin', 'p.ts') },
        cwd,
      ),
    ).toBe(true);
  });

  test('a patch that moves a file into configuration asks', () => {
    const { repo, cwd } = project();
    expect(
      openCodeEditNeedsPerson(
        {
          files: [
            {
              filePath: join(repo, 'a.ts'),
              movePath: join(repo, 'opencode.json'),
            },
          ],
        },
        cwd,
      ),
    ).toBe(true);
  });

  test('an unreadable target asks', () => {
    const { cwd } = project();
    expect(openCodeEditNeedsPerson({ diff: '' }, cwd)).toBe(true);
  });
});

describe('#3924 findOpenCodeProjectCode', () => {
  test('a clean project has none', async () => {
    const { cwd, repo, home } = project();
    put(
      join(repo, 'opencode.json'),
      '{ "model": "x/y", "mcp": { "r": { "type": "remote", "url": "https://x" } } }',
    );
    put(join(repo, '.opencode', 'agent', 'a.md'), 'x');
    put(join(repo, '.opencode', 'plans', 'p.md'), 'x');
    expect(await findOpenCodeProjectCode(cwd, home)).toEqual([]);
  });

  test.each([
    ['.opencode/plugin/p.ts', '', /\.opencode\/plugin$/],
    ['.opencode/plugins/p.js', '', /\.opencode\/plugins$/],
    ['.opencode/tool/t.ts', '', /\.opencode\/tool$/],
    ['.opencode/tools/t.ts', '', /\.opencode\/tools$/],
    ['opencode.json', '{"plugin":["x"]}', /opencode\.json \(plugin\)$/],
    [
      'opencode.jsonc',
      '{ // c\n "mcp": { "m": { "type": "local", "command": ["x"] } }, }',
      /opencode\.jsonc \(mcp "m"\)$/,
    ],
    [
      '.opencode/opencode.json',
      '{"formatter":{"f":{"command":["x"]}}}',
      /\.opencode\/opencode\.json \(formatter "f"\)$/,
    ],
    ['opencode.json', '{"lsp":{"l":{"command":["x"]}}}', /lsp "l"/],
    ['opencode.json', '{ not json', /could not parse it/],
  ])(
    '%s is found from a nested directory',
    async (relative, content, finding) => {
      const { cwd, repo, home } = project();
      put(join(repo, relative), content);
      const found = await findOpenCodeProjectCode(cwd, home);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(finding);
    },
  );

  test('disabled entries and `formatter: false` run nothing', async () => {
    const { cwd, repo, home } = project();
    put(
      join(repo, 'opencode.json'),
      JSON.stringify({
        formatter: false,
        lsp: { l: { command: ['x'], disabled: true } },
        mcp: { m: { type: 'local', command: ['x'], enabled: false } },
      }),
    );
    expect(await findOpenCodeProjectCode(cwd, home)).toEqual([]);
  });

  test('a file too large to check is found, not skipped', async () => {
    const { cwd, repo, home } = project();
    put(
      join(repo, 'opencode.json'),
      `{"x":"${'a'.repeat(OPENCODE_CONFIG_SCAN_MAX_BYTES + 1)}"}`,
    );
    expect(await findOpenCodeProjectCode(cwd, home)).toEqual([
      `${join(repo, 'opencode.json')} (too large for Station to check)`,
    ]);
  });

  test('the scan stops at the git root, as OpenCode does', async () => {
    const { root, cwd, home } = project();
    put(join(root, '.opencode', 'plugin', 'p.ts'));
    expect(await findOpenCodeProjectCode(cwd, home)).toEqual([]);
  });

  test('without a git root it walks up, as OpenCode does, but not into home', async () => {
    const root = realpathSync(makeTempDir('opencode-project-config-nogit-'));
    const home = join(root, 'home');
    const cwd = join(home, 'work', 'app');
    mkdirSync(cwd, { recursive: true });
    put(join(home, 'work', '.opencode', 'plugin', 'p.ts'));
    put(join(home, '.opencode', 'plugin', 'mine.ts'));
    const found = await findOpenCodeProjectCode(cwd, home);
    expect(found).toEqual([join(home, 'work', '.opencode', 'plugin')]);
  });
});
