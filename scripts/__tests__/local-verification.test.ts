import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectWorkspaceProvenance } from '../lib/test-reliability.mjs';
import {
  assertTrustedPath,
  discoverNodeCandidates,
  pinnedNodeEnvironment,
  probeNodeExecutable,
  resolveSupportedNode,
  resolveTrustedNpmCli,
} from '../run-local-verification.mjs';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function runFixtureGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result;
}

function readEffectiveFixtureGitConfig(
  cwd: string,
  key: string,
  env: NodeJS.ProcessEnv,
) {
  return runFixtureGit(cwd, ['config', '--get', key], env).stdout.trim();
}

function sanitizedGitEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (
      key === 'GIT_CONFIG_COUNT' ||
      key === 'GIT_CONFIG_PARAMETERS' ||
      key === 'GIT_CONFIG_GLOBAL' ||
      key === 'GIT_CONFIG_SYSTEM' ||
      key === 'GIT_CONFIG_NOSYSTEM' ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      delete environment[key];
    }
  }
  return { ...environment, ...overrides };
}

function createCommittedProvenanceSubject(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const repository = join(root, 'provenance-subject');
  const emptyHooksDirectory = join(root, 'empty-git-hooks');
  const isolatedGitConfig = [
    '-c',
    'commit.gpgSign=false',
    '-c',
    `core.hooksPath=${emptyHooksDirectory}`,
  ];
  mkdirSync(repository);
  mkdirSync(emptyHooksDirectory);
  writeFileSync(join(repository, 'subject.txt'), 'baseline\n');
  runFixtureGit(repository, [...isolatedGitConfig, 'init', '--quiet'], env);
  runFixtureGit(repository, [...isolatedGitConfig, 'add', 'subject.txt'], env);
  runFixtureGit(
    repository,
    [
      ...isolatedGitConfig,
      '-c',
      'user.name=Station test',
      '-c',
      'user.email=station-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ],
    env,
  );
  return repository;
}

describe('local verification Node pinning', () => {
  it('selects the supported executable and prepends its bin directory', () => {
    const root = mkdtempSync(join(process.cwd(), '.station-node-current-'));
    tempRoots.push(root);
    const trustedNode = join(root, 'bin', 'node');
    mkdirSync(dirname(trustedNode), { recursive: true });
    // The probe is deliberately mocked below, so this fixture only needs to
    // be a trusted executable path. Copying the full Node binary made this
    // unit test depend on host filesystem throughput and could exceed the
    // default timeout on a busy self-hosted runner.
    writeFileSync(trustedNode, '#!/bin/sh\n');
    chmodSync(trustedNode, 0o755);
    const runtime = resolveSupportedNode({
      currentExecutable: trustedNode,
      env: { ...process.env, STATION_NODE: undefined },
      probe: (executable: string) => ({
        execPath: executable,
        name: 'node',
        version: process.version,
      }),
    });
    const env = pinnedNodeEnvironment(runtime, {
      PATH: '/poisoned/bin',
      Node_Options: '--require=/untrusted/preload.cjs',
      node_path: '/untrusted/modules',
    });

    expect(runtime.version).toMatch(/^v24\./);
    expect(env.PATH?.split(delimiter)[0]).toBe(dirname(runtime.executable));
    expect(env.STATION_NODE).toBe(runtime.executable);
    expect(
      Object.keys(env).filter((key) =>
        ['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()),
      ),
    ).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'creates an isolated provenance subject despite hostile global Git signing and hooks',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-provenance-git-'));
      tempRoots.push(root);
      const hostileHooksDirectory = join(root, 'hostile-git-hooks');
      const hostileHookMarker = join(root, 'hostile-hook-ran');
      const hostileSigner = join(root, 'hostile-gpg');
      const hostileSignerMarker = join(root, 'hostile-signer-ran');
      const hostileGlobalConfig = join(root, 'hostile.gitconfig');
      mkdirSync(hostileHooksDirectory);
      writeFileSync(
        join(hostileHooksDirectory, 'pre-commit'),
        `#!/bin/sh\ntouch '${hostileHookMarker}'\nexit 1\n`,
      );
      chmodSync(join(hostileHooksDirectory, 'pre-commit'), 0o755);
      writeFileSync(
        hostileSigner,
        `#!/bin/sh\ntouch '${hostileSignerMarker}'\nexit 1\n`,
      );
      chmodSync(hostileSigner, 0o755);
      writeFileSync(
        hostileGlobalConfig,
        `[commit]\n\tgpgSign = true\n[core]\n\thooksPath = ${hostileHooksDirectory}\n[gpg]\n\tprogram = ${hostileSigner}\n`,
      );
      // Simulate inherited command-scope config that would mask the hostile
      // file unless the fixture's environment removes it first.
      const ambientConfigInjection = {
        ...process.env,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'commit.gpgSign',
        GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'core.hooksPath',
        GIT_CONFIG_VALUE_1: join(root, 'ambient-hooks'),
        GIT_CONFIG_PARAMETERS: "'commit.gpgSign=false'",
      };
      const hostileEnvironment = sanitizedGitEnvironment(
        ambientConfigInjection,
        {
          GIT_CONFIG_GLOBAL: hostileGlobalConfig,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      );
      expect(hostileEnvironment.GIT_CONFIG_COUNT).toBeUndefined();
      expect(hostileEnvironment.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(hostileEnvironment.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(hostileEnvironment.GIT_CONFIG_PARAMETERS).toBeUndefined();

      const provenanceSubject = createCommittedProvenanceSubject(
        root,
        hostileEnvironment,
      );

      expect(
        readEffectiveFixtureGitConfig(
          provenanceSubject,
          'commit.gpgSign',
          hostileEnvironment,
        ),
      ).toBe('true');
      expect(
        readEffectiveFixtureGitConfig(
          provenanceSubject,
          'core.hooksPath',
          hostileEnvironment,
        ),
      ).toBe(hostileHooksDirectory);
      expect(
        readEffectiveFixtureGitConfig(
          provenanceSubject,
          'gpg.program',
          hostileEnvironment,
        ),
      ).toBe(hostileSigner);
      expect(existsSync(hostileHookMarker)).toBe(false);
      expect(existsSync(hostileSignerMarker)).toBe(false);
      expect(collectWorkspaceProvenance({ cwd: provenanceSubject }).dirty).toBe(
        false,
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps parent and child processes on Node 24 with a poisoned PATH without entering workspace provenance',
    () => {
      // Keep mutable fixture state outside the Git worktree and under the
      // caller-owned home, whose ancestors satisfy the production executable
      // trust policy. Copying Node is load-bearing: a symlink resolves back to
      // GitHub's intentionally group/world-writable hosted toolcache and is
      // correctly rejected by assertTrustedPath.
      const root = mkdtempSync(join(homedir(), '.station-node-path-'));
      tempRoots.push(root);
      const provenanceSubject = createCommittedProvenanceSubject(root);
      const provenanceBeforeFixture = collectWorkspaceProvenance({
        cwd: provenanceSubject,
      });
      const poisonedBin = join(root, 'poisoned-bin');
      const trustedBin = join(root, 'trusted-bin');
      mkdirSync(poisonedBin);
      mkdirSync(trustedBin);
      const fakeNode = join(poisonedBin, 'node');
      const trustedNode = join(trustedBin, 'node');
      const helperMarker = join(poisonedBin, 'mise-ran');
      copyFileSync(process.execPath, trustedNode);
      chmodSync(trustedNode, 0o755);
      expect(assertTrustedPath(trustedNode)).toBe(realpathSync(trustedNode));
      const provenanceDuringFixture = collectWorkspaceProvenance({
        cwd: provenanceSubject,
      });
      expect(provenanceDuringFixture.workspaceDigest).toBe(
        provenanceBeforeFixture.workspaceDigest,
      );
      expect(provenanceDuringFixture.dirty).toBe(provenanceBeforeFixture.dirty);
      writeFileSync(fakeNode, '#!/bin/sh\necho poisoned-node-22\n');
      chmodSync(fakeNode, 0o755);
      writeFileSync(
        join(poisonedBin, 'mise'),
        `#!/bin/sh\ntouch '${helperMarker}'\nexit 1\n`,
      );
      chmodSync(join(poisonedBin, 'mise'), 0o755);

      const child = spawnSync(
        trustedNode,
        [
          'scripts/run-local-verification.mjs',
          '--',
          'node',
          '-e',
          'console.log(JSON.stringify({version:process.version,execPath:process.execPath,path:process.env.PATH,stationNode:process.env.STATION_NODE}))',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${poisonedBin}${delimiter}${process.env.PATH}`,
            STATION_NODE: undefined,
          },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      const expectedRuntime = {
        executable: realpathSync(trustedNode),
        version: process.version,
      };
      expect(child.stdout).toContain(
        `[local-verification] Node ${expectedRuntime.version} at ${expectedRuntime.executable}`,
      );
      const report = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
      expect(report.version).toBe(expectedRuntime.version);
      expect(realpathSync(report.execPath)).toBe(expectedRuntime.executable);
      expect(report.path.split(delimiter)[0]).toBe(
        dirname(expectedRuntime.executable),
      );
      expect(report.stationNode).toBe(expectedRuntime.executable);
      expect(child.stdout).not.toContain('poisoned-node-22');
      expect(existsSync(helperMarker)).toBe(false);

      // A mutation inside the isolated Git subject must still affect its
      // provenance. This distinguishes fixture isolation from a no-op check.
      writeFileSync(join(provenanceSubject, 'subject.txt'), 'mutated\n');
      const provenanceAfterMutation = collectWorkspaceProvenance({
        cwd: provenanceSubject,
      });
      expect(provenanceAfterMutation.dirty).toBe(true);
      expect(provenanceAfterMutation.workspaceDigest).not.toBe(
        provenanceBeforeFixture.workspaceDigest,
      );
    },
  );

  it('fails once with the checked executable path and version', () => {
    const root = mkdtempSync(join(process.cwd(), '.station-node-version-'));
    tempRoots.push(root);
    const executable = join(root, 'node');
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o755);

    expect(() =>
      resolveSupportedNode({
        candidates: [executable],
        probe: () => ({
          execPath: executable,
          name: 'node',
          version: 'v26.2.0',
        }),
      }),
    ).toThrow(
      `no supported executable was found (checked v26.2.0 at ${realpathSync(executable)})`,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a group/world-writable runtime leaf',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-untrusted-node-'));
      tempRoots.push(root);
      const executable = join(root, 'node');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o777);

      expect(() => assertTrustedPath(executable, 'Node executable')).toThrow(
        'group/world-writable',
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects malformed or path-mismatched Node self-reports and bounds probes',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-node-probe-'));
      tempRoots.push(root);
      const malformed = join(root, 'malformed-node');
      const mismatched = join(root, 'mismatched-node');
      const slow = join(root, 'slow-node');
      writeFileSync(malformed, '#!/bin/sh\necho not-json\n');
      writeFileSync(
        mismatched,
        '#!/bin/sh\necho \'{"name":"node","version":"v24.0.0","execPath":"/does/not/exist"}\'\n',
      );
      const sleeper = existsSync('/bin/sleep')
        ? '/bin/sleep'
        : '/usr/bin/sleep';
      writeFileSync(slow, `#!/bin/sh\nexec '${sleeper}' 2\n`);
      for (const executable of [malformed, mismatched, slow]) {
        chmodSync(executable, 0o755);
      }

      expect(probeNodeExecutable(malformed)).toBeNull();
      expect(probeNodeExecutable(mismatched)).toBeNull();
      const startedAt = Date.now();
      expect(probeNodeExecutable(slow, process.env, 25)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );

  it('uses an already-supported current runtime before manager discovery', () => {
    const root = mkdtempSync(join(process.cwd(), '.station-node-lazy-'));
    tempRoots.push(root);
    const trustedNode = join(root, 'bin', 'node');
    mkdirSync(dirname(trustedNode), { recursive: true });
    copyFileSync(process.execPath, trustedNode);
    chmodSync(trustedNode, 0o755);
    const invalidManagerRoot = join(root, 'not-a-directory');
    writeFileSync(invalidManagerRoot, 'manager discovery should not open this');

    const runtime = resolveSupportedNode({
      currentExecutable: trustedNode,
      env: {
        ...process.env,
        MISE_DATA_DIR: invalidManagerRoot,
        STATION_NODE: undefined,
      },
      probe: (executable: string) => ({
        execPath: executable,
        name: 'node',
        version: process.version,
      }),
    });

    expect(runtime).toEqual({
      executable: realpathSync(trustedNode),
      version: process.version,
    });
  });

  it('discovers fixed Unix and Windows version-manager layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-node-roots-'));
    tempRoots.push(root);
    const unixNode = join(
      root,
      '.local/share/mise/installs/node/24.18.0/bin/node',
    );
    const localAppData = join(root, 'local-app-data');
    const windowsNode = join(
      localAppData,
      'mise/installs/node/24.18.0/node.exe',
    );
    const nvmHome = join(root, 'nvm-windows');
    const nvmWindowsNode = join(nvmHome, 'v24.18.0/node.exe');
    mkdirSync(dirname(unixNode), { recursive: true });
    mkdirSync(dirname(windowsNode), { recursive: true });
    mkdirSync(dirname(nvmWindowsNode), { recursive: true });
    writeFileSync(unixNode, '');
    writeFileSync(windowsNode, '');
    writeFileSync(nvmWindowsNode, '');

    expect(
      discoverNodeCandidates({
        currentExecutable: '/missing/node',
        env: {},
        home: root,
        platform: 'linux',
      }),
    ).toContain(unixNode);
    expect(
      discoverNodeCandidates({
        currentExecutable: 'C:\\missing\\node.exe',
        env: { LOCALAPPDATA: localAppData, NVM_HOME: nvmHome },
        home: join(root, 'empty-home'),
        platform: 'win32',
      }),
    ).toContain(windowsNode);
    expect(
      discoverNodeCandidates({
        currentExecutable: 'C:\\missing\\node.exe',
        env: { NVM_HOME: nvmHome },
        home: join(root, 'empty-home'),
        platform: 'win32',
      }),
    ).toContain(nvmWindowsNode);
  });

  it('keeps npm inside the trusted selected Node installation', () => {
    const root = mkdtempSync(join(process.cwd(), '.station-node-npm-'));
    tempRoots.push(root);
    const executable = join(root, 'bin', 'node');
    const expectedNpmCli =
      process.platform === 'win32'
        ? join(root, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(dirname(executable), { recursive: true });
    mkdirSync(dirname(expectedNpmCli), { recursive: true });
    writeFileSync(executable, 'synthetic trusted node fixture');
    writeFileSync(expectedNpmCli, 'synthetic npm CLI fixture');
    const runtime = { executable, version: 'v24.18.0' };
    const npmCli = resolveTrustedNpmCli(runtime);

    expect(npmCli).toBe(realpathSync(expectedNpmCli));
    expect(assertTrustedPath(npmCli, 'npm CLI')).toBe(npmCli);
  });
});
