/**
 * #4774: `createStationConfinementPreflight`, the assembly the running
 * Station serves, over the resolvers the runtime hands it: the inherited
 * spawn environment, the real connection launch (`engineProxyLaunch`), the
 * real non-creating app-home resolver and a real temporary Station home.
 * Only the stored connection settings are fixtures.
 *
 * Not covered: the factory's layering mirrors `ClaudeAdapter.startSession`
 * and `prepareSeatbeltStart` rather than sharing them (see the factory's
 * comment), so a change to the adapter's layering is not seen here.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { confinementProvidersForTests } from '../../../__test-utils__/confinement-providers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CredentialProfileEnvironmentError } from '../../../providers/app-home/app-home-profiles.js';
import {
  createCredentialProfileAppHomeEnvPeek,
  createCredentialProfileAppHomeEnvResolver,
} from '../../../providers/app-home/credential-profile-env.js';
import { credentialProfileStorageId } from '../../../providers/app-home/credential-profile-registry.js';
import { inheritedSpawnEnv } from '../../../providers/auth/cli-auth.js';
import { engineProxyLaunch } from '../../../services/connections/engine-proxy-routing.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import {
  createStationConfinementPreflight,
  type StationConfinementPreflightResolvers,
} from '../confinement-preflight.js';
import { canonicalPath } from '../seatbelt.js';

type Env = Record<string, string>;
type Settings = {
  credentialRecovery?: unknown;
  config?: Record<string, unknown>;
};

const OAUTH = { claudeAiOauth: { accessToken: 'fixture-access-token' } };
const SCOPE = 'starts-without-own-credential-profile';

/** Every entry under `root`: kind, size, mode and modification time. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      entries[relative(root, path)] = [
        stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
        stat.size,
        stat.mode,
        stat.mtimeMs,
        stat.isFile() ? readFileSync(path, 'utf8') : '',
      ].join(':');
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return entries;
}

describe('#4774: createStationConfinementPreflight', () => {
  const makeTempDir = trackTempDirs();
  let stationHome: string;

  beforeEach(() => {
    stationHome = join(
      canonicalPath(makeTempDir('station-preflight-factory-')),
      'station-home',
    );
    mkdirSync(stationHome, { recursive: true });
    // `resolveHomeDir`, which the runtime hands the factory, reads this.
    vi.stubEnv('STATION_HOME', stationHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function settingsLoader(settings: Settings) {
    return {
      engine: 'claude' as const,
      homeDir: stationHome,
      loadConnectionSettings: async () => settings,
    };
  }

  /** The runtime's resolvers, with only the stored settings as fixtures. */
  function resolvers(
    options: {
      settings?: Settings;
      inherited?: Env;
      connectionConfig?: Record<string, unknown>;
    } & Partial<StationConfinementPreflightResolvers['claude']> = {},
  ): StationConfinementPreflightResolvers {
    const { settings, inherited, connectionConfig, ...overrides } = options;
    return {
      providers: confinementProvidersForTests(),
      claude: {
        spawnEnv: () => inheritedSpawnEnv({ ...inherited }),
        fallbackEnv: () => ({}),
        connectionLaunch: async () =>
          engineProxyLaunch('claude', connectionConfig, []),
        appHomeEnv: createCredentialProfileAppHomeEnvPeek(
          settingsLoader(settings ?? {}),
        ),
        stationHome: resolveHomeDir,
        ...overrides,
      },
    };
  }

  async function claudeCredential(r: StationConfinementPreflightResolvers) {
    const preflight = await createStationConfinementPreflight(r)();
    return preflight.engines.find((entry) => entry.engine === 'claude')
      ?.confinedAuthentication;
  }

  function enroll(confinedHome: string) {
    const dir = join(stationHome, 'confined-homes', confinedHome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(OAUTH));
  }

  describe('creates, writes and modifies nothing', () => {
    test.each([
      ['the app-home opt-in (useAppHome)', { config: { useAppHome: true } }],
      [
        'an active credential profile',
        {
          credentialRecovery: {
            profiles: [{ ref: 'work' }],
            activeProfileRef: 'work',
          },
        },
      ],
    ])('on an empty Station home, with %s', async (_name, settings) => {
      const before = snapshot(stationHome);
      const credential = await claudeCredential(resolvers({ settings }));
      expect(credential).toEqual({
        state: 'unavailable',
        fallback: 'confined-credential-unavailable',
        remedy: expect.any(String),
        appliesTo: SCOPE,
      });
      expect(snapshot(stationHome)).toEqual(before);
      expect(before).toEqual({});

      // The env read is the one a start gets: the creating resolver, run
      // only now, answers the same for the same settings (and does create).
      const peeked = await createCredentialProfileAppHomeEnvPeek(
        settingsLoader(settings),
      )();
      const started = await createCredentialProfileAppHomeEnvResolver(
        settingsLoader(settings),
      )();
      expect(peeked).toEqual(started);
      expect(peeked?.env?.CLAUDE_CONFIG_DIR).toBeDefined();
      expect(snapshot(stationHome)).not.toEqual(before);
    });

    test('on a Station home whose profile and confined twin exist: read as the start reads them', async () => {
      const settings = {
        credentialRecovery: {
          profiles: [{ ref: 'work' }],
          activeProfileRef: 'work',
        },
      };
      await createCredentialProfileAppHomeEnvResolver(
        settingsLoader(settings),
      )();
      enroll(credentialProfileStorageId('claude', 'work'));
      const before = snapshot(stationHome);
      expect(await claudeCredential(resolvers({ settings }))).toEqual({
        state: 'available',
        source: 'config-dir',
        appliesTo: SCOPE,
      });
      expect(snapshot(stationHome)).toEqual(before);
    });
  });

  describe('assembles what a start assembles', () => {
    test('a credential only in the connection environment is available', async () => {
      const r = resolvers({
        connectionConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } },
      });
      expect(await claudeCredential(r)).toEqual({
        state: 'available',
        source: 'environment',
        appliesTo: SCOPE,
      });
      // Without that layer nothing else holds one.
      expect(await claudeCredential(resolvers())).toMatchObject({
        state: 'unavailable',
      });
    });

    test('a connection environment that blanks the inherited key wins over it', async () => {
      const r = resolvers({
        inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
        connectionConfig: { env: { ANTHROPIC_API_KEY: '' } },
      });
      expect(await claudeCredential(r)).toMatchObject({
        state: 'unavailable',
      });
    });

    test("a credential only in the active profile's confined home is available", async () => {
      enroll(credentialProfileStorageId('claude', 'work'));
      const settings = {
        credentialRecovery: {
          profiles: [{ ref: 'work' }],
          activeProfileRef: 'work',
        },
      };
      expect(await claudeCredential(resolvers({ settings }))).toEqual({
        state: 'available',
        source: 'config-dir',
        appliesTo: SCOPE,
      });
      // The default confined home is not that profile's.
      expect(await claudeCredential(resolvers())).toMatchObject({
        state: 'unavailable',
      });
    });

    test('the inherited environment counts, and the fallback is used only when it cannot be read', async () => {
      expect(
        await claudeCredential(
          resolvers({ inherited: { ANTHROPIC_API_KEY: 'fixture-key' } }),
        ),
      ).toMatchObject({ state: 'available', source: 'environment' });
      const fallbackEnv = vi.fn(() => ({ ANTHROPIC_API_KEY: 'fallback-key' }));
      expect(
        await claudeCredential(
          resolvers({
            spawnEnv: () => {
              throw new Error('environment unavailable');
            },
            fallbackEnv,
          }),
        ),
      ).toMatchObject({ state: 'available', source: 'environment' });
      expect(fallbackEnv).toHaveBeenCalledTimes(1);
      fallbackEnv.mockClear();
      expect(await claudeCredential(resolvers({ fallbackEnv }))).toMatchObject({
        state: 'unavailable',
      });
      expect(fallbackEnv).not.toHaveBeenCalled();
    });

    test('a connection launch that cannot be resolved is unverified', async () => {
      const r = resolvers({
        inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
        connectionLaunch: async () => {
          throw new Error('proxy misconfigured');
        },
      });
      expect(await claudeCredential(r)).toEqual({
        state: 'unverified',
        reason: expect.stringContaining('launch settings'),
        appliesTo: SCOPE,
      });
    });

    test('an active credential profile that cannot be prepared is unverified', async () => {
      const settings = {
        credentialRecovery: {
          profiles: [
            { ref: 'work', env: { ANTHROPIC_AUTH_TOKEN: 'canary-secret' } },
          ],
          activeProfileRef: 'work',
        },
      };
      await expect(
        createCredentialProfileAppHomeEnvPeek(settingsLoader(settings))(),
      ).rejects.toBeInstanceOf(CredentialProfileEnvironmentError);
      const credential = await claudeCredential(
        resolvers({ settings, inherited: { ANTHROPIC_API_KEY: 'k' } }),
      );
      expect(credential).toEqual({
        state: 'unverified',
        reason: expect.stringContaining('credential profile'),
        appliesTo: SCOPE,
      });
      expect(JSON.stringify(credential)).not.toContain('canary-secret');
    });

    test('any other app-home failure continues without an app home, as a start does', async () => {
      // A legacy app home whose marker is not a regular file: the resolver
      // degrades to the global configuration.
      mkdirSync(join(stationHome, 'app-homes', 'claude', 'profile.json'), {
        recursive: true,
      });
      const before = snapshot(stationHome);
      expect(
        await claudeCredential(
          resolvers({
            settings: { config: { useAppHome: true } },
            inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
          }),
        ),
      ).toEqual({
        state: 'available',
        source: 'environment',
        appliesTo: SCOPE,
      });
      expect(snapshot(stationHome)).toEqual(before);
      // A resolver that throws something else: the same.
      expect(
        await claudeCredential(
          resolvers({
            inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
            appHomeEnv: async () => {
              throw new Error('legacy lookup failed');
            },
          }),
        ),
      ).toEqual({
        state: 'available',
        source: 'environment',
        appliesTo: SCOPE,
      });
    });

    test('reports what is decided at start', async () => {
      const preflight = await createStationConfinementPreflight(resolvers())();
      expect(preflight.engines.map((entry) => entry.engine)).toEqual([
        'codex',
        'claude',
      ]);
      expect(preflight.decidedAtStart).toEqual([
        'workspace-too-broad',
        'config-root-pinned',
        'resume-bound-elsewhere',
      ]);
    });
  });
});
