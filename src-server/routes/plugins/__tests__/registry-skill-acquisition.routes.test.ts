import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryItem } from '@kontourai/station-contracts/catalog';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import type { ISkillRegistryProvider } from '../../../providers/provider-interfaces.js';
import { FilesystemSkillRegistryProvider } from '../../../providers/registries/filesystem-skill-registry.js';
import { GitHubSkillRegistryProvider } from '../../../providers/registries/github-skill-registry.js';
import { MultiSourceSkillRegistryProvider } from '../../../providers/registries/multi-source-skill-registry.js';
import {
  clearAll,
  registerSkillRegistryProvider,
} from '../../../providers/registries/registry.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createRegistryRoutes } from '../registry.js';

const makeTempDir = trackTempDirs();
const firstCommit = '1'.repeat(40);
const firstTree = '2'.repeat(40);
const nextCommit = '3'.repeat(40);
const nextTree = '4'.repeat(40);
const markdown = Buffer.from(
  '---\nname: grill-me\ndescription: Clarify an idea\n---\n\nAsk about the idea.',
);
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x80, 0x0a]);
const script = Buffer.from('#!/bin/sh\nprintf example\n');
const prototypeMarkdown = Buffer.from(
  '---\nname: prototype\ndescription: Build a prototype\n---\n\nPlan a prototype.',
);
const formatMarkdown = Buffer.from(
  '---\nname: pr\ndescription: Review a pull request\nmetadata:\n  credits:\n    author: Example Author\n---\n\nReview the change.',
);

function blobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function networkFixture(
  options: {
    duplicate?: boolean;
    truncated?: boolean;
    corruptAsset?: boolean;
    missingAsset?: boolean;
    missingMarkdown?: boolean;
    additionalFiles?: Array<{ path: string; bytes: Buffer }>;
    additionalSkills?: Array<{ directory: string; markdown: Buffer }>;
  } = {},
) {
  let branchMoved = false;
  let unavailable = false;
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (unavailable) return new Response('Unavailable', { status: 503 });
    if (url.endsWith('/commits/main')) {
      return Response.json({
        sha: branchMoved ? nextCommit : firstCommit,
        commit: { tree: { sha: branchMoved ? nextTree : firstTree } },
      });
    }
    if (
      url.endsWith(`/git/trees/${firstTree}?recursive=1`) ||
      url.endsWith('/git/trees/main?recursive=1')
    ) {
      const entries = [
        {
          path: 'skills/productivity/grilling/SKILL.md',
          type: 'blob',
          mode: '100644',
          sha: blobSha(markdown),
        },
        {
          path: 'skills/productivity/grilling/assets/example.png',
          type: 'blob',
          mode: '100644',
          sha: blobSha(binary),
        },
        {
          path: 'skills/productivity/grilling/scripts/example.sh',
          type: 'blob',
          mode: '100755',
          sha: blobSha(script),
        },
      ];
      for (const skill of options.additionalSkills ?? []) {
        entries.push({
          path: `skills/${skill.directory}/SKILL.md`,
          type: 'blob',
          mode: '100644',
          sha: blobSha(skill.markdown),
        });
      }
      for (const file of options.additionalFiles ?? []) {
        entries.push({
          path: `skills/productivity/grilling/${file.path}`,
          type: 'blob',
          mode: '100644',
          sha: blobSha(file.bytes),
        });
      }
      if (options.duplicate)
        entries.push({
          path: 'skills/other/interview/SKILL.md',
          type: 'blob',
          mode: '100644',
          sha: blobSha(markdown),
        });
      return Response.json({
        sha: firstTree,
        truncated: options.truncated ?? false,
        tree: entries,
      });
    }
    if (url.endsWith(`/git/trees/${nextTree}?recursive=1`)) {
      return Response.json({ sha: nextTree, truncated: false, tree: [] });
    }
    const pinnedRoot = `https://raw.githubusercontent.com/example/skills/${firstCommit}/skills/`;
    if (url.startsWith(pinnedRoot)) {
      const path = decodeURIComponent(url.slice(pinnedRoot.length));
      const extraSkill = options.additionalSkills?.find(
        (skill) => path === `${skill.directory}/SKILL.md`,
      );
      if (extraSkill) return new Response(extraSkill.markdown);
      const extra = options.additionalFiles?.find(
        (file) => path === `productivity/grilling/${file.path}`,
      );
      if (extra) return new Response(extra.bytes);
      if (path.endsWith('/SKILL.md')) {
        if (options.missingMarkdown)
          return new Response('Missing', { status: 404 });
        return new Response(markdown);
      }
      if (path === 'productivity/grilling/scripts/example.sh') {
        return new Response(script);
      }
      if (path === 'productivity/grilling/assets/example.png') {
        if (options.missingAsset)
          return new Response('Missing', { status: 404 });
        return new Response(
          options.corruptAsset ? Buffer.from('changed') : binary,
        );
      }
    }
    if (
      url.startsWith(
        'https://raw.githubusercontent.com/example/skills/main/skills/',
      )
    ) {
      return new Response('No skill at collapsed directory', { status: 404 });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  return {
    requests,
    moveBranch: () => {
      branchMoved = true;
    },
    fail: () => {
      unavailable = true;
    },
  };
}

function setup(
  provider: ISkillRegistryProvider = new GitHubSkillRegistryProvider({
    owner: 'example',
    repo: 'skills',
  }),
) {
  clearAll();
  const home = makeTempDir('registry-skill-acquisition-');
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  const skillService = new SkillService(
    configLoader,
    createLogger({ name: 'registry-acquisition-test' }),
  );
  registerSkillRegistryProvider(provider);
  const app = createRegistryRoutes(
    configLoader,
    async () => {},
    undefined,
    skillService,
  );
  return { app, home, configLoader, skillService };
}

function install(app: ReturnType<typeof createRegistryRoutes>) {
  return app.request('/skills/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'grill-me' }),
  });
}

afterEach(() => {
  clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Registry skill acquisition and host compatibility', () => {
  test('keeps unsupported metadata inspectable and refuses its package without falling through or leaving a staged package', async () => {
    networkFixture({
      additionalSkills: [
        { directory: 'engineering/pr', markdown: formatMarkdown },
      ],
    });
    const fallback = makeTempDir('registry-format-fallback-');
    await mkdir(join(fallback, 'pr'));
    await writeFile(
      join(fallback, 'pr/SKILL.md'),
      '---\nname: pr\ndescription: Another source\n---\n\nOther instructions.',
    );
    const provider = new MultiSourceSkillRegistryProvider([
      new GitHubSkillRegistryProvider({ owner: 'example', repo: 'skills' }),
      new FilesystemSkillRegistryProvider([fallback]),
    ]);
    const { app, home, skillService } = setup(provider);
    const listed = await app.request('/skills');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'grill-me' }),
        }),
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'pr' }),
          status: 'unsupported-skill-format',
        }),
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'pr' }),
          source: fallback,
        }),
      ],
    });
    const catalog = (await (await app.request('/skills')).json()) as {
      data: RegistryItem[];
    };
    const selected = catalog.data.find(
      (item) => item.status === 'unsupported-skill-format',
    )!;
    const content = await app.request(`/skills/${selected.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({
      success: true,
      data: formatMarkdown.toString('utf-8'),
    });
    const refused = await app.request('/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      success: false,
      code: 'unsupported-skill-format',
      message:
        'This skill uses metadata that Station cannot install. Its original Markdown is available for inspection; ask its publisher for a supported format.',
    });
    expect(await readdir(join(home, 'skills'))).toEqual([]);
    expect(skillService.listSkills()).toEqual([]);
    expect((await install(app)).status).toBe(200);
    expect(await readFile(join(home, 'skills/grill-me/SKILL.md'))).toEqual(
      markdown,
    );
  });

  test('preserves default-composition local installation while GitHub discovery is unavailable', async () => {
    const network = networkFixture();
    network.fail();
    const source = makeTempDir('registry-local-offline-control-');
    await mkdir(join(source, 'grill-me'));
    await writeFile(join(source, 'grill-me/SKILL.md'), markdown);
    const provider = new MultiSourceSkillRegistryProvider([
      new FilesystemSkillRegistryProvider([source]),
      new GitHubSkillRegistryProvider({ owner: 'example', repo: 'skills' }),
    ]);
    const { app, home } = setup(provider);
    const partial = await app.request('/skills');
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      partial: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ status: 'error' }),
      ]),
    });
    expect((await install(app)).status).toBe(200);
    expect(await readFile(join(home, 'skills/grill-me/SKILL.md'))).toEqual(
      markdown,
    );
  });

  test('schema-refuses __proto__ before the reserved-name custom envelope without filesystem effects', async () => {
    const { app, home } = setup();
    const response = await app.request('/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '__proto__' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty(
      'code',
      'unsupported-skill-name',
    );
    expect(await readdir(home)).toEqual([]);
  });

  test('projects host name compatibility over a filesystem provider availability claim', async () => {
    const source = makeTempDir('registry-filesystem-compatibility-');
    for (const [name, bytes] of [
      ['grill-me', markdown],
      ['prototype', prototypeMarkdown],
    ] as const) {
      await mkdir(join(source, name));
      await writeFile(join(source, name, 'SKILL.md'), bytes);
    }
    class ClaimedAvailableFilesystemRegistry extends FilesystemSkillRegistryProvider {
      override async listAvailable() {
        return (await super.listAvailable()).map((item) => ({
          ...item,
          status: 'available',
        }));
      }
    }
    const { app, home } = setup(
      new ClaimedAvailableFilesystemRegistry([source]),
    );
    const listed = await app.request('/skills');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'grill-me' }),
          status: 'available',
          source,
        }),
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'prototype' }),
          status: 'unsupported-skill-name',
          source,
        }),
      ]),
    });
    const refused = await app.request('/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'prototype' }),
    });
    expect(refused.status).toBe(400);
    expect(await readdir(home)).toEqual(['config']);
    expect((await install(app)).status).toBe(200);
    expect(await readFile(join(home, 'skills/grill-me/SKILL.md'))).toEqual(
      markdown,
    );
  });

  test('keeps a reserved-name skill inspectable without blocking its valid sibling or permitting an install', async () => {
    networkFixture({
      additionalSkills: [
        { directory: 'engineering/prototype', markdown: prototypeMarkdown },
      ],
    });
    const { app, home, skillService } = setup();
    const listed = await app.request('/skills');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'grill-me' }),
        }),
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'prototype' }),
          status: 'unsupported-skill-name',
          source: `https://github.com/example/skills/tree/${firstCommit}/skills/engineering/prototype`,
        }),
      ],
    });
    const content = await app.request('/skills/prototype/content');
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({
      success: true,
      data: 'Plan a prototype.',
    });
    const refused = await app.request('/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'prototype' }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      success: false,
      code: 'unsupported-skill-name',
      message:
        'This skill uses a name reserved by Station. Ask its publisher for a supported name before installing.',
    });
    expect(await readdir(home)).toEqual(['config']);
    expect(skillService.listSkills()).toEqual([]);
    expect((await install(app)).status).toBe(200);
    expect(await readFile(join(home, 'skills/grill-me/SKILL.md'))).toEqual(
      markdown,
    );
    expect(skillService.listSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'grill-me', installed: true }),
      ]),
    );
    await expect(access(join(home, 'skills/prototype'))).rejects.toThrow();
  });

  test('installs a nested skill by its declared name with binary assets from the listed immutable snapshot', async () => {
    networkFixture();
    const { app, home, configLoader, skillService } = setup();
    const listed = await app.request('/skills');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          catalog: expect.objectContaining({ itemId: 'grill-me' }),
          source: `https://github.com/example/skills/tree/${firstCommit}/skills/productivity/grilling`,
        }),
      ],
    });
    const preview = await app.request('/skills/grill-me/content');
    expect(await preview.json()).toEqual({
      success: true,
      data: 'Ask about the idea.',
    });
    const response = await install(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message: expect.stringContaining(firstCommit),
    });
    expect(await readFile(join(home, 'skills/grill-me/SKILL.md'))).toEqual(
      markdown,
    );
    expect(
      await readFile(join(home, 'skills/grill-me/assets/example.png')),
    ).toEqual(binary);
    const scriptPath = join(home, 'skills/grill-me/scripts/example.sh');
    expect(await readFile(scriptPath)).toEqual(script);
    if (process.platform !== 'win32')
      expect((await stat(scriptPath)).mode & 0o111).toBe(0o111);
    expect((await configLoader.loadSkill('grill-me')).origin).toBe('registry');
    expect(skillService.listSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'grill-me',
          installed: true,
        }),
      ]),
    );
  });

  test('refuses an oversized asset body before publishing the package', async () => {
    networkFixture({
      additionalFiles: [
        { path: 'assets/oversized.bin', bytes: Buffer.alloc(1024 * 1024 + 1) },
      ],
    });
    const { app, home } = setup();
    expect((await app.request('/skills')).status).toBe(200);
    const refused = await install(app);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({
      success: false,
      message: expect.stringContaining('byte budget'),
    });
    await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
  });

  test('refuses the inspected GitHub selection when its branch moves before acquisition', async () => {
    const network = networkFixture();
    const { app, home } = setup();
    const listing = (await (await app.request('/skills')).json()) as {
      data: RegistryItem[];
    };
    const selected = listing.data[0]!;
    network.moveBranch();
    const refused = await app.request('/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id }),
    });
    expect(refused.status).toBe(409);
    await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
  });

  test.each([
    ['truncated tree', { truncated: true }],
    ['ambiguous name', { duplicate: true }],
    ['missing declared skill', { missingMarkdown: true }],
    [
      'ambiguous unsupported-format names',
      {
        additionalSkills: [
          { directory: 'engineering/pr', markdown: formatMarkdown },
          { directory: 'other/pr', markdown: formatMarkdown },
        ],
      },
    ],
    [
      'missing description with unsupported metadata',
      {
        additionalSkills: [
          {
            directory: 'engineering/incomplete',
            markdown: Buffer.from(
              '---\nname: incomplete\nmetadata:\n  credits:\n    author: Example Author\n---\n\nIncomplete.',
            ),
          },
        ],
      },
    ],
    [
      'ambiguous reserved name',
      {
        additionalSkills: [
          { directory: 'engineering/prototype', markdown: prototypeMarkdown },
          { directory: 'other/prototype', markdown: prototypeMarkdown },
        ],
      },
    ],
    [
      'unsafe declared name',
      {
        additionalSkills: [
          {
            directory: 'engineering/unsafe',
            markdown: Buffer.from(
              '---\nname: bad/name\ndescription: Invalid package name\n---\n\nBad name.',
            ),
          },
        ],
      },
    ],
    [
      'malformed skill header',
      {
        additionalSkills: [
          {
            directory: 'engineering/malformed',
            markdown: Buffer.from('---\nname: [broken\n---\n\nBad YAML.'),
          },
        ],
      },
    ],
  ])(
    'refuses %s without presenting a partial successful catalog',
    async (_name, options) => {
      networkFixture(options);
      const { app, home } = setup();
      expect((await app.request('/skills')).status).toBe(503);
      const response = await install(app);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        message: 'No available marketplace contains this skill.',
      });
      await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
    },
  );

  test.each([
    ['changed blob bytes', { corruptAsset: true }],
    ['missing asset', { missingAsset: true }],
  ])('does not publish a package with %s', async (_name, options) => {
    networkFixture(options);
    const { app, home } = setup();
    expect((await app.request('/skills')).status).toBe(200);
    expect((await install(app)).status).toBe(500);
    await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
  });

  test.each([
    ['case-colliding filenames', ['assets/Foo.txt', 'assets/foo.txt']],
    ['case-colliding directories', ['Assets/first.txt', 'assets/second.txt']],
    [
      'normalization-colliding filenames',
      ['assets/café.txt', 'assets/cafe\u0301.txt'],
    ],
    ['file/directory aliases', ['assets/Foo.txt', 'assets/foo.txt/child.txt']],
  ])(
    'refuses %s before publishing an installed package',
    async (_name, paths) => {
      networkFixture({
        additionalFiles: paths.map((path, index) => ({
          path,
          bytes: Buffer.from(index === 0 ? 'UPPER' : 'lower'),
        })),
      });
      const { app, home, skillService } = setup();
      expect((await app.request('/skills')).status).toBe(200);
      expect((await install(app)).status).toBe(500);
      await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
      expect(skillService.listSkills()).toEqual([]);
    },
  );

  test.each([
    ['Greek sigma', 'Σ', 'ς'],
    ['sharp s', 'ß', 'SS'],
    ['ligature', 'ﬀ', 'ff'],
  ])(
    'keeps distinct directory identities for %s or refuses host filesystem aliases',
    async (_name, first, second) => {
      const probe = makeTempDir('registry-directory-alias-probe-');
      await mkdir(join(probe, first));
      let aliases = false;
      try {
        await mkdir(join(probe, second));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        )
          throw error;
        aliases = true;
      }
      const files = [
        { path: `assets/${first}/first.txt`, bytes: Buffer.from('UPPER') },
        { path: `assets/${second}/second.txt`, bytes: Buffer.from('lower') },
      ];
      networkFixture({ additionalFiles: files });
      const { app, home, skillService } = setup();
      expect((await app.request('/skills')).status).toBe(200);
      expect((await install(app)).status).toBe(aliases ? 500 : 200);
      if (aliases) {
        await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
        expect(skillService.listSkills()).toEqual([]);
      } else {
        for (const file of files)
          expect(
            await readFile(join(home, 'skills/grill-me', file.path)),
          ).toEqual(file.bytes);
      }
    },
  );

  test('preserves both distinct asset paths and their exact independent bytes', async () => {
    const files = [
      { path: 'assets/first.txt', bytes: Buffer.from('UPPER') },
      { path: 'assets/second.txt', bytes: Buffer.from('lower') },
    ];
    networkFixture({ additionalFiles: files });
    const { app, home } = setup();
    expect((await install(app)).status).toBe(200);
    for (const file of files)
      expect(await readFile(join(home, 'skills/grill-me', file.path))).toEqual(
        file.bytes,
      );
  });

  test('discloses an offline cached catalog and refuses acquisition', async () => {
    const network = networkFixture();
    const { app, home } = setup();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await app.request('/skills')).status).toBe(200);
    network.fail();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);
    const stale = await app.request('/skills');
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({
      partial: true,
      sources: [expect.objectContaining({ status: 'stale' })],
    });
    expect((await app.request('/skills/grill-me/content')).status).toBe(409);
    expect((await install(app)).status).toBe(409);
    await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
  });
});
