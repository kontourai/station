/**
 * #4521: `limits.registries` at the acquisition paths: the real registry
 * routes and `RegistrySourceManager` for marketplace skills, the name-based
 * plugin resolver, the registry trust check a plugin install runs, and the
 * default skill registry registration. Each refusal has a no-policy control
 * that takes the same path to success.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type {
  RegistryItem,
  RegistrySource,
} from '@kontourai/station-contracts/catalog';
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import {
  clearAll,
  getPluginRegistryProviders,
  registerPluginRegistryProvider,
} from '../../../providers/registries/registry.js';
import { writeRegistryInstallAliases } from '../../../providers/registries/registry-install-aliases.js';
import { prepareRuntimeStartup } from '../../../runtime/bootstrap/runtime-startup.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
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
const logger = createLogger({ name: 'managed-registry-test', level: 'error' });

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
  vi.unstubAllGlobals();
});

function installPolicy(registries: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { registries },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

function setup() {
  clearAll();
  const home = temporary('managed-registry-home-');
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
  return { home, config, request };
}

async function library() {
  const root = temporary('managed-registry-library-');
  await mkdir(join(root, 'clarify'));
  await writeFile(
    join(root, 'clarify', 'SKILL.md'),
    '---\nname: clarify\ndescription: Clarify work\n---\n\nInstructions',
  );
  return root;
}

/** A user marketplace on a local folder and its one catalog item. */
async function marketplace(request: ReturnType<typeof setup>['request']) {
  const added = await request('/sources', 'POST', {
    displayName: 'Team skills',
    adapter: 'directory',
    location: await library(),
  });
  expect(added.status).toBe(201);
  const source = ((await added.json()) as { data: RegistrySource }).data;
  const items = (
    (await (await request('/skills')).json()) as {
      data: RegistryItem[];
    }
  ).data;
  expect(items).toHaveLength(1);
  return { source, item: items[0]! };
}

async function expectManaged(response: Response, subject: string) {
  expect(response.status).toBe(403);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe(MANAGED_POLICY_CAPABILITY_DISABLED_CODE);
  expect(String(body.error ?? body.message)).toContain(
    `Acme's policy manages ${subject}`,
  );
}

describe('marketplace skills under limits.registries', () => {
  test('control: without a policy the catalog item installs', async () => {
    const { request, home } = setup();
    const { item } = await marketplace(request);
    expect(
      (await request('/skills/install', 'POST', { id: item.id })).status,
    ).toBe(200);
    await access(join(home, 'skills/clarify/SKILL.md'));
  });

  test.each([
    [
      'an allow list that does not name the folder',
      { allowedUrls: [] },
      'this marketplace',
    ],
    [
      'unsigned packages refused (a skill cannot be signed)',
      { unsignedPackages: false },
      'skills from marketplaces',
    ],
  ])(
    '%s: the source reads as disabled, and install, enable and refresh are refused',
    async (_name, registries, subject) => {
      const { request, home } = setup();
      const { source, item } = await marketplace(request);
      installPolicy(registries);

      const listed = (
        (await (await request('/sources')).json()) as {
          data: RegistrySource[];
        }
      ).data.find((entry) => entry.id === source.id);
      expect(listed).toMatchObject({ enabled: false, status: 'disabled' });
      expect(listed?.managedDenial).toContain(
        `Acme's policy manages ${subject}`,
      );
      expect(
        ((await (await request('/skills')).json()) as { data: RegistryItem[] })
          .data,
      ).toEqual([]);

      await expectManaged(
        await request('/skills/install', 'POST', { id: item.id }),
        subject,
      );
      await expect(
        access(join(home, 'skills/clarify/SKILL.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expectManaged(
        await request(`/sources/${source.id}`, 'PATCH', { enabled: true }),
        subject,
      );
      await expectManaged(
        await request(`/sources/${source.id}/refresh`, 'POST'),
        subject,
      );
      await expectManaged(
        await request('/sources', 'POST', {
          displayName: 'Another folder',
          adapter: 'directory',
          location: await library(),
        }),
        subject,
      );
    },
  );
});

describe('plugin registries under limits.registries', () => {
  function provider(registryKey: string) {
    return {
      registryKey,
      listAvailable: async () => [{ id: 'tool-pack', installed: false }],
      listInstalled: async () => [],
      resolveSource: async () => 'https://example.invalid/tool-pack.git',
      install: async () => ({ success: false, message: 'not an install' }),
      uninstall: async () => ({ success: false, message: 'not an install' }),
    };
  }

  test('the name-based resolver skips a provider outside the allow list and says why', async () => {
    clearAll();
    registerPluginRegistryProvider(
      provider('https://unlisted.example.com/registry.json'),
      'Configured registry',
    );
    await expect(resolvePluginRegistryInstall('tool-pack')).resolves.toEqual({
      source: 'https://example.invalid/tool-pack.git',
      registryKey: 'https://unlisted.example.com/registry.json',
    });
    installPolicy({
      allowedUrls: ['https://approved.example.com/registry.json'],
    });
    await expect(resolvePluginRegistryInstall('tool-pack')).rejects.toThrow(
      "Acme's policy manages this marketplace",
    );
    // A listed registry still resolves under the same policy.
    clearAll();
    registerPluginRegistryProvider(
      provider('https://approved.example.com/registry.json/'),
      'Configured registry',
    );
    await expect(resolvePluginRegistryInstall('tool-pack')).resolves.toEqual({
      source: 'https://example.invalid/tool-pack.git',
      registryKey: 'https://approved.example.com/registry.json/',
    });
  });

  test('unsignedPackages false requires a signer the host already trusts and adds none', async () => {
    const { home, config } = setup();
    await ensureStationHomeSchema(home);
    const pair = generateKeyPairSync('ed25519');
    // The host's own policy: signatures optional, one trusted key.
    const trust = {
      profiles: [
        {
          registryKey: 'signed-marketplace',
          signatures: 'optional' as const,
          trustedEd25519Keys: {
            publisher: pair.publicKey
              .export({ type: 'spki', format: 'pem' })
              .toString(),
          },
        },
      ],
    };
    await config.mutateAppConfig(() => ({ registryTrust: trust }));
    const store = new EventStore(join(home, 'events.sqlite'));
    try {
      const authority = createLocalRegistryTrustPolicyAuthority(
        home,
        store.createRegistryTrustPolicyDecisions(),
      );
      await authority.publishApplied(
        await authority.captureApplication(),
        trust,
      );
      const source = 'https://example.invalid/signed-package.git';
      const contentDigest = `sha256:${createHash('sha256').update('reviewed').digest('hex')}`;
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
      const signed: RegistryPackageClaim = {
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
      let claim: RegistryPackageClaim = unsigned;
      clearAll();
      registerPluginRegistryProvider(
        {
          registryKey: 'signed-marketplace',
          listAvailable: async () => [
            { id: 'signed-package', installed: false },
          ],
          listInstalled: async () => [],
          resolvePackage: async () => ({ source, claim }),
          install: async () => ({ success: false, message: 'n/a' }),
          uninstall: async () => ({ success: false, message: 'n/a' }),
        },
        'signing-plugin',
      );
      const capture = () =>
        capturePluginRegistryAcquisition(
          source,
          { name: 'signed-package', version: '1.0.0' } as never,
          contentDigest,
          { projectHomeDir: home, registryTrustPolicyAuthority: authority },
          'signed-package',
          'signed-marketplace',
        );

      // Control: the host allows an unsigned package from this registry.
      expect((await capture()).registryAcquisition).toMatchObject({
        signer: null,
      });
      installPolicy({ unsignedPackages: false });
      await expect(capture()).rejects.toMatchObject({
        reason: 'managed-signature-required',
      });
      // A package signed by the host's trusted key still installs.
      claim = signed;
      expect((await capture()).registryAcquisition).toMatchObject({
        signer: { keyId: 'publisher' },
      });
      // The policy adds no trust: on a host with no registry trust policy
      // there is no signer to accept, so a registry install is refused. (No
      // policy installed, the same call succeeds unverified.)
      const bare = temporary('managed-registry-bare-');
      const unverified = () =>
        capturePluginRegistryAcquisition(
          source,
          { name: 'signed-package', version: '1.0.0' } as never,
          contentDigest,
          { projectHomeDir: bare },
          undefined,
          'unprofiled-marketplace',
        );
      await expect(unverified()).rejects.toMatchObject({
        reason: 'managed-signature-required',
      });
      installManagedCapabilityLimits(null);
      expect((await unverified()).registryAcquisition).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('unsignedPackages false through the registry install route', () => {
  /**
   * A package host that records every connection: a clone of the package
   * source would connect (its TLS handshake then fails, which is fine).
   */
  async function packageHost() {
    const requests: string[] = [];
    const server = createServer((socket) => {
      requests.push('connection');
      socket.destroy();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP');
    return {
      url: `https://127.0.0.1:${address.port}/unsigned-package.git`,
      requests,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }

  async function installUnsigned(policy: boolean) {
    const host = await packageHost();
    try {
      const { request } = setup();
      registerPluginRegistryProvider(
        {
          registryKey: 'https://approved.example.com/registry.json',
          listAvailable: async () => [
            { id: 'unsigned-package', installed: false },
          ],
          listInstalled: async () => [],
          // The registry's own claim shows the package is unsigned.
          resolvePackage: async () => ({
            source: host.url,
            claim: {
              packageSchema:
                'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
              registryId: 'unsigned-package',
              registryKey: 'https://approved.example.com/registry.json',
              pluginName: 'unsigned-package',
              packageVersion: '1.0.0',
              source: host.url,
              packageDigest: `sha256:${'0'.repeat(64)}`,
            },
          }),
          install: async () => ({ success: false, message: 'n/a' }),
          uninstall: async () => ({ success: false, message: 'n/a' }),
        },
        'Configured registry',
      );
      if (policy) installPolicy({ unsignedPackages: false });
      const response = await request('/plugins/install', 'POST', {
        id: 'unsigned-package',
      });
      return { response, requests: [...host.requests] };
    } finally {
      await host.close();
    }
  }

  test('control: without a policy the install goes on to fetch the package', async () => {
    const { response, requests } = await installUnsigned(false);
    expect(response.status).not.toBe(403);
    expect(requests.length).toBeGreaterThan(0);
  });

  test('an unsigned registry claim is refused with the managed body before any package byte is fetched', async () => {
    const { response, requests } = await installUnsigned(true);
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: false,
      code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
      reason: 'managed-signature-required',
      retryable: false,
    });
    expect(String(body.error)).toBe(
      "Acme's policy manages unsigned registry packages: it is turned off. Contact your administrator for help.",
    );
    expect(requests).toEqual([]);
  });
});

describe('default skill registries', () => {
  async function registered(policy?: Record<string, unknown>) {
    if (policy) installPolicy(policy);
    const createDefaultSkillRegistryProvider = vi.fn(async () => ({}) as never);
    const registerSkillRegistryProvider = vi.fn();
    await prepareRuntimeStartup({
      storageAdapter: { listProjects: () => [] },
      configLoader: { loadPluginOverrides: async () => ({}) },
      appConfig: {},
      createDefaultSkillRegistryProvider,
      registerSkillRegistryProvider,
      skillService: { discoverSkills: async () => {} },
      projectHomeDir: temporary('managed-registry-startup-'),
      timers: [],
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      createUsageAggregator: () => ({}) as never,
      setIntervalImpl: (() => 0) as never,
      seedDefaultProviderConnection: async () => {},
    } as never).catch(() => {});
    return createDefaultSkillRegistryProvider.mock.calls.length;
  }

  test('control: registered without a policy', async () => {
    expect(await registered()).toBe(1);
  });

  test('defaultSkillRegistries false: never registered', async () => {
    expect(await registered({ defaultSkillRegistries: false })).toBe(0);
  });
});

describe('removal is never refused by limits.registries (round 2)', () => {
  const REGISTRY = 'https://registry-b.example/registry.json';

  /** A registry plugin already installed (with no policy) and recorded. */
  async function installedRegistryPlugin() {
    const { request, home } = setup();
    await ensureStationHomeSchema(home);
    const dir = join(home, 'plugins', 'unsigned-package');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({ name: 'unsigned-package', version: '1.0.0' }),
    );
    writeRegistryInstallAliases(home, {
      'unsigned-package': {
        pluginName: 'unsigned-package',
        registryKey: REGISTRY,
      },
    });
    const listed: string[] = [];
    let providerUninstalls = 0;
    registerPluginRegistryProvider(
      {
        registryKey: REGISTRY,
        listAvailable: async () => {
          listed.push('listAvailable');
          return [{ id: 'unsigned-package', installed: true }];
        },
        listInstalled: async () => [],
        // The registry's claim for the package carries no signature.
        resolvePackage: async () => {
          listed.push('resolvePackage');
          return {
            source: 'https://registry-b.example/unsigned-package.git',
            claim: {
              packageSchema:
                'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
              registryId: 'unsigned-package',
              registryKey: REGISTRY,
              pluginName: 'unsigned-package',
              packageVersion: '1.0.0',
              source: 'https://registry-b.example/unsigned-package.git',
              packageDigest: `sha256:${'0'.repeat(64)}`,
            },
          };
        },
        install: async () => ({ success: false, message: 'n/a' }),
        uninstall: async () => {
          providerUninstalls++;
          return { success: false, message: 'raw provider uninstall' };
        },
      },
      'Configured registry',
    );
    return {
      request,
      dir,
      listed,
      providerUninstalls: () => providerUninstalls,
    };
  }

  test.each([
    ['no policy (control)', undefined],
    ['unsignedPackages false', { unsignedPackages: false }],
    ['an allow list that refuses its registry', { allowedUrls: [] }],
  ])(
    '%s: DELETE /agents/:id removes the installed registry plugin',
    async (_name, policy) => {
      const installed = await installedRegistryPlugin();
      if (policy) installPolicy(policy);
      const response = await installed.request(
        '/agents/unsigned-package',
        'DELETE',
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(access(installed.dir)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // The shared uninstall ran, not the provider's raw tree delete.
      expect(installed.providerUninstalls()).toBe(0);
      // A refused registry is not asked anything to remove its package.
      if (policy && 'allowedUrls' in policy)
        expect(installed.listed).toEqual([]);
    },
  );

  test('installing the same unsigned entry is still refused (acquisition)', async () => {
    const installed = await installedRegistryPlugin();
    installPolicy({ unsignedPackages: false });
    await expect(
      resolvePluginRegistryInstall('unsigned-package'),
    ).rejects.toMatchObject({ reason: 'managed-signature-required' });
    expect(installed.listed).toContain('resolvePackage');
  });
});

describe('the agent face of a manifest under allowedUrls (round 2)', () => {
  const UNLISTED = 'https://unlisted-agents.example/registry.json';

  function manifestHost() {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        requested.push(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return Response.json({
          version: 1,
          plugins: [
            {
              id: 'listed-agent',
              type: 'agent',
              displayName: 'Listed agent',
              description: 'An agent from the manifest',
              version: '1.0.0',
              source: 'https://github.com/example/listed-agent',
            },
          ],
        });
      }),
    );
    return requested;
  }

  test('control: without a policy GET /agents reads the manifest and lists its agent', async () => {
    const requested = manifestHost();
    const { request, home } = setup();
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(UNLISTED, home),
    );
    const body = (await (await request('/agents')).json()) as {
      data: RegistryItem[];
    };
    expect(body.data.map((item) => item.id)).toEqual(['listed-agent']);
    expect(requested).toContain(UNLISTED);
  });

  test('an unlisted manifest is never read: no agents, and every face reads nothing', async () => {
    installPolicy({ allowedUrls: [] });
    const requested = manifestHost();
    const { request, home } = setup();
    const provider = new JsonManifestRegistryProvider(UNLISTED, home);
    registerManifestRegistryProvider(provider);
    const body = (await (await request('/agents')).json()) as {
      data: RegistryItem[];
    };
    expect(body.data).toEqual([]);
    expect(
      (await request('/agents/install', 'POST', { id: 'listed-agent' })).status,
    ).not.toBe(200);
    // The shared reader refuses for any face, not only the agent view.
    await expect(provider.listAvailable()).rejects.toThrow(
      "Acme's policy manages this marketplace",
    );
    expect(requested).toEqual([]);
  });

  test('the bundled starter manifest is still read under the same allow list', async () => {
    installPolicy({ allowedUrls: [] });
    const { home } = setup();
    const provider = new JsonManifestRegistryProvider(
      join(process.cwd(), 'examples', 'registry', 'manifest.json'),
      home,
      undefined,
      undefined,
      { bundled: true },
    );
    registerManifestRegistryProvider(provider);
    expect(getPluginRegistryProviders()).toHaveLength(1);
    expect((await provider.listAvailable()).length).toBeGreaterThan(0);
  });
});
