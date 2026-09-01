import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { HEALTH_PROBE_TIMEOUT_MS } from '@kontourai/station-contracts/http';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  onboardingRecommendations: { add: vi.fn() },
  systemOps: { add: vi.fn() },
  adapterReadiness: { add: vi.fn() },
}));
vi.mock('../../../providers/llm/bedrock.js', () => ({
  checkBedrockCredentials: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../providers/registries/registry.js', () => ({
  getAllPrerequisites: vi.fn().mockResolvedValue([]),
  getProviderAdapters: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../services/agents/skill-service.js', () => ({
  SkillService: vi.fn(),
}));

const { createSystemRoutes } = await import('../system.js');
const { createConnectionRoutes } = await import(
  '../../connections/connections.js'
);
const {
  readBuildProvenance,
  reconcileExternalEngineReadiness,
  STATUS_PREREQUISITES_CACHE_TTL_MS,
} = await import('../system-status-routes.js');
const { buildCliRuntimePrerequisites } = await import(
  '../../../providers/auth/cli-auth.js'
);
const { checkBedrockCredentials } = await import(
  '../../../providers/llm/bedrock.js'
);
const { getProviderAdapters } = await import(
  '../../../providers/registries/registry.js'
);
const { onboardingRecommendations, systemOps } = await import(
  '../../../telemetry/metrics.js'
);

function createMockDeps() {
  return {
    getACPStatus: () => ({ connected: false, connections: [] }),
    listProviderConnections: () => [],
    checkOllamaAvailability: async () => false,
    getAppConfig: () => ({
      region: 'us-east-1',
      defaultModel: 'claude-3',
      runtime: 'voltagent',
    }),
    appConfig: { runtime: 'voltagent' },
    port: 3141,
    skillService: {
      listSkills: () => [{ name: 'test-skill', description: 'A test' }],
    },
  };
}

// Minimal test double for a registered external-engine `ProviderAdapterShape`
// (e.g. Claude Code, Codex) — shaped exactly like `resolveExternalEngineReadiness`
// (`system-status-routes.ts`) reads it: `provider`/`metadata.engineId`/
// `metadata.capabilities` select it as an external-engine candidate, and
// `getPrerequisites()` feeds the SAME `resolveRuntimeAdapterReadiness` resolver
// the Connections hub uses, keyed generically (not by engine name) on
// prerequisite `category`/`status`.
function fakeExternalEngineAdapter(input: {
  provider: string;
  engineId: string;
  prerequisites?: Array<{
    id: string;
    status: 'installed' | 'missing' | 'error';
    category?: 'required' | 'optional';
  }>;
  // archive#1193 review finding 1: `getPrerequisites` is OPTIONAL on
  // `ProviderAdapterShape` — set this to omit the method entirely (as a
  // real plugin adapter that never wired up an auth probe would), rather
  // than defaulting to an empty-but-present function.
  omitGetPrerequisites?: boolean;
}) {
  const prerequisites = (input.prerequisites ?? []).map((p) => ({
    id: p.id,
    name: p.id,
    description: 'test prerequisite',
    status: p.status,
    category: p.category ?? 'required',
  }));
  return {
    provider: input.provider,
    metadata: {
      displayName: input.provider,
      description: 'test engine adapter',
      capabilities: ['agent-runtime'],
      runtimeId: `${input.provider}-runtime`,
      engineId: input.engineId,
    },
    ...(input.omitGetPrerequisites
      ? {}
      : { getPrerequisites: vi.fn().mockResolvedValue(prerequisites) }),
  } as any;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

async function waitForStatusDiscovery(
  app: ReturnType<typeof createSystemRoutes>,
) {
  let body: any;
  await vi.waitFor(
    async () => {
      body = await json(await app.request('/status'));
      expect(body.prerequisitesState).toBe('ready');
    },
    { timeout: 3_000, interval: 5 },
  );
  return body;
}

describe('System Routes', () => {
  test('GET /boot-history returns bounded records without fabricating a cause', async () => {
    const getBootHistory = vi.fn().mockResolvedValue({
      currentUptimeSeconds: 43,
      records: Array.from({ length: 55 }, (_, index) => ({
        bootTime: `2026-08-14T07:${String(index % 60).padStart(2, '0')}:00.000Z`,
        source: 'recorded' as const,
      })).slice(0, 50),
    });
    const app = createSystemRoutes(
      { ...createMockDeps(), getBootHistory } as any,
      mockLogger,
    );
    const response = await app.request('/boot-history');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(getBootHistory).toHaveBeenCalledOnce();
    expect(body.currentUptimeSeconds).toBe(43);
    expect(body.records).toHaveLength(50);
    expect(body.records[0]).not.toHaveProperty('cause');
  });
  test('GET /identity returns immutable boot identity without provider discovery', async () => {
    process.env.STATION_BUILD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    process.env.STATION_BUILD_BRANCH = 'main';
    process.env.STATION_BUILD_BUILT_AT = '2026-07-10T18:00:00.000Z';
    process.env.STATION_INSTANCE_ID = 'phone-dogfood';
    process.env.STATION_BOOT_ID = '11111111-1111-4111-8111-111111111111';
    vi.mocked(checkBedrockCredentials).mockClear();
    try {
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      await expect(json(await app.request('/identity'))).resolves.toEqual({
        instanceId: 'phone-dogfood',
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        // Env-only sha: derivation labeled, never presented as the build's.
        shaSource: 'checkout',
        bootId: '11111111-1111-4111-8111-111111111111',
      });
      expect(checkBedrockCredentials).not.toHaveBeenCalled();
    } finally {
      delete process.env.STATION_BUILD_SHA;
      delete process.env.STATION_BUILD_BRANCH;
      delete process.env.STATION_BUILD_BUILT_AT;
      delete process.env.STATION_INSTANCE_ID;
      delete process.env.STATION_BOOT_ID;
    }
  });

  test('GET /status reports the degraded terminal capability with its specific reason (#1244)', async () => {
    const reason =
      'node-pty failed to load. Interactive terminal panes are unavailable; agent execution is unaffected.';
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        probeTerminalCapability: vi
          .fn()
          .mockResolvedValue({ state: 'unavailable', reason }),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/status'));
    expect(body.capabilities.terminal).toEqual({
      ready: false,
      source: null,
      reason,
    });
  });

  test('GET /status reports terminal ready when the PTY backend loads, and makes no terminal claim without a probe (#1244)', async () => {
    const withProbe = createSystemRoutes(
      {
        ...createMockDeps(),
        probeTerminalCapability: vi
          .fn()
          .mockResolvedValue({ state: 'available' }),
      } as any,
      mockLogger,
    );
    const ready = await json(await withProbe.request('/status'));
    expect(ready.capabilities.terminal).toEqual({
      ready: true,
      source: 'node-pty',
    });

    // An older route host that wires no probe observed nothing; status must
    // not fabricate either readiness or degradation.
    const withoutProbe = createSystemRoutes(
      createMockDeps() as any,
      mockLogger,
    );
    const silent = await json(await withoutProbe.request('/status'));
    expect(silent.capabilities).not.toHaveProperty('terminal');
  });

  test('GET /status converts a throwing terminal probe into a degraded reason, never fabricated readiness (#1244)', async () => {
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        probeTerminalCapability: vi
          .fn()
          .mockRejectedValue(new Error('probe exploded')),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/status'));
    expect(body.capabilities.terminal.ready).toBe(false);
    expect(body.capabilities.terminal.reason).toContain('probe exploded');
    expect(body.capabilities.terminal.reason).toContain('npm rebuild node-pty');
  });

  test('GET /status can be forced chat-ready for deterministic E2E runs', async () => {
    process.env.STATION_E2E_SYSTEM_STATUS_READY = '1';
    try {
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await json(await app.request('/status'));
      expect(body.ready).toBe(true);
      expect(body.providers.configuredChatReady).toBe(true);
      expect(body.capabilities.chat).toEqual({
        ready: true,
        source: 'codex',
      });
      expect(body.recommendation.code).toBe('configured-chat-ready');
      expect(body.clis).toEqual({
        'kiro-cli': false,
        codex: false,
        claude: false,
      });
      expect(body.build).toEqual({
        fullSha: '0123456789abcdef0123456789abcdef01234567',
        shortSha: '0123456',
        branch: 'e2e',
        builtAt: '2026-01-01T00:00:00.000Z',
        ageSeconds: 0,
        instanceId: 'e2e',
        bootId: '00000000-0000-4000-8000-000000000000',
      });
    } finally {
      delete process.env.STATION_E2E_SYSTEM_STATUS_READY;
    }
  });

  test('GET /status reports the server endpoint identity the host supplies (#2551)', async () => {
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        host: '127.0.0.1',
        publicOrigins: ['https://kontour.example.ts.net'],
      } as any,
      mockLogger,
    );
    const body = await waitForStatusDiscovery(app);
    expect(body.server).toEqual({
      host: '127.0.0.1',
      port: 3141,
      publicOrigins: ['https://kontour.example.ts.net'],
    });
  });

  test('GET /status omits the server block when the host supplies no endpoint facts', async () => {
    const deps = createMockDeps() as Record<string, unknown>;
    delete deps.port;
    const app = createSystemRoutes(deps as any, mockLogger);
    const body = await waitForStatusDiscovery(app);
    expect(body).not.toHaveProperty('server');
  });

  test('GET /status first-run proof ignores host discovery but honors real configured providers', async () => {
    process.env.STATION_E2E_FIRST_RUN = '1';
    vi.mocked(checkBedrockCredentials).mockClear();
    let providers: Array<{
      id: string;
      type: string;
      enabled: boolean;
      capabilities: string[];
    }> = [];
    try {
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          listProviderConnections: () => providers,
          checkOllamaAvailability: vi.fn(async () => true),
        } as any,
        mockLogger,
      );

      const empty = await json(await app.request('/status'));
      expect(empty).toMatchObject({
        ready: false,
        providers: {
          configuredChatReady: false,
          detected: { ollama: false, bedrock: false },
        },
        clis: { 'kiro-cli': false, codex: false, claude: false },
        recommendation: { code: 'unconfigured' },
      });
      expect(checkBedrockCredentials).not.toHaveBeenCalled();

      providers = [
        {
          id: 'first-run-ollama',
          type: 'ollama',
          enabled: true,
          capabilities: ['llm'],
        },
      ];
      const configured = await json(await app.request('/status'));
      expect(configured).toMatchObject({
        ready: true,
        providers: { configuredChatReady: true },
        capabilities: { chat: { ready: true, source: 'ollama' } },
        recommendation: { code: 'configured-chat-ready' },
      });
    } finally {
      delete process.env.STATION_E2E_FIRST_RUN;
    }
  });

  test('build provenance is derived from immutable runtime metadata', () => {
    expect(
      readBuildProvenance(
        {
          STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
          STATION_BUILD_BRANCH: 'main',
          STATION_BUILD_BUILT_AT: '2026-07-10T12:00:00-06:00',
          STATION_INSTANCE_ID: 'phone-dogfood',
          STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
        },
        Date.parse('2026-07-10T18:02:03.900Z'),
      ),
    ).toEqual({
      fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
      shortSha: 'abcdef0',
      shaSource: 'checkout',
      branch: 'main',
      builtAt: '2026-07-10T18:00:00.000Z',
      ageSeconds: 123,
      instanceId: 'phone-dogfood',
      bootId: '11111111-1111-4111-8111-111111111111',
      channel: 'source-checkout',
    });
  });

  test('build age clamps to zero and invalid metadata stays absent', () => {
    const validFutureBuild = {
      STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      STATION_BUILD_BRANCH: 'main',
      STATION_BUILD_BUILT_AT: '2026-07-10T18:00:01.000Z',
      STATION_INSTANCE_ID: 'dogfood',
      STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
    };
    expect(
      readBuildProvenance(
        validFutureBuild,
        Date.parse('2026-07-10T18:00:00.000Z'),
      )?.ageSeconds,
    ).toBe(0);
    // An unusable value is dropped rather than shown — but only that value.
    expect(
      Object.keys(
        readBuildProvenance({
          ...validFutureBuild,
          STATION_BUILD_SHA: 'mutable-checkout',
        }) ?? {},
      ).sort(),
    ).toEqual(['ageSeconds', 'bootId', 'branch', 'builtAt', 'instanceId']);
    expect(
      Object.keys(
        readBuildProvenance({
          ...validFutureBuild,
          STATION_BUILD_BUILT_AT: 'not-a-date',
        }) ?? {},
      ).sort(),
    ).toEqual([
      'bootId',
      'branch',
      'channel',
      'fullSha',
      'instanceId',
      'shaSource',
      'shortSha',
    ]);
    expect(
      Object.keys(
        readBuildProvenance({
          ...validFutureBuild,
          STATION_INSTANCE_ID: ' ',
        }) ?? {},
      ).sort(),
    ).toEqual([
      'ageSeconds',
      'bootId',
      'branch',
      'builtAt',
      'channel',
      'fullSha',
      'shaSource',
      'shortSha',
    ]);
  });

  // archive#1085: this used to fail closed on any one missing variable, so the
  // packaged desktop app — which set none of them — showed "Build provenance
  // is unavailable" while a `./station start` instance showed everything.
  describe('partial build provenance', () => {
    const complete = {
      STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      STATION_BUILD_BRANCH: 'main',
      STATION_BUILD_BUILT_AT: '2026-07-10T18:00:00.000Z',
      STATION_INSTANCE_ID: 'desktop',
      STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
    };
    const now = Date.parse('2026-07-10T18:02:03.900Z');

    test.each([
      [
        'STATION_BUILD_SHA',
        {
          branch: 'main',
          builtAt: '2026-07-10T18:00:00.000Z',
          ageSeconds: 123,
          instanceId: 'desktop',
          bootId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      [
        'STATION_BUILD_BRANCH',
        {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          builtAt: '2026-07-10T18:00:00.000Z',
          ageSeconds: 123,
          instanceId: 'desktop',
          bootId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      [
        'STATION_BUILD_BUILT_AT',
        {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          branch: 'main',
          instanceId: 'desktop',
          bootId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      [
        'STATION_INSTANCE_ID',
        {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          branch: 'main',
          builtAt: '2026-07-10T18:00:00.000Z',
          ageSeconds: 123,
          bootId: '11111111-1111-4111-8111-111111111111',
        },
      ],
      [
        'STATION_BOOT_ID',
        {
          fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
          shortSha: 'abcdef0',
          branch: 'main',
          builtAt: '2026-07-10T18:00:00.000Z',
          ageSeconds: 123,
          instanceId: 'desktop',
        },
      ],
    ])('everything except %s survives when it is missing', (missing, rest) => {
      const env = { ...complete } as Record<string, string>;
      delete env[missing];
      const expected =
        'fullSha' in rest
          ? { ...rest, shaSource: 'checkout', channel: 'source-checkout' }
          : rest;
      expect(readBuildProvenance(env, now)).toEqual(expected);
    });

    test('the literal "unknown" is an absence marker, not a value', () => {
      // packages/cli/src/commands/lifecycle.ts writes exactly this when no
      // build manifest exists.
      expect(
        readBuildProvenance(
          {
            STATION_BUILD_SHA: 'unknown',
            STATION_BUILD_BRANCH: 'unknown',
            STATION_BUILD_BUILT_AT: 'unknown',
            STATION_INSTANCE_ID: 'dogfood',
            STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
          },
          now,
        ),
      ).toEqual({
        instanceId: 'dogfood',
        bootId: '11111111-1111-4111-8111-111111111111',
      });
    });

    test('the desktop shell environment as it was before #1085 reports nothing', () => {
      // The exact six variables src-desktop/src/lib.rs used to set.
      expect(
        readBuildProvenance(
          {
            STATION_HOME: '/Users/example/.station',
            PORT: '0',
            STATION_PORT_MODE: 'auto',
            STATION_HOST: '127.0.0.1',
            STATION_STDOUT_HANDSHAKE: '1',
            PATH: '/usr/bin',
            HOME: '/Users/example',
          },
          now,
        ),
      ).toBeUndefined();
    });

    test('the desktop shell environment after #1085 reports a full build', () => {
      expect(
        readBuildProvenance(
          {
            STATION_HOME: '/Users/example/.station',
            PORT: '0',
            STATION_PORT_MODE: 'auto',
            STATION_HOST: '127.0.0.1',
            STATION_STDOUT_HANDSHAKE: '1',
            PATH: '/usr/bin',
            HOME: '/Users/example',
            ...complete,
          },
          now,
        ),
      ).toEqual({
        fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
        shortSha: 'abcdef0',
        shaSource: 'checkout',
        branch: 'main',
        builtAt: '2026-07-10T18:00:00.000Z',
        ageSeconds: 123,
        instanceId: 'desktop',
        bootId: '11111111-1111-4111-8111-111111111111',
        channel: 'source-checkout',
      });
    });

    // archive#1985: `readBuildProvenance`'s third parameter is the baked
    // esbuild fallback, injected directly here so these tests never have to
    // mutate real `globalThis` state. Nested inside this describe so `now`
    // and `complete` are in scope, matching the other cases in this block.
    describe('baked build identity precedence (station#1985)', () => {
      const bakedSha = 'ba5ed00123456789abcdef0123456789abcdef01';
      const envSha = 'eeee000123456789abcdef0123456789abcdef01';

      test('a divergent bundle stamp wins over checkout metadata and names its derivation', () => {
        expect(
          readBuildProvenance(
            { STATION_BUILD_SHA: envSha, STATION_CHANNEL: 'stable' },
            now,
            { sha: bakedSha, channel: 'preview' },
          ),
        ).toMatchObject({
          fullSha: bakedSha,
          shortSha: bakedSha.slice(0, 7),
          shaSource: 'build-stamp',
          channel: 'preview',
        });
      });

      test('an unstamped source checkout is explicit about sha derivation and channel', () => {
        expect(
          readBuildProvenance({ STATION_BUILD_SHA: envSha }, now, undefined),
        ).toMatchObject({
          fullSha: envSha,
          shaSource: 'checkout',
          channel: 'source-checkout',
        });
      });

      test('baked surfaces sha/builtAt/channel/dirty when env is absent', () => {
        expect(
          readBuildProvenance({}, now, {
            sha: bakedSha,
            builtAt: '2026-07-10T18:00:00.000Z',
            channel: 'preview',
            dirty: true,
          }),
        ).toEqual({
          fullSha: bakedSha,
          shortSha: bakedSha.slice(0, 7),
          shaSource: 'build-stamp',
          builtAt: '2026-07-10T18:00:00.000Z',
          ageSeconds: 123,
          channel: 'preview',
          dirty: true,
        });
      });

      test('both env and baked absent leaves every field omitted', () => {
        expect(readBuildProvenance({}, now, undefined)).toBeUndefined();
      });

      test('an invalid baked sha is dropped rather than surfaced', () => {
        expect(
          readBuildProvenance({}, now, { sha: 'not-a-sha' }),
        ).toBeUndefined();
      });

      test('an invalid baked sha never suppresses a valid checkout sha', () => {
        // Validate-then-prefer: a malformed stamp must not hide the usable
        // checkout value — and the survivor is labeled checkout-derived.
        const checkout = 'fedcba9876543210fedcba9876543210fedcba98';
        expect(
          readBuildProvenance({ STATION_BUILD_SHA: checkout }, now, {
            sha: 'not-a-sha',
          }),
        ).toMatchObject({
          fullSha: checkout,
          shaSource: 'checkout',
        });
      });

      test('dirty surfaces from baked; there is no env override for it', () => {
        expect(readBuildProvenance({}, now, { dirty: false })).toEqual({
          dirty: false,
        });
        expect(readBuildProvenance({}, now, { dirty: true })).toEqual({
          dirty: true,
        });
      });
    });
  });

  test.each([
    ['STATION_BUILD_SHA', 'the commit'],
    ['STATION_INSTANCE_ID', 'the instance'],
    ['STATION_BOOT_ID', 'the boot'],
  ])('GET /identity stays fail-closed without %s (%s)', async (missing) => {
    const env: Record<string, string> = {
      STATION_BUILD_SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      STATION_BUILD_BRANCH: 'main',
      STATION_BUILD_BUILT_AT: '2026-07-10T18:00:00.000Z',
      STATION_INSTANCE_ID: 'desktop',
      STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
    };
    delete env[missing];
    Object.assign(process.env, env);
    try {
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const response = await app.request('/identity');
      expect(response.status).toBe(503);
      await expect(json(response)).resolves.toEqual({
        ready: false,
        status: 'identity_unavailable',
      });
    } finally {
      for (const key of [
        'STATION_BUILD_SHA',
        'STATION_BUILD_BRANCH',
        'STATION_BUILD_BUILT_AT',
        'STATION_INSTANCE_ID',
        'STATION_BOOT_ID',
      ]) {
        delete process.env[key];
      }
    }
  });

  test('GET /status returns readiness check', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await waitForStatusDiscovery(app);
    expect(body.acp).toBeDefined();
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.recommendation).toEqual(
      expect.objectContaining({
        code: 'detected-provider',
        type: 'providers',
        detectedProviderType: 'bedrock',
      }),
    );
    expect(body.clis).toEqual(
      expect.objectContaining({
        codex: expect.any(Boolean),
        claude: expect.any(Boolean),
      }),
    );
    expect(body.ready).toBe(true);
    expect(onboardingRecommendations.add).toHaveBeenCalledWith(1, {
      source: 'system-status',
      code: 'detected-provider',
      outcome: 'action_required',
      missing_kind: 'providers',
    });
  });

  test('GET /status reports a divergent bundle stamp, never the checkout SHA', async () => {
    const stampSha = 'ba5ed00123456789abcdef0123456789abcdef01';
    const checkoutSha = 'eeee000123456789abcdef0123456789abcdef01';
    const previousStamp = (globalThis as { __STATION_SERVER_BUILD__?: unknown })
      .__STATION_SERVER_BUILD__;
    const previousCheckout = process.env.STATION_BUILD_SHA;
    (
      globalThis as { __STATION_SERVER_BUILD__?: unknown }
    ).__STATION_SERVER_BUILD__ = {
      sha: stampSha,
      builtAt: '2026-07-10T18:00:00.000Z',
      channel: 'stable',
      dirty: false,
    };
    process.env.STATION_BUILD_SHA = checkoutSha;
    try {
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await json(await app.request('/status'));
      expect(body.build).toMatchObject({
        fullSha: stampSha,
        shaSource: 'build-stamp',
        channel: 'stable',
        dirty: false,
      });
      expect(body.build.fullSha).not.toBe(checkoutSha);
    } finally {
      (
        globalThis as { __STATION_SERVER_BUILD__?: unknown }
      ).__STATION_SERVER_BUILD__ = previousStamp;
      if (previousCheckout === undefined) delete process.env.STATION_BUILD_SHA;
      else process.env.STATION_BUILD_SHA = previousCheckout;
    }
  });

  test('GET /status stays within the client health-probe SLA while adapter probes are slow', async () => {
    vi.mocked(getProviderAdapters).mockReturnValueOnce([
      {
        ...fakeExternalEngineAdapter({
          provider: 'slow-engine',
          engineId: 'slow-engine',
        }),
        getPrerequisites: vi.fn(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([]), 10_000);
            }),
        ),
      } as any,
    ]);
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);

    const startedAt = performance.now();
    const body = await json(await app.request('/status'));
    const elapsedMs = performance.now() - startedAt;

    // Contract coupling: lowering the client timeout below the route's actual
    // worst case must break this test instead of reviving archive#1345.
    expect(elapsedMs).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS);
    expect(body.prerequisites).toEqual([]);
    expect(body.prerequisitesState).toBe('pending');
    expect(body.capabilities.runtime.ready).toBe(false);
    expect(systemOps.add).toHaveBeenCalledWith(1, {
      op: 'get_status_prerequisites_pending',
    });
  });

  test('GET /status is ready when a configured provider exists without bedrock credentials', async () => {
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/status'));
    expect(body.ready).toBe(true);
    expect(body.capabilities.chat.source).toBe('ollama');
    expect(body.providers.configuredChatReady).toBe(true);
    expect(body.recommendation.title).toContain('already configured');
    expect(body.providers.configured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ollama',
          enabled: true,
          capabilities: ['llm'],
        }),
      ]),
    );
    expect(onboardingRecommendations.add).toHaveBeenCalledWith(1, {
      source: 'system-status',
      code: 'configured-chat-ready',
      outcome: 'ready',
      missing_kind: 'providers',
    });
  });

  // Review H1 — a refused bound check is a live observation of the very
  // connection Station's managed engine would use. Before this, the hub could
  // render "Check failed" on a connection and, directly above it, recommend
  // the same connection as chat-capable.
  test('GET /status does not recommend a connection whose check was refused', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'anthropic-1',
            type: 'anthropic',
            enabled: true,
            capabilities: ['llm'],
            checkGated: true,
          },
        ],
        isManagedChatReady: () => true,
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.capabilities.chat.source).toBe(null);
    // It still needs attention — it is just not being recommended as ready.
    expect(body.recommendation.code).toBe('configured-no-chat');
    expect(body.recommendation.title).not.toContain('already configured');
  });

  // Delta2 review H2 — an ABSENT resolver is an older route host with no
  // opinion at all; the existential question is then all there is, and a
  // healthy sibling legitimately answers it.
  test('GET /status recommends an unrefused sibling when no resolver is wired', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'anthropic-1',
            type: 'anthropic',
            enabled: true,
            capabilities: ['llm'],
            checkGated: true,
          },
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => true,
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(true);
    expect(body.capabilities.chat.ready).toBe(true);
    expect(body.capabilities.chat.source).toBe('ollama');
    // The refused connection is FIRST in the list, so the recommendation must
    // skip it rather than name it as the one already routing chat.
    expect(body.recommendation.code).toBe('configured-chat-ready');
    expect(body.recommendation.detail).toContain('ollama');
    expect(body.recommendation.detail).not.toContain('anthropic');
  });

  // Delta review H2 — the coarse existential answer was wrong in the other
  // direction: if the default agent RESOLVES the refused connection, a
  // healthy sibling is not its binding and cannot make managed chat ready.
  test('GET /status is not ready when the resolved binding is the refused connection', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'anthropic-1',
            type: 'anthropic',
            enabled: true,
            capabilities: ['llm'],
            checkGated: true,
          },
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => true,
        resolveManagedChatBinding: () => ({
          kind: 'resolved',
          connectionId: 'anthropic-1',
        }),
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.capabilities.chat.source).toBe(null);
    expect(body.recommendation.code).toBe('configured-no-chat');
    // Crucially, it must NOT claim readiness through the healthy sibling.
    expect(body.recommendation.detail).not.toContain('ollama');
  });

  test('GET /status attributes readiness to the resolved binding, not the first unrefused row', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'openai-first',
            type: 'openai-compat',
            enabled: true,
            capabilities: ['llm'],
          },
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => true,
        resolveManagedChatBinding: () => ({
          kind: 'resolved',
          connectionId: 'ollama-local',
        }),
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.capabilities.chat.source).toBe('ollama');
    expect(body.recommendation.detail).toContain('ollama');
    expect(body.recommendation.detail).not.toContain('openai-compat');
  });

  /*
   * archive#3653 — the catalogue-less connection. An OpenAI-compatible
   * endpoint that serves chat and answers `GET /models` with an empty list
   * earns a PASSED explicit-test receipt from `probeChatCompletion`'s real
   * one-token turn against its configured `defaultModel`, so it is not
   * check-gated and the connection card reads "Ready". Whether the Station
   * engine can actually launch it is a SEPARATE derivation
   * (`resolveExactModelSelector`), and these two tests pin that /status
   * answers from the engine's outcome rather than from the receipt — in both
   * directions.
   */
  test('GET /status does not report chat ready from a passed check alone', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'local-openai',
            type: 'openai-compat',
            enabled: true,
            capabilities: ['llm'],
            // Not check-gated: its explicit Test Connection passed.
          },
        ],
        // ...but the engine did not register a default agent, so nothing on
        // this Station can start a chat yet.
        isManagedChatReady: () => false,
        resolveManagedChatBinding: () => ({
          kind: 'resolved',
          connectionId: 'local-openai',
        }),
        getAppConfig: () => ({
          defaultModel: 'local-model',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.capabilities.chat.source).toBe(null);
    expect(body.recommendation.code).toBe('configured-no-chat');
  });

  test('GET /status reports chat ready once the engine bound the catalogue-less connection', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'local-openai',
            type: 'openai-compat',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        // `runtime-route-support.ts` wires this to `activeAgents.has('default')`
        // — true only once `bootstrapRuntimeDefaultAgent` built a model, which
        // is exactly what the empty catalogue used to prevent.
        isManagedChatReady: () => true,
        resolveManagedChatBinding: () => ({
          kind: 'resolved',
          connectionId: 'local-openai',
        }),
        getAppConfig: () => ({
          defaultModel: 'local-model',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(true);
    expect(body.capabilities.chat.ready).toBe(true);
    expect(body.capabilities.chat.source).toBe('openai-compat');
    expect(body.recommendation.code).toBe('configured-chat-ready');
  });

  // Delta2 review H2 — the review's headline case: a resolver that answers
  // `ambiguous` was read as "no opinion" and the existential fallback then
  // recommended a sibling the default agent could never resolve to.
  test('GET /status is not ready, and names no sibling, when the binding is ambiguous', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'anthropic-1',
            type: 'anthropic',
            enabled: true,
            capabilities: ['llm'],
          },
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => true,
        resolveManagedChatBinding: () => ({ kind: 'ambiguous' }),
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.capabilities.chat.source).toBe(null);
    expect(body.recommendation.code).toBe('configured-no-chat');
    expect(body.recommendation.actionLabel).toBe(
      'Choose a default model connection',
    );
    expect(body.recommendation.detail).not.toContain('ollama');
    expect(body.recommendation.detail).not.toContain('anthropic');
  });

  test('GET /status is not ready when the declared default connection is gone', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getACPStatus: () => ({ connected: false, connections: [] }),
        listProviderConnections: () => [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => true,
        resolveManagedChatBinding: () => ({
          kind: 'invalid',
          declaredConnectionId: 'deleted-1',
        }),
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.recommendation.actionLabel).toBe(
      'Choose a default model connection',
    );
    expect(body.recommendation.detail).not.toContain('ollama');
  });

  test('GET /status does not claim managed chat ready without an active default agent', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        listProviderConnections: () => [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        isManagedChatReady: () => false,
      } as any,
      mockLogger,
    );

    const body = await json(await app.request('/status'));
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.recommendation.code).toBe('configured-no-chat');
  });

  test('GET /status stays not ready when only non-llm providers are configured', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);

    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        listProviderConnections: () => [
          {
            id: 'lancedb-builtin',
            type: 'lancedb',
            enabled: true,
            capabilities: ['vectordb'],
          },
        ],
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/status'));
    expect(body.ready).toBe(false);
    expect(body.capabilities.chat.ready).toBe(false);
    expect(['unconfigured', 'runtime-only']).toContain(
      body.recommendation.code,
    );
    expect(body.providers.configured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'lancedb',
          capabilities: ['vectordb'],
        }),
      ]),
    );
  });

  test('GET /status reports configured-no-chat when an llm provider exists but is disabled', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);

    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        listProviderConnections: () => [
          {
            id: 'bedrock-default',
            type: 'bedrock',
            enabled: false,
            capabilities: ['llm'],
          },
        ],
        getAppConfig: () => ({
          defaultModel: 'claude-3',
          runtime: 'voltagent',
        }),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/status'));
    expect(body.capabilities.chat.ready).toBe(false);
    expect(body.providers.configuredChatReady).toBe(false);
    expect(body.recommendation).toEqual(
      expect.objectContaining({
        code: 'configured-no-chat',
        type: 'providers',
        // State-accurate wording pinned: this branch is reached with zero
        // ENABLED connections, where no "default" exists to repair.
        title: 'No model connection is ready for chat',
        detail: 'Enable or repair a model connection in Connections.',
        actionLabel: 'Review model connections',
      }),
    );
  });

  // archive#1193 (epic archive#1191, slice A): "chat ready" is engine-agnostic — a
  // ready external engine (Claude Code/Codex, or a connected ACP engine) is
  // symmetric with a ready Station model connection, and readiness for a
  // native engine means CLI resolvable AND authenticated, never bare `which`.
  describe('engine-agnostic chat readiness (station#1193)', () => {
    const findInstalledTestBinary = (command: string) => `/test/bin/${command}`;

    test('ready when an ACP engine is connected, with no model connection at all', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          getACPStatus: () => ({
            connected: true,
            connections: [{ id: 'kiro', status: 'available' }],
          }),
        } as any,
        mockLogger,
      );
      const body = await json(await app.request('/status'));
      expect(body.ready).toBe(true);
      expect(body.capabilities.runtime.ready).toBe(true);
      expect(body.capabilities.runtime.source).toBe('acp');
      expect(body.recommendation.code).toBe('runtime-only');
      expect(onboardingRecommendations.add).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ code: 'runtime-only', outcome: 'ready' }),
      );
    });

    test('ready when a Claude-Code-shaped external engine is CLI-resolvable AND authenticated', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValue([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      expect(body.ready).toBe(true);
      expect(body.capabilities.runtime.ready).toBe(true);
      expect(body.capabilities.runtime.source).toBe('claude-cli');
      expect(body.externalEngines).toEqual([
        {
          engineId: 'claude',
          name: 'claude',
          engineConnectionId: 'claude',
          detected: true,
          ready: true,
          source: 'claude-cli',
        },
      ]);
      expect(body.recommendation.code).toBe('runtime-only');
    });

    test('ready when a Codex-shaped external engine is CLI-resolvable AND authenticated', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'codex',
          engineId: 'codex',
          prerequisites: [
            { id: 'codex-cli', status: 'installed' },
            { id: 'codex-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      expect(body.ready).toBe(true);
      expect(body.capabilities.runtime.ready).toBe(true);
      expect(body.capabilities.runtime.source).toBe('codex-cli');
      expect(body.recommendation.code).toBe('runtime-only');
    });

    test('does not assert detection for a ready adapter with no CLI observation', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'codex',
          engineId: 'codex',
          prerequisites: [],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);

      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'codex',
          engineConnectionId: 'codex',
          detected: false,
          ready: true,
        }),
      ]);
    });

    // archive#1194: the two regressions this slice fixes, both reproduced
    // from a real machine before the change (see the issue's payload dump).
    test('chat is ready via a ready engine alone — no model connection, no default agent', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      // Previously false while runtime.ready was true — the contradiction
      // archive#1191 opens with. A ready engine connection is already manufactured
      // into a selectable agent, so a turn can genuinely run.
      expect(body.capabilities.chat.ready).toBe(true);
      expect(body.capabilities.chat.source).toBe('claude-cli');
      expect(body.capabilities.runtime.ready).toBe(true);
    });

    test('a ready engine outranks a configured-but-inactive model connection', async () => {
      // The exact live shape: Ollama detected and configured (so it matched
      // `configured-no-chat` first) while Claude Code was ready and authed.
      // The user was told "No chat-capable connection is enabled" and sent to
      // Connections to fix a model they did not need.
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          listProviderConnections: () => [
            {
              id: 'ollama-local',
              type: 'ollama',
              enabled: false,
              capabilities: ['llm'],
            },
          ],
        } as any,
        mockLogger,
      );
      const body = await waitForStatusDiscovery(app);
      expect(body.recommendation.code).toBe('runtime-only');
      expect(body.recommendation.title).not.toContain(
        'No chat-capable connection',
      );
      expect(body.capabilities.chat.ready).toBe(true);
    });

    // archive#1194 review (HIGH): resolveExternalEngineReadiness used to
    // hardcode `enabled: true` and had no appConfig to consult, so it could
    // not see a connection the user had disabled. enriched-agents.ts DOES
    // read that setting and withholds the selectable agent, so the disabled
    // case produced chat.ready:true with nothing behind it — the same
    // one-payload-two-answers defect this slice removes, one layer down.
    test('a DISABLED engine connection is not chat-ready, matching what agent manufacture does', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          // The user connected Claude Code, then turned it off. This is the
          // SAME call enriched-agents.ts consults, so readiness and agent
          // availability cannot disagree.
          listEngineConnectionStates: async () => [
            {
              engineId: engineId('claude'),
              engineConnectionId: engineConnectionId('claude'),
              enabled: false,
            },
          ],
        } as any,
        mockLogger,
      );
      const body = await waitForStatusDiscovery(app);
      expect(body.capabilities.chat.ready).toBe(false);
      expect(body.capabilities.chat.source).toBeNull();
      expect(body.capabilities.runtime.ready).toBe(false);
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'claude',
          detected: true,
          ready: false,
          reason: 'disabled',
        }),
      ]);
    });

    // archive#1345 deliberately replaces always-fresh prerequisite discovery
    // with stale-while-revalidate. A connection toggle can therefore retain
    // the cached answer until the 60s TTL, then refreshes in the background.
    test('refreshes cached engine readiness after the prerequisite TTL', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValue(false);
      vi.mocked(getProviderAdapters).mockReturnValue([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      let now = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let enabled = true;
      try {
        const app = createSystemRoutes(
          {
            ...createMockDeps(),
            listEngineConnectionStates: async () => [
              {
                engineId: engineId('claude'),
                engineConnectionId: engineConnectionId('claude'),
                enabled,
              },
            ],
          } as any,
          mockLogger,
        );
        const before = await waitForStatusDiscovery(app);
        expect(before.capabilities.chat.ready).toBe(true);

        enabled = false;
        now += STATUS_PREREQUISITES_CACHE_TTL_MS;

        const stale = await json(await app.request('/status'));
        expect(stale.prerequisitesState).toBe('stale');
        expect(stale.capabilities.chat.ready).toBe(true);

        const refreshed = await waitForStatusDiscovery(app);
        expect(refreshed.capabilities.chat.ready).toBe(false);
      } finally {
        nowSpy.mockRestore();
      }
    });

    test('an unreadable connection list does NOT count as enabled', async () => {
      // "Couldn't look" is not "not disabled". An engine we cannot verify must
      // not prop up a chat-readiness claim — the same rule the
      // getPrerequisites guard applies to an unverifiable adapter.
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValue([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'installed' },
            { id: 'claude-auth', status: 'installed' },
          ],
        }),
      ]);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          listEngineConnectionStates: async () => {
            throw new Error('connection store unreadable');
          },
        } as any,
        mockLogger,
      );
      const body = await waitForStatusDiscovery(app);
      expect(body.capabilities.chat.ready).toBe(false);
    });

    test('NOT ready when an external engine CLI is installed but not authenticated', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'codex',
          engineId: 'codex',
          prerequisites: [
            { id: 'codex-cli', status: 'installed' },
            { id: 'codex-auth', status: 'missing' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      expect(body.ready).toBe(false);
      expect(body.capabilities.runtime.ready).toBe(false);
      expect(body.capabilities.runtime.source).toBeNull();
      expect(body.recommendation.code).not.toBe('runtime-only');
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'codex',
          detected: true,
          ready: false,
          reason: 'sign_in_required',
        }),
      ]);
    });

    test('reports an errored auth prerequisite as cannot_verify, not sign-in required', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'codex',
          engineId: 'codex',
          prerequisites: [
            { id: 'codex-cli', status: 'installed' },
            { id: 'codex-auth', status: 'error' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'codex',
          engineConnectionId: 'codex',
          detected: true,
          ready: false,
          reason: 'cannot_verify',
        }),
      ]);

      // The CTA's exact target is consumed by the same detail lookup the
      // Agent Apps route performs. A runtime settings key here would produce
      // its empty "Connection not found" pane instead.
      const engineConnectionId = body.externalEngines[0].engineConnectionId;
      const detail = createConnectionRoutes({
        getConnection: async (id: string) =>
          id === 'codex'
            ? {
                id: 'codex',
                kind: 'agent',
                type: 'codex',
                name: 'Codex',
                enabled: true,
                capabilities: ['agent-runtime'],
                config: {},
                status: 'missing_prerequisites',
                prerequisites: [],
                lastCheckedAt: null,
              }
            : null,
      } as any);
      const detailResponse = await detail.request(`/${engineConnectionId}`);
      expect(detailResponse.status).toBe(200);
      expect(await json(detailResponse)).toMatchObject({
        success: true,
        data: { id: 'codex' },
      });
    });

    test('prefers a completed CLI error over sign_in_required when an engine has both', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'codex',
          engineId: 'codex',
          prerequisites: [
            { id: 'codex-cli', status: 'error' },
            { id: 'codex-auth', status: 'missing' },
          ],
        }),
      ]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await waitForStatusDiscovery(app);
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'codex',
          ready: false,
          reason: 'missing_prerequisites',
        }),
      ]);
    });

    describe('reconcileExternalEngineReadiness', () => {
      const signInRequired = {
        ready: false,
        source: null,
        engines: [
          {
            engineId: 'claude',
            name: 'claude',
            detected: true,
            ready: false,
            source: null,
            reason: 'sign_in_required',
          },
        ],
      } as any;
      const cannotVerify = {
        ready: false,
        source: null,
        engines: [
          {
            engineId: 'claude',
            name: 'claude',
            detected: false,
            ready: false,
            source: null,
            reason: 'cannot_verify',
          },
        ],
      } as any;

      test('holds the last genuine sign-in-required observation through a cannot_verify flap', () => {
        expect(
          reconcileExternalEngineReadiness(signInRequired, cannotVerify),
        ).toEqual(signInRequired);
      });

      test('does not hold cannot_verify when there is no prior observation', () => {
        expect(
          reconcileExternalEngineReadiness(undefined, cannotVerify),
        ).toEqual(cannotVerify);
      });
    });

    test('a completed version-probe error replaces held ready readiness after the TTL', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValue(false);
      const readyAdapter = fakeExternalEngineAdapter({
        provider: 'claude',
        engineId: 'claude',
        prerequisites: [
          { id: 'claude-cli', status: 'installed' },
          { id: 'claude-auth', status: 'installed' },
        ],
      });
      const completedErrorAdapter = {
        ...readyAdapter,
        getPrerequisites: vi.fn(() =>
          buildCliRuntimePrerequisites({
            command: 'claude',
            displayName: 'Claude',
            versionArgs: ['--version'],
            authArgs: ['--version'],
            installStep: 'Install Claude.',
            authStep: 'Log in.',
            findBinary: findInstalledTestBinary,
            runCommand: async () => ({
              stdout: '',
              stderr: 'launcher failed',
              code: 1,
            }),
          }),
        ),
      };
      vi.mocked(getProviderAdapters)
        .mockReturnValueOnce([readyAdapter])
        .mockReturnValue([completedErrorAdapter]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const first = await waitForStatusDiscovery(app);
      expect(first.externalEngines[0]).toMatchObject({ ready: true });

      const realNow = Date.now.bind(Date);
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(
          () => realNow() + STATUS_PREREQUISITES_CACHE_TTL_MS + 1_000,
        );
      try {
        await app.request('/status');
        await vi.waitFor(async () => {
          const body = await json(await app.request('/status'));
          expect(body.prerequisitesState).toBe('ready');
          expect(body.externalEngines[0]).toMatchObject({
            ready: false,
            reason: 'missing_prerequisites',
          });
        });
      } finally {
        nowSpy.mockRestore();
        vi.mocked(checkBedrockCredentials).mockResolvedValue(true);
        vi.mocked(getProviderAdapters).mockReturnValue([]);
      }
    });

    test('an aborted probe keeps the last genuine ready observation after the TTL', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValue(false);
      const readyAdapter = fakeExternalEngineAdapter({
        provider: 'claude',
        engineId: 'claude',
        prerequisites: [
          { id: 'claude-cli', status: 'installed' },
          { id: 'claude-auth', status: 'installed' },
        ],
      });
      const abortedAdapter = {
        ...readyAdapter,
        getPrerequisites: vi.fn().mockRejectedValue(new Error('timed out')),
      };
      vi.mocked(getProviderAdapters)
        .mockReturnValueOnce([readyAdapter])
        .mockReturnValue([abortedAdapter]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const first = await waitForStatusDiscovery(app);
      expect(first.externalEngines[0]).toMatchObject({ ready: true });

      const realNow = Date.now.bind(Date);
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(
          () => realNow() + STATUS_PREREQUISITES_CACHE_TTL_MS + 1_000,
        );
      try {
        await app.request('/status');
        await vi.waitFor(async () => {
          const body = await json(await app.request('/status'));
          expect(body.prerequisitesState).toBe('ready');
          expect(body.externalEngines[0]).toMatchObject({ ready: true });
        });
      } finally {
        nowSpy.mockRestore();
        vi.mocked(checkBedrockCredentials).mockResolvedValue(true);
        vi.mocked(getProviderAdapters).mockReturnValue([]);
      }
    });

    test('does not assert detection for a disabled engine whose CLI is absent', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValueOnce([
        fakeExternalEngineAdapter({
          provider: 'claude',
          engineId: 'claude',
          prerequisites: [
            { id: 'claude-cli', status: 'missing' },
            { id: 'claude-auth', status: 'missing' },
          ],
        }),
      ]);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          listEngineConnectionStates: () => [
            {
              engineId: engineId('claude'),
              engineConnectionId: engineConnectionId('claude'),
              enabled: false,
            },
          ],
        } as any,
        mockLogger,
      );
      const body = await waitForStatusDiscovery(app);
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'claude',
          engineConnectionId: 'claude',
          detected: false,
          ready: false,
          reason: 'disabled',
        }),
      ]);
    });

    // #765 B2: `cannot_verify` is the shape of a probe that produced NO
    // observation (aborted at the 2 s discovery budget, threw, or errored).
    // It must not overwrite a projection this cache already VERIFIED ready —
    // that flap is what showed a "Station cannot verify…" first-run launcher
    // for an engine the Engines list (unbudgeted inspector probe) still
    // reported READY, minutes into a working session.
    describe('reconcileExternalEngineReadiness', () => {
      const verified = {
        ready: true,
        source: 'claude-cli',
        engines: [
          {
            engineId: 'claude',
            name: 'claude',
            detected: true,
            ready: true,
            source: 'claude-cli',
          },
        ],
      } as any;

      test('keeps a verified ready engine when the next probe cannot verify', () => {
        const flap = {
          ready: false,
          source: null,
          engines: [
            {
              engineId: 'claude',
              name: 'claude',
              detected: false,
              ready: false,
              source: null,
              reason: 'cannot_verify',
            },
          ],
        } as any;
        expect(reconcileExternalEngineReadiness(verified, flap)).toEqual(
          verified,
        );
      });

      test('lets every genuine observation replace a held ready projection', () => {
        for (const reason of [
          'sign_in_required',
          'missing_prerequisites',
          'disabled',
        ] as const) {
          const observed = {
            ready: false,
            source: null,
            engines: [
              {
                engineId: 'claude',
                name: 'claude',
                detected: true,
                ready: false,
                source: null,
                reason,
              },
            ],
          } as any;
          expect(reconcileExternalEngineReadiness(verified, observed)).toEqual(
            observed,
          );
        }
      });

      test('never invents readiness: a held non-ready observation stays non-ready, and no prior means the flap stands (#851)', () => {
        const previous = {
          ready: false,
          source: null,
          engines: [
            {
              engineId: 'claude',
              name: 'claude',
              detected: true,
              ready: false,
              source: null,
              reason: 'sign_in_required',
            },
          ],
        } as any;
        const flap = {
          ready: false,
          source: null,
          engines: [
            {
              engineId: 'claude',
              name: 'claude',
              detected: false,
              ready: false,
              source: null,
              reason: 'cannot_verify',
            },
          ],
        } as any;
        // #851: the completed sign_in_required observation is HELD through
        // the zero-information flap — still `ready: false`, so no readiness
        // is invented; only the actionable reason survives.
        expect(reconcileExternalEngineReadiness(previous, flap)).toEqual(
          previous,
        );
        expect(reconcileExternalEngineReadiness(undefined, flap)).toEqual(flap);
      });
    });

    test('a cannot_verify flap after the cache verified an engine ready keeps it ready across a TTL refresh (#765 B2)', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValue(false);
      const readyAdapter = fakeExternalEngineAdapter({
        provider: 'claude',
        engineId: 'claude',
        prerequisites: [
          { id: 'claude-cli', status: 'installed' },
          { id: 'claude-auth', status: 'installed' },
        ],
      });
      // The second refresh's probe dies the way a busy host kills it: the
      // whole getPrerequisites call rejects (the abort path takes the same
      // catch), which un-reconciled produces `cannot_verify`.
      const throwingAdapter = {
        ...readyAdapter,
        getPrerequisites: vi
          .fn()
          .mockRejectedValue(new Error('probe timed out')),
      };
      vi.mocked(getProviderAdapters)
        .mockReturnValueOnce([readyAdapter])
        .mockReturnValue([throwingAdapter]);
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const first = await waitForStatusDiscovery(app);
      expect(first.externalEngines[0]).toMatchObject({
        engineId: 'claude',
        ready: true,
        source: 'claude-cli',
      });

      // Expire the TTL so the next read serves stale and refreshes in the
      // background — the exact moment the audit's launcher appeared.
      const realNow = Date.now.bind(Date);
      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(
          () => realNow() + STATUS_PREREQUISITES_CACHE_TTL_MS + 1_000,
        );
      try {
        await app.request('/status');
        await vi.waitFor(
          async () => {
            expect(throwingAdapter.getPrerequisites).toHaveBeenCalled();
            const body = await json(await app.request('/status'));
            // The refreshed (post-flap) snapshot, not the stale one: state
            // only returns to 'ready' once the second refresh has written.
            expect(body.prerequisitesState).toBe('ready');
            expect(body.externalEngines[0]).toMatchObject({
              engineId: 'claude',
              ready: true,
              source: 'claude-cli',
            });
          },
          { timeout: 3_000, interval: 10 },
        );
      } finally {
        nowSpy.mockRestore();
        // Restore the file-level defaults; this test set durable (non-Once)
        // mock values because the cache refreshes twice.
        vi.mocked(checkBedrockCredentials).mockResolvedValue(true);
        vi.mocked(getProviderAdapters).mockReturnValue([]);
      }
    });

    // archive#1193 review finding 1: `getPrerequisites` is OPTIONAL on
    // `ProviderAdapterShape`. A plugin external-engine adapter that never
    // wired one up must fail closed (NOT ready) rather than reading as
    // "ready" from an empty-but-unverified prerequisite list.
    test('uses the adapter engine identity instead of the provider identity mismatch', async () => {
      vi.mocked(checkBedrockCredentials).mockResolvedValueOnce(false);
      vi.mocked(getProviderAdapters).mockReturnValue([
        fakeExternalEngineAdapter({
          // Use a provider whose published capability matrix can deliver
          // chat. An unknown provider is deliberately filtered before this
          // resolver, so it cannot prove the missing-probe fail-closed path.
          provider: 'codex',
          engineId: 'some-plugin-engine',
          omitGetPrerequisites: true,
        }),
      ]);
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          // The adapter registered, but its authoritative registry CAS did
          // not publish a navigable connection row.
          listEngineConnectionStates: async () => [],
        } as any,
        mockLogger,
      );
      const body = await waitForStatusDiscovery(app);
      expect(body.ready).toBe(false);
      expect(body.capabilities.runtime.ready).toBe(false);
      expect(body.capabilities.runtime.source).toBeNull();
      expect(body.recommendation.code).not.toBe('runtime-only');
      expect(body.externalEngines).toEqual([
        expect.objectContaining({
          engineId: 'some-plugin-engine',
          detected: false,
          ready: false,
          reason: 'cannot_verify',
        }),
      ]);
      expect(body.externalEngines[0]).not.toHaveProperty('engineConnectionId');
    });

    test('a Station model connection alone is still ready, symmetric with an external engine', async () => {
      const app = createSystemRoutes(
        {
          ...createMockDeps(),
          listProviderConnections: () => [
            {
              id: 'ollama-local',
              type: 'ollama',
              enabled: true,
              capabilities: ['llm'],
            },
          ],
        } as any,
        mockLogger,
      );
      const body = await json(await app.request('/status'));
      expect(body.ready).toBe(true);
      expect(body.capabilities.chat.ready).toBe(true);
      expect(body.recommendation.code).toBe('configured-chat-ready');
    });
  });

  // archive#1985: additive self-report of this Station instance's
  // build/port identity, fail-open (never a 503) mirroring
  // readBuildProvenance's own degrade-don't-fabricate doctrine.
  test('GET /instance returns component + full fields when build provenance is complete', async () => {
    process.env.STATION_BUILD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    process.env.STATION_BUILD_BUILT_AT = '2026-07-10T18:00:00.000Z';
    process.env.STATION_INSTANCE_ID = 'phone-dogfood';
    process.env.STATION_CHANNEL = 'preview';
    process.env.STATION_HOME = '/tmp/instance-route-home';
    try {
      const app = createSystemRoutes(
        { ...createMockDeps(), port: 3242 } as any,
        mockLogger,
      );
      const body = await json(await app.request('/instance'));
      expect(body).toEqual({
        component: 'command-station',
        instance: 'phone-dogfood',
        port: 3242,
        buildSha: 'abcdef0123456789abcdef0123456789abcdef01',
        // Env-only sha: derivation labeled, never presented as the build's.
        shaSource: 'checkout',
        builtAt: '2026-07-10T18:00:00.000Z',
        channel: 'preview',
      });
      expect(systemOps.add).toHaveBeenCalledWith(1, { op: 'get_instance' });
    } finally {
      delete process.env.STATION_BUILD_SHA;
      delete process.env.STATION_BUILD_BUILT_AT;
      delete process.env.STATION_INSTANCE_ID;
      delete process.env.STATION_CHANNEL;
      delete process.env.STATION_HOME;
    }
  });

  test('GET /instance returns only component (and determinable fields) when everything else is absent, never a 503', async () => {
    const app = createSystemRoutes(
      { ...createMockDeps(), port: undefined } as any,
      mockLogger,
    );
    const response = await app.request('/instance');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({
      component: 'command-station',
    });
  });

  test('GET /instance reflects deps.port exactly', async () => {
    const app = createSystemRoutes(
      { ...createMockDeps(), port: 4321 } as any,
      mockLogger,
    );
    const body = await json(await app.request('/instance'));
    expect(body.port).toBe(4321);
  });

  // Review round 1, fix 3 (MEDIUM): exercise globalThis.__STATION_SERVER_BUILD__
  // through the actual /instance ROUTE (not just the readBuildProvenance unit
  // call above), so a future truthy-check regression on `dirty` (e.g.
  // `build?.dirty ? ... : {}`, which drops a real `false`) ships red instead
  // of green.
  describe('GET /instance reads globalThis.__STATION_SERVER_BUILD__ directly (station#1985 review round 1)', () => {
    function withBakedServerBuild<T>(
      value: unknown,
      run: () => Promise<T>,
    ): Promise<T> {
      const previous = (globalThis as { __STATION_SERVER_BUILD__?: unknown })
        .__STATION_SERVER_BUILD__;
      (
        globalThis as { __STATION_SERVER_BUILD__?: unknown }
      ).__STATION_SERVER_BUILD__ = value;
      return run().finally(() => {
        (
          globalThis as { __STATION_SERVER_BUILD__?: unknown }
        ).__STATION_SERVER_BUILD__ = previous;
      });
    }

    test('surfaces dirty:false as false, not dropped', async () => {
      await withBakedServerBuild({ dirty: false }, async () => {
        const app = createSystemRoutes(createMockDeps() as any, mockLogger);
        const body = await json(await app.request('/instance'));
        expect('dirty' in body).toBe(true);
        expect(body.dirty).toBe(false);
      });
    });

    test('surfaces dirty:true as true', async () => {
      await withBakedServerBuild({ dirty: true }, async () => {
        const app = createSystemRoutes(createMockDeps() as any, mockLogger);
        const body = await json(await app.request('/instance'));
        expect(body.dirty).toBe(true);
      });
    });

    test('surfaces the baked sha when env is absent', async () => {
      await withBakedServerBuild(
        { sha: 'ba5ed00123456789abcdef0123456789abcdef01' },
        async () => {
          const app = createSystemRoutes(createMockDeps() as any, mockLogger);
          const body = await json(await app.request('/instance'));
          expect(body.buildSha).toBe(
            'ba5ed00123456789abcdef0123456789abcdef01',
          );
        },
      );
    });
  });

  test('GET /capabilities returns manifest', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/capabilities'));
    expect(body.runtime).toBe('voltagent');
    expect(body.voice).toBeDefined();
    expect(body.scheduler).toBe(true);
    expect(body.deployment).toEqual({
      features: {
        'web-push': { state: 'unknown' },
        scheduler: { state: 'unknown' },
      },
    });
  });

  test('GET /capabilities reports explicitly declared deployment support', async () => {
    process.env.STATION_DEPLOYMENT_CAPABILITIES = JSON.stringify({
      'web-push': 'supported',
      scheduler: 'supported',
    });
    try {
      const app = createSystemRoutes(createMockDeps() as any, mockLogger);
      const body = await json(await app.request('/capabilities'));
      expect(body.deployment).toEqual({
        features: {
          'web-push': { state: 'supported' },
          scheduler: { state: 'supported' },
        },
      });
    } finally {
      delete process.env.STATION_DEPLOYMENT_CAPABILITIES;
    }
  });

  test('GET /capabilities reports deployment overrides without changing legacy fields', async () => {
    const app = createSystemRoutes(
      {
        ...createMockDeps(),
        getDeploymentCapabilities: () => ({
          features: {
            'web-push': { state: 'unsupported' },
            scheduler: { state: 'unknown' },
          },
        }),
      } as any,
      mockLogger,
    );
    const body = await json(await app.request('/capabilities'));

    expect(body.runtime).toBe('voltagent');
    expect(body.scheduler).toBe(true);
    expect(body.deployment.features['web-push'].state).toBe('unsupported');
    expect(body.deployment.features.scheduler.state).toBe('unknown');
  });

  test('GET /discover returns beacon', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/discover'));
    expect(body.station).toBe(true);
  });

  test('GET /runtime returns runtime type', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/runtime'));
    expect(body.runtime).toBe('voltagent');
  });

  test('GET /skills returns skill list', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/skills'));
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test('GET /terminal-port returns port + 1', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/terminal-port'));
    expect(body.port).toBe(3142);
  });

  test('GET /voice-port returns port + 2 (mirrors /terminal-port for the Voice WS server)', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const body = await json(await app.request('/voice-port'));
    expect(body.success).toBe(true);
    expect(body.port).toBe(3143);
  });

  test('POST /verify-managed-runtime remains available as a compatibility alias', async () => {
    const app = createSystemRoutes(createMockDeps() as any, mockLogger);
    const aliasResponse = await app.request('/verify-managed-runtime', {
      method: 'POST',
      body: JSON.stringify({ region: 'us-east-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const canonicalResponse = await app.request('/verify-bedrock', {
      method: 'POST',
      body: JSON.stringify({ region: 'us-east-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(aliasResponse.status).toBe(canonicalResponse.status);
    expect(await json(aliasResponse)).toEqual(await json(canonicalResponse));
  });
});
