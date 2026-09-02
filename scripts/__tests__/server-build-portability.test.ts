import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_SERVER_RUNTIME_BUDGET,
  DESKTOP_SERVER_RUNTIME_PACKAGES,
  inspectDesktopServerRuntime,
  NON_RUNTIME_ARTIFACT,
  stageDesktopServerRuntime,
  WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG,
} from '../lib/desktop-server-runtime.mjs';
import { STATION_SERVER_EXTERNALS } from '../lib/server-build-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const DESKTOP_SERVER_BUILD_TIMEOUT_MS = 75_000;
const DESKTOP_SERVER_READINESS_TIMEOUT_MS = 60_000;
const DESKTOP_SERVER_READINESS_POLL_INTERVAL_MS = 250;
const DESKTOP_SERVER_OUTPUT_TAIL_BYTES = 4_096;

class DesktopLivenessTransportError extends Error {}

interface DesktopIdentityProbeOptions {
  fetchImpl?: typeof fetch;
  readCredentialRecord?: () => string;
}

interface StagedServerBuildStamp {
  sha: string;
}

type DesktopReleaseConfig = {
  jobs: {
    'desktop-macos': {
      strategy: {
        matrix: {
          include: Array<{
            runner: string;
            target: string;
            artifact: string;
          }>;
        };
      };
    };
    'desktop-windows': unknown;
    'desktop-linux': unknown;
  };
};

type ChildExitState = Pick<ReturnType<typeof spawn>, 'exitCode' | 'signalCode'>;

function loadDesktopReleaseConfig() {
  const tauriConfig = JSON.parse(
    readFileSync(join(repoRoot, 'src-desktop', 'tauri.conf.json'), 'utf8'),
  );
  const desktopTauriConfigs = ['macos', 'windows', 'linux'].map((platform) =>
    JSON.parse(
      readFileSync(
        join(repoRoot, 'src-desktop', `tauri.${platform}.conf.json`),
        'utf8',
      ),
    ),
  );
  const packageConfig = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  );
  const appImageTauriConfig = JSON.parse(
    readFileSync(
      join(repoRoot, 'src-desktop', 'tauri.linux-appimage.conf.json'),
      'utf8',
    ),
  );
  const releaseWorkflow = load(
    readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
  ) as DesktopReleaseConfig;
  return {
    appImageTauriConfig,
    desktopTauriConfigs,
    packageConfig,
    releaseWorkflow,
    tauriConfig,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a desktop smoke port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function stagedRuntimeFiles(release: string): string[] {
  const found: string[] = [];
  const pending = [join(release, 'node_modules')];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else found.push(entryPath);
    }
  }
  return found;
}

async function buildDesktopResourceFixture(root: string) {
  const release = join(root, 'resources');
  const serverOutput = join(release, 'dist-server');
  stageDesktopServerRuntime({ projectRoot: repoRoot, outputRoot: release });
  const footprint = inspectDesktopServerRuntime(release);
  expect(footprint.bytes).toBeLessThanOrEqual(
    DESKTOP_SERVER_RUNTIME_BUDGET.maxBytes,
  );
  expect(footprint.files).toBeLessThanOrEqual(
    DESKTOP_SERVER_RUNTIME_BUDGET.maxFiles,
  );
  // station#2424: a single MSI CAB holds at most 65,535 files, and WiX
  // reports overflow only as `failed to run light.exe`. The staged tree must
  // therefore be pruned of artifacts no runtime reads — and the budget that
  // guards it has to sit below the ceiling, which it did not when Windows
  // packaging broke.
  expect(DESKTOP_SERVER_RUNTIME_BUDGET.maxFiles).toBeLessThan(65_535);
  const staged = stagedRuntimeFiles(release);
  expect(staged.filter((path) => NON_RUNTIME_ARTIFACT.test(path))).toEqual([]);
  // The prune is an allow-everything-else deny-list, so what it must NOT take
  // needs its own assertion: flow-agents ships its canonical skills AS
  // `SKILL.md`, and `resolveCanonicalSkillSources` drops a source whose
  // SKILL.md is absent — fail-open and unlogged, so losing these removes the
  // flow-agents-contributed skills from the packaged app while dev runs stay
  // correct. An earlier revision of this prune did exactly that.
  //
  // This pins the files' presence in the staged tree, which is where the
  // regression happened; it does not drive the packaged server to list
  // skills end to end, so resolution itself remains covered only by that
  // service's own unit tests.
  expect(
    staged.filter((path) => path.endsWith(`${sep}SKILL.md`)).length,
  ).toBeGreaterThan(0);
  expect(staged.some((path) => /LICEN[CS]E/i.test(path))).toBe(true);
  await execFileAsync(process.execPath, ['esbuild.config.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, STATION_BUILD_SERVER_DIR: serverOutput },
    encoding: 'utf8',
    // This settles before temporary resources are cleaned up and leaves room
    // for the bounded readiness probe within the enclosing test timeout.
    timeout: DESKTOP_SERVER_BUILD_TIMEOUT_MS,
  });
  expect(
    existsSync(join(serverOutput, 'project-task-room-working-state-worker.js')),
  ).toBe(true);
  // jsonc-parser's CommonJS UMD `main` entry loads these files with dynamic
  // relative requires. A single-file dist-server cannot carry those sibling
  // modules, so rejecting the emitted shape here makes this packaging failure
  // fail before the real staged-runtime listener smoke below.
  const serverBundle = readFileSync(
    join(serverOutput, 'command-station.js'),
    'utf8',
  );
  expect(serverBundle).not.toMatch(
    /require\d*\("\.\/impl\/(?:format|edit|scanner|parser)"\)/,
  );
  // seed/ was removed in #1586: the desktop bundle no longer ships it and
  // the server bootstraps fresh homes itself, so the staged release must
  // prove portability without it.
  cpSync(join(repoRoot, 'schemas'), join(release, 'schemas'), {
    recursive: true,
  });
  return release;
}

/**
 * The bundled server sets this global in esbuild's banner. Read the staged
 * bytes rather than recomputing from this checkout: the portability contract
 * is that a packaged release reports the identity it was built with, even
 * when its launch environment contains a conflicting checkout SHA.
 */
function readStagedServerBuildStamp(release: string): StagedServerBuildStamp {
  const source = readFileSync(
    join(release, 'dist-server', 'command-station.js'),
    'utf8',
  );
  const match = source.match(
    /globalThis\.__STATION_SERVER_BUILD__ = (\{[^\n]+\});/,
  );
  if (!match?.[1]) {
    throw new Error('Staged desktop server is missing its build stamp');
  }
  const parsed = JSON.parse(match[1]) as { sha?: unknown };
  if (typeof parsed.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(parsed.sha)) {
    throw new Error('Staged desktop server has an invalid build stamp SHA');
  }
  return { sha: parsed.sha };
}

function assertRuntimeContainment(release: string, temporaryRoot: string) {
  for (const packageName of DESKTOP_SERVER_RUNTIME_PACKAGES.filter(
    (name) => name !== 'fsevents',
  )) {
    const installed = join(release, 'node_modules', packageName);
    expect(lstatSync(installed).isSymbolicLink()).toBe(false);
    expect(
      realpathSync(installed).startsWith(realpathSync(temporaryRoot)),
    ).toBe(true);
  }
}

function launchDesktopServer(release: string, root: string, port: number) {
  const homeDir = join(root, 'home');
  const stagedBuild = readStagedServerBuildStamp(release);
  // A supervisor/check-out SHA is intentionally present but must not rewrite
  // the immutable identity of the staged resource bytes.
  const conflictingCheckoutSha = '1234567890abcdef1234567890abcdef12345678';
  const expectedIdentity = {
    instanceId: 'desktop-smoke',
    sha: stagedBuild.sha,
    shaSource: 'build-stamp' as const,
    bootId: randomUUID(),
  };
  const child = spawn(process.execPath, ['dist-server/command-station.js'], {
    cwd: release,
    env: {
      ...process.env,
      PORT: String(port),
      STATION_HOME: homeDir,
      STATION_HOST: '127.0.0.1',
      STATION_BUILD_SHA: conflictingCheckoutSha,
      STATION_BUILD_BRANCH: 'desktop-smoke',
      STATION_BUILD_BUILT_AT: new Date().toISOString(),
      STATION_INSTANCE_ID: expectedIdentity.instanceId,
      STATION_BOOT_ID: expectedIdentity.bootId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]).subarray(
      -DESKTOP_SERVER_OUTPUT_TAIL_BYTES,
    );
  });
  child.stderr.on('data', (chunk) => {
    output = Buffer.concat([output, Buffer.from(chunk)]).subarray(
      -DESKTOP_SERVER_OUTPUT_TAIL_BYTES,
    );
  });
  return {
    child,
    conflictingCheckoutSha,
    expectedIdentity,
    homeDir,
    output: () => output.toString('utf8'),
  };
}

function childExitDiagnostic(child: ChildExitState) {
  if (child.exitCode === null && child.signalCode === null) return null;
  return `code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'}`;
}

async function probeDesktopIdentityOnce(
  port: number,
  homeDir: string,
  options: DesktopIdentityProbeOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let liveness: Response;
  try {
    liveness = await fetchImpl(`http://127.0.0.1:${port}/api/system/liveness`, {
      signal: AbortSignal.timeout(DESKTOP_SERVER_READINESS_POLL_INTERVAL_MS),
    });
  } catch (error) {
    throw new DesktopLivenessTransportError('Liveness transport failed', {
      cause: error,
    });
  }
  if (!liveness.ok) {
    throw new Error(
      `Packaged desktop liveness probe failed with ${liveness.status}`,
    );
  }
  expect(await liveness.json()).toEqual({ live: true });
  const securityRecord = JSON.parse(
    options.readCredentialRecord?.() ??
      readFileSync(join(homeDir, 'security', 'environment.json'), 'utf8'),
  ) as { credential?: unknown };
  if (typeof securityRecord.credential !== 'string') {
    throw new Error(
      'Packaged desktop server did not persist its operator credential',
    );
  }
  const identity = await fetchImpl(
    `http://127.0.0.1:${port}/api/system/identity`,
    {
      headers: { Authorization: `Bearer ${securityRecord.credential}` },
      signal: AbortSignal.timeout(DESKTOP_SERVER_READINESS_POLL_INTERVAL_MS),
    },
  );
  if (!identity.ok) {
    throw new Error(
      `Packaged desktop identity probe failed with ${identity.status}`,
    );
  }
  return identity.json();
}

async function waitForDesktopIdentity(
  port: number,
  launched: ReturnType<typeof launchDesktopServer>,
) {
  const deadline = Date.now() + DESKTOP_SERVER_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exitDiagnostic = childExitDiagnostic(launched.child);
    if (exitDiagnostic) {
      throw new Error(
        `Packaged desktop server exited (${exitDiagnostic}): ${launched.output()}`,
      );
    }
    try {
      return await probeDesktopIdentityOnce(port, launched.homeDir);
    } catch (error) {
      if (!(error instanceof DesktopLivenessTransportError)) throw error;
      // The resource-shaped server is still starting.
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          DESKTOP_SERVER_READINESS_POLL_INTERVAL_MS,
          deadline - Date.now(),
        ),
      ),
    );
  }
  const exitDiagnostic = childExitDiagnostic(launched.child);
  if (exitDiagnostic) {
    throw new Error(
      `Packaged desktop server exited (${exitDiagnostic}): ${launched.output()}`,
    );
  }
  throw new Error(
    `Packaged desktop server did not become ready within ${DESKTOP_SERVER_READINESS_TIMEOUT_MS}ms. Output tail:\n${launched.output()}`,
  );
}

async function terminateDesktopServer(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (childExitDiagnostic(child)) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (childExitDiagnostic(child)) return resolve();
    const timeout = setTimeout(() => {
      if (!childExitDiagnostic(child)) child.kill('SIGKILL');
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function createBudgetFixture(root: string) {
  const projectRoot = join(root, 'project');
  const packageRoot = join(projectRoot, 'node_modules', 'fixture-runtime');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'fixture-runtime', version: '1.0.0' }),
  );
  writeFileSync(join(packageRoot, 'payload.txt'), 'release payload');
  return projectRoot;
}

function createDeepRuntimeFixture(root: string) {
  const projectRoot = join(root, 'project');
  const packageName = 'runtime-package-with-a-deliberately-long-name';
  let packageRoot = join(projectRoot, 'node_modules', packageName);
  for (let index = 0; index < 7; index += 1) {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        dependencies: index < 6 ? { [packageName]: '1.0.0' } : {},
      }),
    );
    writeFileSync(join(packageRoot, 'runtime.js'), 'export default true;');
    if (index < 6) {
      packageRoot = join(packageRoot, 'node_modules', packageName);
    }
  }
  return { projectRoot, packageName };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
}, 60_000);

describe('server build package portability', () => {
  it('treats signal exits as terminal process state', () => {
    expect(childExitDiagnostic({ exitCode: null, signalCode: 'SIGTERM' })).toBe(
      'code none, signal SIGTERM',
    );
  });

  it('fails immediately on liveness HTTP rejection without requesting identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      probeDesktopIdentityOnce(3142, '/unused', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readCredentialRecord: () =>
          JSON.stringify({ credential: 'fixture-credential' }),
      }),
    ).rejects.toThrow('liveness probe failed with 401');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/api/system/liveness',
    );
  });

  it('fails immediately on authenticated identity HTTP rejection', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ live: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      probeDesktopIdentityOnce(3142, '/unused', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readCredentialRecord: () =>
          JSON.stringify({ credential: 'fixture-credential' }),
      }),
    ).rejects.toThrow('identity probe failed with 401');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      '/api/system/identity',
    );
  });

  it('fails on a missing persisted credential without requesting identity', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ live: true }));
    await expect(
      probeDesktopIdentityOnce(3142, '/unused', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readCredentialRecord: () => JSON.stringify({}),
      }),
    ).rejects.toThrow('did not persist its operator credential');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      '/api/system/liveness',
    );
  });

  it('wires the staged runtime into the desktop resource bundle', () => {
    const {
      appImageTauriConfig,
      desktopTauriConfigs,
      packageConfig,
      releaseWorkflow,
      tauriConfig,
    } = loadDesktopReleaseConfig();

    expect(tauriConfig.build.beforeBuildCommand).toBe(
      'npm run build:native-client',
    );
    expect(tauriConfig.bundle.resources).toBeUndefined();
    for (const desktopConfig of desktopTauriConfigs) {
      expect(desktopConfig.build.beforeBuildCommand).toBe(
        'npm run build:desktop:resources',
      );
      expect(
        desktopConfig.bundle.resources['../dist-desktop-runtime/node_modules'],
      ).toBe('node_modules');
    }
    expect(
      appImageTauriConfig.bundle.resources[
        '../dist-desktop-runtime/node_modules'
      ],
    ).toBeNull();
    expect(appImageTauriConfig.bundle.resources['../dist-server']).toBeNull();
    expect(appImageTauriConfig.build.beforeBuildCommand).toBe(
      'npm run build:desktop:resources',
    );
    expect(appImageTauriConfig.bundle.linux.appimage.files).toEqual({
      'usr/share/Station/dist-server': '../dist-server',
      'usr/share/Station/node_modules': '../dist-desktop-runtime/node_modules',
    });
    // The portable wrapper owns one immutable client-build transaction, then
    // delegates server staging after that stamp has been reused. Keep this
    // assertion at the package boundary and verify the nested staging command
    // rather than making the package script duplicate shell-specific env syntax.
    expect(packageConfig.scripts['build:desktop:resources']).toBe(
      'node scripts/build-desktop-resources.mjs',
    );
    expect(
      readFileSync(
        join(repoRoot, 'scripts', 'build-desktop-resources.mjs'),
        'utf8',
      ),
    ).toContain('scripts/stage-desktop-server-runtime.mjs');
    expect(packageConfig.scripts.clean).toContain('dist-desktop-runtime');
    expect(packageConfig.scripts.clean).toContain('dist-desktop-wix-resources');
    // station#3379: Tauri's NSIS template removes resources with `Delete`
    // (files only) then `RMDir` without /r (empty dirs only), so it cannot
    // remove a directory resource. Without these hooks, uninstall exits 0
    // leaving ~34k files behind and every upgrade overlays builds. Assert the
    // wiring AND that each directory resource is cleared pre-install, so a
    // future resource directory cannot be added without being handled.
    const windowsConfig = desktopTauriConfigs[1] as {
      bundle: {
        resources: Record<string, string>;
        windows?: { nsis?: { installerHooks?: string } };
      };
    };
    const hooksPath = windowsConfig.bundle.windows?.nsis?.installerHooks;
    expect(hooksPath).toBe('nsis-hooks.nsh');
    const hooks = readFileSync(
      join(repoRoot, 'src-desktop', hooksPath as string),
      'utf8',
    );
    // Anchored, because a substring match passes against a hooks file whose
    // every line is commented out: a commented `RMDir` line still contains
    // the bare command as a substring. Both macro names are pinned too — the
    // template inserts a hook only where its `!ifmacrodef` sees that exact
    // name, so a typo makes the hook silently never run while the file still
    // reads correctly.
    expect(hooks).toMatch(/^!macro NSIS_HOOK_PREINSTALL$/m);
    expect(hooks).toMatch(/^!macro NSIS_HOOK_POSTUNINSTALL$/m);
    expect(hooks).toMatch(/^ {2}RMDir \/r "\$INSTDIR"$/m);
    // The running-app check must precede the first destructive line: the
    // template's own check runs after this hook, so cancelling it later would
    // leave an install whose resources are already deleted.
    const firstDestructive = hooks.search(/^ {2}RMDir \/r /m);
    const runningCheck = hooks.search(
      /^ {2}!insertmacro CheckIfAppIsRunning /m,
    );
    expect(runningCheck).toBeGreaterThanOrEqual(0);
    expect(runningCheck).toBeLessThan(firstDestructive);
    for (const target of Object.values(windowsConfig.bundle.resources)) {
      expect(hooks).toMatch(
        new RegExp(`^ {2}RMDir \\/r "\\$INSTDIR\\\\${target}"$`, 'm'),
      );
    }
    expect(releaseWorkflow.jobs['desktop-windows']).toBeDefined();
    expect(releaseWorkflow.jobs['desktop-linux']).toBeDefined();
    expect(
      releaseWorkflow.jobs['desktop-macos'].strategy.matrix.include,
    ).toEqual([
      {
        runner: 'macos-15',
        target: 'aarch64-apple-darwin',
        artifact: 'station-desktop-macos-aarch64',
      },
      {
        runner: 'macos-15-intel',
        target: 'x86_64-apple-darwin',
        artifact: 'station-desktop-macos-x86_64',
      },
    ]);
  });

  it('fails desktop staging closed above either release budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-desktop-budget-'));
    temporaryRoots.push(root);
    const projectRoot = createBudgetFixture(root);
    const common = {
      projectRoot,
      packages: ['fixture-runtime'],
    };
    expect(() =>
      stageDesktopServerRuntime({
        ...common,
        outputRoot: join(root, 'bytes'),
        budget: { maxBytes: 0, maxFiles: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow(/exceeds its release budget/);
    expect(() =>
      stageDesktopServerRuntime({
        ...common,
        outputRoot: join(root, 'files'),
        budget: { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: 0 },
      }),
    ).toThrow(/exceeds its release budget/);
  });

  it('uses shallow WiX sources while preserving deep runtime destinations', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-desktop-wix-path-'));
    temporaryRoots.push(root);
    const { projectRoot, packageName } = createDeepRuntimeFixture(root);
    const outputRoot = join(root, 'runtime');
    const wixRoot = join(root, 'wix-resources');
    const configRoot = join(projectRoot, 'src-desktop');
    mkdirSync(configRoot, { recursive: true });

    stageDesktopServerRuntime({
      projectRoot,
      outputRoot,
      packages: [packageName],
      windowsWixResourceRoot: wixRoot,
      windowsTauriConfigRoot: configRoot,
    });

    const config = JSON.parse(
      readFileSync(join(wixRoot, WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG), 'utf8'),
    ) as { bundle: { resources: Record<string, string | null> } };
    expect(
      config.bundle.resources['../dist-desktop-runtime/node_modules'],
    ).toBeNull();

    const deepTarget = [
      'node_modules',
      packageName,
      ...Array.from({ length: 6 }, () => ['node_modules', packageName]).flat(),
    ].join('/');
    const [aliasSource] =
      Object.entries(config.bundle.resources).find(
        ([, target]) => target === deepTarget,
      ) ?? [];
    expect(aliasSource).toMatch(/wix-resources\/package-0006$/);
    expect(
      readFileSync(join(wixRoot, 'package-0006', 'runtime.js'), 'utf8'),
    ).toBe('export default true;');

    // This is the failing pre-fix shape: WiX receives the whole nested source
    // path. The generated map instead gives it a single shallow alias.
    const legacyWixSource = `E:/station/src-desktop/../dist-desktop-runtime/${deepTarget}/runtime.js`;
    const shallowWixSource = `E:/station/src-desktop/${aliasSource}/runtime.js`;
    expect(legacyWixSource.length).toBeGreaterThan(260);
    expect(shallowWixSource.length).toBeLessThanOrEqual(260);
  });

  async function buildProbe(release: string) {
    const source = join(release, 'review-probe.mjs');
    const output = join(release, 'dist-server', 'review-probe.mjs');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      source,
      [
        "import { normalizeTrustBundle } from '@kontourai/flow';",
        "import { discoverSurveyGateReviewWork } from '@kontourai/flow-agents';",
        "import { classifyNodes } from '@kontourai/veritas/engine';",
        "if (typeof normalizeTrustBundle !== 'function') process.exit(2);",
        "if (typeof discoverSurveyGateReviewWork !== 'function') process.exit(2);",
        "if (typeof classifyNodes !== 'function') process.exit(2);",
      ].join('\n'),
    );

    await esbuild.build({
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      entryPoints: [source],
      outfile: output,
      external: STATION_SERVER_EXTERNALS,
      banner: {
        js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
      },
    });
    expect(readFileSync(output, 'utf8')).toContain(
      'from "@kontourai/veritas/engine"',
    );

    expect(() =>
      execFileSync(process.execPath, [output], {
        cwd: release,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }

  it('preserves package-relative helpers from an immutable source release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-server-release-'));
    temporaryRoots.push(root);
    const release = join(root, 'releases', 'candidate');
    mkdirSync(release, { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules'), join(release, 'node_modules'));
    await buildProbe(release);
  }, 20_000);

  it('stages a self-contained runtime beside the desktop server resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-desktop-release-'));
    temporaryRoots.push(root);
    const release = await buildDesktopResourceFixture(root);
    assertRuntimeContainment(release, root);
    const port = await freePort();
    const launched = launchDesktopServer(release, root, port);
    try {
      expect(launched.expectedIdentity.sha).not.toBe(
        launched.conflictingCheckoutSha,
      );
      const identity = await waitForDesktopIdentity(port, launched);
      expect(identity).toEqual(launched.expectedIdentity);
      expect(identity).toMatchObject({
        sha: readStagedServerBuildStamp(release).sha,
        shaSource: 'build-stamp',
      });
    } finally {
      await terminateDesktopServer(launched.child);
    }
  }, 150_000);
});
