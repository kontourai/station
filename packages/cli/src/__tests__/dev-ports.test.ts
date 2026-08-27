import { dirname, isAbsolute, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  allocateDevPorts,
  deriveDevInstanceAndHome,
  fnv1a32,
  resolveDevOffset,
  resolveWorktreePath,
  STATION_DEV_MAX_OFFSET,
  STATION_DEV_SERVER_PORT_BASE,
  STATION_DEV_UI_PORT_BASE,
  type WorktreeFs,
} from '../commands/dev-ports.js';

/** A free-everything predicate for the common allocation case. */
const alwaysFree = () => true;

describe('resolveDevOffset — precedence + determinism', () => {
  test('same worktree path always resolves to the same offset (determinism)', () => {
    const a = resolveDevOffset({ worktreePath: '/repos/wt/feature-x' });
    const b = resolveDevOffset({ worktreePath: '/repos/wt/feature-x' });
    expect(a.offset).toBe(b.offset);
    expect(a.offset).toBeGreaterThanOrEqual(1);
    expect(a.offset).toBeLessThanOrEqual(STATION_DEV_MAX_OFFSET);
    expect(a.source).toContain('worktree');
  });

  test('different worktree paths generally resolve to different offsets', () => {
    const a = resolveDevOffset({ worktreePath: '/repos/wt/feature-x' });
    const b = resolveDevOffset({ worktreePath: '/repos/wt/feature-y' });
    expect(a.offset).not.toBe(b.offset);
  });

  test('numeric STATION_DEV_INSTANCE seed pins that exact offset', () => {
    const resolved = resolveDevOffset({ devInstance: '42' });
    expect(resolved.offset).toBe(42);
    expect(resolved.source).toContain('numeric');
  });

  test('non-numeric STATION_DEV_INSTANCE seed is hashed into 1..MAX_OFFSET', () => {
    const resolved = resolveDevOffset({ devInstance: 'alpha' });
    expect(resolved.offset).toBe(
      (fnv1a32('alpha') % STATION_DEV_MAX_OFFSET) + 1,
    );
    expect(resolved.offset).toBeGreaterThanOrEqual(1);
    expect(resolved.offset).toBeLessThanOrEqual(STATION_DEV_MAX_OFFSET);
    expect(resolved.source).toContain('hashed');
  });

  test('explicit port offset wins over both seed and worktree path', () => {
    const resolved = resolveDevOffset({
      portOffset: 3,
      devInstance: '42',
      worktreePath: '/repos/wt/feature-x',
    });
    expect(resolved.offset).toBe(3);
  });

  test('seed wins over worktree path', () => {
    const resolved = resolveDevOffset({
      devInstance: '9',
      worktreePath: '/repos/wt/feature-x',
    });
    expect(resolved.offset).toBe(9);
  });

  test('no source yields offset 0 (base ports)', () => {
    expect(resolveDevOffset({}).offset).toBe(0);
  });

  test('a negative or out-of-range explicit offset is rejected', () => {
    expect(() => resolveDevOffset({ portOffset: -1 })).toThrow();
    expect(() =>
      resolveDevOffset({ portOffset: STATION_DEV_MAX_OFFSET + 1 }),
    ).toThrow();
  });

  test('an out-of-range numeric seed is rejected', () => {
    expect(() =>
      resolveDevOffset({ devInstance: String(STATION_DEV_MAX_OFFSET + 1) }),
    ).toThrow();
  });
});

describe('allocateDevPorts — probe + scan forward', () => {
  test('derives the base+offset pair when both ports are free', async () => {
    const result = await allocateDevPorts(5, alwaysFree);
    expect(result.offset).toBe(5);
    expect(result.serverPort).toBe(STATION_DEV_SERVER_PORT_BASE + 5);
    expect(result.uiPort).toBe(STATION_DEV_UI_PORT_BASE + 5);
    expect(result.moved).toBe(false);
  });

  test('scans forward past busy offsets to the next free pair', async () => {
    const startOffset = 10;
    const rejectBefore = startOffset + 3; // first 3 offsets are "busy"
    const isPortFree = (port: number) => {
      const serverOffset = port - STATION_DEV_SERVER_PORT_BASE;
      const uiOffset = port - STATION_DEV_UI_PORT_BASE;
      const offset = port >= STATION_DEV_UI_PORT_BASE ? uiOffset : serverOffset;
      return offset >= rejectBefore;
    };
    const result = await allocateDevPorts(startOffset, isPortFree);
    expect(result.offset).toBe(rejectBefore);
    expect(result.serverPort).toBe(STATION_DEV_SERVER_PORT_BASE + rejectBefore);
    expect(result.uiPort).toBe(STATION_DEV_UI_PORT_BASE + rejectBefore);
    expect(result.moved).toBe(true);
  });

  test('a pair is free only when the ui port is also free', async () => {
    // ui port of offset 10 is busy; server ports of 10 are free -> move to 11.
    const busyUiPort = STATION_DEV_UI_PORT_BASE + 10;
    const isPortFree = (port: number) => port !== busyUiPort;
    const result = await allocateDevPorts(10, isPortFree);
    expect(result.offset).toBe(11);
    expect(result.moved).toBe(true);
  });

  test('probes all four listeners (server, terminal, voice, ui) and scans forward when the terminal port is busy', async () => {
    // start() also binds serverPort+1 (terminal) and serverPort+2 (voice).
    // Make ONLY the terminal port of the derived offset busy: server + ui are
    // free, so a server+ui-only probe would wrongly accept offset 10 and then
    // die on EADDRINUSE mid-start. The busy port SERVER_BASE+11 shadows offset
    // 10 (as its terminal) AND offset 11 (as its server), so the scan lands on
    // offset 12 — exactly the cross-offset coupling this probe defends against.
    const busyTerminalPort = STATION_DEV_SERVER_PORT_BASE + 10 + 1;
    const isPortFree = (port: number) => port !== busyTerminalPort;
    const result = await allocateDevPorts(10, isPortFree);
    expect(result.offset).toBe(12);
    expect(result.serverPort).toBe(STATION_DEV_SERVER_PORT_BASE + 12);
    expect(result.moved).toBe(true);
  });

  test('scans forward when only the voice port of the derived offset is busy', async () => {
    // SERVER_BASE+12 is voice(offset 10), terminal(offset 11), and server
    // (offset 12) — three offsets shadowed — so the first fully-free pair is 13.
    const busyVoicePort = STATION_DEV_SERVER_PORT_BASE + 10 + 2;
    const isPortFree = (port: number) => port !== busyVoicePort;
    const result = await allocateDevPorts(10, isPortFree);
    expect(result.offset).toBe(13);
  });

  test('supports an async predicate', async () => {
    const result = await allocateDevPorts(2, async (port) => {
      await Promise.resolve();
      return port !== STATION_DEV_SERVER_PORT_BASE + 2;
    });
    expect(result.offset).toBe(3);
  });

  test('throws when the whole band is exhausted', async () => {
    await expect(allocateDevPorts(0, () => false)).rejects.toThrow(
      /No free Station dev port pair/,
    );
  });
});

describe('deriveDevInstanceAndHome', () => {
  const ROOT = '/home/me/.station-dev';

  test('names the auto instance dev-<basename>-<hash8> and homes it externally', () => {
    const { instance, home } = deriveDevInstanceAndHome({
      worktreePath: '/repos/station-worktrees/feature-x',
      cwd: '/repos/station-worktrees/feature-x/packages/cli',
      homeRoot: ROOT,
    });
    expect(instance).toMatch(/^dev-feature-x-[0-9a-f]{8}$/);
    expect(home).toBe(`${ROOT}/${instance}`);
  });

  test('an explicit STATION_DEV_INSTANCE seed names the instance/home with NO path hash', () => {
    const { instance, home } = deriveDevInstanceAndHome({
      worktreePath: '/repos/station-worktrees/feature-x',
      devInstance: 'Alpha Beta',
      cwd: '/repos/station-worktrees/feature-x',
      homeRoot: ROOT,
    });
    expect(instance).toBe('dev-alpha-beta');
    expect(home).toBe(`${ROOT}/dev-alpha-beta`);
  });

  test('the same seed on two different worktree paths deliberately shares a home', () => {
    const a = deriveDevInstanceAndHome({
      worktreePath: '/alice/repo/wt/x',
      devInstance: 'shared',
      cwd: '/alice/repo/wt/x',
      homeRoot: ROOT,
    });
    const b = deriveDevInstanceAndHome({
      worktreePath: '/bob/other/wt/x',
      devInstance: 'shared',
      cwd: '/bob/other/wt/x',
      homeRoot: ROOT,
    });
    expect(a).toEqual(b);
  });

  test('falls back to the cwd basename (hashed) outside a worktree', () => {
    const { instance } = deriveDevInstanceAndHome({
      cwd: '/repos/plain-checkout',
      homeRoot: ROOT,
    });
    expect(instance).toMatch(/^dev-plain-checkout-[0-9a-f]{8}$/);
  });

  test('the same full path always derives the same instance + home (determinism)', () => {
    const input = {
      worktreePath: '/repos/wt/feature-x',
      cwd: '/repos/wt/feature-x',
      homeRoot: ROOT,
    };
    expect(deriveDevInstanceAndHome(input)).toEqual(
      deriveDevInstanceAndHome(input),
    );
  });

  test('two DIFFERENT full paths sharing a basename never collide (instance AND home differ)', () => {
    // The CRITICAL bug: ports hash the full path but the home used to key off
    // basename only, so `--clean` in one wiped the other's isolated data.
    const alice = deriveDevInstanceAndHome({
      worktreePath: '/alice/repos/station/worktrees/fix-bug',
      cwd: '/alice/repos/station/worktrees/fix-bug',
      homeRoot: ROOT,
    });
    const bob = deriveDevInstanceAndHome({
      worktreePath: '/bob/checkouts/other/fix-bug',
      cwd: '/bob/checkouts/other/fix-bug',
      homeRoot: ROOT,
    });
    expect(alice.instance).not.toBe(bob.instance);
    expect(alice.home).not.toBe(bob.home);
    // Both still share the human-readable basename prefix.
    expect(alice.instance).toMatch(/^dev-fix-bug-[0-9a-f]{8}$/);
    expect(bob.instance).toMatch(/^dev-fix-bug-[0-9a-f]{8}$/);
  });

  describe('sanitization stays under the home root for hostile seeds', () => {
    const escapes = (home: string) => {
      const rel = relative(ROOT, home);
      return rel === '' || rel.startsWith('..') || isAbsolute(rel);
    };
    test.each([
      ['../../../etc', 'relative traversal'],
      ['..', 'literal dot-dot'],
      ['/etc/passwd', 'absolute path'],
      ['..\\..\\windows\\system32', 'backslash traversal'],
      ['a'.repeat(500), 'oversized seed (ENAMETOOLONG guard)'],
    ])('seed %j (%s) never escapes ~/.station-dev', (seed) => {
      const { instance, home } = deriveDevInstanceAndHome({
        devInstance: seed,
        cwd: '/repos/wt/x',
        homeRoot: ROOT,
      });
      // A single path segment (no separators) directly under the root.
      expect(dirname(home)).toBe(ROOT);
      expect(escapes(home)).toBe(false);
      expect(instance.length).toBeLessThanOrEqual(4 + 64); // 'dev-' + cap
    });
  });
});

describe('resolveWorktreePath — worktree detection', () => {
  /** Build an injectable fs that answers for an exact set of paths. */
  function fakeFs(
    entries: Record<string, { kind: 'file' | 'dir'; contents?: string }>,
  ): WorktreeFs {
    return {
      statType: (path) => entries[path]?.kind,
      readText: (path) => entries[path]?.contents ?? '',
    };
  }

  test('a .git FILE whose gitdir points into worktrees/<name> is a worktree', () => {
    const wt = '/repos/station-worktrees/feature-x';
    const fs = fakeFs({
      [`${wt}/.git`]: {
        kind: 'file',
        contents: 'gitdir: /repos/station/.git/worktrees/feature-x\n',
      },
    });
    // Called from a nested subdirectory: walks up to the worktree root.
    expect(resolveWorktreePath(`${wt}/packages/cli`, fs)).toBe(wt);
  });

  test('a .git DIRECTORY (main checkout) is not a worktree', () => {
    const repo = '/repos/station';
    const fs = fakeFs({ [`${repo}/.git`]: { kind: 'dir' } });
    expect(resolveWorktreePath(`${repo}/packages/cli`, fs)).toBeUndefined();
  });

  test('a submodule .git file (modules/<name>, not worktrees) is not a worktree', () => {
    const sub = '/repos/station/vendor/sub';
    const fs = fakeFs({
      [`${sub}/.git`]: {
        kind: 'file',
        contents: 'gitdir: /repos/station/.git/modules/sub\n',
      },
    });
    expect(resolveWorktreePath(sub, fs)).toBeUndefined();
  });

  test('no .git anywhere up the tree yields undefined', () => {
    expect(resolveWorktreePath('/tmp/nowhere', fakeFs({}))).toBeUndefined();
  });
});
