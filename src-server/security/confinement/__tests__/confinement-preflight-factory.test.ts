/**
 * #4774: `createStationConfinementPreflight`, the assembly the running
 * Station serves, over the inputs the runtime hands it: an inherited
 * environment, the real connection launch (`engineProxyLaunch`), stored
 * connection settings and a real temporary Station home (`resolveHomeDir`).
 * The factory's own readers (`inheritedSpawnEnv`, the non-creating app-home
 * resolver) are the real ones; only the environment and the stored settings
 * are fixtures.
 *
 * Not covered: the factory's layering mirrors `ClaudeAdapter.startSession`
 * and `prepareSeatbeltStart` rather than sharing them (see the factory's
 * comment), so a change to the adapter's layering is not seen here.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestContext,
  test,
  vi,
} from 'vitest';
import { confinementProvidersForTests } from '../../../__test-utils__/confinement-providers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  appHomeProfileDir,
  CredentialProfileEnvironmentError,
} from '../../../providers/app-home/app-home-profiles.js';
import {
  createCredentialProfileAppHomeEnvPeek,
  createCredentialProfileAppHomeEnvResolver,
} from '../../../providers/app-home/credential-profile-env.js';
import {
  credentialProfileAppHomeDir,
  credentialProfileStorageId,
} from '../../../providers/app-home/credential-profile-registry.js';
import { engineProxyLaunch } from '../../../services/connections/engine-proxy-routing.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import { createStationConfinementPreflight } from '../confinement-preflight.js';
import { canonicalPath } from '../seatbelt.js';

type Env = Record<string, string>;
type StationConfinementPreflightResolvers = Parameters<
  typeof createStationConfinementPreflight
>[0];
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

  /** The runtime's inputs, with the environment and settings as fixtures. */
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
        processEnv: () => ({ ...inherited }),
        connectionLaunch: async () =>
          engineProxyLaunch('claude', connectionConfig, []),
        loadConnectionSettings: async () => settings ?? {},
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

  // What the snapshot covers: the temporary Station home only. Writes
  // elsewhere (the app config a real runtime loads, the Seatbelt probe's
  // OS temporary directory) are outside it.
  describe('creates, writes and modifies nothing under the Station home', () => {
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

    test('the inherited environment counts, and the process environment is the fallback only when that read fails', async () => {
      expect(
        await claudeCredential(
          resolvers({ inherited: { ANTHROPIC_API_KEY: 'fixture-key' } }),
        ),
      ).toMatchObject({ state: 'available', source: 'environment' });
      // The read fails: the process environment, which holds a key, is used.
      expect(
        await claudeCredential(
          resolvers({
            inherited: { ANTHROPIC_API_KEY: 'fallback-key' },
            spawnEnv: () => {
              throw new Error('environment unavailable');
            },
          }),
        ),
      ).toMatchObject({ state: 'available', source: 'environment' });
      // The read succeeds without a key: the process environment's is unused.
      expect(
        await claudeCredential(
          resolvers({
            inherited: { ANTHROPIC_API_KEY: 'fallback-key' },
            spawnEnv: () => ({}),
          }),
        ),
      ).toMatchObject({ state: 'unavailable' });
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
    });

    test("a Station home given through a symlink is canonicalized, so the profile's confined home is found", async () => {
      // The runtime hands the factory `resolveHomeDir()`, which need not be
      // canonical (macOS `/var` is a link to `/private/var`); the start
      // canonicalizes it, and so must the factory.
      const linkParent = makeTempDir('station-preflight-link-');
      const linkedHome = join(linkParent, 'linked-home');
      symlinkSync(stationHome, linkedHome);
      expect(canonicalPath(linkedHome)).toBe(stationHome);
      enroll(credentialProfileStorageId('claude', 'work'));
      const settings = {
        credentialRecovery: {
          profiles: [{ ref: 'work' }],
          activeProfileRef: 'work',
        },
      };
      expect(
        await claudeCredential(
          resolvers({ settings, stationHome: () => linkedHome }),
        ),
      ).toEqual({ state: 'available', source: 'config-dir', appliesTo: SCOPE });
    });

    describe('where a start would be refused, the answer is unverified (#4774)', () => {
      const PROFILE = {
        credentialRecovery: {
          profiles: [{ ref: 'work' }],
          activeProfileRef: 'work',
        },
      };

      async function expectRefusedLikeStart() {
        // The start's own resolver refuses here: every start without its
        // own credential profile fails before confinement is decided.
        await expect(
          createCredentialProfileAppHomeEnvResolver(settingsLoader(PROFILE))(),
        ).rejects.toBeInstanceOf(CredentialProfileEnvironmentError);
        const before = snapshot(stationHome);
        const credential = await claudeCredential(
          resolvers({
            settings: PROFILE,
            inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
          }),
        );
        expect(credential).toEqual({
          state: 'unverified',
          reason: expect.stringContaining('a start fails'),
          appliesTo: SCOPE,
        });
        if (credential?.state === 'unverified')
          expect(credential.reason).not.toMatch(/[\\/]/);
        expect(snapshot(stationHome)).toEqual(before);
      }

      test("the active profile's home path is a regular file", async () => {
        mkdirSync(join(stationHome, 'app-homes'), { recursive: true });
        writeFileSync(
          credentialProfileAppHomeDir('claude', 'work', stationHome),
          'not a directory',
        );
        await expectRefusedLikeStart();
      });

      test('the app-homes directory is not writable', async (context) => {
        const root = join(stationHome, 'app-homes');
        mkdirSync(root, { recursive: true });
        chmodSync(root, 0o555);
        try {
          const probe = join(root, 'mode-probe');
          let enforced = true;
          try {
            mkdirSync(probe);
            rmSync(probe, { recursive: true, force: true });
            enforced = false;
          } catch {}
          if (!enforced)
            context.skip(
              'this host does not enforce a read-only directory mode (running as root?)',
            );
          await expectRefusedLikeStart();
        } finally {
          chmodSync(root, 0o755);
        }
      });

      /**
       * `app-homes` as a real symlink that cannot be resolved: dangling, or
       * one link of a two-link loop. Returns the paths that must still not
       * exist afterwards; skips, with the reason, where the host cannot
       * create symlinks.
       */
      const UNRESOLVABLE_APP_HOMES = [
        [
          'a dangling symlink',
          () => {
            const target = join(
              makeTempDir('station-preflight-missing-'),
              'missing-app-homes',
            );
            symlinkSync(target, join(stationHome, 'app-homes'));
            return [target];
          },
        ],
        [
          'part of a symlink loop',
          () => {
            const root = join(stationHome, 'app-homes');
            const other = join(stationHome, 'app-homes-loop');
            symlinkSync(other, root);
            symlinkSync(root, other);
            return [];
          },
        ],
      ] as const;

      function linkAppHomes(
        link: () => string[],
        context: TestContext,
      ): string[] {
        try {
          return link();
        } catch (error) {
          return context.skip(
            `this host cannot create symlinks: ${String(error)}`,
          );
        }
      }

      function expectLinkUntouched(targets: string[]) {
        expect(
          lstatSync(join(stationHome, 'app-homes')).isSymbolicLink(),
        ).toBe(true);
        for (const target of targets) expect(existsSync(target)).toBe(false);
      }

      test.for(UNRESOLVABLE_APP_HOMES)(
        'the app-homes directory is %s',
        async ([, link], context) => {
          const targets = linkAppHomes(link, context);
          await expectRefusedLikeStart();
          expectLinkUntouched(targets);
        },
      );

      test.for(UNRESOLVABLE_APP_HOMES)(
        'the legacy app-home opt-in degrades to the global configuration where the app-homes directory is %s',
        async ([, link], context) => {
          const targets = linkAppHomes(link, context);
          const settings = { config: { useAppHome: true } };
          await expect(
            createCredentialProfileAppHomeEnvResolver(
              settingsLoader(settings),
            )(),
          ).resolves.toBeUndefined();
          const before = snapshot(stationHome);
          await expect(
            createCredentialProfileAppHomeEnvPeek(settingsLoader(settings))(),
          ).resolves.toBeUndefined();
          expect(snapshot(stationHome)).toEqual(before);
          expectLinkUntouched(targets);
        },
      );

      test('the legacy app-home opt-in degrades to the global configuration, as its start does', async () => {
        mkdirSync(join(stationHome, 'app-homes'), { recursive: true });
        writeFileSync(
          appHomeProfileDir('claude', stationHome),
          'not a directory',
        );
        const settings = { config: { useAppHome: true } };
        await expect(
          createCredentialProfileAppHomeEnvResolver(settingsLoader(settings))(),
        ).resolves.toBeUndefined();
        await expect(
          createCredentialProfileAppHomeEnvPeek(settingsLoader(settings))(),
        ).resolves.toBeUndefined();
        expect(
          await claudeCredential(
            resolvers({
              settings,
              inherited: { ANTHROPIC_API_KEY: 'fixture-key' },
            }),
          ),
        ).toEqual({
          state: 'available',
          source: 'environment',
          appliesTo: SCOPE,
        });
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
