/**
 * #4521 review: `limits.registries` over tool-server (MCP) catalogs, through
 * the real registry routes and the real integration catalog composition. Two
 * kinds of catalog reach `/integrations`: the MCP subregistry an operator
 * configures with `STATION_MCP_SUBREGISTRY_URL`, and a registry manifest's
 * `tools`. `fetch` is a recorder, so each test states which catalogs were
 * contacted. Station's bundled curation stays available under every limit.
 */
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import { clearAll } from '../../../providers/registries/registry.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { createRegistryRoutes } from '../registry.js';

const makeTempDir = trackTempDirs();
const CATALOG = 'https://tools-catalog.example/v0.1/servers';
const MANIFEST = 'https://manifest.example/catalog.json';
const SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

const subregistryPage = JSON.stringify({
  servers: [
    {
      server: {
        $schema: SCHEMA,
        name: 'com.example/tool',
        description: 'A catalog tool server',
        version: '1.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://com.example/mcp' }],
      },
      _meta: {
        'io.modelcontextprotocol.registry/official': {
          status: 'active',
          isLatest: true,
        },
      },
    },
  ],
  metadata: { count: 1 },
});

/** Records every request; answers the subregistry and the manifest. */
function recorder() {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(url);
      if (url.startsWith(CATALOG)) return new Response(subregistryPage);
      if (url === MANIFEST)
        return Response.json({
          version: 1,
          plugins: [],
          tools: [
            {
              id: 'manifest-tool',
              displayName: 'Manifest tool',
              description: 'A manifest tool server',
              version: '1.0.0',
              source: 'https://github.com/example/manifest-tool',
            },
          ],
        });
      return new Response('not found', { status: 404 });
    }),
  );
  return requested;
}

/** A fresh home, the configured subregistry, and the real routes. */
function setup() {
  const home = makeTempDir('managed-tool-catalogs-');
  vi.stubEnv('STATION_HOME', home);
  vi.stubEnv('STATION_MCP_SUBREGISTRY_URL', CATALOG);
  const requested = recorder();
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  vi.spyOn(configLoader, 'saveIntegration');
  const routes = createRegistryRoutes(
    configLoader as any,
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockResolvedValue(undefined),
    { listSkills: vi.fn().mockReturnValue([]) } as any,
    {
      visibility: {
        resolvePrincipal: () => ({
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          kind: 'human' as const,
          display: 'Operator',
        }),
      },
      canSeePlugin: () => true,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    },
  );
  const app = withOperatorPrincipal(routes);
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { home, request, requested, configLoader };
}

async function listedIds(request: ReturnType<typeof setup>['request']) {
  const body = await json(await request('/integrations'));
  return {
    ids: (body.data as Array<{ id: string }>).map((item) => item.id),
    sources: body.mcpSources as Array<{ id: string; lastError: string | null }>,
  };
}

async function expectManaged(response: Response, subject: string) {
  expect(response.status).toBe(403);
  const body = await json(response);
  expect(body.code).toBe(MANAGED_POLICY_CAPABILITY_DISABLED_CODE);
  expect(body.error).toContain(`Acme's policy manages ${subject}`);
}

describe('the configured MCP subregistry', () => {
  test('control: without a policy it is refreshed, listed and installed from', async () => {
    const { request, requested, configLoader } = setup();
    expect((await request('/integrations/sync', 'POST')).status).toBe(200);
    expect(requested.some((url) => url.startsWith(CATALOG))).toBe(true);
    expect((await listedIds(request)).ids).toContain('com-example--tool');
    expect(
      (
        await request('/integrations/install', 'POST', {
          id: 'com-example--tool',
        })
      ).status,
    ).toBe(200);
    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'com-example--tool',
      expect.objectContaining({ endpoint: 'https://com.example/mcp' }),
      expect.anything(),
    );
  });

  test('outside allowedUrls it is never fetched, lists nothing and refuses install', async () => {
    installPolicy({ allowedUrls: [] });
    const { request, requested, configLoader } = setup();
    expect((await request('/integrations/sync', 'POST')).status).toBe(200);
    const { ids, sources } = await listedIds(request);
    expect(ids).not.toContain('com-example--tool');
    expect(
      sources.find((source) => source.id === 'configured')?.lastError,
    ).toContain("Acme's policy manages this tool server catalog");
    await expectManaged(
      await request('/integrations/install', 'POST', {
        id: 'com-example--tool',
      }),
      'this tool server catalog',
    );
    expect(configLoader.saveIntegration).not.toHaveBeenCalled();
    expect(requested).toEqual([]);
  });

  test('unsignedPackages false refuses it even when listed: a definition cannot be signed', async () => {
    installPolicy({ allowedUrls: [CATALOG], unsignedPackages: false });
    const { request, requested, configLoader } = setup();
    expect((await request('/integrations/sync', 'POST')).status).toBe(200);
    await expectManaged(
      await request('/integrations/install', 'POST', {
        id: 'com-example--tool',
      }),
      'tool servers from catalogs, because their definitions cannot be signed',
    );
    expect(configLoader.saveIntegration).not.toHaveBeenCalled();
    expect(requested).toEqual([]);
  });

  test("Station's bundled curation still installs under both limits", async () => {
    installPolicy({ allowedUrls: [], unsignedPackages: false });
    const { request } = setup();
    expect((await listedIds(request)).ids).toContain('app-linear--linear');
    expect(
      (
        await request('/integrations/install', 'POST', {
          id: 'app-linear--linear',
        })
      ).status,
    ).toBe(200);
  });
});

describe("a registry manifest's tools", () => {
  function registerManifest(home: string) {
    registerManifestRegistryProvider(
      new JsonManifestRegistryProvider(MANIFEST, home),
      'configured',
    );
  }

  test('control: without a policy its tools are listed', async () => {
    const { request, requested, home } = setup();
    registerManifest(home);
    expect((await listedIds(request)).ids).toContain('manifest-tool');
    expect(requested).toContain(MANIFEST);
  });

  test('outside allowedUrls the manifest is never read for tools and install is refused', async () => {
    installPolicy({ allowedUrls: [] });
    const { request, requested, home, configLoader } = setup();
    registerManifest(home);
    expect((await listedIds(request)).ids).not.toContain('manifest-tool');
    await expectManaged(
      await request('/integrations/install', 'POST', { id: 'manifest-tool' }),
      'this tool server catalog',
    );
    expect((await request('/integrations/sync', 'POST')).status).toBe(200);
    expect(requested).not.toContain(MANIFEST);
    expect(configLoader.saveIntegration).not.toHaveBeenCalled();
  });
});
