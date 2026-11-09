/**
 * #2494 fix round: the confined Claude home is never one an unconfined spawn
 * uses (R3), and the spawn wrapper passes the engine only an allowlisted
 * environment (R8) with the secure-store override dropped wherever it came
 * from. The wrapper is exercised directly, through the production provider.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stationSessionTmpRootName } from '@kontourai/station-shared/temp-dir';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  canonicalPath,
  createSeatbeltConfinementProvider,
  seatbeltTempRoot,
  seatbeltWriteGrantKinds,
} from '../../security/confinement/seatbelt.js';
import {
  SESSION_TMPDIR_MAX_BYTES,
  sessionTmpDirTestHooks,
  shortSessionTmpRoots,
} from '../../services/infra/session-tmpdir.js';
import {
  type ConfinedClaudeLaunch,
  confinedClaudeConfigDir,
  confinedClaudeSpawn,
  confinedEnvAllows,
  prepareConfinedClaudeLaunch,
} from '../adapters/claude-seatbelt.js';
import { appHomeProfileDir } from '../app-home/app-home-profiles.js';
import { credentialProfileAppHomeDir } from '../app-home/credential-profile-registry.js';

const STATION_HOME = '/Users/op/.station/instances/stable';
const CONFINED_ROOT = `${STATION_HOME}/confined-homes`;

describe('the confined Claude home', () => {
  /** Every config home an unconfined spawn can be given, by layer. */
  const unconfinedHomes = {
    'no app home (the global ~/.claude)': {
      appHomeEnv: undefined,
      unconfined: join(homedir(), '.claude'),
    },
    'the app-home opt-in': {
      appHomeEnv: {
        CLAUDE_CONFIG_DIR: appHomeProfileDir('claude', STATION_HOME),
      },
      unconfined: appHomeProfileDir('claude', STATION_HOME),
    },
    'a selected credential profile': {
      appHomeEnv: {
        CLAUDE_CONFIG_DIR: credentialProfileAppHomeDir(
          'claude',
          'work',
          STATION_HOME,
        ),
      },
      unconfined: credentialProfileAppHomeDir('claude', 'work', STATION_HOME),
    },
    "a connection's configHome": {
      appHomeEnv: { CLAUDE_CONFIG_DIR: '/Users/op/.claude-work' },
      unconfined: '/Users/op/.claude-work',
    },
  };

  test.each(Object.entries(unconfinedHomes))(
    'with %s, it is under the confined root and differs from the unconfined home',
    (_label, { appHomeEnv, unconfined }) => {
      const confined = confinedClaudeConfigDir(appHomeEnv, STATION_HOME);
      expect(confined.startsWith(`${CONFINED_ROOT}/`)).toBe(true);
      expect(confined).not.toBe(unconfined);
      expect(confined.startsWith(`${STATION_HOME}/app-homes`)).toBe(false);
    },
  );

  test('a credential profile gets a confined twin of its own', () => {
    expect(
      confinedClaudeConfigDir(
        {
          CLAUDE_CONFIG_DIR: credentialProfileAppHomeDir(
            'claude',
            'work',
            STATION_HOME,
          ),
        },
        STATION_HOME,
      ),
    ).toMatch(
      /^\/Users\/op\/\.station\/instances\/stable\/confined-homes\/credential-profile-[0-9a-f]+$/,
    );
    expect(confinedClaudeConfigDir(undefined, STATION_HOME)).toBe(
      `${CONFINED_ROOT}/claude`,
    );
  });
});

describe('the confined spawn environment', () => {
  const launch = {
    workspace: '/Users/op/dev/project',
    configDir: `${CONFINED_ROOT}/claude`,
    tmpDir: `${STATION_HOME}/tmp/confined-sessions/session-1-abcdef`,
    grants: { writable: ['/Users/op/dev/project'], readable: [] },
  };

  test('passes only allowlisted ambient variables and the configured ones, and never the secure-store override', () => {
    const { wrap } = confinedClaudeSpawn(
      createSeatbeltConfinementProvider(),
      launch,
      new Set(['STATION_TEST_CONFIGURED', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']),
    );
    const out = wrap({
      command: '/usr/local/bin/claude',
      args: [],
      cwd: launch.workspace,
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/op',
        LC_ALL: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'sk-ant-fake',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        GH_TOKEN: 'ghp_planted',
        GITHUB_TOKEN: 'ghp_planted',
        NPM_TOKEN: 'npm_planted',
        AWS_SECRET_ACCESS_KEY: 'aws_planted',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        STATION_TEST_CONFIGURED: 'kept',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/op/.claude',
        CLAUDE_CONFIG_DIR: '/Users/op/.claude',
        TMPDIR: '/tmp',
        UNSET: undefined,
      },
    });
    expect(out.command).toBe('/usr/bin/sandbox-exec');
    expect(out.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/op',
      LC_ALL: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      STATION_TEST_CONFIGURED: 'kept',
      CLAUDE_CONFIG_DIR: launch.configDir,
      TMPDIR: launch.tmpDir,
    });
  });

  test.each([
    ['GH_TOKEN', false],
    ['GITHUB_TOKEN', false],
    ['NPM_TOKEN', false],
    ['AWS_ACCESS_KEY_ID', false],
    ['GOOGLE_APPLICATION_CREDENTIALS', false],
    ['SSH_AUTH_SOCK', false],
    ['OPENAI_API_KEY', false],
    ['PATH', true],
    ['HTTPS_PROXY', true],
    ['NODE_EXTRA_CA_CERTS', true],
    ['ANTHROPIC_BASE_URL', true],
    ['CLAUDE_CODE_OAUTH_TOKEN', true],
    ['GIT_AUTHOR_NAME', true],
    ['GIT_AUTHOR_EMAIL', true],
    ['GIT_COMMITTER_NAME', true],
    ['GIT_COMMITTER_EMAIL', true],
    ['EDITOR', true],
    ['VISUAL', true],
    ['GIT_ASKPASS', false],
    ['GIT_SSH_COMMAND', false],
    ['NVM_DIR', false],
    ['JAVA_HOME', false],
  ])('%s is allowed: %s', (key, allowed) => {
    expect(confinedEnvAllows(key)).toBe(allowed);
  });
});

/**
 * #4740: a confined session's TMPDIR is where its agent's tools put Unix
 * sockets, capped by `sun_path` (104 bytes with the NUL on macOS). Under a
 * long Station home it goes in the short per-user root, and the generated
 * profile grants writes to exactly that one directory. The kernel side
 * (`sandbox-exec`) is `seatbelt.process.test.ts`, which runs only on macOS.
 */
describe.skipIf(process.platform === 'win32')(
  'the confined TMPDIR socket budget and its write grant',
  () => {
    const makeTempDir = trackTempDirs();
    // Short bases under the system /tmp, so a test-owned short root fits.
    const makeShortDir = trackTempDirs({ base: '/tmp' });

    afterEach(() => {
      sessionTmpDirTestHooks.shortBases = undefined;
    });

    /** A macOS-style long home, a workspace, and a test-owned short root. */
    function layout() {
      const root = canonicalPath(makeTempDir('claude-seatbelt-budget-'));
      const home = join(root, 'Users', 'firstname.lastname');
      const stationHome = join(
        home,
        '.station',
        'instances',
        'workstation-review',
      );
      const workspace = join(home, 'dev', 'project');
      mkdirSync(stationHome, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      const base = realpathSync(makeShortDir('st'));
      sessionTmpDirTestHooks.shortBases = () => [base];
      const [shortRoot] = shortSessionTmpRoots();
      return { home, stationHome, workspace, base, shortRoot: shortRoot! };
    }

    function prepare(
      at: ReturnType<typeof layout>,
    ): Promise<ConfinedClaudeLaunch> {
      return prepareConfinedClaudeLaunch({
        workspace: at.workspace,
        configDir: join(at.stationHome, 'confined-homes', 'claude'),
        stationHome: at.stationHome,
        home: at.home,
        stationRoot: join(at.home, '.station'),
      });
    }

    /** The profile the production provider actually spawns with. */
    function spawnedProfile(launch: ConfinedClaudeLaunch): string {
      const { wrap } = confinedClaudeSpawn(
        createSeatbeltConfinementProvider(),
        launch,
      );
      const spawned = wrap({
        command: '/usr/local/bin/claude',
        args: [],
        cwd: launch.workspace,
        env: {},
      });
      expect(spawned.args[0]).toBe('-p');
      expect(spawned.env.TMPDIR).toBe(launch.tmpDir);
      return spawned.args[1]!;
    }

    /**
     * Every path an allow rule that includes a write operation names, read
     * from the profile text (a rule may carry several filters).
     */
    function writablePaths(profile: string): string[] {
      return profile
        .split('\n')
        .filter((line) => /^\(allow [^(]*file-write/.test(line))
        .flatMap((line) =>
          [
            ...line.matchAll(/\((?:subpath|literal|regex|prefix) ([^)]*)\)/g),
          ].map((match) => match[1]!),
        );
    }

    test('under a default macOS home, the old layout overflows a tsx socket and the short root leaves room', () => {
      // A real macOS layout: a long account name, the default instance, a
      // five-digit pid, uid 501, and the canonical /tmp.
      const macHome =
        '/Users/firstname.lastname/.station/instances/workstation-review';
      const name = 'session-99999-abcdef';
      const tsxPipe = (dir: string) => join(dir, 'tsx-501', '99999.pipe');
      const before = join(seatbeltTempRoot(macHome), name);
      expect(Buffer.byteLength(before)).toBeGreaterThan(
        SESSION_TMPDIR_MAX_BYTES,
      );
      expect(Buffer.byteLength(tsxPipe(before))).toBeGreaterThan(103);
      const after = join('/private/tmp', stationSessionTmpRootName(501), name);
      expect(after).toBe('/private/tmp/stn-501/session-99999-abcdef');
      expect(Buffer.byteLength(after)).toBeLessThanOrEqual(
        SESSION_TMPDIR_MAX_BYTES,
      );
      expect(Buffer.byteLength(tsxPipe(after))).toBeLessThanOrEqual(103);
    });

    test('a long home gets a private per-launch TMPDIR in the short root, within budget, removed on cleanup', async () => {
      const at = layout();
      const inHome = join(
        seatbeltTempRoot(at.stationHome),
        'session-99999-abcdef',
      );
      expect(Buffer.byteLength(inHome)).toBeGreaterThan(
        SESSION_TMPDIR_MAX_BYTES,
      );
      const launch = await prepare(at);
      const second = await prepare(at);
      try {
        expect(dirname(launch.tmpDir)).toBe(at.shortRoot);
        expect(basename(launch.tmpDir)).toMatch(
          new RegExp(`^session-${process.pid}-[A-Za-z0-9]{6}$`),
        );
        expect(Buffer.byteLength(launch.tmpDir)).toBeLessThanOrEqual(
          SESSION_TMPDIR_MAX_BYTES,
        );
        expect(second.tmpDir).not.toBe(launch.tmpDir);
        for (const owned of [launch.tmpDir, at.shortRoot]) {
          const stats = lstatSync(owned);
          expect(stats.isDirectory() && !stats.isSymbolicLink()).toBe(true);
          expect(stats.mode & 0o777).toBe(0o700);
          expect(stats.uid).toBe(process.getuid!());
        }
        expect(existsSync(seatbeltTempRoot(at.stationHome))).toBe(false);
        expect(launch.writeGrants).toContain('station-temp');
        // A tool's socket under it listens (the host kernel's sun_path).
        const tsxDir = join(launch.tmpDir, `tsx-${process.getuid!()}`);
        mkdirSync(tsxDir);
        const widest = join(
          launch.tmpDir,
          'x'.repeat(103 - Buffer.byteLength(launch.tmpDir) - 1),
        );
        expect(Buffer.byteLength(widest)).toBe(103);
        for (const path of [join(tsxDir, '4194304.pipe'), widest]) {
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(path, resolve);
          });
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        launch.cleanup();
        second.cleanup();
      }
      expect(existsSync(launch.tmpDir)).toBe(false);
      expect(readdirSync(at.shortRoot)).toEqual([]);
    });

    test('the spawned profile grants writes to exactly that directory, never its root, /tmp or TMPDIR', async () => {
      const at = layout();
      const launch = await prepare(at);
      try {
        const profile = spawnedProfile(launch);
        const allowed = writablePaths(profile);
        // The workspace has no git: exactly these grants, besides the base
        // profile's two devices.
        expect(allowed.sort()).toEqual(
          [
            launch.workspace,
            launch.tmpDir,
            launch.configDir,
            '/dev/null',
            '/dev/dtracehelper',
          ]
            .map((path) => `"${path}"`)
            .sort(),
        );
        for (const broader of [
          at.shortRoot,
          at.base,
          '/tmp',
          '/private/tmp',
          canonicalPath(tmpdir()),
          ...(process.env.TMPDIR ? [process.env.TMPDIR] : []),
        ]) {
          expect(profile).not.toContain(`file-write* (subpath "${broader}")`);
          expect(allowed).not.toContain(`"${broader}"`);
        }
        const lines = profile.split('\n');
        // The root, with other sessions' directories, is hidden; the
        // session's own grant comes after it, so it wins for that subpath.
        const hideRoot = lines.indexOf(
          `(deny file-read* (subpath "${at.shortRoot}"))`,
        );
        const grant = lines.indexOf(
          `(allow file-read* file-write* (subpath "${launch.tmpDir}"))`,
        );
        expect(hideRoot).toBeGreaterThan(-1);
        expect(grant).toBeGreaterThan(hideRoot);
        // Its engine configuration directories (.codex, .claude) stay
        // write-denied inside it too.
        const escaped = launch.tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(
          lines.filter((line) =>
            line.startsWith(`(deny file-write* (regex #"^${escaped}/`),
          ),
        ).toHaveLength(2);
      } finally {
        launch.cleanup();
      }
    });

    test('a grant of the short root, another session directory there, or a look-alike elsewhere is out of bounds', async () => {
      const at = layout();
      const launch = await prepare(at);
      try {
        const swap = (path: string) =>
          seatbeltWriteGrantKinds(
            {
              ...launch.grants,
              writable: launch.grants.writable.map((granted) =>
                granted === launch.tmpDir ? path : granted,
              ),
            },
            launch.bounds,
          );
        expect(swap(launch.tmpDir)).toContain('station-temp');
        expect(swap(at.shortRoot)).toBeUndefined();
        // An unconfined session's TMPDIR in the same root.
        expect(
          swap(join(at.shortRoot, `${process.pid}-${'a'.repeat(16)}`)),
        ).toBeUndefined();
        expect(swap(join(at.base, basename(launch.tmpDir)))).toBeUndefined();
        expect(swap('/tmp')).toBeUndefined();
      } finally {
        launch.cleanup();
      }
    });

    test('a short root that is a link is passed over for the in-home root, and the grant follows', async () => {
      const at = layout();
      const elsewhere = realpathSync(makeShortDir('st'));
      symlinkSync(elsewhere, at.shortRoot);
      const launch = await prepare(at);
      try {
        expect(dirname(launch.tmpDir)).toBe(seatbeltTempRoot(at.stationHome));
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(launch.writeGrants).toContain('station-temp');
        expect(writablePaths(spawnedProfile(launch))).toContain(
          `"${launch.tmpDir}"`,
        );
      } finally {
        launch.cleanup();
      }
    });

    test('a short home keeps the directory in its own tmp tree', async () => {
      const at = layout();
      const stationHome = realpathSync(makeShortDir('h'));
      const launch = await prepareConfinedClaudeLaunch({
        workspace: at.workspace,
        configDir: join(stationHome, 'confined-homes', 'claude'),
        stationHome,
        home: at.home,
        stationRoot: join(at.home, '.station'),
      });
      try {
        expect(dirname(launch.tmpDir)).toBe(seatbeltTempRoot(stationHome));
        expect(Buffer.byteLength(launch.tmpDir)).toBeLessThanOrEqual(
          SESSION_TMPDIR_MAX_BYTES,
        );
        expect(existsSync(at.shortRoot)).toBe(false);
        expect(launch.writeGrants).toContain('station-temp');
      } finally {
        launch.cleanup();
      }
    });
  },
);
