/**
 * #2494: the Seatbelt provider's pure rules, on any host: availability,
 * profile text and rule order, the breadth check, and the posture it
 * derives from evidence. The kernel's behaviour under the production
 * profile is `seatbelt.process.test.ts`.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  confineWithSeatbelt,
  createSeatbeltConfinementProvider,
  observeSeatbeltPosture,
  type SeatbeltBounds,
  type SeatbeltEvidence,
  seatbeltGrants,
  seatbeltProfile,
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
const TEMP = `${STATION_HOME}/tmp/confined-sessions/session-abc`;
const CONFIG = `${STATION_HOME}/app-homes/claude-confined`;

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
        `${GIT.gitDir}/config.worktree`,
        `${WORKSPACE}/.git`,
      ],
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
      `${dotGit}/config.worktree`,
    ]);
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
    [
      'a missing .git pointer deny',
      (g: ReturnType<typeof linkedGrants>) => ({
        ...g,
        writeDenied: (g.writeDenied ?? []).filter(
          (path) => path !== `${WORKSPACE}/.git`,
        ),
      }),
    ],
  ])('a grant reaching %s is out of bounds', (_label, widen) => {
    expect(seatbeltWriteGrantKinds(widen(linkedGrants()), BOUNDS)).toBe(
      undefined,
    );
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
