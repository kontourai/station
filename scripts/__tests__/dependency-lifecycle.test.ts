import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  INERT_INSTALL_TIMEOUT_ENV,
  inertInstallTimeout,
  preflightInstalledLifecycle,
  resolveNpmCli,
  runApprovedHooks,
  verifyLifecycleArtifacts,
} from '../dependency-lifecycle.mjs';
import {
  checkWorkflowDirectory,
  collectRawNpmLifecycleBypasses,
  REPOSITORY_LIFECYCLE_SOURCES,
} from '../dependency-lifecycle-workflow-gate.mjs';
import { installGitIntegration } from '../install-git-hooks.mjs';
import {
  allowlistDigest,
  assertNodePtyPrebuildConsistency,
  assertPtyHandshakeOutcome,
  confinedPackageTarget,
  degradableLifecycleCapability,
  evaluateLifecyclePolicy,
  expectedLifecyclePurls,
  platformMatches,
  prepareLifecycleArtifacts,
  readLifecycleLocks,
  readNodePtyPrebuildManifest,
  stageNodePtyPrebuild,
  verifyArtifact,
  verifyNodePtyHandshake,
} from '../lib/dependency-lifecycle-policy.mjs';
import {
  classifyDependencySpec,
  findWorkspaceDependencyProblems,
} from '../lib/workspace-dependency-satisfaction.mjs';

const root = resolve(import.meta.dirname, '../..');
const policy = JSON.parse(
  readFileSync(
    resolve(root, 'config/dependency-lifecycle-allowlist.json'),
    'utf8',
  ),
);
const nodes = readLifecycleLocks(root);
const shellLauncherTest = process.platform === 'win32' ? it.skip : it;

// `installGitIntegration` compares `resolve(toplevel)` against `root`, so the
// fixture root has to be an absolute path for THIS platform: a hardcoded POSIX
// '/repo' resolves to '<cwd-drive>:\repo' on Windows and can never equal the
// '/repo' passed as `root`, which failed the enclosing-repo guard spuriously.
// Real `git rev-parse --show-toplevel` reports forward slashes on every
// platform (Git for Windows prints 'C:/checkout'), so feed the toplevel in that
// form and let production's `resolve()` normalise it — that is exactly the
// conversion the guard relies on, now actually exercised on Windows.
const gitFixtureRoot = resolve(tmpdir(), 'station-git-integration-repo');
const gitFixtureToplevel = gitFixtureRoot.replaceAll('\\', '/');

describe('git integration installer', () => {
  it('writes and reads back hooks and every merge-driver setting', () => {
    const config = new Map<string, string>();
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return gitFixtureToplevel;
      if (args[1] === '--local' && args[2] === '--get')
        return config.get(args[3]) ?? '';
      if (args[0] === 'config' && args[1] === '--local') {
        config.set(args[2], args[3]);
        return '';
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    installGitIntegration({
      root: gitFixtureRoot,
      runGit,
      pathExists: () => true,
    });

    expect(config).toEqual(
      new Map([
        ['core.hooksPath', '.githooks'],
        [
          'merge.station-ui-bundle-budget.name',
          'Station UI bundle budget re-measurement',
        ],
        [
          'merge.station-ui-bundle-budget.driver',
          'node scripts/merge-ui-bundle-budget.mjs %O %A %B %L %P',
        ],
      ]),
    );
    expect(calls).toContainEqual([
      'config',
      '--local',
      '--get',
      'merge.station-ui-bundle-budget.driver',
    ]);
  });

  it('fails when a merge-driver write does not read back exactly', () => {
    const config = new Map<string, string>();
    const runGit = (args: string[]) => {
      if (args[0] === 'rev-parse') return gitFixtureToplevel;
      if (args[1] === '--local' && args[2] === '--get') {
        if (args[3] === 'merge.station-ui-bundle-budget.driver') return '';
        return config.get(args[3]) ?? '';
      }
      config.set(args[2], args[3]);
      return '';
    };

    expect(() =>
      installGitIntegration({
        root: gitFixtureRoot,
        runGit,
        pathExists: () => true,
      }),
    ).toThrow(
      'merge.station-ui-bundle-budget.driver did not read back as configured',
    );
  });
});

function workspaceDependencyFixture({
  dependencies,
  optionalDependencies,
  rootPackages = {},
  workspacePackages = {},
}: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  rootPackages?: Record<string, Record<string, unknown>>;
  workspacePackages?: Record<string, Record<string, unknown>>;
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'station-workspace-deps-'));
  const workspace = join(fixtureRoot, 'packages', 'fixture');
  const writePackage = (path: string, manifest: Record<string, unknown>) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
  };
  writePackage(fixtureRoot, {
    name: 'fixture-root',
    private: true,
    workspaces: ['packages/fixture'],
  });
  writePackage(workspace, {
    name: '@fixture/workspace',
    version: '1.0.0',
    dependencies,
    optionalDependencies,
  });
  for (const [name, manifest] of Object.entries(rootPackages))
    writePackage(
      join(fixtureRoot, 'node_modules', ...name.split('/')),
      manifest,
    );
  for (const [name, manifest] of Object.entries(workspacePackages))
    writePackage(join(workspace, 'node_modules', ...name.split('/')), manifest);
  return { fixtureRoot };
}

function executable(path: string, source: string) {
  writeFileSync(path, source, { mode: 0o755 });
}

function launcherFixture({
  warm = false,
  lockfile = true,
  runtimeFailure = false,
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'station-launcher-'));
  const checkout = join(fixtureRoot, 'checkout with spaces');
  const bin = join(fixtureRoot, 'bin');
  const caller = join(fixtureRoot, 'caller cwd');
  const log = join(fixtureRoot, 'calls.log');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(caller, { recursive: true });
  copyFileSync(join(root, 'station'), join(checkout, 'station'));
  chmodSync(join(checkout, 'station'), 0o755);
  writeFileSync(
    join(checkout, 'scripts', 'node-runtime-contract.mjs'),
    runtimeFailure ? 'process.exit(42);' : '',
  );
  if (lockfile) writeFileSync(join(checkout, 'package-lock.json'), '{}');
  if (warm) mkdirSync(join(checkout, 'node_modules'));
  executable(
    join(bin, 'npm'),
    '#!/bin/sh\nprintf "npm|%s" "$PWD" >> "$STATION_TEST_LOG"\nfor arg do printf "|<%s>" "$arg" >> "$STATION_TEST_LOG"; done\nprintf "\\n" >> "$STATION_TEST_LOG"\n[ "$STATION_TEST_NPM_FAIL" = 0 ] || exit 71\n',
  );
  executable(
    join(bin, 'npx'),
    '#!/bin/sh\nprintf "npx|%s|%s|%s" "$PWD" "$STATION_INVOKED_CWD" "$#" >> "$STATION_TEST_LOG"\nfor arg do printf "|<%s>" "$arg" >> "$STATION_TEST_LOG"; done\nprintf "\\n" >> "$STATION_TEST_LOG"\n',
  );
  const launcher = join(fixtureRoot, 'station link');
  symlinkSync(join(checkout, 'station'), launcher);
  return { bin, caller, checkout, fixtureRoot, launcher, log };
}

function runLauncher(
  fixture: ReturnType<typeof launcherFixture>,
  args: string[] = ['doctor'],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync('bash', [fixture.launcher, ...args], {
    cwd: fixture.caller,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ''}`,
      STATION_TEST_NPM_FAIL: env.STATION_TEST_NPM_FAIL ?? '0',
      STATION_TEST_LOG: fixture.log,
    },
    timeout: 5_000,
    windowsHide: true,
  });
}

function executeCapturedPtyChild({
  chunks,
  exit,
}: {
  chunks: string[];
  exit: any;
}) {
  let source = '';
  verifyNodePtyHandshake('/fixture/node-pty', {
    exec: (_command, args) => {
      source = args[1];
      return JSON.stringify({
        marker: 'STATION_NODE_PTY_READY_4296',
        exitCode: 0,
        signal: 0,
      });
    },
  });
  let onData!: (chunk: string) => void;
  let onExit!: (event: any) => void;
  const writes: string[] = [];
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  const timer = {};
  runInNewContext(source, {
    require: () => ({
      spawn: () => ({
        onData(callback: (chunk: string) => void) {
          onData = callback;
        },
        onExit(callback: (event: any) => void) {
          onExit = callback;
        },
        write(value: string) {
          writes.push(value);
        },
        kill() {},
      }),
    }),
    process: {
      argv: ['node', '/fixture/node-pty'],
      cwd: () => '/fixture',
      env: {
        STATION_PTY_MARKER: 'STATION_NODE_PTY_READY_4296',
        STATION_PTY_TIMEOUT_MS: '8000',
      },
      execPath: '/node',
      exit(code: number) {
        exitCode = code;
      },
      stderr: {
        write(value: string) {
          stderr += value;
        },
      },
      stdout: {
        write(value: string) {
          stdout += value;
        },
      },
    },
    clearTimeout() {},
    setTimeout() {
      return timer;
    },
  });
  for (const chunk of chunks) onData(chunk);
  onExit(exit);
  return { exitCode, stderr, stdout, writes };
}

describe('dependency lifecycle policy', () => {
  it('requires the PTY marker and a natural zero exit', () => {
    expect(() => assertPtyHandshakeOutcome('')).toThrow('no parseable outcome');
    expect(() =>
      assertPtyHandshakeOutcome(
        JSON.stringify({ marker: 'wrong', exitCode: 0 }),
      ),
    ).toThrow('never observed');
    expect(() =>
      assertPtyHandshakeOutcome(
        JSON.stringify({ marker: 'STATION_NODE_PTY_READY_4296', exitCode: 1 }),
      ),
    ).toThrow('exited 1');
    expect(() =>
      assertPtyHandshakeOutcome(
        JSON.stringify({
          marker: 'STATION_NODE_PTY_READY_4296',
          exitCode: 0,
          signal: 15,
        }),
      ),
    ).toThrow('was signalled');
  });

  it('does not hide real PTY child failure output', () => {
    expect(() =>
      verifyNodePtyHandshake('/fixture/node-pty', {
        exec: () => {
          throw { stderr: 'AttachConsole failed' };
        },
      }),
    ).toThrow('AttachConsole failed');
  });

  it('requires the marker/ack/natural-exit protocol instead of immediate PTY teardown', () => {
    let childSource = '';
    verifyNodePtyHandshake('/fixture/node-pty', {
      exec: (_command, args) => {
        childSource = args[1];
        return JSON.stringify({
          marker: 'STATION_NODE_PTY_READY_4296',
          exitCode: 0,
        });
      },
    });
    expect(childSource).toContain('terminal.onData');
    expect(childSource).toContain("terminal.write('station-pty-ack");
    expect(childSource).toContain('terminal.onExit');
    expect(childSource).toContain('node-pty handshake timed out');
  });

  it('acks a marker split across PTY chunks and accepts only a natural exit', () => {
    const result = executeCapturedPtyChild({
      chunks: ['STATION_NODE_PTY_READY_', '4296\r\n'],
      exit: { exitCode: 0, signal: 0 },
    });
    expect(result.writes).toEqual(['station-pty-ack\r']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      marker: 'STATION_NODE_PTY_READY_4296',
      exitCode: 0,
      signal: 0,
    });
  });

  it('rejects a signalled child even when it reports exit code zero', () => {
    const result = executeCapturedPtyChild({
      chunks: ['STATION_NODE_PTY_READY_4296'],
      exit: { exitCode: 0, signal: 15 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('did not exit naturally');
  });

  it('matches every root, SDK, and Shared lifecycle marker exactly', () => {
    expect(evaluateLifecyclePolicy({ allowlist: policy, nodes })).toEqual([]);
    expect(allowlistDigest(policy)).toMatch(/^[a-f0-9]{64}$/);
    expect(expectedLifecyclePurls(policy)).toContain('pkg:npm/node-pty@1.1.0');
  });

  it('keeps Station-owned lifecycle hooks out of the lock marker inventory', () => {
    const lock = JSON.parse(
      readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
    );
    expect(lock.packages[''].hasInstallScript).not.toBe(true);
  });

  it.each([
    [
      'unapproved node',
      (value: any[]) => [
        ...value,
        {
          ...value[0],
          path: 'node_modules/evil',
          name: 'evil',
          version: '1.0.0',
          integrity: value[0].integrity,
          purl: 'pkg:npm/evil@1.0.0',
        },
      ],
      'unapproved install script',
    ],
    [
      'nested-path borrowing',
      (value: any[]) =>
        value.map((node) =>
          node.path.includes('@voltagent')
            ? { ...node, path: 'node_modules/esbuild' }
            : node,
        ),
      'stale allowlist entry',
    ],
    [
      'version drift',
      (value: any[]) =>
        value.map((node, index) =>
          index === 0 ? { ...node, version: '9.9.9' } : node,
        ),
      'identity drift',
    ],
    [
      'integrity drift',
      (value: any[]) =>
        value.map((node, index) =>
          index === 0 ? { ...node, integrity: 'sha512-evil' } : node,
        ),
      'identity drift',
    ],
    [
      'suppressed marker',
      (value: any[]) => value.slice(1),
      'stale allowlist entry',
    ],
    [
      'platform drift',
      (value: any[]) =>
        value.map((node) =>
          node.name === 'fsevents'
            ? { ...node, platform: { os: [], cpu: [] } }
            : node,
        ),
      'platform drift',
    ],
  ])('rejects %s', (_name, mutate, message) => {
    expect(
      evaluateLifecyclePolicy({ allowlist: policy, nodes: mutate(nodes) }).join(
        '\n',
      ),
    ).toContain(message);
  });

  it('requires reviewed artifact and decision metadata', () => {
    const invalid = structuredClone(policy);
    invalid.entries[0].artifact.path = '../evil';
    invalid.entries[0].hooks = [{ name: 'prepare', command: 'node evil.js' }];
    const findings = evaluateLifecyclePolicy({ allowlist: invalid, nodes });
    expect(findings.join('\n')).toContain('invalid artifact proof');
    expect(findings.join('\n')).toContain('unapproved hook command');
  });

  it('does not borrow Darwin approval on Linux or Windows', () => {
    const fsevents = policy.entries.find(
      (entry: any) => entry.name === 'fsevents',
    );
    expect(platformMatches(fsevents, 'darwin', 'arm64')).toBe(true);
    expect(platformMatches(fsevents, 'linux', 'x64')).toBe(false);
    expect(platformMatches(fsevents, 'win32', 'x64')).toBe(false);
  });

  it('selects reviewed node-pty artifacts per native platform', () => {
    const pty = policy.entries.find((entry: any) => entry.name === 'node-pty');
    expect(pty.artifact.platforms['linux/x64']).toEqual([
      'build/Release/pty.node',
    ]);
    expect(pty.artifact.platforms['linux/arm64']).toEqual([
      'build/Release/pty.node',
    ]);
    expect(pty.artifact.platforms['darwin/arm64']).toEqual([
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
    ]);
    for (const arch of ['x64', 'arm64'])
      expect(pty.artifact.platforms[`win32/${arch}`]).toEqual([
        `prebuilds/win32-${arch}/pty.node`,
        `prebuilds/win32-${arch}/conpty.node`,
        `prebuilds/win32-${arch}/conpty_console_list.node`,
        `prebuilds/win32-${arch}/conpty/conpty.dll`,
        `prebuilds/win32-${arch}/conpty/OpenConsole.exe`,
        `prebuilds/win32-${arch}/winpty.dll`,
        `prebuilds/win32-${arch}/winpty-agent.exe`,
      ]);
  });

  it('rejects empty, wrong, and unreviewed native artifact arrays', () => {
    const invalid = structuredClone(policy);
    const pty = invalid.entries.find((entry: any) => entry.name === 'node-pty');
    pty.artifact.platforms['win32/x64'] = [];
    expect(
      evaluateLifecyclePolicy({ allowlist: invalid, nodes }).join('\n'),
    ).toContain('invalid platform artifact selectors');
    pty.artifact.platforms['win32/x64'] = ['../wrong.node'];
    expect(
      evaluateLifecyclePolicy({ allowlist: invalid, nodes }).join('\n'),
    ).toContain('invalid platform artifact selectors');
  });

  it('fails closed for missing and nonloadable artifacts', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    try {
      const packageRoot = resolve(
        fixtureRoot,
        'node_modules',
        'fixture-native',
      );
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'fixture-native',
          version: '1.0.0',
          main: 'index.js',
        }),
      );
      writeFileSync(resolve(packageRoot, 'index.js'), 'module.exports = {};');
      const entry = {
        lock: 'package-lock.json',
        path: 'node_modules/fixture-native',
        name: 'fixture-native',
        version: '1.0.0',
        artifact: { path: 'missing.node', proof: 'node-pty-smoke' },
        platform: { os: [], cpu: [] },
      };
      expect(() => verifyArtifact(fixtureRoot, entry)).toThrow(
        /missing lifecycle artifact/,
      );
      writeFileSync(resolve(packageRoot, 'missing.node'), 'not a native addon');
      expect(() => verifyArtifact(fixtureRoot, entry)).toThrow();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('degrades only the terminal-backing node-pty entry, never other proofs (#1244)', () => {
    const ptyEntry = policy.entries.find(
      (item: any) => item.name === 'node-pty',
    );
    const degradable = degradableLifecycleCapability(ptyEntry);
    expect(degradable?.capability).toBe('terminal');
    expect(degradable?.remediation).toContain('npm run dependencies:install');
    for (const entry of policy.entries) {
      if (entry.name === 'node-pty') continue;
      expect(
        degradableLifecycleCapability(entry),
        `${entry.name} must not silently become degradable`,
      ).toBeUndefined();
    }
  });

  it('converts a failed degradable build into a loud DEGRADED report and keeps installing (#1244)', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const writeFixturePackage = (
        name: string,
        script: string,
        source: string,
      ) => {
        const packageRoot = resolve(fixtureRoot, 'node_modules', name);
        mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
        writeFileSync(
          resolve(packageRoot, 'package.json'),
          JSON.stringify({
            name,
            version: '1.0.0',
            scripts: { install: `node scripts/${script}` },
          }),
        );
        writeFileSync(resolve(packageRoot, 'scripts', script), source);
        return packageRoot;
      };
      writeFixturePackage('fixture-degradable', 'fail.mjs', 'process.exit(1);');
      const survivorRoot = writeFixturePackage(
        'fixture-survivor',
        'ok.mjs',
        "import { writeFileSync } from 'node:fs'; writeFileSync('built.marker', 'ok');",
      );
      const entryBase = {
        scope: 'root',
        lock: 'package-lock.json',
        version: '1.0.0',
        decision: 'execute',
        platform: { os: [], cpu: [] },
      };
      const allowlist = {
        entries: [
          {
            ...entryBase,
            path: 'node_modules/fixture-degradable',
            name: 'fixture-degradable',
            hooks: [{ name: 'install', command: 'node scripts/fail.mjs' }],
            // node-pty-smoke marks the one entry whose failure degrades the
            // terminal capability instead of aborting the install.
            artifact: { path: 'missing.node', proof: 'node-pty-smoke' },
          },
          {
            ...entryBase,
            path: 'node_modules/fixture-survivor',
            name: 'fixture-survivor',
            hooks: [{ name: 'install', command: 'node scripts/ok.mjs' }],
            artifact: { path: 'built.marker', proof: 'fixture' },
          },
        ],
      };
      runApprovedHooks(allowlist, { cwd: fixtureRoot });
      // The failure was loud and specific…
      const degradedLine = warn.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('DEGRADED terminal'));
      expect(degradedLine).toBeDefined();
      expect(degradedLine).toContain('terminal panes will be unavailable');
      expect(degradedLine).toContain('npm run dependencies:install');
      // …and did not abort the entries behind it.
      expect(existsSync(resolve(survivorRoot, 'built.marker'))).toBe(true);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('a non-degradable hook failure still aborts the install (#1244)', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const packageRoot = resolve(
        fixtureRoot,
        'node_modules',
        'fixture-required',
      );
      mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
      writeFileSync(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'fixture-required',
          version: '1.0.0',
          scripts: { install: 'node scripts/fail.mjs' },
        }),
      );
      writeFileSync(
        resolve(packageRoot, 'scripts', 'fail.mjs'),
        'process.exit(1);',
      );
      const allowlist = {
        entries: [
          {
            scope: 'root',
            lock: 'package-lock.json',
            path: 'node_modules/fixture-required',
            name: 'fixture-required',
            version: '1.0.0',
            decision: 'execute',
            platform: { os: [], cpu: [] },
            hooks: [{ name: 'install', command: 'node scripts/fail.mjs' }],
            artifact: { path: 'built.marker', proof: 'fixture' },
          },
        ],
      };
      expect(() => runApprovedHooks(allowlist, { cwd: fixtureRoot })).toThrow();
    } finally {
      log.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('verifies degradable artifacts as loud degraded results while others fail closed (#1244)', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const packageRoot = resolve(fixtureRoot, 'node_modules', 'node-pty');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
      );
      // `optionalPackageMayBeAbsent` reads every lifecycle lock from cwd.
      const emptyLock = JSON.stringify({ packages: {} });
      writeFileSync(resolve(fixtureRoot, 'package-lock.json'), emptyLock);
      for (const scoped of ['sdk', 'shared']) {
        mkdirSync(resolve(fixtureRoot, 'packages', scoped), {
          recursive: true,
        });
        writeFileSync(
          resolve(fixtureRoot, 'packages', scoped, 'package-lock.json'),
          emptyLock,
        );
      }
      const degradableEntry = {
        scope: 'root',
        lock: 'package-lock.json',
        path: 'node_modules/node-pty',
        name: 'node-pty',
        version: '1.1.0',
        platform: { os: [], cpu: [] },
        artifact: { path: 'build/Release/pty.node', proof: 'node-pty-smoke' },
      };
      const results = verifyLifecycleArtifacts(
        { entries: [degradableEntry] },
        { cwd: fixtureRoot },
      );
      expect(results).toEqual([
        expect.objectContaining({ degraded: true, skipped: false }),
      ]);
      expect(
        warn.mock.calls
          .map((call) => String(call[0]))
          .some((line) => line.includes('DEGRADED terminal')),
      ).toBe(true);

      // The same missing artifact on a NON-degradable entry still fails closed.
      const requiredEntry = {
        ...degradableEntry,
        artifact: { path: 'build/Release/pty.node', proof: 'fixture' },
      };
      expect(() =>
        verifyLifecycleArtifacts(
          { entries: [requiredEntry] },
          { cwd: fixtureRoot },
        ),
      ).toThrow(/missing lifecycle artifact/);
    } finally {
      warn.mockRestore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // Review finding `dependency-lifecycle-fail-open` on #1257. Being the
  // terminal-backing entry buys a pass on "was never built" and nothing else.
  // verifyArtifact also rejects redirected paths, escapes, version drift and a
  // failed PTY handshake; degrading those would accept a TAMPERED native
  // module as merely unavailable, which inverts the gate.
  it.skipIf(process.platform === 'win32')(
    'aborts on a redirected degradable artifact instead of degrading it (#1257)',
    () => {
      const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const packageRoot = resolve(fixtureRoot, 'node_modules', 'node-pty');
        mkdirSync(resolve(packageRoot, 'build/Release'), { recursive: true });
        writeFileSync(
          resolve(packageRoot, 'package.json'),
          JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
        );
        const emptyLock = JSON.stringify({ packages: {} });
        writeFileSync(resolve(fixtureRoot, 'package-lock.json'), emptyLock);
        for (const scoped of ['sdk', 'shared']) {
          mkdirSync(resolve(fixtureRoot, 'packages', scoped), {
            recursive: true,
          });
          writeFileSync(
            resolve(fixtureRoot, 'packages', scoped, 'package-lock.json'),
            emptyLock,
          );
        }
        // Present, but redirected out of the package — a trust-boundary
        // failure, not an absent artifact.
        const outside = resolve(fixtureRoot, 'outside.node');
        writeFileSync(outside, 'planted');
        symlinkSync(outside, resolve(packageRoot, 'build/Release/pty.node'));

        const degradableEntry = {
          scope: 'root',
          lock: 'package-lock.json',
          path: 'node_modules/node-pty',
          name: 'node-pty',
          version: '1.1.0',
          platform: { os: [], cpu: [] },
          artifact: { path: 'build/Release/pty.node', proof: 'node-pty-smoke' },
        };

        expect(() =>
          verifyLifecycleArtifacts(
            { entries: [degradableEntry] },
            { cwd: fixtureRoot },
          ),
        ).toThrow(/redirected by a symlink/);
        expect(
          warn.mock.calls
            .map((call) => String(call[0]))
            .some((line) => line.includes('DEGRADED')),
        ).toBe(false);
      } finally {
        warn.mockRestore();
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  describe('node-pty Linux prebuild staging (#1245)', () => {
    const ptyEntry = () =>
      policy.entries.find((item: any) => item.name === 'node-pty');

    function stagingFixture({ digest }: { digest?: string } = {}) {
      const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-prebuilds-'));
      const packageRoot = resolve(fixtureRoot, 'node_modules', 'node-pty');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
      );
      const artifactDir = resolve(
        fixtureRoot,
        'packaging/node-pty-prebuilds/linux-arm64',
      );
      mkdirSync(artifactDir, { recursive: true });
      const artifact = Buffer.from('not a real addon, digest is what matters');
      writeFileSync(resolve(artifactDir, 'pty.node'), artifact);
      const sha256 =
        digest ?? createHash('sha256').update(artifact).digest('hex');
      writeFileSync(
        resolve(fixtureRoot, 'packaging/node-pty-prebuilds/manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          package: 'node-pty',
          version: '1.1.0',
          artifacts: { 'linux-arm64': { sha256 } },
        }),
      );
      return { fixtureRoot, packageRoot };
    }

    it('stages the pinned artifact into the package prebuilds directory', () => {
      const { fixtureRoot, packageRoot } = stagingFixture();
      try {
        const result = stageNodePtyPrebuild(fixtureRoot, ptyEntry(), {
          platform: 'linux',
          arch: 'arm64',
          env: {},
        });
        expect(result.staged).toBe(true);
        expect(
          existsSync(resolve(packageRoot, 'prebuilds/linux-arm64/pty.node')),
        ).toBe(true);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('aborts on a digest mismatch instead of staging a tampered artifact', () => {
      const { fixtureRoot, packageRoot } = stagingFixture({
        digest: 'a'.repeat(64),
      });
      try {
        expect(() =>
          stageNodePtyPrebuild(fixtureRoot, ptyEntry(), {
            platform: 'linux',
            arch: 'arm64',
            env: {},
          }),
        ).toThrow(/digest mismatch/);
        expect(
          existsSync(resolve(packageRoot, 'prebuilds/linux-arm64/pty.node')),
        ).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('keeps the compile path for source-build opt-out, non-linux, and unpinned targets', () => {
      const { fixtureRoot } = stagingFixture();
      try {
        expect(
          stageNodePtyPrebuild(fixtureRoot, ptyEntry(), {
            platform: 'linux',
            arch: 'arm64',
            env: { npm_config_build_from_source: 'true' },
          }).staged,
        ).toBe(false);
        expect(
          stageNodePtyPrebuild(fixtureRoot, ptyEntry(), {
            platform: 'darwin',
            arch: 'arm64',
            env: {},
          }).staged,
        ).toBe(false);
        expect(
          stageNodePtyPrebuild(fixtureRoot, ptyEntry(), {
            platform: 'linux',
            arch: 'x64',
            env: {},
          }).staged,
        ).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    });

    it('requires the manifest and the allowlist to flip together', () => {
      // The committed state must be consistent…
      expect(() =>
        assertNodePtyPrebuildConsistency(
          policy,
          readNodePtyPrebuildManifest(root),
        ),
      ).not.toThrow();
      // …a pinned artifact without the allowlist flip fails…
      expect(() =>
        assertNodePtyPrebuildConsistency(policy, {
          schemaVersion: 1,
          package: 'node-pty',
          version: '1.1.0',
          artifacts: { 'linux-arm64': { sha256: 'a'.repeat(64) } },
        }),
      ).toThrow(/disagree for linux-arm64/);
      // …and an allowlist flip without a pinned artifact fails too.
      const flipped = structuredClone(policy);
      flipped.entries.find(
        (item: any) => item.name === 'node-pty',
      ).artifact.platforms['linux/arm64'] = ['prebuilds/linux-arm64/pty.node'];
      expect(() =>
        assertNodePtyPrebuildConsistency(
          flipped,
          readNodePtyPrebuildManifest(root),
        ),
      ).toThrow(/disagree for linux-arm64/);
      // A version drift between manifest and approved entry fails.
      expect(() =>
        assertNodePtyPrebuildConsistency(
          (() => {
            const consistent = structuredClone(policy);
            consistent.entries.find(
              (item: any) => item.name === 'node-pty',
            ).artifact.platforms['linux/arm64'] = [
              'prebuilds/linux-arm64/pty.node',
            ];
            return consistent;
          })(),
          {
            schemaVersion: 1,
            package: 'node-pty',
            version: '1.0.0',
            artifacts: { 'linux-arm64': { sha256: 'a'.repeat(64) } },
          },
        ),
      ).toThrow(/pins version 1.0.0/);
    });
  });

  // POSIX-only: the assertion is about a real execute bit surviving in the
  // filesystem's mode. Windows has no per-file execute permission — Node's
  // `chmodSync` only toggles the read-only attribute and `statSync().mode`
  // reports a synthesised 0o666/0o444, so `mode & 0o111` is 0 both before and
  // after `prepareLifecycleArtifacts`. The production call still runs here (the
  // fixture passes darwin/arm64 explicitly, so the win32 early-return does not
  // apply); it is only the observable bit that Windows cannot represent.
  it.skipIf(process.platform === 'win32')(
    'restores only the approved node-pty spawn-helper execute bit',
    () => {
      const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
      try {
        const packageRoot = resolve(fixtureRoot, 'node_modules', 'node-pty');
        const helper = resolve(
          packageRoot,
          'prebuilds/darwin-arm64/spawn-helper',
        );
        mkdirSync(resolve(helper, '..'), { recursive: true });
        writeFileSync(
          resolve(packageRoot, 'package.json'),
          JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
        );
        writeFileSync(helper, '#!/bin/sh\nexit 0\n');
        chmodSync(helper, 0o644);
        const entry = policy.entries.find(
          (item: any) => item.name === 'node-pty',
        );
        prepareLifecycleArtifacts(fixtureRoot, entry, 'darwin', 'arm64');
        expect(statSync(helper).mode & 0o111).not.toBe(0);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it('keeps the cold bootstrap validator dependency-free', () => {
    const source = readFileSync(
      resolve(root, 'scripts/lib/dependency-lifecycle-policy.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]ajv/);
  });

  it('fails an expired approval before lifecycle effects', () => {
    const expired = structuredClone(policy);
    expired.entries[0].reviewedAt = '2019-01-01';
    expired.entries[0].expiresAt = '2020-01-01';
    expect(
      evaluateLifecyclePolicy({ allowlist: expired, nodes }).join('\n'),
    ).toContain('approval has expired');
  });

  it('preflights every hook set and rejects a later package tamper', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    try {
      for (const lock of [
        'package-lock.json',
        'packages/sdk/package-lock.json',
        'packages/shared/package-lock.json',
      ]) {
        mkdirSync(resolve(fixtureRoot, lock, '..'), { recursive: true });
        writeFileSync(
          resolve(fixtureRoot, lock),
          JSON.stringify({ packages: {} }),
        );
      }
      const entries = ['first', 'later'].map((name) => ({
        scope: 'root',
        lock: 'package-lock.json',
        path: `node_modules/${name}`,
        name,
        version: '1.0.0',
        hooks: [{ name: 'install', command: 'node install.js' }],
        platform: { os: [], cpu: [] },
      }));
      for (const entry of entries) {
        const packageRoot = resolve(fixtureRoot, entry.path);
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(
          resolve(packageRoot, 'package.json'),
          JSON.stringify({
            name: entry.name,
            version: entry.version,
            scripts:
              entry.name === 'later'
                ? {
                    install: 'node install.js',
                    postinstall: 'node tampered.js',
                  }
                : { install: 'node install.js' },
          }),
        );
      }
      expect(() =>
        preflightInstalledLifecycle({ entries }, { cwd: fixtureRoot }),
      ).toThrow(/hook set drift.*later/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects same-checkout symlink borrowing instead of falling back by name', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    try {
      for (const lock of [
        'package-lock.json',
        'packages/sdk/package-lock.json',
        'packages/shared/package-lock.json',
      ]) {
        mkdirSync(resolve(fixtureRoot, lock, '..'), { recursive: true });
        writeFileSync(
          resolve(fixtureRoot, lock),
          JSON.stringify({ packages: {} }),
        );
      }
      mkdirSync(resolve(fixtureRoot, 'borrowed'), { recursive: true });
      writeFileSync(
        resolve(fixtureRoot, 'borrowed', 'package.json'),
        JSON.stringify({ name: 'same-name', version: '1.0.0', scripts: {} }),
      );
      mkdirSync(resolve(fixtureRoot, 'node_modules'), { recursive: true });
      symlinkSync(
        resolve(fixtureRoot, 'borrowed'),
        resolve(fixtureRoot, 'node_modules/same-name'),
      );
      const entry = {
        scope: 'root',
        lock: 'package-lock.json',
        path: 'node_modules/same-name',
        name: 'same-name',
        version: '1.0.0',
        hooks: [],
        platform: { os: [], cpu: [] },
      };
      expect(() =>
        preflightInstalledLifecycle({ entries: [entry] }, { cwd: fixtureRoot }),
      ).toThrow(/redirected by a symlink or junction/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects a redirected artifact before chmod can affect it', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    try {
      const packageRoot = resolve(fixtureRoot, 'node_modules', 'node-pty');
      const helper = resolve(fixtureRoot, 'outside-spawn-helper');
      mkdirSync(resolve(packageRoot, 'prebuilds/darwin-arm64'), {
        recursive: true,
      });
      writeFileSync(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
      );
      writeFileSync(helper, '#!/bin/sh\nexit 0\n');
      symlinkSync(
        helper,
        resolve(packageRoot, 'prebuilds/darwin-arm64/spawn-helper'),
      );
      const entry = policy.entries.find(
        (item: any) => item.name === 'node-pty',
      );
      expect(() =>
        prepareLifecycleArtifacts(fixtureRoot, entry, 'darwin', 'arm64'),
      ).toThrow(/redirected by a symlink or junction/);
      expect(statSync(helper).mode & 0o111).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects dangling redirected generated targets and ancestors', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-lifecycle-'));
    try {
      const packageRoot = resolve(fixtureRoot, 'node_modules', 'fixture');
      mkdirSync(packageRoot, { recursive: true });
      symlinkSync(
        resolve(fixtureRoot, 'missing-target'),
        resolve(packageRoot, 'generated.node'),
      );
      expect(() =>
        confinedPackageTarget(
          packageRoot,
          'generated.node',
          'generated target',
          {
            mustExist: false,
          },
        ),
      ).toThrow(/redirected by a symlink or junction/);
      mkdirSync(resolve(packageRoot, 'generated'), { recursive: true });
      symlinkSync(
        resolve(fixtureRoot, 'missing-ancestor'),
        resolve(packageRoot, 'generated', 'nested'),
      );
      expect(() =>
        confinedPackageTarget(
          packageRoot,
          'generated/nested/target.node',
          'generated ancestor',
          { mustExist: false },
        ),
      ).toThrow(/redirected by a symlink or junction/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('refuses Windows npm command shims and resolves npm through node', () => {
    expect(() => resolveNpmCli({ npm_execpath: 'C:\\npm.cmd' })).toThrow(
      /npm_execpath/,
    );
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'station-npm-cli-'));
    try {
      const node = resolve(fixtureRoot, 'node.exe');
      const npmCli = resolve(fixtureRoot, 'node_modules/npm/bin/npm-cli.js');
      mkdirSync(resolve(npmCli, '..'), { recursive: true });
      writeFileSync(node, 'node');
      writeFileSync(npmCli, 'console.log("npm")');
      expect(resolveNpmCli({}, node)).toBe(npmCli);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('gives Windows inert installs a bounded extended cache-miss deadline', () => {
    expect(inertInstallTimeout('darwin', {})).toBe(600_000);
    expect(inertInstallTimeout('linux', {})).toBe(600_000);
    expect(inertInstallTimeout('win32', {})).toBe(1_200_000);
  });

  it('lets a slow host raise the inert install deadline without losing it', () => {
    const env = { [INERT_INSTALL_TIMEOUT_ENV]: '1800000' };
    expect(inertInstallTimeout('linux', env)).toBe(1_800_000);
    expect(inertInstallTimeout('win32', env)).toBe(1_800_000);
  });

  it('ignores an unset or empty override rather than treating it as zero', () => {
    expect(inertInstallTimeout('linux', {})).toBe(600_000);
    expect(
      inertInstallTimeout('linux', { [INERT_INSTALL_TIMEOUT_ENV]: '' }),
    ).toBe(600_000);
  });

  it('refuses a malformed override instead of silently restoring the default', () => {
    for (const value of ['0', '-1', 'soon', '1.5', 'Infinity']) {
      expect(() =>
        inertInstallTimeout('linux', { [INERT_INSTALL_TIMEOUT_ENV]: value }),
      ).toThrow(INERT_INSTALL_TIMEOUT_ENV);
    }
  });

  shellLauncherTest(
    'delegates cold launcher bootstrap to the lifecycle runner and preserves symlink, cwd, and arguments',
    () => {
      const fixture = launcherFixture();
      try {
        const result = runLauncher(fixture, ['doctor', '--base=with spaces']);
        expect(result.status, result.stderr).toBe(0);
        const checkout = realpathSync(fixture.checkout);
        const caller = realpathSync(fixture.caller);
        expect(readFileSync(fixture.log, 'utf8').trim().split('\n')).toEqual([
          `npm|${caller}|<run>|<--prefix>|<${checkout}>|<dependencies:ci>`,
          `npm|${caller}|<run>|<--prefix>|<${checkout}>|<install:playwright>`,
          `npx|${checkout}|${caller}|4|<tsx>|<${checkout}/scripts/station-cli.ts>|<doctor>|<--base=with spaces>`,
        ]);
      } finally {
        rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  shellLauncherTest(
    'halts launcher startup when the lifecycle supervisor fails',
    () => {
      const fixture = launcherFixture();
      try {
        const result = runLauncher(fixture, ['doctor'], {
          STATION_TEST_NPM_FAIL: '1',
        });
        expect(result.status).toBe(71);
        expect(readFileSync(fixture.log, 'utf8')).toContain('dependencies:ci');
        expect(readFileSync(fixture.log, 'utf8')).not.toContain(
          'install:playwright',
        );
        expect(readFileSync(fixture.log, 'utf8')).not.toContain('npx|');
      } finally {
        rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  shellLauncherTest(
    'skips lifecycle bootstrap for a warm launcher checkout and fails closed without a lockfile',
    () => {
      const warm = launcherFixture({ warm: true });
      const missingLock = launcherFixture({ lockfile: false });
      try {
        const warmResult = runLauncher(warm, ['doctor']);
        expect(warmResult.status, warmResult.stderr).toBe(0);
        expect(readFileSync(warm.log, 'utf8')).not.toContain('npm|');
        const missingLockResult = runLauncher(missingLock, ['doctor']);
        expect(missingLockResult.status).toBe(1);
        expect(missingLockResult.stderr).toContain(
          'dependency lockfile is missing',
        );
      } finally {
        rmSync(warm.fixtureRoot, { recursive: true, force: true });
        rmSync(missingLock.fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  shellLauncherTest(
    'halts before bootstrap when Node runtime validation fails',
    () => {
      const fixture = launcherFixture({ runtimeFailure: true });
      try {
        const result = runLauncher(fixture);
        expect(result.status).toBe(42);
        expect(existsSync(fixture.log)).toBe(false);
      } finally {
        rmSync(fixture.fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it('verifies nearest installed workspace dependencies rather than a root inventory', () => {
    const nested = workspaceDependencyFixture({
      dependencies: { datum: '0.8.0' },
      rootPackages: { datum: { name: 'datum', version: '0.7.0' } },
      workspacePackages: { datum: { name: 'datum', version: '0.8.0' } },
    });
    const hoisted = workspaceDependencyFixture({
      dependencies: { datum: '^0.8.0' },
      rootPackages: { datum: { name: 'datum', version: '0.8.4' } },
    });
    const brokenNearest = workspaceDependencyFixture({
      dependencies: { datum: '0.8.0' },
      rootPackages: { datum: { name: 'datum', version: '0.7.0' } },
    });
    try {
      expect(
        findWorkspaceDependencyProblems({ root: nested.fixtureRoot }),
      ).toEqual([]);
      expect(
        findWorkspaceDependencyProblems({ root: hoisted.fixtureRoot }),
      ).toEqual([]);
      expect(
        findWorkspaceDependencyProblems({ root: brokenNearest.fixtureRoot }),
      ).toEqual([
        'packages/fixture → datum: installed 0.7.0 at node_modules/datum/package.json does not satisfy declared 0.8.0',
      ]);
    } finally {
      for (const fixture of [nested, hoisted, brokenNearest])
        rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails required missing packages but permits npm optional absence', () => {
    const required = workspaceDependencyFixture({
      dependencies: { missing: '^1.0.0' },
    });
    const optional = workspaceDependencyFixture({
      optionalDependencies: { optional: '^1.0.0' },
    });
    const optionalMismatch = workspaceDependencyFixture({
      optionalDependencies: { optional: '^1.0.0' },
      rootPackages: { optional: { name: 'optional', version: '2.0.0' } },
    });
    try {
      expect(
        findWorkspaceDependencyProblems({ root: required.fixtureRoot }),
      ).toEqual(['packages/fixture → missing: missing (declared ^1.0.0)']);
      expect(
        findWorkspaceDependencyProblems({ root: optional.fixtureRoot }),
      ).toEqual([]);
      expect(
        findWorkspaceDependencyProblems({ root: optionalMismatch.fixtureRoot }),
      ).toEqual([
        'packages/fixture → optional: installed 2.0.0 at node_modules/optional/package.json does not satisfy declared ^1.0.0',
      ]);
    } finally {
      for (const fixture of [required, optional, optionalMismatch])
        rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('reads scoped and exports-blocked package manifests by installation path', () => {
    const fixture = workspaceDependencyFixture({
      dependencies: { '@scope/exports-blocked': '~1.2.0' },
      rootPackages: {
        '@scope/exports-blocked': {
          name: '@scope/exports-blocked',
          version: '1.2.9',
          exports: './index.js',
        },
      },
    });
    try {
      expect(
        findWorkspaceDependencyProblems({ root: fixture.fixtureRoot }),
      ).toEqual([]);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('explicitly classifies local and remote npm protocols while requiring installation', () => {
    expect(classifyDependencySpec('workspace:*')).toMatchObject({
      kind: 'local-protocol',
    });
    expect(classifyDependencySpec('file:../local')).toMatchObject({
      kind: 'local-protocol',
    });
    expect(
      classifyDependencySpec('git+https://example.test/repo.git'),
    ).toMatchObject({
      kind: 'remote-protocol',
    });
    expect(classifyDependencySpec('npm:real-package@^1.0.0')).toMatchObject({
      kind: 'npm-alias',
      targetName: 'real-package',
      targetSpec: '^1.0.0',
    });
    const fixture = workspaceDependencyFixture({
      dependencies: {
        local: 'workspace:*',
        linked: 'file:../linked',
        aliased: 'npm:real-package@^1.0.0',
      },
      rootPackages: {
        local: { name: 'local', version: '9.9.9' },
        linked: { name: 'linked', version: '1.0.0' },
        aliased: { name: 'real-package', version: '1.2.0' },
      },
    });
    try {
      expect(
        findWorkspaceDependencyProblems({ root: fixture.fixtureRoot }),
      ).toEqual([]);
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects raw workflow bypasses while permitting the runner', () => {
    expect(REPOSITORY_LIFECYCLE_SOURCES).toContain('station');
    expect(checkWorkflowDirectory()).toEqual([]);
    expect(
      collectRawNpmLifecycleBypasses('run: npm run dependencies:ci'),
    ).toEqual([]);
    expect(collectRawNpmLifecycleBypasses('run: npm ci')).toEqual(
      expect.arrayContaining([expect.stringContaining('raw npm ci')]),
    );
    expect(collectRawNpmLifecycleBypasses('run: npm install evil')).toEqual(
      expect.arrayContaining([expect.stringContaining('raw npm install')]),
    );
    expect(
      collectRawNpmLifecycleBypasses('run: npm --ignore-scripts=false ci'),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must not re-enable lifecycle scripts'),
      ]),
    );
    expect(collectRawNpmLifecycleBypasses('run: npm i evil')).toEqual(
      expect.arrayContaining([expect.stringContaining('raw npm install')]),
    );
    for (const bypass of [
      'run: npm rebuild --ignore-scripts=false',
      'run: npm --prefix . ci --ignore-scripts=false',
      'run: npm --loglevel error ci --ignore-scripts=false',
      'run: npm add left-pad --ignore-scripts=false',
      'run: "npm ci"',
      '"bootstrap": "npm ci",',
      'run: "npm rebuild --ignore-scripts=\'false\'"',
      'env:\n  NPM_CONFIG_IGNORE_SCRIPTS: false\nrun: npm rebuild',
      'env:\n  NPM_CONFIG_IGNORE_SCRIPTS: "false"\nrun: npm rebuild',
    ])
      expect(collectRawNpmLifecycleBypasses(bypass)).not.toEqual([]);
    const actions = [
      'steps:',
      '  - run: "npm ci"',
      "  - run: 'npm add left-pad'",
      '  - run: |',
      '      npm rebuild --ignore-scripts=false',
    ].join('\n');
    expect(collectRawNpmLifecycleBypasses(actions)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('raw npm ci'),
        expect.stringContaining('raw npm install'),
        expect.stringContaining('raw npm rebuild'),
      ]),
    );
  });
});
