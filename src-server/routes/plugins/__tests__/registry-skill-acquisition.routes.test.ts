import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { GitHubSkillRegistryProvider } from '../../../providers/registries/github-skill-registry.js';
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

function setup() {
  clearAll();
  const home = makeTempDir('registry-skill-acquisition-');
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  const skillService = new SkillService(
    configLoader,
    createLogger({ name: 'registry-acquisition-test' }),
  );
  registerSkillRegistryProvider(
    new GitHubSkillRegistryProvider({ owner: 'example', repo: 'skills' }),
  );
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

describe('GitHub skill acquisition through Registry routes', () => {
  test('installs a nested skill by its declared name with binary assets from the listed immutable snapshot', async () => {
    const network = networkFixture();
    const { app, home, configLoader, skillService } = setup();
    const listed = await app.request('/skills');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          id: 'grill-me',
          source: `https://github.com/example/skills/tree/${firstCommit}/skills/productivity/grilling`,
        }),
      ],
    });
    network.moveBranch();
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
    expect(
      network.requests.filter((url) => url.endsWith('/commits/main')),
    ).toHaveLength(1);
  });

  test.each([
    ['truncated tree', { truncated: true }],
    ['ambiguous name', { duplicate: true }],
    ['missing declared skill', { missingMarkdown: true }],
  ])(
    'refuses %s without presenting a partial successful catalog',
    async (_name, options) => {
      networkFixture(options);
      const { app, home } = setup();
      expect((await app.request('/skills')).status).toBe(500);
      const response = await install(app);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        message: 'No skill registry provider could install grill-me',
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

  test('reports refresh failure instead of returning an expired catalog as successful', async () => {
    const network = networkFixture();
    const { app, home } = setup();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await app.request('/skills')).status).toBe(200);
    network.fail();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);
    expect((await app.request('/skills')).status).toBe(500);
    expect((await app.request('/skills/grill-me/content')).status).toBe(500);
    expect((await install(app)).status).toBe(500);
    await expect(access(join(home, 'skills/grill-me'))).rejects.toThrow();
  });
});
