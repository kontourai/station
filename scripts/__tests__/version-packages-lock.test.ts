import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { pnpmInvocation, resolveNpmCli } from '../dependency-lifecycle.mjs';

const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runGate(root: string) {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'lockfile-sync-gate.mjs')],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

test('managed version pipeline repairs stale pnpm locks offline without pnpm on PATH', () => {
  const sourceManifest = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  );
  const rootScript = sourceManifest.scripts['version-packages'];
  expect(rootScript).toBe(
    'changeset version && npm run dependencies:lock && npm run dependencies:check && npm run lockfile-sync:gate',
  );
  expect(
    readFileSync(
      join(process.cwd(), '.github/workflows/publish-packages.yml'),
      'utf8',
    ),
  ).toMatch(/^\s*version-script: npm run version-packages$/m);

  const root = mkdtempSync(join(tmpdir(), 'station-release-lock-'));
  dirs.push(root);
  mkdirSync(join(root, 'packages', 'a'), { recursive: true });
  mkdirSync(join(root, 'packages', 'b'), { recursive: true });
  const packageManager = sourceManifest.packageManager;
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages: [packages/a, packages/b]\nlinkWorkspacePackages: true\nstrictPeerDependencies: true\nstoreDir: ${JSON.stringify(join(root, 'store'))}\n`,
  );
  const npmCli = resolveNpmCli();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(bin, 'node.exe'));
    writeFileSync(
      join(bin, 'npm.cmd'),
      `@"${process.execPath}" "${npmCli}" %*\r\n`,
    );
  } else {
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync(npmCli, join(bin, 'npm'));
  }
  const systemBin =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [bin, systemBin].filter(Boolean).join(delimiter),
    CI: 'true',
    npm_config_offline: 'true',
    npm_config_script_shell:
      process.platform === 'win32'
        ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
        : '/bin/sh',
    npm_execpath: npmCli,
  };
  // Windows environment keys are case-insensitive; remove the original Path
  // spelling so child_process cannot choose it over the isolated PATH.
  for (const key of Object.keys(env))
    if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
  const absentPnpm = spawnSync('pnpm', ['--version'], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect((absentPnpm.error as NodeJS.ErrnoException | undefined)?.code).toBe(
    'ENOENT',
  );
  const sourceRunner = join(process.cwd(), 'scripts/dependency-lifecycle.mjs');
  const quotedRunner =
    process.platform === 'win32'
      ? `"${sourceRunner}"`
      : `'${sourceRunner.replaceAll("'", "'\\''")}'`;
  const scripts = {
    'dependencies:lock': sourceManifest.scripts['dependencies:lock'].replace(
      'scripts/dependency-lifecycle.mjs',
      quotedRunner,
    ),
  };
  const invocation = pnpmInvocation({ cwd: process.cwd(), env });
  const repairStep = rootScript.split(' && ')[1].split(' ');
  expect(repairStep.shift()).toBe('npm');
  const repair = () =>
    execFileSync(process.execPath, [npmCli, ...repairStep], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    packageManager,
    scripts,
    version: '1.0.0',
    private: true,
    workspaces: ['packages/a', 'packages/b'],
    dependencies: { 'fixture-a': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'a', 'package.json'), {
    name: 'fixture-a',
    version: '1.0.0',
    private: true,
    dependencies: { 'fixture-b': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'b', 'package.json'), {
    name: 'fixture-b',
    version: '1.0.0',
    private: true,
    devDependencies: { 'fixture-a': '^1.0.0' },
    peerDependencies: { 'fixture-a': '^1.0.0' },
  });

  // Make this test's one external precondition explicit (#1517).
  //
  // `repair()` below runs with `npm_config_offline`, and the repair step is
  // `npm exec --package=<packageManager>`, so pnpm must ALREADY be in npm's
  // cache. That used to hold for free: when the repo installed through npm,
  // ordinary setup ran `npm exec … pnpm` and warmed the cache as a side
  // effect. Since the pnpm migration, installs go through pnpm directly, so
  // nothing populates npm's cache and the offline exec has nothing to
  // resolve -- `ENOTCACHED`, deterministically, on every CI run.
  //
  // Warming here rather than in the workflow keeps the requirement visible to
  // the next reader of this file. It does not weaken what the test proves:
  // the subject is still `dependencies:lock` completing with no network, and
  // this step is setup, exactly as the old toolchain's accidental warming was.
  execFileSync(process.execPath, [npmCli, 'cache', 'add', packageManager], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    // Deliberately NOT `env`: that carries `npm_config_offline`, which would
    // make this step unable to do the one thing it exists to do.
    env: { ...process.env, CI: 'true' },
  });

  // No registry dependencies exist in this fixture; this creates its lock
  // entirely locally and proves the exact release repair stays network-free.
  repair();
  expect(runGate(root)).toContain('Lockfile sync gate:');

  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    packageManager,
    scripts,
    version: '1.0.0',
    private: true,
    workspaces: ['packages/a', 'packages/b'],
    dependencies: { 'fixture-a': '^1.0.1' },
  });
  writeJson(join(root, 'packages', 'a', 'package.json'), {
    name: 'fixture-a',
    version: '1.0.1',
    private: true,
    dependencies: { 'fixture-b': '^1.0.0' },
  });
  writeJson(join(root, 'packages', 'b', 'package.json'), {
    name: 'fixture-b',
    version: '1.0.0',
    private: true,
    devDependencies: { 'fixture-a': '^1.0.1' },
    peerDependencies: { 'fixture-a': '~1.0.1' },
  });

  let failure: { stderr?: string } | undefined;
  try {
    runGate(root);
  } catch (error) {
    failure = error as { stderr?: string };
  }
  expect(failure).toBeDefined();
  expect(failure?.stderr).toContain('. dependencies.fixture-a.specifier');
  expect(failure?.stderr).toContain('packages/b devDependencies.fixture-a');

  let frozenFailure: { stdout?: string } | undefined;
  try {
    execFileSync(
      invocation.command,
      [
        ...invocation.args,
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--offline',
        '--store-dir',
        join(root, 'store'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env,
      },
    );
  } catch (error) {
    frozenFailure = error as { stdout?: string };
  }
  expect(frozenFailure?.stdout).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
  repair();
  expect(runGate(root)).toContain('Lockfile sync gate:');
});

test('the real pnpm gate rejects competing root and workspace npm locks but permits standalone examples', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-competing-lock-'));
  dirs.push(root);
  const workspaces = ['packages/sdk', 'packages/shared'];
  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    packageManager: 'pnpm@11.25.0',
    workspaces,
  });
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages: ${JSON.stringify(workspaces)}\n`,
  );
  writeJson(join(root, 'pnpm-lock.yaml'), {
    lockfileVersion: '9.0',
    importers: { '.': {}, 'packages/sdk': {}, 'packages/shared': {} },
    packages: {},
    snapshots: {},
  });
  for (const workspace of workspaces) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeJson(join(root, workspace, 'package.json'), {
      name: workspace.replace('/', '-'),
      version: '1.0.0',
    });
  }
  mkdirSync(join(root, 'examples/standalone'), { recursive: true });
  writeJson(join(root, 'examples/standalone/package-lock.json'), {
    lockfileVersion: 3,
    packages: {},
  });
  expect(runGate(root)).toContain('Lockfile sync gate:');
  for (const workspace of ['.', ...workspaces]) {
    const path = join(root, workspace, 'package-lock.json');
    writeJson(path, { lockfileVersion: 3, packages: {} });
    let failure: { stderr?: string } | undefined;
    try {
      runGate(root);
    } catch (error) {
      failure = error as { stderr?: string };
    }
    expect(failure?.stderr).toContain(`${workspace} package-lock.json`);
    expect(failure?.stderr).toContain('competing npm lockfile');
    rmSync(path);
    expect(runGate(root)).toContain('Lockfile sync gate:');
  }
});
