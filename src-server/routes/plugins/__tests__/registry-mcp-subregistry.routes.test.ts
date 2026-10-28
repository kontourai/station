import { describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { readIntegrationOrigin } from '../../../services/plugins/integration-origin.js';
import { createRegistryRoutes } from '../registry.js';

// The real integration catalogue composition, so the curated MCP source is
// reached through the same provider list the install route uses.
const makeTempDir = trackTempDirs();

function setup() {
  const home = makeTempDir('registry-mcp-subregistry-');
  // The real loader, so its stored-definition validation is reached.
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
  return { app: withOperatorPrincipal(routes), configLoader, home };
}

const install = (app: ReturnType<typeof setup>['app'], id: string) =>
  app.request('/integrations/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });

describe('Registry routes over the curated MCP subregistry', () => {
  test('GET /integrations lists curated entries with auth mode, qualification and source state', async () => {
    const { app } = setup();
    const body = await json(await app.request('/integrations'));
    expect(body.success).toBe(true);
    const linear = body.data.find(
      (item: any) => item.id === 'app-linear--linear',
    );
    expect(linear).toMatchObject({
      displayName: 'Linear',
      catalogSourceName: 'Station curated',
      installed: false,
      mcpServer: {
        name: 'app.linear/linear',
        authMode: 'dcr',
        qualification: { state: 'qualified' },
        remote: {
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
        },
        unavailable: [],
      },
    });
    const gmail = body.data.find(
      (item: any) => item.id === 'ai-kontour-station--gmail',
    );
    expect(gmail.mcpServer).toMatchObject({
      authMode: 'pre-registered-required',
      launchStage: 'developer-preview',
      contentTrust: 'untrusted',
      qualification: { state: 'blocked' },
    });
    expect(body.mcpSources).toEqual([
      expect.objectContaining({
        id: 'station-curated',
        origin: 'station',
        freshness: 'bundled',
        refused: [],
      }),
    ]);
  });

  test('POST /integrations/install refuses a blocked entry with its reasons and stores nothing', async () => {
    const { app, configLoader } = setup();
    const response = await install(app, 'ai-kontour-station--gmail');
    expect(response.status).toBe(500);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.message).toContain('OAuth client you register');
    expect(configLoader.saveIntegration).not.toHaveBeenCalled();
  });

  test('POST /integrations/install stores a qualified entry as a disabled, principal-owned remote server', async () => {
    const { app, configLoader, home } = setup();
    const response = await install(app, 'app-linear--linear');
    expect(response.status).toBe(200);
    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'app-linear--linear',
      expect.objectContaining({
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://mcp.linear.app/mcp',
        credentialOwnership: { owner: 'principal' },
        enabled: false,
      }),
    );
    const saved = await configLoader.loadIntegration('app-linear--linear');
    expect(saved.command).toBeUndefined();
    expect(readIntegrationOrigin(home, saved)).toMatchObject({
      kind: 'registry',
      registryName: 'Station curated',
      itemId: 'app-linear--linear',
      version: '1.0.2',
    });
  });
});
