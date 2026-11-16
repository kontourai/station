/**
 * #2966: the runtime composes each engine adapter's `getAppHomeEnv` from the
 * credential-profile env resolver, reading THAT engine's own connection
 * settings. Drives the real `StationRuntime` constructor (stopped at the
 * Discord gateway, as in `station-runtime-discord-forwarder.test.ts`),
 * captures the options the real adapters were built with, and calls the
 * captured closures against a real `config/app.json`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import type { EngineMcpOAuthResolver } from '../../../services/plugins/engine-mcp-oauth.js';

const hoisted = vi.hoisted(() => ({
  claude: undefined as
    | undefined
    | {
        getAppHomeEnv?: (ref?: string) => Promise<unknown>;
        resolveMcpOAuth?: EngineMcpOAuthResolver;
      },
  codex: undefined as
    | undefined
    | {
        getAppHomeEnv?: (ref?: string) => Promise<unknown>;
        resolveMcpOAuth?: EngineMcpOAuthResolver;
        resolveSourceHome?: (affinity: {
          kind: string;
          ref: string;
        }) => string | null | Promise<string | null>;
        resolveSourceHomeEnv?: (
          home: string,
        ) => Promise<Record<string, string> | undefined>;
      },
  muse: undefined as
    | undefined
    | {
        getAppHomeEnv?: (ref?: string) => Promise<unknown>;
        peekAppHomeEnv?: () => Promise<unknown>;
      },
}));

/** Answers every member with an inert, non-thenable callable proxy. */
vi.mock('../../../services/orchestration/event-store.js', () => {
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (property === 'close') return () => ({ kind: 'closed' as const });
      return inert;
    },
    apply: () => inert,
  });
  return {
    EventStore: class {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: an inert stand-in store
        return inert as object;
      }
    },
  };
});

vi.mock(
  '../../../providers/adapters/claude-adapter.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../providers/adapters/claude-adapter.js')
      >();
    return {
      ...actual,
      ClaudeAdapter: class extends actual.ClaudeAdapter {
        constructor(
          options: ConstructorParameters<typeof actual.ClaudeAdapter>[0],
        ) {
          super(options);
          hoisted.claude = options;
        }
      },
    };
  },
);

vi.mock(
  '../../../providers/adapters/codex-adapter.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../providers/adapters/codex-adapter.js')
      >();
    return {
      ...actual,
      CodexAdapter: class extends actual.CodexAdapter {
        constructor(
          options: ConstructorParameters<typeof actual.CodexAdapter>[0],
        ) {
          super(options);
          hoisted.codex = options;
        }
      },
    };
  },
);

vi.mock(
  '../../../providers/adapters/muse-adapter.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../providers/adapters/muse-adapter.js')
      >();
    return {
      ...actual,
      MuseAdapter: class extends actual.MuseAdapter {
        constructor(
          options: ConstructorParameters<typeof actual.MuseAdapter>[0],
        ) {
          super(options);
          hoisted.muse = options;
        }
      },
    };
  },
);

vi.mock('../../../services/discord/discord-gateway-service.js', () => ({
  DiscordGatewayService: class {
    constructor() {
      throw new Error('runtime construction stopped at the Discord gateway');
    }
  },
}));

const makeTempDir = trackTempDirs();

describe('StationRuntime wires the credential profile env resolver per engine (#2966)', () => {
  it('claude and codex wire runtime OAuth admission and their own profile overlays; invalid overlays fail closed', {
    timeout: 120_000,
  }, async () => {
    const homeDir = makeTempDir('station-runtime-profile-env-');
    ensureStationHomeSchemaSync(homeDir);
    mkdirSync(join(homeDir, 'config'), { recursive: true });
    const recovery = (env: Record<string, string>) => ({
      profiles: [
        { ref: 'proxy', env },
        { ref: 'tampered', env: { ANTHROPIC_AUTH_TOKEN: 'canary-secret' } },
      ],
      group: { profileRefs: ['proxy', 'tampered'], enrolledProfileRefs: [] },
    });
    writeFileSync(
      join(homeDir, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: 'model-a',
        agentConnections: {
          claude: {
            credentialRecovery: recovery({
              ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
            }),
          },
          codex: {
            credentialRecovery: recovery({
              OPENAI_BASE_URL: 'http://127.0.0.1:9000',
            }),
          },
          // #1942: Muse reads its own connection's profiles.
          muse: {
            credentialRecovery: {
              profiles: [{ ref: 'work' }],
              group: { profileRefs: ['work'], enrolledProfileRefs: [] },
              activeProfileRef: 'work',
            },
          },
        },
      }),
    );
    const { StationRuntime } = await import('../station-runtime.js');
    const { credentialProfileAppHomeDir } = await import(
      '../../../providers/app-home/credential-profile-registry.js'
    );
    const { CredentialProfileEnvUnavailableError } = await import(
      '../../../providers/app-home/credential-profile-env.js'
    );

    expect(() => new StationRuntime({ projectHomeDir: homeDir })).toThrow(
      'runtime construction stopped at the Discord gateway',
    );

    await expect(hoisted.claude?.getAppHomeEnv?.('proxy')).resolves.toEqual({
      profileRef: 'proxy',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        CLAUDE_CONFIG_DIR: credentialProfileAppHomeDir('claude', 'proxy'),
        CLAUDE_SECURESTORAGE_CONFIG_DIR: credentialProfileAppHomeDir(
          'claude',
          'proxy',
        ),
      },
    });
    // #1942: the peek names the active Muse profile without creating it;
    // the resolver a session uses names the same home.
    const museHome = credentialProfileAppHomeDir('muse', 'work');
    await expect(hoisted.muse?.peekAppHomeEnv?.()).resolves.toEqual({
      profileRef: 'work',
      env: { XDG_CONFIG_HOME: museHome },
    });
    expect(existsSync(museHome)).toBe(false);
    await expect(hoisted.muse?.getAppHomeEnv?.()).resolves.toEqual({
      profileRef: 'work',
      env: { XDG_CONFIG_HOME: museHome },
    });
    expect(existsSync(museHome)).toBe(true);
    await expect(hoisted.codex?.getAppHomeEnv?.('proxy')).resolves.toEqual({
      profileRef: 'proxy',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9000',
        CODEX_HOME: credentialProfileAppHomeDir('codex', 'proxy'),
      },
    });
    // A session discovered in that profile's home continues there, with the
    // profile's overlay: the runtime lists the profile home for discovery
    // (configuredEngineHomes) and maps the home back to its overlay.
    const profileHome = credentialProfileAppHomeDir('codex', 'proxy');
    const sessions = join(profileHome, 'sessions', '2026', '11', '15');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'rollout-profile.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-11-15T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'profile-session', cwd: '/workspace' },
      })}\n`,
    );
    const { deriveConfigHomeAffinity } = await import(
      '../../../providers/sessions/transcript-file-io.js'
    );
    const profileIdentity = deriveConfigHomeAffinity(
      'codex-config-home',
      profileHome,
    )!;
    await expect(
      hoisted.codex?.resolveSourceHome?.(profileIdentity.affinity),
    ).resolves.toBe(profileIdentity.canonicalRoot);
    await expect(
      hoisted.codex?.resolveSourceHomeEnv?.(profileIdentity.canonicalRoot),
    ).resolves.toEqual({ OPENAI_BASE_URL: 'http://127.0.0.1:9000' });
    const input = {
      threadId: 'oauth-session',
      agent: {
        slug: 'oauth-agent',
        toolServers: [
          {
            id: 'workspace',
            transport: 'streamable-http' as const,
            endpoint: 'https://example.test/mcp',
          },
        ],
      },
    };
    const admissionFailure = new Error('runtime OAuth admission reached');
    const loadAgent = vi
      .spyOn(ConfigLoader.prototype, 'loadAgent')
      .mockRejectedValue(admissionFailure);
    try {
      for (const [provider, options] of [
        ['claude', hoisted.claude],
        ['codex', hoisted.codex],
      ] as const) {
        expect(options?.resolveMcpOAuth).toBeTypeOf('function');
        await expect(
          options!.resolveMcpOAuth!({ ...input, provider }),
        ).rejects.toBe(admissionFailure);
      }
      expect(loadAgent.mock.calls).toEqual([['oauth-agent'], ['oauth-agent']]);
    } finally {
      loadAgent.mockRestore();
    }

    for (const options of [hoisted.claude, hoisted.codex]) {
      await expect(options?.getAppHomeEnv?.('tampered')).rejects.toBeInstanceOf(
        CredentialProfileEnvUnavailableError,
      );
    }
  });
});
