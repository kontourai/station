import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pnpmInvocation,
  preflightInstalledLifecycle,
} from '../dependency-lifecycle.mjs';
import {
  evaluateLifecyclePolicy,
  readPnpmLifecycleNodes,
} from '../lib/dependency-lifecycle-policy.mjs';
import { readPnpmLockfile, readPnpmWorkspace } from '../lib/pnpm-lockfile.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const policy = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../config/dependency-lifecycle-allowlist.json',
    ),
    'utf8',
  ),
);

function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-pnpm-lifecycle-')),
  );
  temporary.push(root);
  const entry = {
    ...policy.entries.find(
      (entry: { name: string; version: string }) =>
        entry.name === 'esbuild' && entry.version === '0.28.1',
    ),
    lock: 'pnpm-lock.yaml',
  };
  const allowlist = { schemaVersion: 1, entries: [entry] };
  const lock = {
    lockfileVersion: '9.0',
    importers: { '.': {} },
    packages: {
      [`${entry.name}@${entry.version}`]: {
        resolution: { integrity: entry.integrity },
      },
    },
  };
  mkdirSync(join(root, 'config'));
  writeFileSync(
    join(root, 'config/dependency-lifecycle-allowlist.json'),
    JSON.stringify(allowlist),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
  const packageRoot = join(root, entry.path);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: entry.name,
      version: entry.version,
      scripts: { postinstall: 'node install.js' },
    }),
  );
  return { root, entry, allowlist, lock, packageRoot };
}

describe('pnpm lifecycle boundary', () => {
  it('bootstraps an uncached Corepack pin without allowing network access during discovery', () => {
    const { root } = fixture();
    const corepack = join(root, 'corepack');
    mkdirSync(join(corepack, 'dist'), { recursive: true });
    const cli = join(corepack, 'dist/pnpm.js');
    writeFileSync(cli, '');
    writeFileSync(
      join(corepack, 'package.json'),
      JSON.stringify({ name: 'corepack', version: '0.1.0' }),
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.25.0' }),
    );
    const invocation = pnpmInvocation({
      cwd: root,
      env: { npm_execpath: cli },
      exec: () => {
        throw new Error(
          "Network access disabled by the environment; can't reach registry",
        );
      },
    });
    expect(invocation.args).toContain('--package=pnpm@11.25.0');
    expect(() =>
      pnpmInvocation({
        cwd: root,
        env: { npm_execpath: cli },
        exec: () => '11.24.0',
      }),
    ).toThrow('does not match');
  });
  it('reuses an exact-version native executable on PATH without a Windows command shell', () => {
    const { root } = fixture();
    const bin = join(root, 'native bin');
    mkdirSync(bin);
    const executable = join(bin, 'pnpm.exe');
    writeFileSync(executable, 'native executable fixture');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.25.0' }),
    );
    const probes: unknown[] = [];
    expect(
      pnpmInvocation({
        cwd: root,
        env: { PATH: bin },
        platform: 'win32',
        exec: (command, args, options) => {
          probes.push({ command, args, options });
          return '11.25.0\n';
        },
      }),
    ).toEqual({ command: executable, args: [] });
    expect(probes).toEqual([
      {
        command: executable,
        args: ['--version'],
        options: {
          cwd: root,
          env: { PATH: bin, COREPACK_ENABLE_NETWORK: '0' },
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        },
      },
    ]);
    expect(() =>
      pnpmInvocation({
        cwd: root,
        env: { PATH: bin },
        platform: 'win32',
        exec: () => '11.24.0\n',
      }),
    ).toThrow('does not match');
  });
  it('accepts a local-only pnpm lock without package snapshots but refuses absent registry metadata', () => {
    const { root } = fixture();
    const lock = {
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            local: { specifier: 'workspace:*', version: 'link:packages/local' },
          },
        },
      },
    };
    writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
    expect(readPnpmLockfile(root).packages).toEqual({});
    lock.importers['.'].dependencies.local.version = '1.0.0';
    writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
    expect(() => readPnpmLockfile(root)).toThrow('unsupported packages');
  });
  it('reuses an invoking pnpm only when its package identity matches the exact pin', () => {
    const { root } = fixture();
    const pnpmRoot = join(root, 'tooling/pnpm');
    mkdirSync(join(pnpmRoot, 'bin'), { recursive: true });
    const pnpmCli = join(pnpmRoot, 'bin/pnpm.cjs');
    writeFileSync(pnpmCli, 'console.log("11.25.0");');
    writeFileSync(
      join(pnpmRoot, 'package.json'),
      JSON.stringify({ name: 'pnpm', version: '11.25.0' }),
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.25.0' }),
    );
    expect(
      pnpmInvocation({ cwd: root, env: { npm_execpath: pnpmCli } }),
    ).toEqual({ command: process.execPath, args: [pnpmCli] });
    writeFileSync(
      join(pnpmRoot, 'package.json'),
      JSON.stringify({ name: 'pnpm', version: '11.24.0' }),
    );
    expect(() =>
      pnpmInvocation({ cwd: root, env: { npm_execpath: pnpmCli } }),
    ).toThrow('does not match');
  });
  it('excludes Station-owned root lifecycle commands from dependency inventory', () => {
    const { root } = fixture();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'station',
        scripts: { install: 'node station-owned.js' },
      }),
    );
    expect(readPnpmLifecycleNodes(root).map((entry) => entry.name)).toEqual([
      'esbuild',
    ]);
  });
  it('binds a physical installed lifecycle package to pnpm integrity and its exact reviewed hooks', () => {
    const { root, allowlist } = fixture();
    expect(
      evaluateLifecyclePolicy({
        allowlist,
        nodes: readPnpmLifecycleNodes(root),
      }),
    ).toEqual([]);
    expect(preflightInstalledLifecycle(allowlist, { cwd: root })).toHaveLength(
      1,
    );
  });

  it('discovers a previously unapproved hook before any hook can run', () => {
    const { root, allowlist, lock } = fixture();
    const unexpected = join(root, 'node_modules/unexpected');
    mkdirSync(unexpected);
    writeFileSync(
      join(unexpected, 'package.json'),
      JSON.stringify({
        name: 'unexpected',
        version: '1.0.0',
        scripts: { install: 'node malicious.js' },
      }),
    );
    Object.assign(lock.packages, {
      'unexpected@1.0.0': {
        resolution: { integrity: allowlist.entries[0].integrity },
      },
    });
    writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify(lock));
    expect(
      evaluateLifecyclePolicy({
        allowlist,
        nodes: readPnpmLifecycleNodes(root),
      }),
    ).toContain(
      'unapproved install script: pnpm-lock.yaml:node_modules/unexpected',
    );
  });

  it('rejects installed identities missing from the pnpm lock', () => {
    const { root, packageRoot } = fixture();
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'esbuild',
        version: '99.0.0',
        scripts: { install: 'node install.js' },
      }),
    );
    expect(() => readPnpmLifecycleNodes(root)).toThrow('not integrity-locked');
  });

  it('rejects changed hooks even when package identity and integrity remain approved', () => {
    const { root, allowlist, packageRoot, entry } = fixture();
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: entry.name,
        version: entry.version,
        scripts: { postinstall: 'node replacement.js' },
      }),
    );
    expect(() => preflightInstalledLifecycle(allowlist, { cwd: root })).toThrow(
      'hook set drift',
    );
  });

  it('refuses dependency links outside the worktree instead of scanning or mutating another tree', () => {
    const { root } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'station-pnpm-outside-'));
    temporary.push(outside);
    symlinkSync(
      outside,
      join(root, 'node_modules/escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => readPnpmLifecycleNodes(root)).toThrow(
      'redirected by a symlink or junction',
    );
  });

  it('rejects duplicate YAML keys and unsupported lock formats', () => {
    const { root } = fixture();
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nlockfileVersion: '8.0'\nimporters: {}\npackages: {}\n",
    );
    expect(() => readPnpmLockfile(root)).toThrow('invalid');
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      "lockfileVersion: '8.0'\nimporters: {}\npackages: {}\n",
    );
    expect(() => readPnpmLockfile(root)).toThrow('unsupported');
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages: [packages/*]\n',
    );
    expect(readPnpmWorkspace(root).packages).toEqual(['packages/*']);
  });

  it('bootstraps only an exact pnpm 11 pin as inert argv through the Node-distributed npm CLI', () => {
    const { root } = fixture();
    const npmCli = join(root, 'npm-cli.js');
    writeFileSync(npmCli, '');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.25.0' }),
    );
    expect(
      pnpmInvocation({
        cwd: root,
        env: { npm_execpath: npmCli },
        node: process.execPath,
      }),
    ).toEqual({
      command: process.execPath,
      args: [npmCli, 'exec', '--yes', '--package=pnpm@11.25.0', '--', 'pnpm'],
    });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@latest' }),
    );
    expect(() => pnpmInvocation({ cwd: root })).toThrow('exact pnpm 11');
  });
});
