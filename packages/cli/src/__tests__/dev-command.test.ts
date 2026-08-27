import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  ensurePrivateDevHome,
  runDevCommand,
} from '../commands/dev-command.js';
import {
  STATION_DEV_SERVER_PORT_BASE,
  STATION_DEV_UI_PORT_BASE,
} from '../commands/dev-ports.js';
import type { CleanOptions, StartOptions } from '../commands/lifecycle.js';

const WORKTREE = '/repos/station-worktrees/feature-x';

function baseDeps(overrides: Record<string, unknown> = {}) {
  const start = vi.fn<(opts: StartOptions) => Promise<void>>(async () => {});
  const clean = vi.fn<(opts: CleanOptions) => Promise<void>>(async () => {});
  const ensureDir = vi.fn();
  const log = vi.fn();
  return {
    start,
    clean,
    ensureDir,
    log,
    deps: {
      env: {} as NodeJS.ProcessEnv,
      cwd: WORKTREE,
      isPortFree: () => true,
      resolveWorktreePath: () => WORKTREE,
      startImpl: (opts: StartOptions = {}) => start(opts),
      cleanImpl: (opts: boolean | CleanOptions = false) =>
        clean(typeof opts === 'boolean' ? { force: opts } : opts),
      ensureDir,
      log,
      ...overrides,
    },
  };
}

describe('runDevCommand — wiring to the start path', () => {
  test('creates a fresh dev home owner-only and safely tightens an old 0755 home', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'station-dev-home-'));
    const parent = join(root, '.station-dev');
    const home = join(parent, 'dev-feature');

    ensurePrivateDevHome(home);
    expect(lstatSync(parent).mode & 0o077).toBe(0);
    expect(lstatSync(home).mode & 0o077).toBe(0);

    chmodSync(parent, 0o755);
    chmodSync(home, 0o755);
    ensurePrivateDevHome(home);
    expect(lstatSync(parent).mode & 0o077).toBe(0);
    expect(lstatSync(home).mode & 0o077).toBe(0);
  });

  test('refuses symlinked or non-directory dev homes without modifying their targets', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'station-dev-home-adverse-'));
    const parent = join(root, '.station-dev');
    const external = join(root, 'external');
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    writeFileSync(join(external, 'sentinel'), 'preserved');
    symlinkSync(external, join(parent, 'dev-symlink'));

    expect(() => ensurePrivateDevHome(join(parent, 'dev-symlink'))).toThrow(
      /must be a real directory/,
    );
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserved');

    const symlinkedParent = join(root, '.station-dev-symlink');
    symlinkSync(external, symlinkedParent);
    expect(() =>
      ensurePrivateDevHome(join(symlinkedParent, 'dev-through-parent')),
    ).toThrow(/must be a real directory/);
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserved');

    const fileHome = join(parent, 'dev-file');
    writeFileSync(fileHome, 'not a directory');
    expect(() => ensurePrivateDevHome(fileHome)).toThrow(
      /must be a real directory/,
    );
  });

  test('derives deterministic ports + isolated home and reuses start', async () => {
    const { start, ensureDir, deps } = baseDeps();

    await runDevCommand([], deps);

    expect(start).toHaveBeenCalledTimes(1);
    const opts = start.mock.calls[0]![0];
    // Same worktree -> stable offset -> stable ports.
    expect(opts.serverPort).toBe(
      opts.uiPort! - STATION_DEV_UI_PORT_BASE + STATION_DEV_SERVER_PORT_BASE,
    );
    expect(opts.serverPort).toBeGreaterThanOrEqual(
      STATION_DEV_SERVER_PORT_BASE + 1,
    );
    expect(opts.uiPort).toBeGreaterThanOrEqual(STATION_DEV_UI_PORT_BASE + 1);
    expect(opts.instanceName).toMatch(/^dev-feature-x-[0-9a-f]{8}$/);
    expect(opts.baseDir).toMatch(
      new RegExp(`instances/dev/${opts.instanceName}$`),
    );
    // Home is created before start.
    expect(ensureDir).toHaveBeenCalledWith(opts.baseDir);
    // Host defaults to 0.0.0.0 (owned by start()): not passed unless overridden.
    expect(opts.host).toBeUndefined();
  });

  test('same worktree resolves to identical ports across invocations', async () => {
    const first = baseDeps();
    const second = baseDeps();
    await runDevCommand([], first.deps);
    await runDevCommand([], second.deps);
    expect(first.start.mock.calls[0]![0].serverPort).toBe(
      second.start.mock.calls[0]![0].serverPort,
    );
  });

  test('--port-offset pins the exact ports', async () => {
    const { start, deps } = baseDeps();
    await runDevCommand(['--port-offset=7'], deps);
    expect(start.mock.calls[0]![0].serverPort).toBe(
      STATION_DEV_SERVER_PORT_BASE + 7,
    );
    expect(start.mock.calls[0]![0].uiPort).toBe(STATION_DEV_UI_PORT_BASE + 7);
  });

  test('STATION_PORT_OFFSET env wins over the worktree derivation', async () => {
    const { start, deps } = baseDeps({
      env: { STATION_PORT_OFFSET: '4' } as NodeJS.ProcessEnv,
    });
    await runDevCommand([], deps);
    expect(start.mock.calls[0]![0].serverPort).toBe(
      STATION_DEV_SERVER_PORT_BASE + 4,
    );
  });

  test('numeric STATION_DEV_INSTANCE pins the offset and names the instance', async () => {
    const { start, deps } = baseDeps({
      env: { STATION_DEV_INSTANCE: '12' } as NodeJS.ProcessEnv,
    });
    await runDevCommand([], deps);
    expect(start.mock.calls[0]![0].serverPort).toBe(
      STATION_DEV_SERVER_PORT_BASE + 12,
    );
    expect(start.mock.calls[0]![0].instanceName).toBe('dev-12');
  });

  test('--dry-run resolves and prints but never starts', async () => {
    const { start, ensureDir, log, deps } = baseDeps();
    await runDevCommand(['--dry-run'], deps);
    expect(start).not.toHaveBeenCalled();
    expect(ensureDir).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  test('collision scan-forward moves the ports off a busy pair', async () => {
    const busyOffsetPort = (offset: number) => [
      STATION_DEV_SERVER_PORT_BASE + offset,
      STATION_DEV_UI_PORT_BASE + offset,
    ];
    // Pin a known base offset via --port-offset, then make that pair busy.
    const busy = new Set(busyOffsetPort(20));
    const { start, deps } = baseDeps({
      isPortFree: (p: number) => !busy.has(p),
    });
    await runDevCommand(['--port-offset=20'], deps);
    expect(start.mock.calls[0]![0].serverPort).toBe(
      STATION_DEV_SERVER_PORT_BASE + 21,
    );
  });

  test('--clean wipes the isolated home before starting, --host overrides bind', async () => {
    const { start, clean, deps } = baseDeps();
    await runDevCommand(['--clean', '--force', '--host=127.0.0.1'], deps);
    expect(clean).toHaveBeenCalledTimes(1);
    const cleanOpts = clean.mock.calls[0]![0];
    expect(cleanOpts.projectHome).toMatch(
      /instances\/dev\/dev-feature-x-[0-9a-f]{8}$/,
    );
    expect(cleanOpts.force).toBe(true);
    expect(start.mock.calls[0]![0].host).toBe('127.0.0.1');
  });

  test('outside a worktree, offset 0 (base ports) keyed off the cwd basename', async () => {
    const { start, deps } = baseDeps({
      cwd: '/repos/plain-checkout',
      resolveWorktreePath: () => undefined,
    });
    await runDevCommand([], deps);
    expect(start.mock.calls[0]![0].serverPort).toBe(
      STATION_DEV_SERVER_PORT_BASE,
    );
    expect(start.mock.calls[0]![0].instanceName).toMatch(
      /^dev-plain-checkout-[0-9a-f]{8}$/,
    );
  });

  test('an unknown option is rejected', async () => {
    const { deps } = baseDeps();
    await expect(runDevCommand(['--nope'], deps)).rejects.toThrow(
      /Unknown station dev option/,
    );
  });
});
