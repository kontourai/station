import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

describe('repo hook wiring', () => {
  const hook = readFileSync('.githooks/pre-push', 'utf8');
  const commands = hook
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('leaves moving-main composition freshness to the required merge queue', () => {
    expect(commands).not.toContain('git fetch');
    expect(commands).not.toContain('check-merge-base-fresh.mjs');
    expect(commands).not.toContain('STATION_ALLOW_STALE_BASE');
  });

  it('keeps the hook to seconds-scale checks', () => {
    // full:regression stays the sole completion receipt and ci:fast stays the
    // bounded feedback lane; a hook that runs either becomes a hook people
    // route around with --no-verify. Comments may name them; commands may not.
    // The UI bundle build left the hook for the same reason (#1703): CI's
    // candidate budget step and the merge queue already enforce it.
    expect(commands).not.toMatch(
      /full:regression|ci:fast|test:full|verify:static|build:ui/,
    );
  });
});

describe.skipIf(process.platform === 'win32')(
  'real linked-worktree push environment',
  () => {
    const makeTempDir = trackTempDirs();

    function fixture() {
      const root = realpathSync(
        makeTempDir('station-prepush-git-environment-'),
      );
      const primary = join(root, 'primary');
      const worktree = join(root, 'linked');
      const foreign = join(root, 'foreign');
      const remote = join(root, 'remote.git');
      const bin = join(root, 'bin');
      const report = join(root, 'gate-observations.jsonl');
      const globalConfig = join(root, 'global.gitconfig');
      writeFileSync(globalConfig, '[station]\n\tfixture-global = preserved\n');
      const env = {
        ...sanitizedGitEnvironment(process.env),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      };
      const git = (cwd: string, args: string[]) => {
        const result = spawnSync('git', args, {
          cwd,
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      mkdirSync(primary);
      git(primary, ['init', '-q']);
      mkdirSync(join(primary, '.githooks'));
      mkdirSync(join(primary, 'scripts', 'lib'), { recursive: true });
      mkdirSync(join(primary, 'docs'));
      writeFileSync(
        join(primary, '.githooks', 'pre-push'),
        readFileSync('.githooks/pre-push'),
        { mode: 0o755 },
      );
      // The hook runs these itself before any gate: git-environment, and the
      // liveness-scale resolver (#3309) with its whole relative-import closure.
      for (const lib of [
        'git-environment.mjs',
        'liveness-scale-resolve.mjs',
        'liveness-scale.mjs',
        'module-entry.mjs',
        'verification-host-pressure.mjs',
      ])
        writeFileSync(
          join(primary, 'scripts', 'lib', lib),
          readFileSync(`scripts/lib/${lib}`),
        );
      writeFileSync(join(primary, 'README.md'), 'pushed repository\n');
      writeFileSync(join(primary, 'docs', 'guide.md'), 'tracked guide\n');
      git(primary, ['add', '.']);
      git(primary, [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'fixture root',
      ]);
      git(primary, ['config', 'core.hooksPath', '.githooks']);
      git(primary, ['worktree', 'add', '-q', '-b', 'fixture-push', worktree]);
      const pushedHead = git(worktree, ['rev-parse', 'HEAD']);
      writeFileSync(join(worktree, 'untracked.txt'), 'untracked input\n');
      mkdirSync(foreign);
      git(foreign, ['init', '-q']);
      writeFileSync(join(foreign, 'foreign.txt'), 'different repository\n');
      git(foreign, ['add', '.']);
      git(foreign, [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'foreign root',
      ]);
      const foreignHead = git(foreign, ['rev-parse', 'HEAD']);
      expect(foreignHead).not.toBe(pushedHead);
      git(root, ['init', '--bare', '-q', remote]);
      mkdirSync(bin);

      // Only expensive gate commands are replaced. Every Git read below is a
      // real subprocess inheriting exactly the environment the real hook gave it.
      const probe = join(root, 'probe.cjs');
      writeFileSync(
        probe,
        `
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const worktree = ${JSON.stringify(worktree)};
const foreign = ${JSON.stringify(foreign)};
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
module.exports = (gate) => {
  const observation = {
    gate, cwd: process.cwd(),
    routingKeys: Object.keys(process.env).filter(key => /^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|PREFIX|INDEX_FILE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\\d+|CONFIG_VALUE_\\d+)$/.test(key)),
    root: git(process.cwd(), ['ls-files', '--cached', '--others', '--exclude-standard']),
    docs: git(worktree + '/docs', ['ls-files', '--error-unmatch', 'guide.md']),
    foreign: git(foreign, ['rev-parse', 'HEAD']),
    global: git(foreign, ['config', '--get', 'station.fixture-global']),
    local: git(foreign, ['config', '--get', 'station.fixture-local']),
    parameter: git(foreign, ['config', '--get', 'station.fixture-parameter']),
  };
  appendFileSync(${JSON.stringify(report)}, JSON.stringify(observation) + '\\n');
  if (observation.cwd !== worktree || observation.root.status !== 0 ||
      !observation.root.stdout.split('\\n').includes('docs/guide.md') ||
      !observation.root.stdout.split('\\n').includes('untracked.txt') ||
      observation.docs.status !== 0 || observation.docs.stdout !== 'guide.md' ||
      observation.foreign.status !== 0 || observation.foreign.stdout !== ${JSON.stringify(foreignHead)} ||
      observation.global.status !== 0 || observation.global.stdout !== 'preserved' || observation.local.status !== 1 ||
      observation.parameter.status !== 1 || observation.routingKeys.length !== 0) {
    console.error('GIT_GATE_CONTEXT_INVALID ' + JSON.stringify(observation));
    process.exit(31);
  }
  if (process.env.STATION_FIXTURE_FAIL_GATE === gate) {
    console.error('INTENTIONAL_GATE_REFUSAL ' + gate);
    process.exit(37);
  }
};
`,
      );
      writeFileSync(
        join(bin, 'npm'),
        `#!${process.execPath}
const args = process.argv.slice(2);
const gate = args.at(-1);
if (args[0] !== 'run' || !['lint:check', 'proof:repo-governance', 'veritas:readiness'].includes(gate)) {
  throw new Error('Unexpected npm gate: ' + args.join(' '));
}
require(${JSON.stringify(probe)})(gate);
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'node'),
        `#!${process.execPath}
const { spawnSync } = require('node:child_process');
// The hook runs heavy gates through the slot runner; its admission is
// covered in prepush-pure-merge.test.ts, so this probe records the gate.
const raw = process.argv.slice(2);
const args = raw[0] === 'scripts/heavy-check-slot.mjs' ? raw.slice(2) : raw;
const gates = ['check-prepush-orchestration-transfer.mjs', 'check-prepush-static-gates.mjs', 'check-prepush-sdk-barrel.mjs', 'commit-message-gate.mjs'];
if (gates.some(gate => args[0] === 'scripts/' + gate)) {
  require(${JSON.stringify(probe)})(args[0]);
} else {
  // The hook's real environment-cleanup helper runs on real Node.
  const result = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(result.status ?? 1);
}
`,
        { mode: 0o755 },
      );

      const index = git(worktree, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ]);
      return {
        pushedHead,
        push: (branch: string, failGate = '') =>
          spawnSync(
            'git',
            [
              '-c',
              'station.fixture-parameter=command-local',
              'push',
              remote,
              `HEAD:refs/heads/${branch}`,
            ],
            {
              cwd: join(worktree, 'docs'),
              env: {
                ...env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                GIT_INDEX_FILE: index,
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'station.fixture-local',
                GIT_CONFIG_VALUE_0: 'environment-local',
                STATION_FIXTURE_FAIL_GATE: failGate,
              },
              encoding: 'utf8',
              windowsHide: true,
              timeout: 20_000,
            },
          ),
        remoteRef: (branch: string) =>
          spawnSync(
            'git',
            [
              '--git-dir',
              remote,
              'rev-parse',
              '--verify',
              `refs/heads/${branch}`,
            ],
            {
              cwd: root,
              env,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 5000,
            },
          ),
        observations: () =>
          readFileSync(report, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { gate: string }),
      };
    }

    it('lets real gate Git reads discover root, docs and an unrelated repository while preserving global config', () => {
      const f = fixture();
      const result = f.push('accepted');
      const remote = f.remoteRef('accepted');
      expect(
        result.status,
        `${result.stdout}\n${result.stderr}\nremote status: ${remote.status}`,
      ).toBe(0);
      expect(remote.status, remote.stderr).toBe(0);
      expect(remote.stdout.trim()).toBe(f.pushedHead);
      expect(f.observations().map((entry) => entry.gate)).toEqual([
        'lint:check',
        'proof:repo-governance',
        'scripts/check-prepush-orchestration-transfer.mjs',
        'scripts/check-prepush-static-gates.mjs',
        'scripts/check-prepush-sdk-barrel.mjs',
        'scripts/commit-message-gate.mjs',
      ]);
    });

    it.each(['lint:check', 'proof:repo-governance'])(
      'refuses the actual push when %s fails and publishes no remote ref',
      (gate) => {
        const f = fixture();
        const result = f.push('refused', gate);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`INTENTIONAL_GATE_REFUSAL ${gate}`);
        expect(f.remoteRef('refused').status).not.toBe(0);
        expect(f.observations().map((entry) => entry.gate)).not.toContain(
          'scripts/check-prepush-orchestration-transfer.mjs',
        );
      },
    );
  },
);
