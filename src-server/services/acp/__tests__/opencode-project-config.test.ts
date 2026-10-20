import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
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

describe('#3924 openCodeEditNeedsPerson: symbolic links and global configuration', () => {
  const env = {} as NodeJS.ProcessEnv;

  test.each([
    ['an absolute dangling link to the global configuration', 'abs-global'],
    ['a relative dangling link to the global configuration', 'rel-global'],
    ['a dangling link to the project opencode.json', 'project'],
    ['a dangling link to a .opencode configuration', 'dotdir'],
    ['a link to an ordinary project file', 'ordinary'],
  ])('a write through %s asks', (_label, kind) => {
    const { root, repo, cwd } = project();
    const home = join(root, 'home');
    const globalConfig = join(home, '.config', 'opencode', 'opencode.jsonc');
    const target = {
      'abs-global': globalConfig,
      'rel-global': join('..', 'home', '.config', 'opencode', 'opencode.jsonc'),
      project: 'opencode.json',
      dotdir: join('.opencode', 'opencode.jsonc'),
      ordinary: 'README.md',
    }[kind] as string;
    if (kind === 'ordinary') put(join(repo, 'README.md'), 'x');
    symlinkSync(target, join(repo, 'NOTES.md'));
    expect(
      openCodeEditNeedsPerson(
        { filepath: join(repo, 'NOTES.md') },
        cwd,
        env,
        home,
      ),
    ).toBe(true);
  });

  test('a dangling link directory on the way asks', () => {
    const { root, repo, cwd } = project();
    symlinkSync(join(root, 'home', '.config', 'opencode'), join(repo, 'docs'));
    expect(
      openCodeEditNeedsPerson(
        { filepath: join(repo, 'docs', 'plugin', 'p.ts') },
        cwd,
        env,
        root,
      ),
    ).toBe(true);
  });

  test.each([
    ['an absolute link target', 'absolute'],
    ['a relative link target', 'relative'],
  ])(
    'a raw `link/..` path is judged as written, through %s',
    (_label, kind) => {
      const { root, repo, cwd } = project();
      const home = join(root, 'home');
      const globalDir = join(home, '.config', 'opencode');
      mkdirSync(globalDir, { recursive: true });
      symlinkSync(
        kind === 'absolute'
          ? globalDir
          : join('..', 'home', '.config', 'opencode'),
        join(repo, 'a'),
      );
      // `path.resolve` would collapse this to <repo>/opencode/plugins/x.js;
      // the file system resolves it to the global plugins directory.
      const raw = `${repo}${sep}a${sep}..${sep}opencode${sep}plugins${sep}x.js`;
      expect(openCodeEditNeedsPerson({ filepath: raw }, cwd, env, home)).toBe(
        true,
      );
    },
  );

  test.each([
    ['a `..` segment', (repo: string) => `${repo}${sep}src${sep}..${sep}a.ts`],
    ['a `.` segment', (repo: string) => `${repo}${sep}.${sep}a.ts`],
    ['a repeated separator', (repo: string) => `${repo}${sep}${sep}a.ts`],
  ])('a path with %s asks, even without a link', (_label, path) => {
    const { repo, cwd } = project();
    expect(openCodeEditNeedsPerson({ filepath: path(repo) }, cwd, env)).toBe(
      true,
    );
    // The same file, written plainly, does not.
    expect(
      openCodeEditNeedsPerson({ filepath: join(repo, 'a.ts') }, cwd, env),
    ).toBe(false);
  });

  test.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
    'global configuration in another letter case asks, where the file system ignores case',
    () => {
      const root = realpathSync(makeTempDir('opencode-project-config-case-'));
      const home = join(root, 'home');
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      expect(
        openCodeEditNeedsPerson(
          { filepath: join(home, '.CONFIG', 'OpenCode', 'plugins', 'z.ts') },
          home,
          env,
          home,
        ),
      ).toBe(true);
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'a Windows 8.3 short-name segment asks',
    () => {
      const { repo, cwd } = project();
      expect(
        openCodeEditNeedsPerson(
          { filepath: join(repo, 'OPENCO~1', 'x.js') },
          cwd,
          env,
        ),
      ).toBe(true);
    },
  );

  test('a link above the project is resolved, so ordinary edits stay ordinary', () => {
    const { root, repo } = project();
    const linked = join(root, 'linked-repo');
    symlinkSync(repo, linked);
    const cwd = join(linked, 'packages', 'app');
    expect(
      openCodeEditNeedsPerson(
        { filepath: join(linked, 'src', 'a.ts') },
        cwd,
        env,
        root,
      ),
    ).toBe(false);
  });

  test.each([
    [
      'the default global directory',
      {},
      ['.config', 'opencode', 'plugin', 'p.ts'],
    ],
    [
      'XDG_CONFIG_HOME',
      { XDG_CONFIG_HOME: 'xdg' },
      ['xdg', 'opencode', 'plugin', 'p.ts'],
    ],
    ['OPENCODE_CONFIG_DIR', { OPENCODE_CONFIG_DIR: 'cfg' }, ['cfg', 'p.ts']],
    ['OPENCODE_CONFIG', { OPENCODE_CONFIG: 'my.json' }, ['my.json']],
  ])(
    'global configuration inside the project (%s) asks',
    (_label, vars, parts) => {
      const root = realpathSync(makeTempDir('opencode-project-config-home-'));
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const resolved = Object.fromEntries(
        Object.entries(vars).map(([key, value]) => [key, join(home, value)]),
      );
      expect(
        openCodeEditNeedsPerson(
          { filepath: join(home, ...parts) },
          home,
          resolved as NodeJS.ProcessEnv,
          home,
        ),
      ).toBe(true);
      // An ordinary file in that project does not.
      expect(
        openCodeEditNeedsPerson(
          { filepath: join(home, 'notes.txt') },
          home,
          resolved as NodeJS.ProcessEnv,
          home,
        ),
      ).toBe(false);
    },
  );
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
