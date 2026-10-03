import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { FilesystemSkillRegistryProvider } from '../../../providers/registries/filesystem-skill-registry.js';
import {
  clearAll,
  registerSkillRegistryProvider,
  replacePluginProvidersForSource,
} from '../../../providers/registries/registry.js';
import { RegistrySourceManager } from '../../../providers/registries/registry-source-manager.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
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
  const app = createRegistryRoutes(config, async () => {}, undefined, service, {
    logger,
    visibility: {
      resolvePrincipal: () => ({
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        kind: 'human',
        display: 'Operator',
      }),
    },
  });
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
      registryKey: 'publisher/catalog',
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
