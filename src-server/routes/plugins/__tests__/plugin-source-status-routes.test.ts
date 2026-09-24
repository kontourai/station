/**
 * #2323 S4: "Reinstall from source" for a local-folder plugin.
 *
 * Everything here runs the REAL installer against a real installation
 * journal (EventStore) through the real `/preview` and `/install` routes, so
 * the source digest the status compares against is the one the installer
 * actually recorded at consent, and the origin match is the one the
 * installer actually computed. Only the bundle build is stubbed (the fixture
 * has no bundle).
 *
 * Who is calling is bound the way the auth boundary binds it
 * (`setRuntimeAuthenticatedRequestPrincipal`), by a stand-in middleware; the
 * production composition, with real paired-device credentials, is covered in
 * `runtime-routes-plugin-proposals-wiring.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginLocalSourceStatus } from '@kontourai/station-contracts/plugin';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { pluginAcquisitionOrigin } from '../../../services/plugins/plugin-acquisition-origin.js';
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import {
  LOCAL_SOURCE_STATUS_MAX_FOLDERS,
  observeLocalPluginSourceStatuses,
} from '../../../services/plugins/plugin-local-source-status.js';
import {
  LOCAL_SOURCE_DIGEST_MAX_BYTES,
  LOCAL_SOURCE_DIGEST_MAX_ENTRIES,
} from '../../../services/plugins/plugin-source-digest.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { createPluginSourceStatusRoutes } from '../plugin-source-status-routes.js';

const { observeTree, real } = vi.hoisted(() => ({
  observeTree: vi.fn(),
  real: { observe: null as unknown as (...args: unknown[]) => unknown },
}));
vi.mock(
  '@kontourai/station-shared/plugin-tree-digest',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/plugin-tree-digest')
      >();
    observeTree.mockImplementation(actual.observePluginTreeAsync);
    real.observe = actual.observePluginTreeAsync as never;
    return { ...actual, observePluginTreeAsync: observeTree };
  },
);

const homes: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
  observeTree.mockClear();
  observeTree.mockImplementation(real.observe);
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

type Caller = 'operator' | 'member' | 'internal';

function writeManifest(dir: string, version: string, extra = {}) {
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'pulse',
      version,
      ...extra,
    }),
  );
}

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'station-s4-source-')));
  homes.push(home);
  const plugins = join(home, 'plugins');
  const source = join(home, 'work', 'pulse');
  mkdirSync(plugins);
  mkdirSync(join(source, 'skills', 'pulse-skill'), { recursive: true });
  writeManifest(source, '1.0.0');
  writeFileSync(
    join(source, 'skills', 'pulse-skill', 'SKILL.md'),
    '---\nname: pulse-skill\ndescription: Pulse\n---\nGeneration one.',
  );
  const store = new EventStore(join(home, 'events.sqlite'));
  stores.push(store);
  const journal = store.createPackageMcpAdmissionJournal();
  const projects: Array<{ slug: string; workingDirectory?: string }> = [
    { slug: 'pulse-project', workingDirectory: source },
    { slug: 'unrelated', workingDirectory: join(home, 'work') },
    { slug: 'no-folder' },
  ];
  const deps = {
    pluginsDir: plugins,
    projectHomeDir: home,
    agentsDir: join(home, 'agents'),
    packageMcpJournal: journal,
    buildPlugin: vi.fn(),
    logger,
  };
  const app = new Hono();
  // Stand-in for the auth boundary: binds the principal the way
  // `configureRuntimeHttp` does, from which caller class the test names.
  app.use('*', async (c, next) => {
    const caller = (c.req.header('x-test-caller') ?? 'operator') as Caller;
    setRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
      caller === 'internal'
        ? {
            kind: 'internal',
            credential: 'internal',
            authority: undefined,
            source: 'bearer',
          }
        : caller === 'member'
          ? {
              kind: 'credential',
              credential: 'member',
              authority: 'device-credential',
              deviceId: 'phone',
              deviceKind: 'device',
              source: 'bearer',
            }
          : {
              kind: 'credential',
              credential: 'operator',
              authority: 'operator-credential',
              source: 'bearer',
            },
    );
    await next();
  });
  const plugin = new Hono();
  registerPluginInstallRoutes(plugin, {
    ...deps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  app.route('/api/plugins', plugin);
  app.route(
    '/api/plugin-sources',
    createPluginSourceStatusRoutes({
      projectHomeDir: home,
      journal,
      listProjects: () => projects,
      // As production resolves them: the internal caller and the operator
      // credential are both the operator; a paired device is its own person.
      resolvePrincipal: (c) => {
        const caller = (c.req.header('x-test-caller') ?? 'operator') as Caller;
        if (caller === 'member')
          return {
            id: 'human:device:phone',
            kind: 'human',
            display: 'Phone',
          };
        if (caller === 'operator' || caller === 'internal')
          return {
            id: LOCAL_OPERATOR_PRINCIPAL_ID,
            kind: 'human',
            display: 'Operator',
          };
        throw new PrincipalUnresolvedError('none');
      },
      logger,
    }),
  );

  const statuses = async (caller: Caller = 'operator') => {
    const response = await app.request('/api/plugin-sources', {
      headers: { 'x-test-caller': caller },
    });
    return { response, text: await response.clone().text() };
  };
  const sources = async () => {
    const { response } = await statuses();
    expect(response.status).toBe(200);
    return (await readJson<{ sources: PluginLocalSourceStatus[] }>(response))
      .sources;
  };
  /** The ordinary preview → consent → install, as the Plugins view sends it. */
  const previewAndInstall = async (
    installSource: string,
    dataPolicy?: 'preserve',
  ) => {
    const preview = await readJson<{
      valid: boolean;
      contentDigest: string;
      permissions: { required: string[] };
      installationRevision: unknown;
      grantRevision?: string;
    }>(
      await app.request('/api/plugins/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: installSource }),
      }),
    );
    expect(preview.valid).toBe(true);
    const response = await app.request('/api/plugins/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: installSource,
        skip: [],
        ...(dataPolicy
          ? { dataPolicy, expectedInstallation: preview.installationRevision }
          : {}),
        consent: {
          permissions: preview.permissions.required,
          contentDigest: preview.contentDigest,
          dependencies: [],
          ...(preview.grantRevision !== undefined
            ? { grantRevision: preview.grantRevision }
            : {}),
        },
      }),
    });
    const body = await readJson<Record<string, unknown>>(response);
    expect(body, JSON.stringify(body)).toMatchObject({ success: true });
    return { preview, body };
  };
  return {
    home,
    plugins,
    source,
    journal,
    projects,
    statuses,
    sources,
    previewAndInstall,
  };
}

describe('#2323 S4 GET /api/plugin-sources', () => {
  test('a Project folder that is an installed plugin’s source reads unchanged, then changed after an edit; other Projects are not listed', async () => {
    const f = fixture();
    const { preview } = await f.previewAndInstall(f.source);

    expect(await f.sources()).toEqual([
      {
        pluginName: 'pulse',
        projectSlug: 'pulse-project',
        status: 'unchanged',
        installedSourceDigest: preview.contentDigest,
        currentSourceDigest: preview.contentDigest,
      },
    ]);

    writeFileSync(
      join(f.source, 'skills', 'pulse-skill', 'SKILL.md'),
      '---\nname: pulse-skill\ndescription: Pulse\n---\nGeneration two.',
    );
    const [changed] = await f.sources();
    expect(changed).toMatchObject({
      pluginName: 'pulse',
      projectSlug: 'pulse-project',
      status: 'changed',
      installedSourceDigest: preview.contentDigest,
    });
    expect(changed!.currentSourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(changed!.currentSourceDigest).not.toBe(preview.contentDigest);
  });

  test('another spelling of the same folder matches (realpath), because the installer canonicalizes the same way', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    const alias = join(f.home, 'alias');
    symlinkSync(f.source, alias);
    f.projects.splice(0, f.projects.length, {
      slug: 'via-alias',
      workingDirectory: `${alias}/`,
    });
    expect(await f.sources()).toEqual([
      expect.objectContaining({
        projectSlug: 'via-alias',
        status: 'unchanged',
      }),
    ]);
  });

  test('a folder beyond the digest bounds reads unknown and says why, with no current digest', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    mkdirSync(join(f.source, 'bulk'));
    for (let index = 0; index <= LOCAL_SOURCE_DIGEST_MAX_ENTRIES; index++)
      writeFileSync(join(f.source, 'bulk', `f${index}`), '');
    const [status] = await f.sources();
    expect(status).toMatchObject({ status: 'unknown', reason: 'too-large' });
    expect(status).not.toHaveProperty('currentSourceDigest');
  });

  test('a folder over the byte bound reads unknown / too-large without being digested', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    // A sparse file: its size crosses the bound without writing the bytes.
    const big = join(f.source, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, LOCAL_SOURCE_DIGEST_MAX_BYTES + 1);
    observeTree.mockClear();
    const [status] = await f.sources();
    expect(status).toMatchObject({ status: 'unknown', reason: 'too-large' });
    expect(status).not.toHaveProperty('currentSourceDigest');
    expect(observeTree).not.toHaveBeenCalled();
  });

  test('the body names plugins and Projects, never a host path', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    const { response, text } = await f.statuses();
    expect(response.status).toBe(200);
    expect(text).toContain('pulse-project');
    for (const path of [f.source, f.home, realpathSync(f.source)])
      expect(text).not.toContain(path);
    expect(text).not.toContain('work/pulse');
  });

  test('a non-operator person gets 404, and no folder is walked', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    observeTree.mockClear();
    const { response, text } = await f.statuses('member');
    expect(response.status).toBe(404);
    expect(text).not.toContain('pulse');
    expect(observeTree).not.toHaveBeenCalled();
  });

  test('Station’s internal agent caller gets 404: it walks nothing and changes no installation', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    writeFileSync(join(f.source, 'extra.txt'), 'changed');
    const before = f.journal.selectedInstallations();
    observeTree.mockClear();
    const { response, text } = await f.statuses('internal');
    expect(response.status).toBe(404);
    expect(text).not.toContain('pulse');
    expect(observeTree).not.toHaveBeenCalled();
    expect(f.journal.selectedInstallations()).toEqual(before);
  });
});

describe('#2323 S4 reinstall from source', () => {
  test('preview → consent → install with dataPolicy preserve keeps the data scope, selects a new generation, and the status reads unchanged again', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    const before = resolveInstalledPluginRoot(f.plugins, 'pulse')!;
    writeFileSync(join(before.dataRoot!, 'state'), 'kept across reinstall');
    const generationBefore = f.journal.currentInstallation('pulse');

    writeManifest(f.source, '1.1.0');
    expect((await f.sources())[0]?.status).toBe('changed');

    const { preview, body } = await f.previewAndInstall(f.source, 'preserve');
    expect(body).toMatchObject({
      plugin: { version: '1.1.0' },
      lifecycle: { data: 'preserved' },
    });
    const after = resolveInstalledPluginRoot(f.plugins, 'pulse')!;
    expect(after.dataScope).toBe(before.dataScope);
    expect(after.packageRoot).not.toBe(before.packageRoot);
    expect(readFileSync(join(after.dataRoot!, 'state'), 'utf8')).toBe(
      'kept across reinstall',
    );
    const generationAfter = f.journal.currentInstallation('pulse');
    expect(generationBefore.state).toBe('observed');
    expect(generationAfter.state).toBe('observed');
    if (
      generationBefore.state === 'observed' &&
      generationAfter.state === 'observed'
    ) {
      expect(generationAfter.installation.incarnation).not.toBe(
        generationBefore.installation.incarnation,
      );
      expect(generationAfter.installation.dataScope).toBe(
        generationBefore.installation.dataScope,
      );
      expect(generationAfter.installation.origin).toBe(
        generationBefore.installation.origin,
      );
    }

    expect(await f.sources()).toEqual([
      expect.objectContaining({
        status: 'unchanged',
        installedSourceDigest: preview.contentDigest,
      }),
    ]);
  });
});

describe('#2323 S4 review: the walk is bounded by folders, not by Projects', () => {
  /** Calls to the tree digest that read the fixture source folder. */
  const walksOf = (folder: string) =>
    observeTree.mock.calls.filter(
      ([path]) => realpathSync(path as string) === realpathSync(folder),
    ).length;

  test('forty Projects naming one source folder (through two spellings) walk it once', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    const alias = join(f.home, 'alias');
    symlinkSync(f.source, alias);
    f.projects.splice(
      0,
      f.projects.length,
      ...Array.from({ length: 40 }, (_, index) => ({
        slug: `p${index}`,
        workingDirectory: index % 2 ? alias : f.source,
      })),
    );
    observeTree.mockClear();
    const sources = await f.sources();
    expect(sources).toHaveLength(40);
    expect(sources.every((entry) => entry.status === 'unchanged')).toBe(true);
    expect(walksOf(f.source)).toBe(1);
  });

  test('concurrent status reads share one walk of a folder', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    observeTree.mockClear();
    observeTree.mockImplementation(async (...args: unknown[]) => {
      await gate;
      return real.observe(...args);
    });
    const reads = Promise.all([f.sources(), f.sources(), f.sources()]);
    // Let all three requests reach the walk before it finishes.
    await vi.waitFor(() => expect(observeTree).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await reads;
    expect(results.map((entry) => entry[0]?.status)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(walksOf(f.source)).toBe(1);
    // Nothing is cached once the walk settles: a later read walks again.
    await f.sources();
    expect(walksOf(f.source)).toBe(2);
  });

  test('a walk that fails is not remembered: the next read walks again and succeeds', async () => {
    const f = fixture();
    await f.previewAndInstall(f.source);
    observeTree.mockClear();
    observeTree.mockImplementationOnce(async () => {
      throw new Error('disk went away');
    });
    const failed = await f.statuses();
    expect(failed.response.status).toBe(500);
    const [status] = await f.sources();
    expect(status).toMatchObject({ status: 'unchanged' });
    expect(walksOf(f.source)).toBe(2);
  });

  test('past the per-request folder cap a source reads unknown / too-many-sources and is not walked', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'station-s4-cap-')));
    homes.push(home);
    const count = LOCAL_SOURCE_STATUS_MAX_FOLDERS + 2;
    const folders = Array.from({ length: count }, (_, index) => {
      const folder = join(home, `src-${index}`);
      mkdirSync(folder);
      writeManifest(folder, '1.0.0');
      return folder;
    });
    const installations = folders.map((folder, index) => ({
      journalId: 'j',
      pluginId: `plugin-${index}`,
      incarnation: 'g1',
      contentDigest: 'sha256:artifact',
      origin: pluginAcquisitionOrigin({ projectHomeDir: home, source: folder }),
    }));
    observeTree.mockClear();
    const statuses = await observeLocalPluginSourceStatuses({
      projectHomeDir: home,
      journal: {
        selectedInstallations: () => ({ state: 'observed', installations }),
        activationPlan: () => ({ sourceDigest: 'sha256:recorded' }) as never,
      },
      projects: folders.map((folder, index) => ({
        slug: `p${index}`,
        workingDirectory: folder,
      })),
    });
    expect(statuses).toHaveLength(count);
    const capped = statuses.filter(
      (entry) => entry.reason === 'too-many-sources',
    );
    expect(capped.map((entry) => entry.projectSlug)).toEqual([
      `p${count - 2}`,
      `p${count - 1}`,
    ]);
    expect(capped.every((entry) => entry.status === 'unknown')).toBe(true);
    expect(observeTree).toHaveBeenCalledTimes(LOCAL_SOURCE_STATUS_MAX_FOLDERS);
  });
});
