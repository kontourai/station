import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { FilesystemSkillRegistryProvider } from '../../../providers/registries/filesystem-skill-registry.js';
import {
  clearAll,
  registerPluginRegistryProvider,
  registerSkillRegistryProvider,
  replacePluginProvidersForSource,
} from '../../../providers/registries/registry.js';
import {
  readRegistryInstallAliases,
  writeRegistryInstallAliases,
} from '../../../providers/registries/registry-install-aliases.js';
import { RegistrySourceManager } from '../../../providers/registries/registry-source-manager.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from '../../../services/plugins/plugin-incarnation.js';
import {
  capturePluginRegistryAcquisition,
  resolvePluginRegistryInstall,
} from '../../../services/plugins/plugin-install-transaction.js';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
} from '../../../services/plugins/registry-supply-chain.js';
import { createLocalRegistryTrustPolicyAuthority } from '../../../services/plugins/registry-trust-policy.js';
import { createLogger } from '../../../utils/logger.js';
import { createRegistryRoutes } from '../registry.js';

const temporary = trackTempDirs();
const logger = createLogger({ name: 'marketplace-test' });
afterEach(clearAll);

function setup() {
  clearAll();
  const home = temporary('marketplace-home-');
  const config = new ConfigLoader({ projectHomeDir: home });
  const service = new SkillService(config, logger);
  const app = withOperatorPrincipal(
    createRegistryRoutes(config, async () => {}, undefined, service, {
      logger,
      canSeePlugin: () => true,
      visibility: {
        resolvePrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          kind: 'human',
          display: 'Operator',
        }),
      },
    }),
  );
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { home, config, service, app, request };
}

async function library(text: string) {
  const root = temporary('marketplace-library-');
  await mkdir(join(root, 'clarify'));
  await writeFile(
    join(root, 'clarify', 'SKILL.md'),
    `---\nname: clarify\ndescription: Clarify work\n---\n\n${text}`,
  );
  await mkdir(join(root, 'clarify', 'assets'));
  await writeFile(
    join(root, 'clarify', 'assets', 'bytes.bin'),
    Buffer.from([0, 255, text.length]),
  );
  return root;
}

async function add(
  request: ReturnType<typeof setup>['request'],
  name: string,
  location: string,
) {
  const response = await request('/sources', 'POST', {
    displayName: name,
    adapter: 'directory',
    location,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { data: RegistrySource }).data;
}

async function catalog(request: ReturnType<typeof setup>['request']) {
  const response = await request('/skills');
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: RegistryItem[] }).data;
}

describe('Marketplace source lifecycle through Registry routes', () => {
  test.each(['malformed', 'unsupported', 'oversized'] as const)(
    'refuses %s source configuration on restart without replacing its bytes',
    async (shape) => {
      const home = temporary('marketplace-config-');
      const file = join(home, 'config/registry-sources.json');
      await mkdir(join(home, 'config'));
      const bytes =
        shape === 'malformed'
          ? '{bad'
          : shape === 'unsupported'
            ? JSON.stringify({ version: 2, sources: [], disabled: [] })
            : JSON.stringify({
                version: 1,
                sources: [],
                disabled: ['x'.repeat(8 * 1024 * 1024)],
              });
      await writeFile(file, bytes);
      expect(() => new RegistrySourceManager(home)).toThrow(
        'Registry source configuration',
      );
      expect(await readFile(file, 'utf8')).toBe(bytes);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'refuses symlink and FIFO source configurations without following or replacing them',
    async () => {
      const home = temporary('marketplace-config-special-');
      const file = join(home, 'config/registry-sources.json');
      const target = join(home, 'retained.json');
      await mkdir(join(home, 'config'));
      const bytes = JSON.stringify({
        version: 1,
        sources: [],
        disabled: [],
        snapshots: {},
      });
      await writeFile(target, bytes);
      await symlink(target, file);
      expect(() => new RegistrySourceManager(home)).toThrow(
        'bounded regular file',
      );
      expect((await lstat(file)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe(bytes);
      await rm(file);
      execFileSync('mkfifo', [file], { windowsHide: true, timeout: 5000 });
      expect(() => new RegistrySourceManager(home)).toThrow(
        'bounded regular file',
      );
      expect((await lstat(file)).isFIFO()).toBe(true);
    },
  );

  test('bounds persisted offline catalogs by count and bytes while keeping live discovery available', async () => {
    const { home } = setup();
    let large = false;
    for (let n = 0; n < 34; n += 1) {
      registerPluginRegistryProvider({
        registryKey: `bounded-${n}`,
        listAvailable: async () =>
          Array.from({ length: large && n >= 25 ? 512 : 1 }, (_, i) => ({
            id: `item-${i}`,
            installed: false,
            ...(large && n >= 25 ? { description: 'x'.repeat(2000) } : {}),
          })),
        listInstalled: async () => [],
        install: async () => ({
          success: false,
          message: 'Not an install fixture',
        }),
        uninstall: async () => ({
          success: false,
          message: 'Not an install fixture',
        }),
      });
    }
    const manager = new RegistrySourceManager(home);
    expect(await manager.catalog('plugins')).toHaveLength(34);
    const file = join(home, 'config/registry-sources.json');
    const first = JSON.parse(await readFile(file, 'utf8')) as {
      snapshots: Record<string, unknown>;
    };
    expect(Object.keys(first.snapshots)).toHaveLength(32);
    large = true;
    expect(await manager.catalog('plugins')).toHaveLength(9 * 512 + 25);
    const bytes = await readFile(file);
    expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    const retained = JSON.parse(bytes.toString()) as {
      snapshots: Record<string, unknown>;
    };
    expect(Object.keys(retained.snapshots).length).toBeLessThan(32);
    expect(Object.keys(retained.snapshots).length).toBeGreaterThan(0);
    expect(new RegistrySourceManager(home).list()).toHaveLength(34);
  }, 30000);

  test('a manifest catalog request binds every row and package claim to one fresh network observation', async () => {
    const { request } = setup();
    let calls = 0;
    const remote = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            version: 1,
            plugins: Array.from({ length: 3 }, (_, n) => ({
              id: `item-${n}`,
              source: `https://catalog.example/packages/${n}-${calls}`,
              version: `${calls}.0.0`,
              claim: { observation: calls },
            })),
          }),
        );
      });
    try {
      expect(
        (
          await request('/sources', 'POST', {
            displayName: 'Coherent catalog',
            adapter: 'manifest',
            location: 'https://catalog.example/catalog.json',
          })
        ).status,
      ).toBe(201);
      const first = (
        (await (await request('/plugins')).json()) as { data: RegistryItem[] }
      ).data;
      expect(calls).toBe(1);
      expect(first.map((item) => item.version)).toEqual([
        '1.0.0',
        '1.0.0',
        '1.0.0',
      ]);
      expect(first[0]!.packageRevision).toBe(
        createHash('sha256')
          .update(
            JSON.stringify({
              source: 'https://catalog.example/packages/0-1',
              claim: { observation: 1 },
            }),
          )
          .digest('hex'),
      );
      const second = (
        (await (await request('/plugins')).json()) as { data: RegistryItem[] }
      ).data;
      expect(calls).toBe(2);
      expect(second.map((item) => item.version)).toEqual([
        '2.0.0',
        '2.0.0',
        '2.0.0',
      ]);
      expect(second[0]!.id).not.toBe(first[0]!.id);
    } finally {
      remote.mockRestore();
    }
  });

  test.each(['skills', 'plugins'] as const)(
    '%s catalog failures refuse an empty-success response and retain healthy independent observations',
    async (kind) => {
      const { request, home } = setup();
      const missing = join(home, 'missing-source');
      let rows: RegistryItem[] = [];
      await expect(access(missing)).rejects.toThrow();
      expect(
        (
          await request('/sources', 'POST', {
            displayName: 'Unavailable catalog',
            adapter: kind === 'plugins' ? 'manifest' : 'directory',
            location: missing,
          })
        ).status,
      ).toBe(201);
      const failed = await request(`/${kind}`);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        success: false,
        data: [],
        partial: true,
        sources: [expect.objectContaining({ status: 'error', kind })],
      });
      const register =
        kind === 'plugins'
          ? registerPluginRegistryProvider
          : registerSkillRegistryProvider;
      register({
        registryKey: 'healthy-independent-catalog',
        listAvailable: async () => rows,
        listInstalled: async () => [],
        install: async () => ({
          success: false,
          message: 'Not an install fixture',
        }),
        uninstall: async () => ({
          success: false,
          message: 'Not an install fixture',
        }),
      });
      const healthyEmpty = await request(`/${kind}`);
      expect(healthyEmpty.status).toBe(200);
      expect(await healthyEmpty.json()).toMatchObject({
        success: true,
        data: [],
        partial: true,
      });
      rows = [{ id: 'available', installed: false }];
      const partial = await request(`/${kind}`);
      expect(partial.status).toBe(200);
      expect(await partial.json()).toMatchObject({
        success: true,
        partial: true,
        data: [
          expect.objectContaining({
            catalog: expect.objectContaining({ itemId: 'available' }),
          }),
        ],
        sources: expect.arrayContaining([
          expect.objectContaining({ status: 'error' }),
        ]),
      });
    },
  );

  test.each(['plugin', 'agent-plugin'] as const)(
    'hides %s provided Skill ownership from public catalog conflicts while retaining an operator control',
    async (kind) => {
      const { home, config } = setup();
      const publicRoot = await library('Public instructions');
      let afterPublicRead: (() => void) | undefined;
      class PublicLibrary extends FilesystemSkillRegistryProvider {
        override async listAvailable() {
          const items = await super.listAvailable();
          afterPublicRead?.();
          return items;
        }
      }
      registerSkillRegistryProvider(new PublicLibrary([publicRoot]));
      const privateRoot = await library('Private package instructions');
      const source = `${kind}:private-provider` as const;
      const service = new SkillService(
        config,
        logger,
        kind === 'plugin'
          ? {
              pluginCommandSource: () => [
                {
                  name: 'clarify',
                  description: 'Private supplied skill',
                  body: 'Private instructions',
                  resources: [],
                  location: join(privateRoot, 'plugin.json'),
                  source,
                },
              ],
            }
          : {
              canonicalSources: [
                {
                  root: privateRoot,
                  label: 'agent-plugin:private-provider',
                  origin: 'plugin',
                },
              ],
            },
      );
      await service.discoverSkills(home);
      expect(service.listSkills()).toEqual([
        expect.objectContaining({
          name: 'clarify',
          origin: 'plugin',
          source,
          installed: true,
        }),
      ]);
      const listing = async (visible: boolean, revokeDuringRead = false) => {
        let allowed = visible;
        afterPublicRead = revokeDuringRead
          ? () => {
              allowed = false;
            }
          : undefined;
        const app = createRegistryRoutes(
          config,
          async () => {},
          undefined,
          service,
          {
            logger,
            canSeePlugin: (_context, owner) =>
              allowed && owner === 'private-provider',
          },
        );
        const response = await app.request('/skills');
        expect(response.status).toBe(200);
        return (await response.json()) as { data: RegistryItem[] };
      };
      const hidden = await listing(false);
      expect(hidden.data).toHaveLength(1);
      expect(hidden.data[0]).toMatchObject({ installed: false });
      expect(hidden.data[0]!.status).not.toBe('installed-name-conflict');
      expect(JSON.stringify(hidden)).not.toContain('private-provider');
      const operator = await listing(true);
      expect(operator.data[0]).toMatchObject({
        installed: false,
        status: 'installed-name-conflict',
      });
      const revoked = await listing(true, true);
      expect(revoked.data[0]!.status).not.toBe('installed-name-conflict');
      expect(revoked.data[0]!.installed).toBe(false);
    },
  );

  test('configured multi-root filesystem libraries keep stable distinct source choices and install the exact same-name package', async () => {
    const { request, home } = setup();
    const first = await library('Configured first instructions');
    const second = await library('Configured second instructions');
    registerSkillRegistryProvider(
      new FilesystemSkillRegistryProvider([first, second]),
    );
    const items = await catalog(request);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.catalog?.sourceId)).size).toBe(2);
    const chosen = items.find((item) => item.source === second)!;
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(200);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('Configured second instructions');
    expect(
      await readFile(join(home, 'skills/clarify/assets/bytes.bin')),
    ).toEqual(await readFile(join(second, 'clarify/assets/bytes.bin')));
  });

  test('an installed private skill cannot read or update its source when caller visibility is refused, or publish when revoked during staging', async () => {
    const { request, home, config, service } = setup();
    const root = await library('Retained instructions');
    const calls = { list: 0, install: 0 };
    let allowed = true;
    let revokeDuringInstall = false;
    class PrivateLibrary extends FilesystemSkillRegistryProvider {
      override async listAvailable() {
        calls.list += 1;
        return super.listAvailable();
      }
      override async install(
        id: string,
        target: string,
        options?: { expectedPackageRevision?: string },
      ) {
        calls.install += 1;
        const result = await super.install(id, target, options);
        if (revokeDuringInstall) allowed = false;
        return result;
      }
    }
    await replacePluginProvidersForSource('private-library-plugin', [
      {
        type: 'skillRegistry',
        source: 'private-library-plugin',
        provider: new PrivateLibrary([root]),
      },
    ]);
    const selected = (await catalog(request))[0]!;
    expect(
      (await request('/skills/install', 'POST', { id: selected.id })).status,
    ).toBe(200);
    const app = createRegistryRoutes(
      config,
      async () => {},
      undefined,
      service,
      { logger, canSeePlugin: () => allowed },
    );
    calls.list = 0;
    calls.install = 0;
    allowed = false;
    expect(
      (await app.request('/skills/clarify/update', { method: 'POST' })).status,
    ).toBe(403);
    expect((await app.request(`/skills/${selected.id}/content`)).status).toBe(
      403,
    );
    expect(calls).toEqual({ list: 0, install: 0 });
    allowed = true;
    revokeDuringInstall = true;
    await writeFile(
      join(root, 'clarify/SKILL.md'),
      '---\nname: clarify\ndescription: New private content\n---\n\nReplacement instructions',
    );
    expect(
      (await app.request('/skills/clarify/update', { method: 'POST' })).status,
    ).toBe(403);
    expect(calls.install).toBe(1);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('Retained instructions');
  });

  test('keeps same-name choices and installs only the inspected source with complete bytes and durable provenance', async () => {
    const { request, home, config, service } = setup();
    const first = await library('First instructions');
    const second = await library('Second instructions');
    const a = await add(request, 'First collection', first);
    const b = await add(request, 'Second collection', second);
    const items = await catalog(request);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    const chosen = items.find((item) => item.catalog?.sourceId === b.id)!;
    expect((await request(`/skills/${chosen.id}/content`)).status).toBe(200);
    expect(
      (await request('/skills/install', 'POST', { id: 'clarify' })).status,
    ).toBe(500);
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(200);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('Second instructions');
    expect(
      await readFile(join(home, 'skills/clarify/assets/bytes.bin')),
    ).toEqual(await readFile(join(second, 'clarify/assets/bytes.bin')));
    expect(
      (await config.loadSkill('clarify')).provenance?.catalog,
    ).toMatchObject({
      sourceId: b.id,
      itemId: 'clarify',
      revision: chosen.catalog?.revision,
      source: second,
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(service.listSkills()[0]?.provenance?.catalog?.sourceId).toBe(b.id);
    expect(
      (
        await request(
          `/skills/${items.find((item) => item.catalog?.sourceId === a.id)!.id}`,
          'DELETE',
        )
      ).status,
    ).toBe(409);
  });

  test('caller projection withholds ungranted plugin-owned skill sources and refuses a copied selection before effects', async () => {
    const { config, service, request, home } = setup();
    await replacePluginProvidersForSource('private-skill-plugin', [
      {
        type: 'skillRegistry',
        source: 'private-skill-plugin',
        provider: {
          registryKey: 'private-skills',
          listAvailable: async () => [
            { id: 'private-skill', installed: false },
          ],
          listInstalled: async () => [],
          getPackageRevision: async () => 'private-revision',
          getContent: async () => 'Private instructions',
          install: async () => ({ success: false, message: 'not expected' }),
          uninstall: async () => ({ success: false, message: 'not expected' }),
        },
      },
    ]);
    const selected = (await catalog(request))[0]!;
    expect(selected.catalogSourceName).toBe('private-skill-plugin');
    const denied = createRegistryRoutes(
      config,
      async () => {},
      undefined,
      service,
      { logger, canSeePlugin: () => false },
    );
    expect(await (await denied.request('/skills')).json()).toMatchObject({
      data: [],
      sources: [],
    });
    expect(
      (await denied.request(`/skills/${selected.id}/content`)).status,
    ).toBe(403);
    expect(
      (
        await denied.request('/skills/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: selected.id }),
        })
      ).status,
    ).toBe(403);
    await expect(access(join(home, 'skills/private-skill'))).rejects.toThrow();
  });

  test('a selected provider refusal never installs or inspects a same-name alternative', async () => {
    const { request, home } = setup();
    const alternate = await library('Wrong source instructions');
    registerSkillRegistryProvider({
      registryKey: 'refusing-publisher',
      listAvailable: async () => [
        { id: 'clarify', description: 'Refused selection', installed: false },
      ],
      listInstalled: async () => [],
      getPackageRevision: async () => 'pinned-source-revision',
      getContent: async () => null,
      install: async () => ({
        success: false,
        message: 'Publisher refuses acquisition.',
      }),
      uninstall: async () => ({ success: false, message: 'not owned' }),
    });
    registerSkillRegistryProvider(
      new FilesystemSkillRegistryProvider([alternate]),
    );
    const chosen = (await catalog(request)).find(
      (item) => item.description === 'Refused selection',
    )!;
    expect((await request(`/skills/${chosen.id}/content`)).status).toBe(404);
    const refused = await request('/skills/install', 'POST', { id: chosen.id });
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({
      success: false,
      message: 'Publisher refuses acquisition.',
    });
    await expect(access(join(home, 'skills/clarify'))).rejects.toThrow();
  });

  test('source add, disable, enable and removal survive restart without deleting installed content', async () => {
    const { request, home, config } = setup();
    const source = await add(
      request,
      'Restart collection',
      await library('Keep this package'),
    );
    const chosen = (await catalog(request))[0]!;
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(200);
    expect(
      (await request(`/sources/${source.id}`, 'PATCH', { enabled: false }))
        .status,
    ).toBe(200);
    expect(new RegistrySourceManager(home).list()).toMatchObject([
      { id: source.id, enabled: false },
    ]);
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(409);
    expect(
      (await request(`/sources/${source.id}`, 'PATCH', { enabled: true }))
        .status,
    ).toBe(200);
    expect((await request(`/sources/${source.id}`, 'DELETE')).status).toBe(200);
    expect(new RegistrySourceManager(home).list()).toEqual([]);
    expect(
      (await config.loadSkill('clarify')).provenance?.catalog?.sourceId,
    ).toBe(source.id);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('Keep this package');
  });

  test('refuses a changed asset revision before publication and keeps other sources available when one fails', async () => {
    const { request, home } = setup();
    const root = await library('Reviewed content');
    const source = await add(request, 'Reviewed collection', root);
    const chosen = (await catalog(request))[0]!;
    await writeFile(
      join(root, 'clarify/assets/bytes.bin'),
      Buffer.from([1, 2, 3]),
    );
    expect((await request(`/skills/${chosen.id}/content`)).status).toBe(409);
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(409);
    await expect(access(join(home, 'skills/clarify'))).rejects.toThrow();
    const missing = await add(
      request,
      'Offline collection',
      join(root, 'missing'),
    );
    // A missing local source is a named unavailable catalog, never a fabricated empty source.
    const refreshed = await request(`/sources/${missing.id}/refresh`, 'POST');
    expect(await refreshed.json()).toMatchObject({ data: { status: 'error' } });
    const listed = await request('/skills');
    expect(await listed.json()).toMatchObject({
      success: true,
      partial: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: source.id, status: 'ready' }),
        expect.objectContaining({ id: missing.id, status: 'error' }),
      ]),
    });
  });

  test('failed update preserves the existing package and successful update replaces it through the staged owner', async () => {
    const { request, home } = setup();
    const root = await library('Old instructions');
    const source = await add(request, 'Updates', root);
    const chosen = (await catalog(request))[0]!;
    expect(
      (await request('/skills/install', 'POST', { id: chosen.id })).status,
    ).toBe(200);
    await request(`/sources/${source.id}`, 'PATCH', { enabled: false });
    expect((await request('/skills/clarify/update', 'POST')).status).toBe(409);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('Old instructions');
    await request(`/sources/${source.id}`, 'PATCH', { enabled: true });
    await writeFile(
      join(root, 'clarify/SKILL.md'),
      '---\nname: clarify\ndescription: Updated clarification\n---\n\nNew instructions',
    );
    expect((await request('/skills/clarify/update', 'POST')).status).toBe(200);
    expect(
      await readFile(join(home, 'skills/clarify/SKILL.md'), 'utf8'),
    ).toContain('New instructions');
  });

  test('installs a source-qualified package through the real authority and updates legacy aliases across catalog revisions without changing the data owner', async () => {
    const { home, config, service } = setup();
    await ensureStationHomeSchema(home);
    const root = temporary('marketplace-plugin-package-');
    const packageRoot = join(root, 'shared');
    await mkdir(packageRoot);
    const manifestPath = join(root, 'catalog.json');
    const writeVersion = async (version: string) => {
      await writeFile(
        join(packageRoot, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: 'shared',
          version,
        }),
      );
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          plugins: [{ id: 'shared', version, source: './shared' }],
          tools: [],
        }),
      );
    };
    await writeVersion('1.0.0');
    const store = new EventStore(join(home, 'events.sqlite'));
    try {
      const app = withOperatorPrincipal(
        createRegistryRoutes(config, async () => {}, undefined, service, {
          logger,
          packageMcpJournal: store.createPackageMcpAdmissionJournal(),
          visibility: {
            resolvePrincipal: () => ({
              id: LOCAL_OPERATOR_PRINCIPAL_ID,
              kind: 'human',
              display: 'Operator',
            }),
          },
        }),
      );
      const call = (path: string, body?: unknown) =>
        app.request(path, {
          method: body ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      expect(
        (
          await call('/sources', {
            displayName: 'Package catalog',
            adapter: 'manifest',
            location: manifestPath,
          })
        ).status,
      ).toBe(201);
      const install = async () => {
        const item = (
          (await (await call('/plugins')).json()) as { data: RegistryItem[] }
        ).data[0]!;
        const result = await call('/plugins/install', {
          id: item.id,
          dataPolicy: 'preserve',
          consent: {
            permissions: [],
            contentDigest: computePluginContentDigest(root, 'shared'),
            dependencies: [],
          },
        });
        const outcome = await result.json();
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          success: true,
        });
        expect(result.status).toBe(200);
        return item;
      };
      const first = await install();
      const before = resolveInstalledPluginRoot(
        join(home, 'plugins'),
        'shared',
      )!;
      expect(Object.keys(readRegistryInstallAliases(home))).toEqual([first.id]);
      writeRegistryInstallAliases(home, {
        shared: readRegistryInstallAliases(home)[first.id]!,
      });
      const otherManifest = join(root, 'other-catalog.json');
      await writeFile(
        otherManifest,
        JSON.stringify({
          version: 1,
          plugins: [{ id: 'shared', source: './shared', version: '1.0.0' }],
        }),
      );
      const connected = await call('/sources', {
        displayName: 'Other catalog',
        adapter: 'manifest',
        location: otherManifest,
      });
      expect(connected.status).toBe(201);
      const otherSource = ((await connected.json()) as { data: RegistrySource })
        .data;
      const otherItem = (
        (await (await call('/plugins')).json()) as { data: RegistryItem[] }
      ).data.find((item) => item.catalog?.sourceId === otherSource.id)!;
      const refused = await call('/plugins/install', {
        id: otherItem.id,
        dataPolicy: 'preserve',
        consent: {
          permissions: [],
          contentDigest: computePluginContentDigest(root, 'shared'),
          dependencies: [],
        },
      });
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({
        success: false,
        message: expect.stringContaining('already linked'),
      });
      expect(
        resolveInstalledPluginRoot(join(home, 'plugins'), 'shared')!.dataScope,
      ).toEqual(before.dataScope);
      await writeVersion('2.0.0');
      const revised = (
        (await (await call('/plugins')).json()) as { data: RegistryItem[] }
      ).data[0]!;
      expect(revised).toMatchObject({
        installed: true,
        installedPluginName: 'shared',
      });
      const second = await install();
      expect(second.id).not.toBe(first.id);
      const after = resolveInstalledPluginRoot(
        join(home, 'plugins'),
        'shared',
      )!;
      expect(after.dataScope).toEqual(before.dataScope);
      expect(
        JSON.parse(
          await readFile(join(after.packageRoot, 'plugin.json'), 'utf8'),
        ).version,
      ).toBe('2.0.0');
      expect(Object.keys(readRegistryInstallAliases(home))).toEqual([
        second.id,
      ]);
      const installed = (
        (await (await call('/plugins')).json()) as { data: RegistryItem[] }
      ).data[0]!;
      expect(installed).toMatchObject({
        installed: true,
        installedPluginName: 'shared',
      });
      await rm(manifestPath);
      const offline = (
        (await (await call('/plugins')).json()) as { data: RegistryItem[] }
      ).data[0]!;
      expect(offline).toMatchObject({
        catalogFreshness: 'stale',
        installed: true,
        installedPluginName: 'shared',
      });
      expect(
        (await app.request('/plugins/shared', { method: 'DELETE' })).status,
      ).toBe(200);
      const removed = (
        (await (await call('/plugins')).json()) as { data: RegistryItem[] }
      ).data[0]!;
      expect(removed.installed).toBe(false);
      expect(removed.installedPluginName).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('resolves same-name plugin catalogs exactly and refuses a removed or changed source', async () => {
    const { request } = setup();
    const root = temporary('marketplace-manifests-');
    const manifests = await Promise.all(
      ['one', 'two'].map(async (name) => {
        const path = join(root, `${name}.json`);
        await writeFile(
          path,
          JSON.stringify({
            version: 1,
            plugins: [{ id: 'shared', displayName: name, source: `./${name}` }],
            tools: [],
          }),
        );
        const response = await request('/sources', 'POST', {
          displayName: name,
          adapter: 'manifest',
          location: path,
        });
        expect(response.status).toBe(201);
        return {
          path,
          source: ((await response.json()) as { data: RegistrySource }).data,
        };
      }),
    );
    const items = (
      (await (await request('/plugins')).json()) as { data: RegistryItem[] }
    ).data;
    expect(items).toHaveLength(2);
    const selected = items.find(
      (item) => item.catalog?.sourceId === manifests[1]!.source.id,
    )!;
    expect(await resolvePluginRegistryInstall(selected.id)).toMatchObject({
      source: join(root, 'two'),
    });
    await writeFile(
      manifests[1]!.path,
      JSON.stringify({
        version: 2,
        plugins: [{ id: 'shared', source: './changed' }],
        tools: [],
      }),
    );
    await expect(resolvePluginRegistryInstall(selected.id)).rejects.toThrow(
      'changed',
    );
    await request(`/sources/${manifests[1]!.source.id}`, 'DELETE');
    await expect(resolvePluginRegistryInstall(selected.id)).rejects.toThrow(
      'no longer available',
    );
  });

  test('revocation during a catalog read withholds the result and its prior cached snapshot', async () => {
    const { request } = setup();
    let waiting = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      registryKey: 'in-flight-publisher',
      listAvailable: async () => {
        if (waiting) {
          enter();
          await released;
        }
        return [{ id: 'pending-package', installed: false }];
      },
      listInstalled: async () => [],
      resolvePackage: async () => ({ source: '/catalog/pending' }),
      install: async () => ({ success: false, message: 'refused' }),
      uninstall: async () => ({ success: false, message: 'refused' }),
    };
    await replacePluginProvidersForSource('in-flight-publisher', [
      { type: 'pluginRegistry', source: 'in-flight-publisher', provider },
    ]);
    expect(
      ((await (await request('/plugins')).json()) as { data: RegistryItem[] })
        .data,
    ).toHaveLength(1);
    waiting = true;
    const pending = request('/plugins');
    await entered;
    await replacePluginProvidersForSource('in-flight-publisher', []);
    release();
    expect(
      ((await (await pending).json()) as { data: RegistryItem[] }).data,
    ).toEqual([]);
  });

  test('verifies the publisher signed item ID through the source-qualified selection and refuses changed signing metadata', async () => {
    const { home, config, request } = setup();
    await ensureStationHomeSchema(home);
    const pair = generateKeyPairSync('ed25519');
    const policy = {
      profiles: [
        {
          registryKey: 'signed-marketplace',
          signatures: 'required' as const,
          trustedEd25519Keys: {
            publisher: pair.publicKey
              .export({ type: 'spki', format: 'pem' })
              .toString(),
          },
        },
      ],
    };
    await config.mutateAppConfig(() => ({ registryTrust: policy }));
    const store = new EventStore(join(home, 'events.sqlite'));
    try {
      const authority = createLocalRegistryTrustPolicyAuthority(
        home,
        store.createRegistryTrustPolicyDecisions(),
      );
      await authority.publishApplied(
        await authority.captureApplication(),
        policy,
      );
      const source = 'https://example.invalid/signed-package.git';
      const contentDigest = `sha256:${createHash('sha256').update('reviewed package').digest('hex')}`;
      const unsigned: RegistryPackageClaim = {
        packageSchema:
          'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        registryId: 'signed-package',
        registryKey: 'signed-marketplace',
        pluginName: 'signed-package',
        packageVersion: '1.0.0',
        source,
        packageDigest: contentDigest,
      };
      let claim: RegistryPackageClaim = {
        ...unsigned,
        signature: {
          algorithm: 'ed25519',
          keyId: 'publisher',
          value: sign(
            null,
            registryPackageSignaturePayload(unsigned),
            pair.privateKey,
          ).toString('base64'),
        },
      };
      await replacePluginProvidersForSource('signing-plugin', [
        {
          type: 'pluginRegistry',
          source: 'signing-plugin',
          provider: {
            registryKey: 'signed-marketplace',
            listAvailable: async () => [
              { id: 'signed-package', installed: false },
            ],
            listInstalled: async () => [],
            resolvePackage: async () => ({ source, claim }),
            install: async () => ({
              success: false,
              message: 'Not an installation test',
            }),
            uninstall: async () => ({
              success: false,
              message: 'Not an installation test',
            }),
          },
        },
      ]);
      const item = (
        (await (await request('/plugins')).json()) as { data: RegistryItem[] }
      ).data[0]!;
      const captured = await capturePluginRegistryAcquisition(
        source,
        { name: 'signed-package', version: '1.0.0' },
        contentDigest,
        { projectHomeDir: home, registryTrustPolicyAuthority: authority },
        item.id,
        'signed-marketplace',
      );
      expect(captured.registryAcquisition).toMatchObject({
        registryId: 'signed-package',
        signer: { keyId: 'publisher' },
      });
      claim = {
        ...claim,
        signature: { ...claim.signature!, keyId: 'changed-publisher' },
      };
      await expect(
        capturePluginRegistryAcquisition(
          source,
          { name: 'signed-package', version: '1.0.0' },
          contentDigest,
          { projectHomeDir: home, registryTrustPolicyAuthority: authority },
          item.id,
          'signed-marketplace',
        ),
      ).rejects.toThrow('changed');
    } finally {
      store.close();
    }
  });

  test('uses the published provider contribution lifecycle and refuses its prior generation after replacement or revoke', async () => {
    const { request } = setup();
    const provider = {
      registryKey: 'fixture',
      listAvailable: async () => [
        { id: 'shared', source: '/catalog/a', installed: false },
      ],
      listInstalled: async () => [],
      resolvePackage: async () => ({ source: '/catalog/a' }),
      install: async () => ({ success: false, message: 'refused' }),
      uninstall: async () => ({ success: false, message: 'refused' }),
    };
    await replacePluginProvidersForSource('publisher', [
      { type: 'pluginRegistry', source: 'publisher', provider },
    ]);
    const chosen = (
      (await (await request('/plugins')).json()) as { data: RegistryItem[] }
    ).data[0]!;
    expect(await resolvePluginRegistryInstall(chosen.id)).toMatchObject({
      source: '/catalog/a',
    });
    await replacePluginProvidersForSource('publisher', [
      { type: 'pluginRegistry', source: 'publisher', provider },
    ]);
    await expect(resolvePluginRegistryInstall(chosen.id)).rejects.toThrow(
      'changed',
    );
    await replacePluginProvidersForSource('publisher', []);
    expect(
      ((await (await request('/plugins')).json()) as { data: RegistryItem[] })
        .data,
    ).toEqual([]);
    await expect(resolvePluginRegistryInstall(chosen.id)).rejects.toThrow(
      'no longer available',
    );
  });
});
