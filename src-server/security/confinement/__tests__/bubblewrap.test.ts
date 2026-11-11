/**
 * #4770: the bubblewrap provider's rules, on any host: availability (by
 * injection), the grants and the arguments built from them, the breadth
 * check read back from those arguments, and the posture it derives from
 * evidence. Nothing is spawned. The kernel's behaviour under the production
 * arguments is `bubblewrap.process.test.ts`.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  confinedClaudeDecision,
  prepareConfinedClaudeLaunch,
} from '../../../providers/adapters/claude-seatbelt.js';
import { codexSandboxConfinementProvider } from '../../../providers/adapters/codex-confinement.js';
import {
  BUBBLEWRAP,
  BUBBLEWRAP_BASE_ARGS,
  bubblewrapArgs,
  bubblewrapConfinementProvider,
  bubblewrapGrants,
  bubblewrapHiddenPaths,
  bubblewrapVersionRefusal,
  bubblewrapWorkspaceRefusal,
  bubblewrapWriteGrantKinds,
  confineWithBubblewrap,
  createBubblewrapConfinementProvider,
  observeBubblewrapPosture,
} from '../bubblewrap.js';
import {
  type ConfinementProvider,
  type ConfinementSpawnSpec,
  resolveConfinement,
} from '../confinement-provider.js';
import { defaultConfinementProviders } from '../default-confinement-providers.js';
import {
  canonicalPath,
  type SeatbeltBounds,
  seatbeltConfinementProvider,
  seatbeltHiddenPaths,
} from '../seatbelt.js';

const makeTempDir = trackTempDirs();

/** A host layout on disk: the arguments are built from what exists. */
interface Layout {
  root: string;
  home: string;
  stationRoot: string;
  stationHome: string;
  workspace: string;
  temp: string;
  config: string;
  bounds: SeatbeltBounds;
}

function layout(options: { git?: boolean } = {}): Layout {
  const root = canonicalPath(makeTempDir('bubblewrap-unit-'));
  const home = join(root, 'home');
  const stationRoot = join(home, '.station');
  const stationHome = join(stationRoot, 'instances', 'test');
  const workspace = join(root, 'dev', 'feature');
  const temp = join(
    stationHome,
    'tmp',
    'confined-sessions',
    'session-4242-abcdef',
  );
  const config = join(stationHome, 'confined-homes', 'claude');
  for (const dir of [
    join(home, '.ssh'),
    join(stationRoot, 'installs'),
    workspace,
    temp,
    config,
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.netrc'), 'machine x\n');
  const common = join(root, 'dev', 'repo', '.git');
  const git = options.git
    ? { gitDir: join(common, 'worktrees', 'feature'), commonDir: common }
    : undefined;
  if (git) writeFileSync(join(workspace, '.git'), `gitdir: ${git.gitDir}\n`);
  return {
    root,
    home,
    stationRoot,
    stationHome,
    workspace,
    temp,
    config,
    bounds: { workspace, stationHome, home, ...(git ? { git } : {}) },
  };
}

function grantsFor(at: Layout): ConfinementSpawnSpec['grants'] {
  const { hidden, readable } = bubblewrapHiddenPaths({
    home: at.home,
    stationRoot: at.stationRoot,
    stationHome: at.stationHome,
    runtimeDir: null,
  });
  return bubblewrapGrants({
    workspace: at.workspace,
    stationTempDir: at.temp,
    stationConfigDir: at.config,
    ...(at.bounds.git ? { git: at.bounds.git } : {}),
    hidden,
    readable,
  });
}

function specFor(
  at: Layout,
  grants: ConfinementSpawnSpec['grants'] = grantsFor(at),
): ConfinementSpawnSpec {
  return {
    command: '/opt/claude/bin/claude',
    args: ['--print'],
    cwd: at.workspace,
    env: {},
    grants,
    network: 'full',
  };
}

/** The index of the operation `option a b` in `args`, or -1. */
function at(args: readonly string[], ...operation: string[]): number {
  return args.findIndex((_, index) =>
    operation.every((value, offset) => args[index + offset] === value),
  );
}

describe('bubblewrap availability', () => {
  test.each(['darwin', 'win32'] as const)(
    'is unavailable on %s, naming why, without probing',
    (platform) => {
      const probe = vi.fn();
      const provider = createBubblewrapConfinementProvider({
        platform: () => platform,
        probe,
      });
      expect(provider.availability()).toEqual({
        available: false,
        reason: `bubblewrap is Linux-only; this host is ${platform}`,
      });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  test('is unavailable on Linux without bwrap, naming the package, without probing', () => {
    const probe = vi.fn();
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
      bwrap: '/nonexistent/bwrap',
      probe,
    });
    expect(provider.availability()).toEqual({
      available: false,
      reason:
        '/nonexistent/bwrap is missing or not executable (install the bubblewrap package)',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  test('is unavailable on a Linux kernel that refuses the sandbox, with the probe’s reason', () => {
    const reason =
      'the bubblewrap sandbox did not apply (bwrap: setting up uid map: Permission denied)';
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
      // Any executable stands in for bwrap; the probe is the kernel's answer.
      bwrap: process.execPath,
      probe: () => ({ ok: false, reason }),
    });
    expect(provider.availability()).toEqual({ available: false, reason });
  });

  test('follows the production-sandbox probe, run once', () => {
    const probe = vi.fn(() => ({ ok: true, reason: 'applies' }));
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
      bwrap: process.execPath,
      probe,
    });
    expect(provider.availability()).toEqual({
      available: true,
      reason: 'applies',
    });
    expect(provider.availability().available).toBe(true);
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.execPath);
  });

  test('applies only to Claude, as a spawn wrapper, in either workspace mode', () => {
    expect(bubblewrapConfinementProvider).toMatchObject({
      level: 'os-profile',
      mechanism: 'bubblewrap',
      workspaceAccess: 'mounted',
      supportedIsolationModes: ['shared', 'worktree'],
      engagement: 'spawn-wrapper',
      engines: ['claude'],
    });
  });
});

describe('the default providers on each platform', () => {
  test('Linux consults bubblewrap for Claude, never Seatbelt', () => {
    expect(defaultConfinementProviders('linux')).toEqual([
      codexSandboxConfinementProvider,
      bubblewrapConfinementProvider,
    ]);
  });

  test.each(['darwin', 'win32'] as const)('%s keeps Seatbelt', (platform) => {
    expect(defaultConfinementProviders(platform)).toEqual([
      codexSandboxConfinementProvider,
      seatbeltConfinementProvider,
    ]);
  });
});

describe('resolution on Linux', () => {
  const resolve = (provider: ConfinementProvider) =>
    resolveConfinement({
      confinement: 'workspace',
      engine: 'claude',
      appliedMode: 'never',
      isolationMode: 'worktree',
      providers: [codexSandboxConfinementProvider, provider],
      platform: 'linux',
    });

  test('a workspace Claude start at never resolves a bubblewrap plan where it applies', () => {
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
      bwrap: process.execPath,
      probe: () => ({ ok: true, reason: 'applies' }),
    }) as ConfinementProvider;
    expect(resolve(provider).plan).toEqual({
      requiredLevel: 'os-profile',
      policyBasis: 'workspace-floor',
      mechanism: 'bubblewrap',
      level: 'os-profile',
      workspaceAccess: 'mounted',
    });
  });

  test('where the kernel refuses it, the start is refused before anything starts, naming bubblewrap and why', () => {
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
      bwrap: process.execPath,
      probe: () => ({
        ok: false,
        reason: 'the bubblewrap sandbox did not apply (No permissions)',
      }),
    }) as ConfinementProvider;
    expect(() => resolve(provider)).toThrow(
      expect.objectContaining({
        code: 'confinement_mechanism_unavailable',
        message: expect.stringMatching(
          /needs a bubblewrap sandbox; none is available .*bubblewrap: the bubblewrap sandbox did not apply \(No permissions\)/,
        ),
      }),
    );
  });
});

describe('bubblewrap grants', () => {
  test('the workspace, the session temp directory and the Station configuration directory are the only write grants', () => {
    const where = layout();
    const grants = grantsFor(where);
    expect(grants.writable).toEqual([
      where.workspace,
      where.temp,
      where.config,
    ]);
    expect(grants.writableFiles).toEqual([]);
    expect(grants.writeDeniedExact).toEqual([]);
    expect(grants.writeDenied).toEqual([]);
    expect(grants.writeDeniedNames).toEqual(['.codex', '.claude']);
  });

  test("with a git layout the workspace's own .git is denied and no git directory is granted", () => {
    const where = layout({ git: true });
    const grants = grantsFor(where);
    expect(grants.writeDenied).toEqual([join(where.workspace, '.git')]);
    expect(grants.writable).not.toContain(where.bounds.git!.gitDir);
    expect(
      grants.writable.some((path) =>
        path.startsWith(where.bounds.git!.commonDir),
      ),
    ).toBe(false);
  });

  test('hides the Seatbelt list, the login keyring, the runtime directory and the daemon sockets', () => {
    const options = {
      home: '/home/op',
      stationRoot: '/home/op/.station',
      stationHome: '/home/op/.station/instances/a',
    };
    const hidden = bubblewrapHiddenPaths({
      ...options,
      runtimeDir: '/run/user/1000',
    }).hidden;
    // Pinned independently of the builder: each path, symlink-resolved as
    // every confinement path is (/var/run links to /run on most hosts, so
    // the two Docker paths may be one).
    const expected = [
      ...seatbeltHiddenPaths(options).hidden,
      '/home/op/.local/share/keyrings',
      '/home/op/.docker/run',
      '/home/op/.Xauthority',
      '/run/user/1000',
      '/run/docker.sock',
      '/var/run/docker.sock',
      '/run/podman',
      '/run/containerd',
      '/run/dbus/system_bus_socket',
      '/tmp/.X11-unix',
    ].map(canonicalPath);
    expect(hidden).toEqual([...new Set(expected)]);
    expect(
      bubblewrapHiddenPaths({ ...options, runtimeDir: null }).hidden,
    ).not.toContain(canonicalPath('/run/user/1000'));
  });

  test('an existing .git is read-only even when its layout cannot be read', () => {
    const where = layout();
    writeFileSync(join(where.workspace, '.git'), 'not a git pointer\n');
    const grants = grantsFor(where);
    const dotGit = join(where.workspace, '.git');
    expect(grants.writeDenied).toEqual([dotGit]);
    const args = bubblewrapArgs(specFor(where, grants));
    expect(at(args, '--ro-bind', dotGit, dotGit)).toBeGreaterThan(
      at(args, '--bind', where.workspace, where.workspace),
    );
    // And arguments that leave it writable are out of bounds.
    const index = at(args, '--ro-bind', dotGit, dotGit);
    expect(
      bubblewrapWriteGrantKinds(
        [...args.slice(0, index), ...args.slice(index + 3)],
        where.bounds,
      ),
    ).toBeUndefined();
  });
});

describe('bubblewrap arguments', () => {
  let where: Layout;
  beforeEach(() => {
    where = layout({ git: true });
  });

  test('start with the namespaces and the read-only root, and end with the command after --', () => {
    const args = bubblewrapArgs(specFor(where));
    expect(args.slice(0, BUBBLEWRAP_BASE_ARGS.length)).toEqual([
      ...BUBBLEWRAP_BASE_ARGS,
    ]);
    expect(BUBBLEWRAP_BASE_ARGS).toEqual([
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--disable-userns',
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
    ]);
    expect(args.slice(-5)).toEqual([
      '--chdir',
      where.workspace,
      '--',
      '/opt/claude/bin/claude',
      '--print',
    ]);
    expect(confineWithBubblewrap(specFor(where))).toMatchObject({
      command: BUBBLEWRAP,
      args,
    });
  });

  test('hide a directory under a read-only empty mount and a file under /dev/null; skip what does not exist', () => {
    const args = bubblewrapArgs(specFor(where));
    const ssh = join(where.home, '.ssh');
    expect(at(args, '--tmpfs', ssh)).toBeGreaterThan(0);
    expect(at(args, '--remount-ro', ssh)).toBeGreaterThan(
      at(args, '--bind', where.workspace, where.workspace),
    );
    const netrc = join(where.home, '.netrc');
    expect(at(args, '--ro-bind', '/dev/null', netrc)).toBeGreaterThan(0);
    // Absent at the start: nothing to cover (a stated difference).
    expect(args).not.toContain(join(where.home, '.aws'));
    // Inside a hidden directory already: not covered twice.
    expect(args.filter((value) => value === where.stationHome)).toEqual([]);
    expect(at(args, '--tmpfs', where.stationRoot)).toBeGreaterThan(0);
  });

  test('re-open the installs, then the write grants inside the hidden Station root, before denying the .git', () => {
    const args = bubblewrapArgs(specFor(where));
    const installs = join(where.stationRoot, 'installs');
    const hiddenRoot = at(args, '--tmpfs', where.stationRoot);
    const reopened = at(args, '--ro-bind', installs, installs);
    const temp = at(args, '--bind', where.temp, where.temp);
    const config = at(args, '--bind', where.config, where.config);
    const workspace = at(args, '--bind', where.workspace, where.workspace);
    const dotGit = join(where.workspace, '.git');
    const denied = at(args, '--ro-bind', dotGit, dotGit);
    expect(reopened).toBeGreaterThan(hiddenRoot);
    for (const grant of [temp, config, workspace])
      expect(grant).toBeGreaterThan(reopened);
    expect(denied).toBeGreaterThan(Math.max(temp, config, workspace));
  });

  test('an existing engine configuration directory at a grant root is read-only, in any case; a file or a link is not', () => {
    mkdirSync(join(where.workspace, '.claude'));
    mkdirSync(join(where.workspace, '.Codex'));
    writeFileSync(join(where.workspace, '.claude.json'), '{}');
    mkdirSync(join(where.root, 'elsewhere'));
    symlinkSync(join(where.root, 'elsewhere'), join(where.temp, '.codex'));
    const args = bubblewrapArgs(specFor(where));
    for (const name of ['.claude', '.Codex']) {
      const path = join(where.workspace, name);
      expect(at(args, '--ro-bind', path, path), name).toBeGreaterThan(
        at(args, '--bind', where.workspace, where.workspace),
      );
    }
    expect(args).not.toContain(join(where.workspace, '.claude.json'));
    expect(args).not.toContain(join(where.temp, '.codex'));
  });

  test('an absent denied path is covered by its nearest existing ancestor inside the grant', () => {
    mkdirSync(join(where.workspace, 'sub'));
    const args = bubblewrapArgs(
      specFor(where, {
        ...grantsFor(where),
        writeDenied: [join(where.workspace, 'sub', 'absent', 'file')],
      }),
    );
    const sub = join(where.workspace, 'sub');
    expect(at(args, '--ro-bind', sub, sub)).toBeGreaterThan(0);
  });

  test('a denied path outside every grant needs no mount: the root is read-only', () => {
    const outside = join(where.root, 'outside', 'file');
    const args = bubblewrapArgs(
      specFor(where, { ...grantsFor(where), writeDenied: [outside] }),
    );
    expect(args).not.toContain(outside);
    expect(args).not.toContain(where.root);
  });

  test.each([
    [
      'an absent denied path that only its whole grant could cover',
      (g: ConfinementSpawnSpec['grants'], w: Layout) => ({
        ...g,
        writeDenied: [join(w.workspace, 'absent')],
      }),
      /cannot be covered without covering its whole grant/,
    ],
    [
      'a single-file grant',
      (g: ConfinementSpawnSpec['grants'], w: Layout) => ({
        ...g,
        writableFiles: [join(w.workspace, 'ref')],
      }),
      /cannot grant a single file/,
    ],
    [
      'an exact-path deny',
      (g: ConfinementSpawnSpec['grants'], w: Layout) => ({
        ...g,
        writeDeniedExact: [w.workspace],
      }),
      /cannot deny a path exactly/,
    ],
    [
      'a writable grant that does not exist',
      (g: ConfinementSpawnSpec['grants'], w: Layout) => ({
        ...g,
        writable: [...g.writable, join(w.root, 'absent')],
      }),
      /is not a directory/,
    ],
    [
      'a relative path',
      (g: ConfinementSpawnSpec['grants']) => ({
        ...g,
        hidden: ['relative/secret'],
      }),
      /not absolute/,
    ],
  ])('refuse %s rather than narrow or widen it', (_label, change, message) => {
    expect(() =>
      bubblewrapArgs(specFor(where, change(grantsFor(where), where))),
    ).toThrow(message);
  });

  test('refuse a narrower network than it can enforce', () => {
    expect(() =>
      bubblewrapArgs({ ...specFor(where), network: 'loopback' }),
    ).toThrow(/does not restrict the network/);
  });
});

describe('bubblewrap breadth, read from the arguments', () => {
  test('in-bounds arguments are named by kind', () => {
    for (const git of [false, true]) {
      const where = layout({ git });
      expect(
        bubblewrapWriteGrantKinds(bubblewrapArgs(specFor(where)), where.bounds),
      ).toEqual(['station-config', 'station-temp', 'workspace']);
    }
  });

  test.each([
    ['the whole filesystem writable', ['--bind', '/', '/']],
    ['the home folder writable', (w: Layout) => ['--bind', w.home, w.home]],
    [
      "the linked worktree's git directory writable",
      (w: Layout) => ['--bind', w.bounds.git!.gitDir, w.bounds.git!.gitDir],
    ],
    [
      'a grant mounted somewhere else',
      (w: Layout) => ['--bind', w.root, w.workspace],
    ],
    [
      'a temp directory not named for its owner process',
      (w: Layout) => {
        const other = join(w.stationHome, 'tmp', 'confined-sessions', 'x');
        return ['--bind', other, other];
      },
    ],
    ['an option Station never emits', ['--dev-bind', '/', '/']],
  ])('%s is out of bounds', (_label, extra) => {
    const where = layout({ git: true });
    const args = bubblewrapArgs(specFor(where));
    const inserted = typeof extra === 'function' ? extra(where) : extra;
    const separator = args.indexOf('--');
    expect(
      bubblewrapWriteGrantKinds(
        [...args.slice(0, separator), ...inserted, ...args.slice(separator)],
        where.bounds,
      ),
    ).toBeUndefined();
  });

  test.each([
    ['the read-only root', '--ro-bind'],
    ['the PID namespace', '--unshare-pid'],
    ['the nested user namespace refusal', '--disable-userns'],
  ])('arguments missing %s are out of bounds', (_label, option) => {
    const where = layout();
    const args = bubblewrapArgs(specFor(where));
    const index = args.indexOf(option);
    const arity = option === '--ro-bind' ? 3 : 1;
    expect(
      bubblewrapWriteGrantKinds(
        [...args.slice(0, index), ...args.slice(index + arity)],
        where.bounds,
      ),
    ).toBeUndefined();
  });

  test('a git layout whose .git is not read-only after the workspace mount is out of bounds', () => {
    const where = layout({ git: true });
    const args = bubblewrapArgs(specFor(where));
    const dotGit = join(where.workspace, '.git');
    const denied = at(args, '--ro-bind', dotGit, dotGit);
    const without = [...args.slice(0, denied), ...args.slice(denied + 3)];
    expect(bubblewrapWriteGrantKinds(without, where.bounds)).toBeUndefined();
    // Mounted before the workspace, it would be covered by it.
    const workspace = at(without, '--bind', where.workspace, where.workspace);
    const early = [
      ...without.slice(0, workspace),
      '--ro-bind',
      dotGit,
      dotGit,
      ...without.slice(workspace),
    ];
    expect(bubblewrapWriteGrantKinds(early, where.bounds)).toBeUndefined();
  });

  test('a workspace that is the home folder is out of bounds', () => {
    const where = layout();
    expect(
      bubblewrapWriteGrantKinds(bubblewrapArgs(specFor(where)), {
        ...where.bounds,
        workspace: where.home,
      }),
    ).toBeUndefined();
  });

  test('arguments without the command separator are out of bounds', () => {
    const where = layout();
    const args = bubblewrapArgs(specFor(where));
    expect(
      bubblewrapWriteGrantKinds(
        args.slice(0, args.indexOf('--')),
        where.bounds,
      ),
    ).toBeUndefined();
  });
});

describe('bubblewrap posture', () => {
  test('confined only when the engine answered from the exact sandboxed spawn, in bounds', () => {
    const where = layout({ git: true });
    const confined = confineWithBubblewrap(specFor(where));
    const spawned = { command: confined.command, args: confined.args };
    const evidence = {
      spawned,
      handshake: 'completed' as const,
      bounds: where.bounds,
    };
    expect(observeBubblewrapPosture(confined, evidence)).toBe('confined');
    expect(observeBubblewrapPosture(confined, undefined)).toBe(
      'configured-but-failed',
    );
    expect(
      observeBubblewrapPosture(confined, { ...evidence, handshake: 'failed' }),
    ).toBe('configured-but-failed');
    expect(
      observeBubblewrapPosture(confined, { ...evidence, spawned: undefined }),
    ).toBe('configured-but-failed');
    expect(
      observeBubblewrapPosture(confined, {
        ...evidence,
        spawned: { command: '/opt/claude/bin/claude', args: ['--print'] },
      }),
    ).toBe('configured-but-failed');
    expect(
      observeBubblewrapPosture(confined, {
        ...evidence,
        spawned: { ...spawned, args: spawned.args.slice(1) },
      }),
    ).toBe('configured-but-failed');
    expect(
      observeBubblewrapPosture(confined, {
        ...evidence,
        bounds: { ...where.bounds, workspace: where.home },
      }),
    ).toBe('configured-but-failed');
  });

  test("the provider's pending posture is the observation of its own confined spawn", () => {
    const where = layout();
    const provider = createBubblewrapConfinementProvider({
      platform: () => 'linux',
    });
    const { spec, pending } = provider.confine(specFor(where));
    expect(spec.command).toBe(BUBBLEWRAP);
    expect(
      pending.observe({
        spawned: { command: spec.command, args: spec.args },
        handshake: 'completed',
        bounds: where.bounds,
      }),
    ).toBe('confined');
  });
});

describe('a confined Claude launch under bubblewrap', () => {
  test('prepares the same Station-owned directories and records only the grants bubblewrap can apply', async () => {
    const where = layout();
    const launch = await prepareConfinedClaudeLaunch({
      workspace: where.workspace,
      configDir: where.config,
      stationHome: where.stationHome,
      home: where.home,
      stationRoot: where.stationRoot,
      mechanism: 'bubblewrap',
    });
    try {
      expect(launch.grants.writable).toEqual([
        where.workspace,
        launch.tmpDir,
        where.config,
      ]);
      expect(launch.grants.writableFiles).toEqual([]);
      expect(launch.writeGrants).toEqual([
        'station-config',
        'station-temp',
        'workspace',
      ]);
    } finally {
      launch.cleanup();
    }
  });

  test('a launch out of bounds records no grants, for the start to refuse before spawning', async () => {
    const where = layout();
    const launch = await prepareConfinedClaudeLaunch({
      workspace: where.workspace,
      configDir: where.config,
      stationHome: where.stationHome,
      // The workspace is the home folder: too broad to confine.
      home: where.workspace,
      stationRoot: where.stationRoot,
      mechanism: 'bubblewrap',
    });
    launch.cleanup();
    expect(launch.writeGrants).toBeUndefined();
  });
});

describe('bubblewrap version', () => {
  test.each([
    ['bubblewrap 0.6.1', 'bubblewrap 0.6.1 is older than 0.8.0'],
    ['bubblewrap 0.7.0\n', 'bubblewrap 0.7.0 is older than 0.8.0'],
  ])('%s is refused, naming the version', (output, reason) => {
    expect(bubblewrapVersionRefusal(output)).toContain(reason);
    expect(bubblewrapVersionRefusal(output)).toContain('--disable-userns');
  });

  test.each([
    'bubblewrap 0.8.0',
    'bubblewrap 0.9.0',
    'bubblewrap 0.11.0',
    'bubblewrap 1.0',
    'something else',
  ])('%s is not refused by version', (output) => {
    expect(bubblewrapVersionRefusal(output)).toBeUndefined();
  });
});

describe('a workspace and the hidden paths', () => {
  test('a workspace inside or containing a hidden path is refused; a disjoint one is not', () => {
    const hidden = ['/home/op/.ssh', '/run/user/1000'];
    expect(bubblewrapWorkspaceRefusal('/run/user/1000/ws', hidden)).toBe(
      'it is inside a path the sandbox hides',
    );
    expect(bubblewrapWorkspaceRefusal('/run/user', hidden)).toBe(
      'it contains a path the sandbox hides',
    );
    expect(bubblewrapWorkspaceRefusal('/srv/ws', hidden)).toBeUndefined();
  });

  test('arguments refuse a hidden path inside a write grant rather than re-open it', () => {
    const where = layout();
    const secret = join(where.workspace, 'linked-secret');
    writeFileSync(secret, 'x');
    expect(() =>
      bubblewrapArgs(
        specFor(where, {
          ...grantsFor(where),
          hidden: [...(grantsFor(where).hidden ?? []), secret],
        }),
      ),
    ).toThrow(/hidden confinement path is inside a write grant/);
  });

  test('a bubblewrap start whose workspace holds a secret store linked into it falls back as too broad', () => {
    const where = layout();
    // `~/.netrc` is a link to a file inside the workspace: its resolved path
    // is there.
    writeFileSync(join(where.workspace, 'netrc'), 'machine x\n');
    const netrc = join(where.home, '.netrc');
    rmSync(netrc);
    symlinkSync(join(where.workspace, 'netrc'), netrc);
    const decide = (mechanism: 'seatbelt' | 'bubblewrap') =>
      confinedClaudeDecision({
        cwd: where.workspace,
        appHomeEnv: undefined,
        env: { ANTHROPIC_API_KEY: 'sk-ant-api03-fake-for-tests' },
        globalConfigPinned: false,
        stationHome: where.stationHome,
        stationRoot: where.stationRoot,
        home: where.home,
        mechanism,
      });
    expect(decide('bubblewrap')).toEqual({ fallback: 'workspace-too-broad' });
    // Seatbelt's rule is unchanged here.
    expect(decide('seatbelt')).toMatchObject({ workspace: where.workspace });
  });
});
