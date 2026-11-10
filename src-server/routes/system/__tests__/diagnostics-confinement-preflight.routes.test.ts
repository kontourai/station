/**
 * #4774: `GET /api/diagnostics/confinement-preflight` at the route seam,
 * over the real preflight service, the real providers (availability
 * injected through the Seatbelt provider's own dependencies) and the real
 * Claude credential check against a temporary Station home.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { confinementProvidersForTests } from '../../../__test-utils__/confinement-providers.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { claudeConfinedCredentialPreflight } from '../../../providers/adapters/claude-confinement-preflight.js';
import { codexSandboxConfinementProvider } from '../../../providers/adapters/codex-confinement.js';
import { confinementPreflight } from '../../../security/confinement/confinement-preflight.js';
import type { ConfinementProvider } from '../../../security/confinement/confinement-provider.js';
import {
  canonicalPath,
  createSeatbeltConfinementProvider,
} from '../../../security/confinement/seatbelt.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  serverLogsRead: { add: vi.fn() },
}));

const { createDiagnosticsRoutes } = await import('../diagnostics.js');
const { createServerLogReader } = await import(
  '../../../services/infra/server-log-reader.js'
);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const SECRET = 'sk-ant-fixture-secret-0123456789abcdef';

/** The production Seatbelt provider on a host where it cannot apply. */
function unavailableSeatbelt(): ConfinementProvider {
  return createSeatbeltConfinementProvider({
    platform: () => 'linux',
  }) as ConfinementProvider;
}

describe('#4774: GET /api/diagnostics/confinement-preflight', () => {
  let root: string;
  let stationHome: string;

  const makeTempDir = trackTempDirs();

  beforeEach(() => {
    root = canonicalPath(makeTempDir('station-preflight-route-'));
    stationHome = join(root, 'station-home');
    mkdirSync(stationHome, { recursive: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function app(
    providers: readonly ConfinementProvider[],
    baseEnv: Record<string, string>,
  ) {
    const routes = createDiagnosticsRoutes(
      { generateBundle: vi.fn() } as any,
      logger,
      createServerLogReader({ directory: join(root, 'logs') }),
      {
        confinementPreflight: () =>
          confinementPreflight({
            providers,
            credentialChecks: {
              claude: () =>
                claudeConfinedCredentialPreflight({
                  baseEnv: async () => baseEnv,
                  connectionEnv: async () => undefined,
                  appHomeEnv: async () => undefined,
                  stationHome,
                }),
            },
          }),
      },
    );
    return new Hono().route('/api/diagnostics', routes);
  }

  async function read(
    providers: readonly ConfinementProvider[],
    baseEnv: Record<string, string>,
  ) {
    const response = await app(providers, baseEnv).request(
      '/api/diagnostics/confinement-preflight',
    );
    expect(response.status).toBe(200);
    const raw = await response.clone().text();
    return { body: await json(response), raw };
  }

  function claude(body: any) {
    return body.engines.find((entry: any) => entry.engine === 'claude');
  }

  test('mechanism unavailable: names the provider reason and still reports the credential', async () => {
    const { body } = await read(
      [codexSandboxConfinementProvider, unavailableSeatbelt()],
      { ANTHROPIC_API_KEY: SECRET },
    );
    expect(claude(body)).toEqual({
      engine: 'claude',
      mechanism: 'seatbelt',
      level: 'os-profile',
      mechanismState: 'unavailable',
      mechanismReason: 'Seatbelt is macOS-only; this host is linux',
      confinedAuthentication: {
        state: 'available',
        source: 'environment',
        appliesTo: 'starts-without-own-credential-profile',
      },
    });
    expect(body.decidedAtStart).toEqual([
      'workspace-too-broad',
      'config-root-pinned',
      'resume-bound-elsewhere',
    ]);
  });

  test('mechanism available and a credential available', async () => {
    const { body } = await read(confinementProvidersForTests(), {
      ANTHROPIC_API_KEY: SECRET,
    });
    expect(claude(body)).toMatchObject({
      mechanismState: 'available',
      confinedAuthentication: {
        state: 'available',
        source: 'environment',
        appliesTo: 'starts-without-own-credential-profile',
      },
    });
  });

  test('mechanism available and no credential: the fallback a start takes', async () => {
    const { body } = await read(confinementProvidersForTests(), {});
    expect(claude(body)).toMatchObject({
      mechanismState: 'available',
      confinedAuthentication: {
        state: 'unavailable',
        fallback: 'confined-credential-unavailable',
      },
    });
  });

  test('an enrolled credential file counts, by kind and without its path', async () => {
    const dir = join(stationHome, 'confined-homes', 'claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }),
    );
    const { body, raw } = await read(confinementProvidersForTests(), {});
    expect(claude(body).confinedAuthentication).toEqual({
      state: 'available',
      source: 'config-dir',
      appliesTo: 'starts-without-own-credential-profile',
    });
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(stationHome);
  });

  test('Codex: its sandbox is reported by the engine at start, and no credential check applies', async () => {
    const { body } = await read(confinementProvidersForTests(), {});
    expect(body.engines.find((e: any) => e.engine === 'codex')).toMatchObject({
      mechanism: 'codex-sandbox',
      mechanismState: 'engine-reported',
      confinedAuthentication: { state: 'not-applicable' },
    });
  });

  test('no credential content, environment value or host path in the answer', async () => {
    const leaky = createSeatbeltConfinementProvider({
      platform: () => 'darwin',
      sandboxExec: process.execPath,
      probe: () => ({
        ok: false,
        reason: `the Seatbelt profile could not be probed (EACCES '${join(root, 'private', 'probe')}')`,
      }),
    }) as ConfinementProvider;
    const { body, raw } = await read([leaky], {
      ANTHROPIC_API_KEY: SECRET,
      HOME: root,
    });
    expect(claude(body).mechanismState).toBe('unavailable');
    expect(claude(body).mechanismReason).toContain('[REDACTED_PATH]');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(root);
  });

  test('a preflight that throws answers 500 without the error text', async () => {
    const routes = createDiagnosticsRoutes(
      { generateBundle: vi.fn() } as any,
      logger,
      createServerLogReader({ directory: join(root, 'logs') }),
      {
        confinementPreflight: async () => {
          throw new Error(`boom at ${stationHome}`);
        },
      },
    );
    const response = await new Hono()
      .route('/api/diagnostics', routes)
      .request('/api/diagnostics/confinement-preflight');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(stationHome);
    expect(logger.error).toHaveBeenCalled();
  });

  test('unmounted without a preflight: an older or unwired host answers 404', async () => {
    const routes = createDiagnosticsRoutes(
      { generateBundle: vi.fn() } as any,
      logger,
      createServerLogReader({ directory: join(root, 'logs') }),
    );
    const response = await new Hono()
      .route('/api/diagnostics', routes)
      .request('/api/diagnostics/confinement-preflight');
    expect(response.status).toBe(404);
  });
});
