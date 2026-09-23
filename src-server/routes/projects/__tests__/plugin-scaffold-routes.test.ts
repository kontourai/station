import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { readPluginManifestFileWithFormat } from '../../../services/plugins/plugin-manifest-loader.js';
import { writePluginScaffold } from '../../../services/projects/plugin-scaffold-writer.js';
import { createPluginScaffoldRoutes } from '../plugin-scaffold-routes.js';

interface ScaffoldResponse {
  success: boolean;
  error?: string;
  code?: string;
  entries?: string[];
  entryCount?: number;
  data?: { name: string; template: string; files: string[] };
}

describe('POST /api/projects/:slug/plugin-scaffold', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-route-'));
    tempDirs.push(dir);
    return dir;
  }

  /** Mounted exactly as `createProjectRoutes` mounts it. */
  function appFor(projects: Record<string, { workingDirectory?: string }>) {
    const app = new Hono();
    app.route(
      '/api/projects/:slug/plugin-scaffold',
      createPluginScaffoldRoutes({
        getProject: (slug: string) => {
          const project = projects[slug];
          if (!project) throw new Error(`Project ${slug} not found`);
          return project as never;
        },
      }),
    );
    return app;
  }

  async function post(
    app: Hono,
    slug: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: ScaffoldResponse }> {
    const response = await app.request(
      `/api/projects/${slug}/plugin-scaffold`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: await readJson<ScaffoldResponse>(response),
    };
  }

  test('scaffolds into an empty Project folder that only holds .git and .DS_Store', async () => {
    const folder = tempDir();
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.DS_Store'), '');
    const app = appFor({ alpha: { workingDirectory: folder } });

    const { status, body } = await post(app, 'alpha', {
      name: 'pulse-board',
      template: 'pane',
      displayName: 'Pulse Board',
    });

    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.data?.files).toEqual(
      expect.arrayContaining(['plugin.json', 'src/index.tsx', 'src/pane.css']),
    );
    expect(JSON.stringify(body)).not.toContain(folder);
    for (const file of body.data!.files) {
      expect(existsSync(join(folder, file))).toBe(true);
    }
    // The server's own manifest reader, the one install runs, accepts it as
    // an Agent Plugin with its Station extension validated and the Pane
    // declared.
    const loaded = await readPluginManifestFileWithFormat(
      join(folder, 'plugin.json'),
    );
    expect(loaded.format).toBe('agent-plugin-1.0');
    expect(loaded.stationExtension?.status).toBe('validated');
    expect(loaded.manifest.name).toBe('pulse-board');
    expect(loaded.manifest.workspacePanes?.map((pane) => pane.id)).toEqual([
      'pane:plugin%3Apulse-board:main:workspace',
    ]);
  });

  test('refuses a folder that already holds work, names what is there, and writes nothing', async () => {
    const folder = tempDir();
    writeFileSync(join(folder, 'notes.md'), 'keep me');
    mkdirSync(join(folder, 'src'));
    const app = appFor({ alpha: { workingDirectory: folder } });

    const { status, body } = await post(app, 'alpha', { name: 'pulse' });

    expect(status).toBe(409);
    expect(body.code).toBe('working-directory-not-empty');
    expect(body.entries).toEqual(['notes.md', 'src']);
    expect(body.entryCount).toBe(2);
    expect(readdirSync(folder).sort()).toEqual(['notes.md', 'src']);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('keep me');
  });

  test('never overwrites: a second scaffold into the same folder is refused', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    expect((await post(app, 'alpha', { name: 'first' })).status).toBe(201);
    const before = readFileSync(join(folder, 'plugin.json'), 'utf8');

    const second = await post(app, 'alpha', { name: 'second' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('working-directory-not-empty');
    expect(readFileSync(join(folder, 'plugin.json'), 'utf8')).toBe(before);
  });

  test('refuses a Project with no folder', async () => {
    const app = appFor({ alpha: {} });
    const { status, body } = await post(app, 'alpha', { name: 'pulse' });
    expect(status).toBe(409);
    expect(body.code).toBe('no-working-directory');
  });

  test('refuses a Project whose folder does not exist, without creating it', async () => {
    const missing = join(tempDir(), 'gone');
    const app = appFor({ alpha: { workingDirectory: missing } });
    const { status, body } = await post(app, 'alpha', { name: 'pulse' });
    expect(status).toBe(409);
    expect(body.code).toBe('working-directory-missing');
    expect(existsSync(missing)).toBe(false);
  });

  test('refuses a Project folder that is a file', async () => {
    const file = join(tempDir(), 'file.txt');
    writeFileSync(file, 'x');
    const app = appFor({ alpha: { workingDirectory: file } });
    const { status, body } = await post(app, 'alpha', { name: 'pulse' });
    expect(status).toBe(409);
    expect(body.code).toBe('working-directory-not-a-directory');
  });

  test('refuses an unknown Project', async () => {
    const app = appFor({});
    const { status } = await post(app, 'ghost', { name: 'pulse' });
    expect(status).toBe(404);
  });

  test.each([
    ['uppercase', { name: 'Pulse' }],
    ['traversal', { name: '../pulse' }],
    ['double hyphen', { name: 'a--b' }],
  ])(
    'refuses an invalid name (%s) before touching the folder',
    async (_label, request) => {
      const folder = tempDir();
      const app = appFor({ alpha: { workingDirectory: folder } });
      const { status, body } = await post(app, 'alpha', request);
      expect(status).toBe(400);
      expect(body.code).toBe('invalid-name');
      expect(readdirSync(folder)).toEqual([]);
    },
  );

  test('refuses an unknown template and unknown fields', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    expect(
      (await post(app, 'alpha', { name: 'pulse', template: 'layout' })).status,
    ).toBe(400);
    expect(
      (await post(app, 'alpha', { name: 'pulse', path: '/etc' })).status,
    ).toBe(400);
    expect(readdirSync(folder)).toEqual([]);
  });

  test('a Project folder that is a symlink scaffolds into its real target', async () => {
    const root = tempDir();
    const target = join(root, 'real');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link, 'dir');
    const app = appFor({ alpha: { workingDirectory: link } });

    const { status } = await post(app, 'alpha', { name: 'linked' });

    expect(status).toBe(201);
    expect(existsSync(join(target, 'plugin.json'))).toBe(true);
  });
});

describe('writePluginScaffold containment', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test('refuses a file that would land outside the folder, before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-writer-'));
    tempDirs.push(root);
    const folder = join(root, 'project');
    mkdirSync(folder);

    const result = await writePluginScaffold(folder, [
      { path: 'plugin.json', contents: '{}' },
      { path: '../outside.txt', contents: 'escaped' },
    ]);

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'path-escapes-working-directory',
        path: '../outside.txt',
      },
    });
    expect(existsSync(join(root, 'outside.txt'))).toBe(false);
    // Lexical containment is proven for every file before the first write.
    expect(readdirSync(folder)).toEqual([]);
  });

  test('refuses an absolute file path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-writer-'));
    tempDirs.push(root);
    const folder = join(root, 'project');
    mkdirSync(folder);
    const outside = join(root, 'absolute.txt');

    const result = await writePluginScaffold(folder, [
      { path: outside, contents: 'escaped' },
    ]);

    expect(result.ok).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });
});
