/**
 * #2494: the Seatbelt provider's pure rules, on any host: availability,
 * profile text and rule order, the breadth check, and the posture it
 * derives from evidence. The kernel's behaviour under the production
 * profile is `seatbelt.process.test.ts`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  canonicalPath,
  confineWithSeatbelt,
  createSeatbeltConfinementProvider,
  observeSeatbeltPosture,
  reapStaleSeatbeltSessionDirs,
  type SeatbeltBounds,
  type SeatbeltEvidence,
  seatbeltGrants,
  seatbeltProfile,
  seatbeltSessionDirPrefix,
  seatbeltTempRoot,
  seatbeltWorkspaceRefusal,
  seatbeltWriteGrantKinds,
} from '../seatbelt.js';

const HOME = '/Users/op';
const STATION_HOME = '/Users/op/.station/instances/stable';
const WORKSPACE = '/Users/op/dev/feature';
const COMMON = '/Users/op/dev/repo/.git';
const GIT = {
  gitDir: `${COMMON}/worktrees/feature`,
  commonDir: COMMON,
  branch: 'feat/x',
};
const TEMP = `${STATION_HOME}/tmp/confined-sessions/session-4242-abcdef`;
const CONFIG = `${STATION_HOME}/confined-homes/claude`;

function linkedGrants() {
  return seatbeltGrants({
    workspace: WORKSPACE,
    stationTempDir: TEMP,
    stationConfigDir: CONFIG,
    git: GIT,
    hidden: [`${HOME}/.ssh`],
    readable: [],
  });
}

const BOUNDS: SeatbeltBounds = {
  workspace: WORKSPACE,
  stationHome: STATION_HOME,
  home: HOME,
  git: GIT,
};

describe('Seatbelt availability', () => {
  test.each(['linux', 'win32'] as const)(
    'is unavailable on %s, naming why, without probing',
    (platform) => {
      const probe = vi.fn();
      const provider = createSeatbeltConfinementProvider({
        platform: () => platform,
        probe,
      });
      expect(provider.availability()).toEqual({
        available: false,
        reason: `Seatbelt is macOS-only; this host is ${platform}`,
      });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  test('is unavailable on macOS without sandbox-exec', () => {
    const provider = createSeatbeltConfinementProvider({
      platform: () => 'darwin',
      sandboxExec: '/nonexistent/sandbox-exec',
    });
    expect(provider.availability()).toEqual({
      available: false,
      reason: '/nonexistent/sandbox-exec is missing or not executable',
    });
  });

  test('follows the production-profile probe, run once', () => {
    const probe = vi.fn(() => ({ ok: false, reason: 'it aborted' }));
    const provider = createSeatbeltConfinementProvider({
      platform: () => 'darwin',
      sandboxExec: process.execPath,
      probe,
    });
    expect(provider.availability()).toEqual({
      available: false,
      reason: 'it aborted',
    });
    provider.availability();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(process.execPath);
  });

  test('applies only to Claude, as a spawn wrapper', () => {
    const provider = createSeatbeltConfinementProvider();
    expect(provider).toMatchObject({
      level: 'os-profile',
      mechanism: 'seatbelt',
      engagement: 'spawn-wrapper',
      engines: ['claude'],
      supportedIsolationModes: ['shared', 'worktree'],
    });
  });
});

describe('Seatbelt grants and profile', () => {
  test('a linked worktree gets its own git dir, the object store and only its branch ref, lock and log', () => {
    expect(linkedGrants()).toEqual({
      writable: [WORKSPACE, TEMP, CONFIG, GIT.gitDir, `${COMMON}/objects`],
      writableFiles: [
        `${COMMON}/refs/heads/feat/x`,
        `${COMMON}/refs/heads/feat/x.lock`,
        `${COMMON}/logs/refs/heads/feat/x`,
      ],
      writeDenied: [
        `${COMMON}/hooks`,
        `${COMMON}/config`,
        `${COMMON}/info`,
        `${COMMON}/commondir`,
        `${COMMON}/objects/info/alternates`,
        `${GIT.gitDir}/config.worktree`,
        `${WORKSPACE}/.git`,
        // Redirects a later unconfined git would follow (R1).
        `${GIT.gitDir}/commondir`,
        `${GIT.gitDir}/gitdir`,
        `${GIT.gitDir}/config`,
        `${GIT.gitDir}/hooks`,
      ],
      writeDeniedExact: [],
      // The engines' project configuration, at any depth (#3800).
      writeDeniedNames: ['.codex', '.claude'],
      hidden: [`${HOME}/.ssh`],
      readable: [],
    });
  });

  test('a checkout whose .git is inside the workspace gets no git grant, and its hooks, config and info stay denied', () => {
    const dotGit = `${WORKSPACE}/.git`;
    const grants = seatbeltGrants({
      workspace: WORKSPACE,
      stationTempDir: TEMP,
      stationConfigDir: CONFIG,
      git: { gitDir: dotGit, commonDir: dotGit, branch: 'main' },
      hidden: [],
      readable: [],
    });
    expect(grants.writable).toEqual([WORKSPACE, TEMP, CONFIG]);
    expect(grants.writableFiles).toEqual([]);
    expect(grants.writeDenied).toEqual([
      `${dotGit}/hooks`,
      `${dotGit}/config`,
      `${dotGit}/info`,
      `${dotGit}/commondir`,
      `${dotGit}/objects/info/alternates`,
      `${dotGit}/config.worktree`,
      // Other worktrees' and submodules' pointers and config (R2).
      `${dotGit}/worktrees`,
      `${dotGit}/modules`,
    ]);
    // `.git` itself cannot be removed, renamed or replaced by a pointer.
    expect(grants.writeDeniedExact).toEqual([dotGit]);
  });

  test('rules are ordered so the later, narrower rule wins', () => {
    const lines = seatbeltProfile(linkedGrants()).split('\n');
    const index = (prefix: string) =>
      lines.findIndex((line) => line.startsWith(prefix));
    expect(lines.slice(0, 2)).toEqual(['(version 1)', '(deny default)']);
    expect(lines).toContain('(allow signal (target same-sandbox))');
    expect(lines).not.toContain('(allow signal)');
    expect(index('(deny file-read*')).toBeGreaterThan(
      index('(allow file-read*)'),
    );
    expect(index('(allow file-read* file-write* (subpath')).toBeGreaterThan(
      index('(deny file-read*'),
    );
    expect(index('(deny file-write*')).toBeGreaterThan(
      index('(allow file-read* file-write* (literal'),
    );
    expect(lines).toContain(
      `(allow file-read* file-write* (literal "${COMMON}/refs/heads/feat/x"))`,
    );
  });

  test('denies the engine configuration names at any depth of every writable grant, in any case (#3800)', () => {
    const lines = seatbeltProfile(linkedGrants()).split('\n');
    const named = lines.filter((line) => line.includes('(regex '));
    expect(named).toHaveLength(5 * 2);
    expect(named).toContain(
      `(deny file-write* (regex #"^${WORKSPACE}/(.*/)?\\.[Cc][Oo][Dd][Ee][Xx](/|$)"))`,
    );
    expect(named).toContain(
      `(deny file-write* (regex #"^${TEMP.replace(/\./g, '\\.')}/(.*/)?\\.[Cc][Ll][Aa][Uu][Dd][Ee](/|$)"))`,
    );
    // After every allow, so no grant re-opens them.
    expect(lines.indexOf(named[0]!)).toBeGreaterThan(
      lines.length -
        1 -
        [...lines].reverse().findIndex((line) => line.startsWith('(allow ')),
    );
    expect(() =>
      seatbeltProfile({
        writable: ['/tmp/w'],
        readable: [],
        writeDeniedNames: ['../x'],
      }),
    ).toThrow(/cannot express/);
  });

  test.each([
    '/tmp/with"quote',
    '/tmp/with\\slash',
    '/tmp/new\nline',
    'relative',
  ])('refuses a path it cannot spell safely: %j', (path) => {
    expect(() => seatbeltProfile({ writable: [path], readable: [] })).toThrow(
      /cannot express/,
    );
  });

  test('wraps the command in sandbox-exec with the profile, and refuses a narrower network it cannot enforce', () => {
    const spec = {
      command: '/usr/local/bin/claude',
      args: ['--print'],
      cwd: WORKSPACE,
      env: {},
      grants: linkedGrants(),
      network: 'full' as const,
    };
    expect(confineWithSeatbelt(spec).args).toEqual([
      '-p',
      seatbeltProfile(spec.grants),
      '/usr/local/bin/claude',
      '--print',
    ]);
    expect(() => confineWithSeatbelt({ ...spec, network: 'none' })).toThrow(
      /does not restrict the network/,
    );
  });
});

describe('Seatbelt breadth', () => {
  test('in-bounds grants are named by kind', () => {
    expect(seatbeltWriteGrantKinds(linkedGrants(), BOUNDS)).toEqual([
      'git-branch-ref',
      'git-objects',
      'git-worktree',
      'station-config',
      'station-temp',
      'workspace',
    ]);
  });

  test.each([
    [
      'the whole refs/heads tree',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writable: [...g.writable, `${COMMON}/refs/heads`],
      }),
    ],
    [
      'another branch ref',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writableFiles: [
          ...(g.writableFiles ?? []),
          `${COMMON}/refs/heads/main`,
        ],
      }),
    ],
    [
      'the home folder',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writable: [...g.writable, HOME],
      }),
    ],
    [
      'a config dir outside app-homes',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writable: [...g.writable, `${HOME}/.claude`],
      }),
    ],
    [
      'a missing hooks deny',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writeDenied: (g.writeDenied ?? []).filter(
          (path) => path !== `${COMMON}/hooks`,
        ),
      }),
    ],
    ...(['commondir', 'gitdir'] as const).map(
      (file) =>
        [
          `a missing ${file} deny in the worktree's git dir`,
          (g: ReturnType<typeof linkedGrants>) => ({
            ...g,
            writeDenied: (g.writeDenied ?? []).filter(
              (path) => path !== `${GIT.gitDir}/${file}`,
            ),
          }),
        ] as const,
    ),
    ...(['.codex', '.claude'] as const).map(
      (dir) =>
        [
          `a missing ${dir} deny`,
          (g: ReturnType<typeof linkedGrants>) => ({
            ...g,
            writeDeniedNames: (g.writeDeniedNames ?? []).filter(
              (name) => name !== dir,
            ),
          }),
        ] as const,
    ),
    [
      'a missing .git pointer deny',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writeDenied: (g.writeDenied ?? []).filter(
          (path) => path !== `${WORKSPACE}/.git`,
        ),
      }),
    ],
  ] as const)('a grant reaching %s is out of bounds', (_label, widen) => {
    expect(seatbeltWriteGrantKinds(widen(linkedGrants()), BOUNDS)).toBe(
      undefined,
    );
  });

  test.each([
    [
      'worktrees',
      (g: ReturnType<typeof seatbeltGrants>, dotGit: string) => ({
        ...g,
        writeDenied: (g.writeDenied ?? []).filter(
          (p) => p !== `${dotGit}/worktrees`,
        ),
      }),
    ],
    [
      'modules',
      (g: ReturnType<typeof seatbeltGrants>, dotGit: string) => ({
        ...g,
        writeDenied: (g.writeDenied ?? []).filter(
          (p) => p !== `${dotGit}/modules`,
        ),
      }),
    ],
    [
      'the .git directory itself',
      (g: ReturnType<typeof seatbeltGrants>) => ({
        ...g,
        writeDeniedExact: [],
      }),
    ],
  ] as const)(
    'a checkout with .git inside the workspace is out of bounds without its %s deny',
    (_label, drop) => {
      const dotGit = `${WORKSPACE}/.git`;
      const git = { gitDir: dotGit, commonDir: dotGit, branch: 'main' };
      const grants = seatbeltGrants({
        workspace: WORKSPACE,
        stationTempDir: TEMP,
        stationConfigDir: CONFIG,
        git,
        hidden: [],
        readable: [],
      });
      const bounds = { ...BOUNDS, git };
      expect(seatbeltWriteGrantKinds(grants, bounds)).toEqual([
        'station-config',
        'station-temp',
        'workspace',
      ]);
      expect(seatbeltWriteGrantKinds(drop(grants, dotGit), bounds)).toBe(
        undefined,
      );
    },
  );

  test.each(['.codex', '.claude'])(
    'a workspace without git is out of bounds without its %s deny (#3800)',
    (dir) => {
      const grants = seatbeltGrants({
        workspace: WORKSPACE,
        stationTempDir: TEMP,
        stationConfigDir: CONFIG,
        hidden: [],
        readable: [],
      });
      const { git: _git, ...bounds } = BOUNDS;
      expect(grants.writeDenied).toEqual([]);
      expect(grants.writeDeniedNames).toEqual(['.codex', '.claude']);
      expect(seatbeltWriteGrantKinds(grants, bounds)).toEqual([
        'station-config',
        'station-temp',
        'workspace',
      ]);
      expect(
        seatbeltWriteGrantKinds(
          {
            ...grants,
            writeDeniedNames: (grants.writeDeniedNames ?? []).filter(
              (name) => name !== dir,
            ),
          },
          bounds,
        ),
      ).toBe(undefined);
    },
  );

  test('a temp directory not named for its owner process is out of bounds', () => {
    const grants = linkedGrants();
    expect(
      seatbeltWriteGrantKinds(
        {
          ...grants,
          writable: grants.writable.map((path) =>
            path === TEMP
              ? `${STATION_HOME}/tmp/confined-sessions/anything`
              : path,
          ),
        },
        BOUNDS,
      ),
    ).toBe(undefined);
  });

  test.each([
    ['/', 'it is the filesystem root'],
    [HOME, 'it is or contains the home folder'],
    ['/Users', 'it is or contains the home folder'],
    [STATION_HOME, "it is or overlaps Station's data"],
    [`${STATION_HOME}/workspaces/x`, "it is or overlaps Station's data"],
    [`${HOME}/.claude`, 'it is inside ~/.claude'],
    [`${HOME}/Library/Mobile`, 'it is inside ~/Library'],
  ])('a workspace at %s cannot be confined: %s', (workspace, reason) => {
    expect(
      seatbeltWorkspaceRefusal(workspace, {
        home: HOME,
        stationHome: STATION_HOME,
      }),
    ).toBe(reason);
  });

  test('an ordinary project folder can be confined', () => {
    expect(
      seatbeltWorkspaceRefusal(WORKSPACE, {
        home: HOME,
        stationHome: STATION_HOME,
      }),
    ).toBeUndefined();
  });
});

describe('Seatbelt posture', () => {
  const confined = confineWithSeatbelt({
    command: '/usr/local/bin/claude',
    args: [],
    cwd: WORKSPACE,
    env: {},
    grants: linkedGrants(),
    network: 'full',
  });
  const evidence = (
    overrides: Partial<SeatbeltEvidence> = {},
  ): SeatbeltEvidence => ({
    spawned: { command: confined.command, args: [...confined.args] },
    handshake: 'completed',
    bounds: BOUNDS,
    ...overrides,
  });

  test('confined only when the engine answered from the exact sandboxed spawn, in bounds', () => {
    expect(observeSeatbeltPosture(confined, evidence())).toBe('confined');
  });

  test.each([
    ['no evidence', undefined],
    ['no handshake', evidence({ handshake: 'failed' })],
    ['no spawn recorded', evidence({ spawned: undefined })],
    [
      'an unwrapped spawn',
      evidence({ spawned: { command: '/usr/local/bin/claude', args: [] } }),
    ],
    [
      'a different profile',
      evidence({
        spawned: {
          command: confined.command,
          args: ['-p', '(version 1)(allow default)', '/usr/local/bin/claude'],
        },
      }),
    ],
    [
      'grants out of bounds',
      evidence({ bounds: { ...BOUNDS, workspace: '/Users/op/dev/other' } }),
    ],
  ])('configured-but-failed with %s', (_label, value) => {
    expect(observeSeatbeltPosture(confined, value)).toBe(
      'configured-but-failed',
    );
  });

  test("the provider's pending posture is the observation of its own confined spawn", () => {
    const provider = createSeatbeltConfinementProvider();
    const { spec, pending } = provider.confine({
      command: '/usr/local/bin/claude',
      args: [],
      cwd: WORKSPACE,
      env: {},
      grants: linkedGrants(),
      network: 'full',
    });
    expect(spec.command).toBe('/usr/bin/sandbox-exec');
    expect(
      pending.observe({
        spawned: { command: spec.command, args: [...spec.args] },
        handshake: 'completed',
        bounds: BOUNDS,
      }),
    ).toBe('confined');
    expect(pending.observe(undefined)).toBe('configured-but-failed');
  });
});

describe('reaping stale confined-session temp directories (R9)', () => {
  const makeTempDir = trackTempDirs();

  function layout() {
    const home = canonicalPath(makeTempDir('seatbelt-reap-'));
    const root = seatbeltTempRoot(home);
    mkdirSync(root, { recursive: true });
    const dir = (name: string) => {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'f'), 'x');
      return join(root, name);
    };
    return { home, root, dir };
  }

  test('removes only real directories, named for a dead owner, directly in the root', () => {
    const { home, root, dir } = layout();
    const dead = dir('session-999991-abcdef');
    const live = dir('session-999992-abcdef');
    const own = dir(`${seatbeltSessionDirPrefix()}abcdef`);
    const unnamed = dir('something-else');
    const outside = canonicalPath(makeTempDir('seatbelt-reap-outside-'));
    symlinkSync(outside, join(root, 'session-999993-abcdef'));
    writeFileSync(join(root, 'session-999994-abcdef'), 'a file');
    const alive = new Set([999992]);
    expect(
      reapStaleSeatbeltSessionDirs(home, { isAlive: (pid) => alive.has(pid) }),
    ).toBe(1);
    expect(existsSync(dead)).toBe(false);
    for (const kept of [live, own, unnamed])
      expect(existsSync(kept), kept).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(root, 'session-999994-abcdef'))).toBe(true);
  });

  test('keeps a directory another user owns', () => {
    const { home, dir } = layout();
    const foreign = dir('session-999995-abcdef');
    expect(
      reapStaleSeatbeltSessionDirs(home, {
        isAlive: () => false,
        uid: (process.getuid?.() ?? 0) + 1,
      }),
    ).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  test('a real dead process is detected without injection', async () => {
    const { home, dir } = layout();
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    const stale = dir(`session-${child.pid}-abcdef`);
    expect(reapStaleSeatbeltSessionDirs(home)).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  test('a missing root is nothing to reap', () => {
    expect(
      reapStaleSeatbeltSessionDirs(
        canonicalPath(makeTempDir('seatbelt-none-')),
      ),
    ).toBe(0);
  });
});
