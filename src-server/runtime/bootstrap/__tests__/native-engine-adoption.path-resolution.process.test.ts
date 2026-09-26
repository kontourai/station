// @vitest-environment node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

/**
 * #2663: native-engine adoption must find a CLI where the engine spawn and
 * the ACP prerequisite probe find it.
 *
 * Adoption used to ask `which`, which sees only the process PATH — for an
 * installed service, the PATH frozen into its unit. The spawn and the ACP
 * probe ask `findCliBinary`, which also searches the interactive-shell PATH
 * and the well-known install dirs. A Muse in `~/.local/bin` was therefore
 * spawnable and "ready" yet never adopted: no Agent, no delegate target.
 *
 * Nothing about the lookup is mocked. HOME points at a temp dir holding a
 * fake `muse`, the process PATH is set so it cannot reach it, and `$SHELL`
 * is either absent or a fake that prints a chosen PATH. Modules are reloaded
 * per case because the login-shell PATH is cached once per process.
 *
 * Process-heavy (resource manifest): the lookup may spawn `$SHELL -ic`, and
 * the spawn cases launch fake binaries through the production Codex and
 * `MuseAdapter` spawns. POSIX-only: `/bin/sh` shebangs, execute bits.
 */

const posixOnly = describe.skipIf(process.platform === 'win32');

const makeTempDir = trackTempDirs();

function tempRoot(): string {
  return makeTempDir('station-native-adoption-path-');
}

/** A `muse` that records the path it was executed as, then completes. */
function writeFakeMuse(dir: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'muse');
  // `/bin/sh` by absolute path and builtins only: the PATH under test may be
  // empty, and the script must not depend on it.
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s' "$0" > '${marker}'`,
      `printf '%s\\n' '{"payload":{"kind":"run_terminal","terminal":"completed","reason":null,"text":"ok"}}'`,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/** A `$SHELL` whose "interactive PATH" is exactly `pathValue`. */
async function writeFakeShell(root: string, pathValue: string) {
  const { LOGIN_PATH_START_SENTINEL, LOGIN_PATH_END_SENTINEL } = await import(
    '../../../providers/auth/cli-auth.js'
  );
  const path = join(root, 'fake-shell');
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s' '${LOGIN_PATH_START_SENTINEL}${pathValue}${LOGIN_PATH_END_SENTINEL}'\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Host {
  home: string;
  stationHome: string;
  marker: string;
}

function isolatedHost(): Host {
  const root = tempRoot();
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const stationHome = join(root, 'station-home');
  mkdirSync(stationHome, { recursive: true });
  vi.stubEnv('HOME', home);
  // A SHELL that does not exist: the capture fails and degrades to ''.
  vi.stubEnv('SHELL', join(root, 'no-such-shell'));
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '');
  vi.stubEnv('STATION_OWNED_PROCESS_REGISTRY', join(root, 'owned'));
  return { home, stationHome, marker: join(root, 'spawned-as') };
}

/**
 * The well-known dirs that are NOT under HOME are real host directories. An
 * "absent" assertion about `muse` is only meaningful on a host where none of
 * them holds one, so that is checked, not assumed.
 */
async function assertNoHostMuseOutsideHome(host: Host): Promise<void> {
  const { wellKnownInstallDirCandidates } = await import(
    '../../../providers/auth/cli-auth.js'
  );
  const hostDirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...wellKnownInstallDirCandidates().filter(
      (dir) => !dir.startsWith(host.home),
    ),
  ];
  expect(
    hostDirs.filter((dir) => existsSync(join(dir, 'muse'))),
    'this host has a muse outside HOME; the absent case cannot be observed here',
  ).toEqual([]);
}

async function loadFresh() {
  vi.resetModules();
  const adoption = await import('../native-engine-adoption.js');
  const registry = await import('../../../domain/agent-registry.js');
  const { ConfigLoader } = await import('../../../domain/config-loader.js');
  const auth = await import('../../../providers/auth/cli-auth.js');
  return { adoption, registry, ConfigLoader, auth };
}

async function adoptInto(host: Host, options: { probePath?: string } = {}) {
  const fresh = await loadFresh();
  const loader = new fresh.ConfigLoader({ projectHomeDir: host.stationHome });
  const { detectCliOnPath } = await import('../../../utils/cli-detection.js');
  const summary = await fresh.adoption.adoptDetectedNativeEngines({
    configLoader: loader,
    logger: { info: vi.fn(), warn: vi.fn() },
    delaysMs: [0],
    // Only for `probePath`: the production detector, run under a PATH that
    // is swapped in for the probe alone. The registry lock around it
    // fingerprints this process with `ps`, which an empty PATH cannot run,
    // so a whole-case empty PATH would fail in the lock, not the lookup.
    ...(options.probePath !== undefined
      ? {
          detect: async (
            cli: string,
            probeOptions?: Parameters<typeof detectCliOnPath>[1],
          ) => {
            const saved = process.env.PATH;
            process.env.PATH = options.probePath;
            try {
              return await detectCliOnPath(cli, probeOptions);
            } finally {
              process.env.PATH = saved;
            }
          },
        }
      : {}),
  });
  const registry = await fresh.registry.loadOrCreateAgentRegistry(loader);
  return { summary, registry, loader, fresh };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

posixOnly(
  'native-engine adoption resolves CLIs like the engine spawn (#2663)',
  () => {
    it('adopts a muse found only in ~/.local/bin, and the engine spawn executes that absolute path', async () => {
      const host = isolatedHost();
      const binary = writeFakeMuse(
        join(host.home, '.local', 'bin'),
        host.marker,
      );

      const { summary, registry, fresh } = await adoptInto(host);

      expect(summary.outcomes.muse).toBe('adopted');
      expect(
        registry.engineConnections.find((c) => c.id === 'muse'),
      ).toMatchObject({ id: 'muse' });
      // The resolution the spawn uses names the absolute path, not `muse`.
      expect(fresh.auth.findCliBinary('muse')).toBe(binary);

      // The production spawn: MuseAdapter's default process factory, which
      // falls back to a bare `muse` when resolution fails. `muse` is not on
      // this PATH, so a bare spawn would ENOENT and never write the marker.
      const { MuseAdapter } = await import(
        '../../../providers/adapters/muse-adapter.js'
      );
      const adapter = new MuseAdapter({ turnTimeoutMs: 20_000 });
      try {
        await adapter.startSession({ provider: 'muse', threadId: 'path-2663' });
        await adapter.sendTurn({ threadId: 'path-2663', input: 'probe' });
        await vi.waitFor(() => expect(existsSync(host.marker)).toBe(true), {
          timeout: 15_000,
          interval: 25,
        });
        expect(readFileSync(host.marker, 'utf-8')).toBe(binary);
      } finally {
        await adapter.stopAll();
      }
    });

    it('adopts it when the process PATH is empty during the probe', async () => {
      const host = isolatedHost();
      writeFakeMuse(join(host.home, '.local', 'bin'), host.marker);

      const { summary, registry } = await adoptInto(host, { probePath: '' });

      expect(summary.outcomes.muse).toBe('adopted');
      expect(registry.engineConnections.map((c) => c.id)).toContain('muse');
    });

    it("adopts a muse found only on the interactive shell's PATH", async () => {
      const host = isolatedHost();
      const shellOnlyDir = join(tempRoot(), 'shell-only-bin');
      const binary = writeFakeMuse(shellOnlyDir, host.marker);
      vi.stubEnv('SHELL', await writeFakeShell(tempRoot(), shellOnlyDir));

      const { summary, fresh } = await adoptInto(host);

      expect(summary.outcomes.muse).toBe('adopted');
      expect(fresh.auth.findCliBinary('muse')).toBe(binary);
    });

    it('adopts nothing, and writes no row, when muse is nowhere', async () => {
      const host = isolatedHost();
      await assertNoHostMuseOutsideHome(host);

      const { summary, registry, loader } = await adoptInto(host);

      expect(summary.outcomes.muse).toBe('absent');
      expect(registry.engineConnections.map((c) => c.id)).not.toContain('muse');
      const agents = await loader.listAgents();
      expect(agents.map((agent) => agent.slug)).not.toContain('muse');
    });

    it('keeps process-PATH-only semantics under STATION_DISABLE_LOGIN_PATH_RESOLVE=1', async () => {
      const host = isolatedHost();
      await assertNoHostMuseOutsideHome(host);
      vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
      writeFakeMuse(join(host.home, '.local', 'bin'), host.marker);

      const { summary, registry } = await adoptInto(host);

      expect(summary.outcomes.muse).toBe('absent');
      expect(registry.engineConnections.map((c) => c.id)).not.toContain('muse');
    });
  },
);

posixOnly('the login-shell PATH capture adoption now awaits (#2663)', () => {
  it('settles at its own timeout even when the shell ignores SIGTERM', async () => {
    const root = tempRoot();
    // An interactive shell ignores SIGTERM, so this fake does too. `read`
    // blocks on the capture's stdin pipe with no child of its own, so a kill
    // that lands leaves nothing orphaned behind it.
    const shell = join(root, 'stubborn-shell');
    writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nread never\n");
    chmodSync(shell, 0o755);
    vi.stubEnv('SHELL', shell);
    const { auth } = await loadFresh();

    const startedAt = Date.now();
    await expect(auth.resolveLoginShellPath()).resolves.toBe('');
    // The fake never exits by itself: settling at all is the bound. The
    // elapsed check only guards against settling via vitest teardown.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 25_000);
});

/**
 * A launcher script in the shape npm installs: `#!/usr/bin/env node`. It
 * records that it ran, which it can only do if `env` found `node`.
 */
function writeNodeLauncher(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.execPath);`,
      `process.stdout.write('{"payload":{"kind":"run_terminal","terminal":"completed","reason":null,"text":"ok"}}\\n');`,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * `node` reachable ONLY through HOME/.local/bin, a well-known dir the process
 * PATH (`/usr/bin:/bin`) lacks, as a mise- or nix-managed node is for a
 * service. Checked, not assumed: a host with a system node would pass
 * without the augmented env.
 */
function nodeOnlyInLocalBin(host: Host): void {
  expect(
    ['/usr/bin/node', '/bin/node'].filter((p) => existsSync(p)),
    'this host has a node on the test process PATH; the case cannot be observed here',
  ).toEqual([]);
  const bin = join(host.home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
}

posixOnly('engine spawns get the PATH the engine was found on (#2663)', () => {
  it('runs a `#!/usr/bin/env node` codex whose node is only in ~/.local/bin', async () => {
    const host = isolatedHost();
    nodeOnlyInLocalBin(host);
    // codex itself sits FIRST on the process PATH (a host codex in a
    // well-known dir would otherwise win); only its interpreter is off it.
    const codexDir = join(tempRoot(), 'codex-bin');
    const codex = writeNodeLauncher(codexDir, 'codex', host.marker);
    vi.stubEnv('PATH', `${codexDir}:/usr/bin:/bin`);
    vi.resetModules();
    const { createCodexProcess } = await import(
      '../../../providers/adapters/codex-adapter-transport.js'
    );
    const { findCliBinary } = await import(
      '../../../providers/auth/cli-auth.js'
    );
    expect(findCliBinary('codex')).toBe(codex);

    const child =
      createCodexProcess() as unknown as import('node:child_process').ChildProcess;
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
    });

    // 127 with `env: node: No such file or directory` is the defect.
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(existsSync(host.marker)).toBe(true);
  });

  it('runs a `#!/usr/bin/env node` muse found only in ~/.local/bin', async () => {
    const host = isolatedHost();
    nodeOnlyInLocalBin(host);
    writeNodeLauncher(join(host.home, '.local', 'bin'), 'muse', host.marker);
    vi.resetModules();
    const { MuseAdapter } = await import(
      '../../../providers/adapters/muse-adapter.js'
    );
    const adapter = new MuseAdapter({ turnTimeoutMs: 20_000 });
    try {
      await adapter.startSession({ provider: 'muse', threadId: 'env-2663' });
      await adapter.sendTurn({ threadId: 'env-2663', input: 'probe' });
      await vi.waitFor(() => expect(existsSync(host.marker)).toBe(true), {
        timeout: 15_000,
        interval: 25,
      });
    } finally {
      await adapter.stopAll();
    }
  });
});

posixOnly('a found CLI is one that can be executed (#2663)', () => {
  it('skips a non-executable file and a directory for a runnable binary later on the PATH', async () => {
    const host = isolatedHost();
    const root = tempRoot();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'muse'), '#!/bin/sh\n');
    chmodSync(join(plain, 'muse'), 0o644);
    const dirs = join(root, 'dirs');
    mkdirSync(join(dirs, 'muse'), { recursive: true });
    const runnable = writeFakeMuse(join(root, 'runnable'), host.marker);
    vi.stubEnv('PATH', [plain, dirs, join(root, 'runnable')].join(':'));
    const { auth } = await loadFresh();

    expect(auth.findCliBinary('muse')).toBe(runnable);
  });

  it('finds nothing when the only candidates are a non-executable file or a directory', async () => {
    const host = isolatedHost();
    const root = tempRoot();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'muse'), '#!/bin/sh\n');
    chmodSync(join(plain, 'muse'), 0o644);
    const dirs = join(root, 'dirs');
    mkdirSync(join(dirs, 'muse'), { recursive: true });
    await assertNoHostMuseOutsideHome(host);
    vi.stubEnv('PATH', [plain, dirs].join(':'));
    const { auth } = await loadFresh();

    expect(auth.findCliBinary('muse')).toBeNull();
    await expect(auth.findCliBinaryAsync('muse')).resolves.toBeNull();
    // The absolute spelling goes through the same check.
    expect(auth.findCliBinary(join(plain, 'muse'))).toBeNull();
    expect(auth.findCliBinary(join(dirs, 'muse'))).toBeNull();
  });
});

posixOnly(
  'detection does not wait on the shell for a CLI already on PATH (#2663)',
  () => {
    it('reports a process-PATH CLI within a 2s budget while the shell capture hangs', async () => {
      const host = isolatedHost();
      const root = tempRoot();
      const shell = join(root, 'stubborn-shell');
      writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nread never\n");
      chmodSync(shell, 0o755);
      vi.stubEnv('SHELL', shell);
      const onPath = join(root, 'on-path');
      writeFakeMuse(onPath, host.marker);
      vi.stubEnv('PATH', `${onPath}:/usr/bin:/bin`);
      vi.resetModules();
      const { detectCliOnPath } = await import(
        '../../../utils/cli-detection.js'
      );

      // `timeoutMs` makes a wait-first lookup answer false: the capture it
      // would wait on does not settle for 5s.
      await expect(detectCliOnPath('muse', { timeoutMs: 2_000 })).resolves.toBe(
        true,
      );
    });
  },
);
