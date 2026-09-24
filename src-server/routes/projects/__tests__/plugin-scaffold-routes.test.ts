import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPluginScaffold,
  PLUGIN_SCAFFOLD_TEMPLATES,
} from '@kontourai/station-shared/plugin-scaffold';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { auditInfo } = vi.hoisted(() => ({ auditInfo: vi.fn() }));
vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/logger.js')>();
  return {
    ...actual,
    createLogger: (options: { name: string }) => {
      const logger = actual.createLogger(options);
      return options.name === 'plugin-scaffold-routes'
        ? Object.assign(Object.create(logger), { info: auditInfo })
        : logger;
    },
  };
});

import pluginScaffoldDependencies from '../../../../config/plugin-scaffold-dependencies.json' with {
  type: 'json',
};
import { readJson } from '../../../__test-utils__/read-json.js';
import {
  parsePluginManifestDocumentWithFormat,
  readPluginManifestFileWithFormat,
} from '../../../services/plugins/plugin-manifest-loader.js';
import {
  ensureContainedDirectory,
  writePluginScaffold,
} from '../../../services/projects/plugin-scaffold-writer.js';
import { createPluginScaffoldRoutes } from '../plugin-scaffold-routes.js';

interface ScaffoldResponse {
  success: boolean;
  error?: string;
  code?: string;
  entries?: string[];
  entryCount?: number;
  present?: string[];
  presentCount?: number;
  missingCount?: number;
  data?: {
    name: string;
    template: string;
    files: string[];
    alreadyPresent?: boolean;
  };
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
  function appFor(
    projects: Record<
      string,
      { workingDirectory?: string; isolation?: 'shared' | 'worktree' }
    >,
    requestPrincipalId?: () => string,
  ) {
    const app = new Hono();
    app.route(
      '/api/projects/:slug/plugin-scaffold',
      createPluginScaffoldRoutes(
        {
          getProject: (slug: string) => {
            const project = projects[slug];
            if (!project) throw new Error(`Project ${slug} not found`);
            return project as never;
          },
          workspaceIsolationFor: async (slug: string) => {
            const project = projects[slug];
            if (!project) throw new Error(`Project ${slug} not found`);
            return project.isolation ?? 'shared';
          },
        },
        { requestPrincipalId },
      ),
    );
    return app;
  }

  async function eligibility(app: Hono, slug: string) {
    const response = await app.request(`/api/projects/${slug}/plugin-scaffold`);
    return {
      status: response.status,
      body: await readJson<{
        success: boolean;
        data?: { eligible: boolean; reason?: string };
      }>(response),
    };
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

  test('records who scaffolded, and who was refused', async () => {
    auditInfo.mockClear();
    const folder = tempDir();
    const app = appFor(
      { alpha: { workingDirectory: folder } },
      () => 'human:deployment:member-7',
    );

    expect((await post(app, 'alpha', { name: 'audited' })).status).toBe(201);
    expect((await post(app, 'alpha', { name: 'second' })).status).toBe(409);

    expect(auditInfo).toHaveBeenCalledWith(
      'Plugin scaffold written',
      expect.objectContaining({
        project: 'alpha',
        pluginName: 'audited',
        principal: 'human:deployment:member-7',
      }),
    );
    expect(auditInfo).toHaveBeenCalledWith(
      'Plugin scaffold refused',
      expect.objectContaining({
        pluginName: 'second',
        code: 'working-directory-not-empty',
        principal: 'human:deployment:member-7',
      }),
    );
    // I5: exactly these keys. The folder path and anything found in it
    // stay out of the log line.
    const [[, written], [, refused]] = auditInfo.mock.calls as [
      unknown,
      Record<string, unknown>,
    ][];
    expect(Object.keys(written).sort()).toEqual([
      'alreadyPresent',
      'files',
      'pluginName',
      'principal',
      'project',
      'template',
    ]);
    expect(Object.keys(refused).sort()).toEqual([
      'code',
      'pluginName',
      'principal',
      'project',
    ]);
    expect(JSON.stringify(auditInfo.mock.calls)).not.toContain(folder);
    expect(written.files).toBe(8);
  });

  test('refuses a folder that already holds work, counts what is there without naming it, and writes nothing', async () => {
    const folder = tempDir();
    writeFileSync(join(folder, 'notes.md'), 'keep me');
    mkdirSync(join(folder, 'src'));
    const app = appFor({ alpha: { workingDirectory: folder } });

    const { status, body } = await post(app, 'alpha', { name: 'pulse' });

    expect(status).toBe(409);
    expect(body.code).toBe('working-directory-not-empty');
    expect(body.entryCount).toBe(2);
    // D1: a member may call this route; the folder's contents are not theirs
    // to list, so a refusal names nothing that is on disk.
    expect(body).not.toHaveProperty('entries');
    expect(JSON.stringify(body)).not.toContain('notes.md');
    expect(readdirSync(folder).sort()).toEqual(['notes.md', 'src']);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('keep me');
  });

  test('never overwrites: a different scaffold into a scaffolded folder is refused', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    expect((await post(app, 'alpha', { name: 'first' })).status).toBe(201);
    const before = readFileSync(join(folder, 'plugin.json'), 'utf8');

    const second = await post(app, 'alpha', { name: 'second' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('working-directory-not-empty');
    expect(readFileSync(join(folder, 'plugin.json'), 'utf8')).toBe(before);
  });

  test('a retry of the SAME scaffold after a lost answer succeeds without writing', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    const request = { name: 'retry', template: 'pane', displayName: 'Retry' };
    const first = await post(app, 'alpha', request);
    expect(first.status).toBe(201);
    const before = readFileSync(join(folder, 'plugin.json'), 'utf8');

    const again = await post(app, 'alpha', request);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data?.alreadyPresent).toBe(true);
    expect([...again.body.data!.files].sort()).toEqual(
      [...first.body.data!.files].sort(),
    );
    expect(readFileSync(join(folder, 'plugin.json'), 'utf8')).toBe(before);
  });

  test('a retry that finds the scaffold changed is not mistaken for it', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    const request = { name: 'retry', template: 'pane' };
    expect((await post(app, 'alpha', request)).status).toBe(201);
    writeFileSync(join(folder, 'README.md'), 'edited by someone');

    const again = await post(app, 'alpha', request);

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('working-directory-not-empty');
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe(
      'edited by someone',
    );
  });

  test('a same-named file of the wrong size is judged by its size, never read', async () => {
    // D4: the occupancy check is member-triggerable. A 3 GiB sparse file at a
    // scaffold path (no disk cost) is beyond what `readFile` will load, so
    // reading it would fail the request; the size check refuses it first.
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    writeFileSync(join(folder, 'plugin.json'), '');
    truncateSync(join(folder, 'plugin.json'), 3 * 1024 ** 3);

    const { status, body } = await post(app, 'alpha', { name: 'sized' });

    expect(status).toBe(409);
    expect(body.code).toBe('working-directory-not-empty');
  });

  test.each([
    ['a foreign empty directory', 'docs'],
    ['an empty scaffold directory', 'src'],
  ])(
    'a folder holding only %s is not-empty, never a partial scaffold',
    async (_label, directory) => {
      // I12: only the scaffold's own files may count toward a partial scaffold.
      const folder = tempDir();
      mkdirSync(join(folder, directory));
      const app = appFor({ alpha: { workingDirectory: folder } });

      const { status, body } = await post(app, 'alpha', {
        name: 'dirs',
        template: 'pane',
      });

      expect(status).toBe(409);
      expect(body.code).toBe('working-directory-not-empty');
      expect(body.entryCount).toBe(1);
      expect(readdirSync(folder)).toEqual([directory]);
    },
  );

  test('a partial scaffold counts the files already there and writes nothing', async () => {
    const folder = tempDir();
    const app = appFor({ alpha: { workingDirectory: folder } });
    const request = { name: 'retry', template: 'pane' };
    expect((await post(app, 'alpha', request)).status).toBe(201);
    rmSync(join(folder, 'src'), { recursive: true });
    rmSync(join(folder, 'build.ts'));

    const again = await post(app, 'alpha', request);

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('partial-scaffold');
    expect(again.body.presentCount).toBe(5);
    expect(again.body.missingCount).toBe(3);
    expect(again.body).not.toHaveProperty('present');
    expect(JSON.stringify(again.body)).not.toContain('tsconfig.json');
    expect(again.body.error).toMatch(/Open the Project/);
    expect(existsSync(join(folder, 'build.ts'))).toBe(false);
  });

  test('refuses a Project whose chats run in worktrees, before writing', async () => {
    const folder = tempDir();
    const app = appFor({
      alpha: { workingDirectory: folder, isolation: 'worktree' },
    });
    const { status, body } = await post(app, 'alpha', { name: 'pulse' });
    expect(status).toBe(409);
    expect(body.code).toBe('worktree-isolation');
    expect(body.error).toMatch(/Shared/);
    expect(readdirSync(folder)).toEqual([]);
  });

  test('eligibility says yes only for an empty folder under shared isolation', async () => {
    const empty = tempDir();
    mkdirSync(join(empty, '.git'));
    const occupied = tempDir();
    writeFileSync(join(occupied, 'notes.md'), 'x');
    const app = appFor({
      empty: { workingDirectory: empty },
      occupied: { workingDirectory: occupied },
      worktree: { workingDirectory: empty, isolation: 'worktree' },
      nofolder: {},
      missing: { workingDirectory: join(empty, 'gone') },
    });
    const reasons: Record<string, unknown> = {};
    for (const slug of [
      'empty',
      'occupied',
      'worktree',
      'nofolder',
      'missing',
    ]) {
      const { status, body } = await eligibility(app, slug);
      expect(status).toBe(200);
      reasons[slug] = body.data?.eligible ? 'eligible' : body.data?.reason;
    }
    expect(reasons).toEqual({
      empty: 'eligible',
      occupied: 'working-directory-not-empty',
      worktree: 'worktree-isolation',
      nofolder: 'no-working-directory',
      missing: 'working-directory-missing',
    });
    // Read-only: it names no path and writes nothing.
    const { body } = await eligibility(app, 'occupied');
    expect(JSON.stringify(body)).not.toContain(occupied);
    expect(readdirSync(empty)).toEqual(['.git']);
    expect((await eligibility(app, 'ghost')).status).toBe(404);
  });

  test.each([
    ['a zero-width space', 'a\u200bb'],
    ['a bidi override', 'a\u202eb'],
    ['a newline', 'A\nB'],
  ])(
    'refuses a display name with %s before touching the folder',
    async (_label, displayName) => {
      const folder = tempDir();
      const app = appFor({ alpha: { workingDirectory: folder } });
      const { status, body } = await post(app, 'alpha', {
        name: 'titled',
        displayName,
      });
      expect(status).toBe(400);
      expect(body.code).toBe('invalid-display-name');
      expect(readdirSync(folder)).toEqual([]);
    },
  );

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

describe('every scaffold passes the SERVER manifest loader', () => {
  // The shared parser is not the only gate: install runs the server loader,
  // which also refuses hidden content. A scaffold the loader refuses would be
  // written and then be uninstallable.
  test.each(
    PLUGIN_SCAFFOLD_TEMPLATES.flatMap((template) =>
      [undefined, 'Demo "x" <b>', 'Café Board', 'x'.repeat(128)].map(
        (displayName) => [template, displayName] as const,
      ),
    ),
  )('%s with title %j', (template, displayName) => {
    const scaffold = buildPluginScaffold({
      name: `loader-${template}`,
      template,
      displayName,
      dependencies: pluginScaffoldDependencies,
    });
    const raw = scaffold.files.find(
      (file) => file.path === 'plugin.json',
    )!.contents;
    const loaded = parsePluginManifestDocumentWithFormat(
      raw,
      '/tmp/loader/plugin.json',
    );
    expect(loaded.format).toBe('agent-plugin-1.0');
    expect(loaded.stationExtension?.status).toBe('validated');
    expect(loaded.manifest.name).toBe(`loader-${template}`);
    expect(loaded.manifest.workspacePanes?.length ?? 0).toBe(
      template === 'full' ? 2 : template === 'pane' ? 1 : 0,
    );
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

  test('never overwrites a file, even one that appears after the emptiness check', async () => {
    // The emptiness check runs first, so only a file created during the
    // write can collide. Listing the same path twice is that race, made
    // deterministic: the second write must refuse rather than replace.
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-writer-'));
    tempDirs.push(root);

    const result = await writePluginScaffold(root, [
      { path: 'plugin.json', contents: 'first' },
      { path: 'plugin.json', contents: 'second' },
    ]);

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'file-exists',
        path: 'plugin.json',
        written: ['plugin.json'],
      },
    });
    expect(readFileSync(join(root, 'plugin.json'), 'utf8')).toBe('first');
  });

  test('creates directories one level at a time and stops at a symlinked level', async () => {
    // L1: a subdirectory the scaffold needs becoming a symlink after the
    // emptiness check is a race; the per-level walk is what stops it, so the
    // walk is driven directly here.
    const root = mkdtempSync(join(tmpdir(), 'station-plugin-scaffold-writer-'));
    tempDirs.push(root);
    const folder = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(folder);
    mkdirSync(outside);

    expect(
      await ensureContainedDirectory(folder, join(folder, 'src', 'deep')),
    ).toBe(true);
    expect(existsSync(join(folder, 'src', 'deep'))).toBe(true);

    symlinkSync(outside, join(folder, 'agents'), 'dir');
    expect(
      await ensureContainedDirectory(
        folder,
        join(folder, 'agents', 'assistant'),
      ),
    ).toBe(false);
    expect(readdirSync(outside)).toEqual([]);

    // A link that stays INSIDE the folder is refused too: realpath
    // containment alone would pass it, and a scaffold never needs a link.
    symlinkSync(join(folder, 'src'), join(folder, 'alias'), 'dir');
    expect(
      await ensureContainedDirectory(folder, join(folder, 'alias', 'nested')),
    ).toBe(false);
    expect(existsSync(join(folder, 'src', 'nested'))).toBe(false);
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
