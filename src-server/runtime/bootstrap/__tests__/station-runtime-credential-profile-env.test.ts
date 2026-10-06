/**
 * #2966: the runtime composes each engine adapter's `getAppHomeEnv` from the
 * credential-profile env resolver, reading THAT engine's own connection
 * settings. Drives the real `StationRuntime` constructor (stopped at the
 * Discord gateway, as in `station-runtime-discord-forwarder.test.ts`),
 * captures the options the real adapters were built with, and calls the
 * captured closures against a real `config/app.json`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const hoisted = vi.hoisted(() => ({
  claude: undefined as
    | undefined
    | { getAppHomeEnv?: (ref?: string) => Promise<unknown> },
  codex: undefined as
    | undefined
    | { getAppHomeEnv?: (ref?: string) => Promise<unknown> },
}));

/** Answers every member with an inert, non-thenable callable proxy. */
vi.mock('../../../services/orchestration/event-store.js', () => {
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, property) => (property === 'then' ? undefined : inert),
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

vi.mock('../../../services/discord/discord-gateway-service.js', () => ({
  DiscordGatewayService: class {
    constructor() {
      throw new Error('runtime construction stopped at the Discord gateway');
    }
  },
}));

const makeTempDir = trackTempDirs();

describe('StationRuntime wires the credential profile env resolver per engine (#2966)', () => {
  it('claude and codex each resolve their own profile overlay; an invalid overlay fails closed', {
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
      },
    });
    await expect(hoisted.codex?.getAppHomeEnv?.('proxy')).resolves.toEqual({
      profileRef: 'proxy',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9000',
        CODEX_HOME: credentialProfileAppHomeDir('codex', 'proxy'),
      },
    });
    for (const options of [hoisted.claude, hoisted.codex]) {
      await expect(options?.getAppHomeEnv?.('tampered')).rejects.toBeInstanceOf(
        CredentialProfileEnvUnavailableError,
      );
    }
  });
});
