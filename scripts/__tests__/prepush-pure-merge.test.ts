import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

/**
 * #3101 slice F. Every case builds a real Git graph and runs the real
 * classifier, or the real hook, as a child process: the verdict that matters
 * is the exit status the hook branches on, not a return value.
 */

const SCRIPT = realpathSync('scripts/prepush-pure-merge.mjs');
const ZERO = '0'.repeat(40);
const EXPENSIVE = [
  'scripts/check-prepush-orchestration-transfer.mjs',
  'scripts/check-prepush-static-gates.mjs',
  'scripts/check-prepush-sdk-barrel.mjs',
  'scripts/check-prepush-typecheck.mjs',
  'veritas:readiness',
];

const makeTempDir = trackTempDirs();

function gitEnv() {
  return {
    ...sanitizedGitEnvironment(process.env),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

/**
 * A remote with `main`, a clone whose `feat` branch has one gated commit on
 * the remote, and `main` advanced by one commit the clone has fetched.
 */
function fixture() {
  const root = realpathSync(makeTempDir('station-pure-merge-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const env = gitEnv();
  const git = (args: string[], options: { ok?: boolean } = {}) => {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      },
    );
    if (options.ok !== false) expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  spawnSync('git', ['init', '--bare', '-q', '-b', 'main', remote], {
    env,
    windowsHide: true,
  });
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', remote]);
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (path: string, text: string, message: string) => {
    write(path, text);
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };
  commit('shared.txt', 'one\ntwo\nthree\n', 'chore: root');
  git(['push', '-q', 'origin', 'main']);
  git(['checkout', '-q', '-b', 'feat']);
  commit('feat.txt', 'feature\n', 'feat: branch work');
  git(['push', '-q', 'origin', 'feat']);
  const gatedTip = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', 'main']);
  commit('main.txt', 'from main\n', 'fix: main moved');
  git(['push', '-q', 'origin', 'main']);
  git(['checkout', '-q', 'feat']);
  git(['fetch', '-q', 'origin']);
  const classify = (
    local = git(['rev-parse', 'HEAD']),
    remoteSha = gatedTip,
    {
      remoteName = 'origin',
      ref = 'refs/heads/feat',
      extraEnv = {},
    }: {
      remoteName?: string;
      ref?: string;
      extraEnv?: Record<string, string>;
    } = {},
  ) =>
    spawnSync(process.execPath, [SCRIPT, remoteName], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      input: `${ref} ${local} ${ref} ${remoteSha}\n`,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
  return { root, repo, remote, env, git, write, commit, gatedTip, classify };
}

describe.skipIf(process.platform === 'win32')(
  'pure-merge classifier (real git, child process)',
  () => {
    it('accepts a clean merge of origin/main onto the gated remote tip', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const result = f.classify();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Pure merge of main: yes');
    });

    it('accepts two successive clean merges of main', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      f.git(['checkout', '-q', 'main']);
      f.commit('main2.txt', 'again\n', 'fix: main moved again');
      f.git(['push', '-q', 'origin', 'main']);
      f.git(['checkout', '-q', 'feat']);
      f.git(['fetch', '-q', 'origin']);
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const result = f.classify();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('2 clean merge(s)');
    });

    it('refuses a merge whose resolution was hand-edited although Git saw no conflict', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-commit', '--no-ff', 'origin/main']);
      f.write('feat.txt', 'feature, quietly changed inside the merge\n');
      f.git(['add', '-A']);
      f.git(['commit', '-q', '--no-edit']);
      const result = f.classify();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('differs from the automatic merge');
    });

    it('refuses a merge with a conflict resolution, even one taking a side verbatim', () => {
      const f = fixture();
      // Make main and the branch edit the same line.
      f.git(['checkout', '-q', 'main']);
      f.commit('shared.txt', 'one\nMAIN\nthree\n', 'fix: main edits shared');
      f.git(['push', '-q', 'origin', 'main']);
      f.git(['checkout', '-q', 'feat']);
      f.commit(
        'shared.txt',
        'one\nBRANCH\nthree\n',
        'feat: branch edits shared',
      );
      f.git(['push', '-q', 'origin', 'feat']);
      const gated = f.git(['rev-parse', 'HEAD']);
      f.git(['fetch', '-q', 'origin']);
      f.git(['merge', '-q', '--no-edit', 'origin/main'], { ok: false });
      f.write('shared.txt', 'one\nBRANCH\nthree\n');
      f.git(['add', '-A']);
      f.git(['commit', '-q', '--no-edit']);
      const result = f.classify(undefined, gated);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('needed conflict resolution');
    });

    it("refuses a push that adds the author's own commit after a clean merge", () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      f.commit('feat.txt', 'more feature\n', 'feat: more');
      const result = f.classify();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('is not a merge');
    });

    it('refuses a merge of a branch that is not on origin/main', () => {
      const f = fixture();
      f.git(['checkout', '-q', '-b', 'other', 'main']);
      f.commit('other.txt', 'unreviewed\n', 'feat: unrelated branch');
      f.git(['checkout', '-q', 'feat']);
      f.git(['merge', '-q', '--no-edit', 'other']);
      const result = f.classify();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("which is not on origin's main");
    });

    it('refuses a brand-new ref and an unknown remote tip', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const fresh = f.classify(undefined, ZERO);
      expect(fresh.status).toBe(1);
      expect(fresh.stdout).toContain('new remote ref');
      const unknown = f.classify(undefined, 'f'.repeat(40));
      expect(unknown.status).toBe(1);
      expect(unknown.stdout).toContain('not available locally');
    });

    it('refuses a merge of a forged local origin/main, even with STATION_BASE_REF pointing at it', () => {
      const f = fixture();
      // Unreviewed content that never reached the remote's main.
      f.git(['checkout', '-q', '--detach', 'origin/main']);
      const evil = f.commit('evil.txt', 'never gated\n', 'feat: forged main');
      f.git(['checkout', '-q', 'feat']);
      f.git(['update-ref', 'refs/remotes/origin/main', evil]);
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const result = f.classify(undefined, undefined, {
        extraEnv: { STATION_BASE_REF: 'refs/remotes/origin/main' },
      });
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain("which is not on origin's main");
    });

    it('refuses when the remote main cannot be read', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const result = f.classify(undefined, undefined, {
        remoteName: join(f.root, 'missing.git'),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('cannot read refs/heads/main');
    });

    it('refuses a plain commit dressed up as a clean merge with git replace', () => {
      const f = fixture();
      const gated = f.gatedTip;
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const cleanMerge = f.git(['rev-parse', 'HEAD']);
      f.git(['reset', '-q', '--hard', gated]);
      const plain = f.commit('feat.txt', 'unreviewed edit\n', 'feat: sneaky');
      f.git(['replace', plain, cleanMerge]);
      const result = f.classify(plain);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('is not a merge');
    });

    it('names a tag accurately instead of a long walk', () => {
      const f = fixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      f.git(['tag', '-a', '-m', 'release', 'v1']);
      const tag = f.git(['rev-parse', 'v1']);
      const asTag = f.classify(tag, f.gatedTip, { ref: 'refs/tags/v1' });
      expect(asTag.status).toBe(1);
      expect(asTag.stdout).toContain('refs/tags/v1 is not a branch');
      const ontoBranch = f.classify(tag);
      expect(ontoBranch.status).toBe(1);
      expect(ontoBranch.stdout).toContain('is a tag, not a commit');
      expect(ontoBranch.stdout).not.toContain('first-parent commits');
    });

    it('refuses when no ref lines arrive', () => {
      const f = fixture();
      const result = spawnSync(process.execPath, [SCRIPT, 'origin'], {
        cwd: f.repo,
        env: f.env,
        input: '',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
      expect(result.status).toBe(1);
    });
  },
);

/**
 * The real hook, pushed through by real `git push`. Only the gate commands are
 * stubbed (they record their name); the classifier, the hook's branching and
 * every Git read are real. This is what proves the skip reaches the hook.
 */
describe.skipIf(process.platform === 'win32')(
  'pre-push hook skips expensive lanes only for a pure merge',
  () => {
    function hookFixture() {
      const f = fixture();
      const report = join(f.root, 'gates.log');
      const bin = join(f.root, 'bin');
      mkdirSync(bin);
      mkdirSync(join(f.repo, '.githooks'), { recursive: true });
      mkdirSync(join(f.repo, 'scripts', 'lib'), { recursive: true });
      writeFileSync(
        join(f.repo, '.githooks', 'pre-push'),
        readFileSync('.githooks/pre-push'),
        { mode: 0o755 },
      );
      // The whole helper directory: the hook calls several of these directly
      // (environment cleanup, liveness scale) and they import one another.
      cpSync('scripts/lib', join(f.repo, 'scripts', 'lib'), {
        recursive: true,
      });
      writeFileSync(
        join(f.repo, 'scripts', 'prepush-pure-merge.mjs'),
        readFileSync('scripts/prepush-pure-merge.mjs'),
      );
      // Hook files are untracked in the fixture so they never affect the merge.
      mkdirSync(join(f.repo, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(f.repo, '.git', 'info', 'exclude'),
        '.githooks/\nscripts/\n',
      );
      const record = `require('node:fs').appendFileSync(${JSON.stringify(report)}, gate + '\\n');`;
      writeFileSync(
        join(bin, 'npm'),
        `#!${process.execPath}\nconst gate = process.argv.at(-1);\n${record}\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'node'),
        `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (/^scripts\\/(check-prepush-|commit-message-gate)/.test(args[0] ?? '')) {
  const gate = args[0];
  ${record}
  if (gate === 'scripts/commit-message-gate.mjs') require('node:fs').readFileSync(0);
} else {
  const result = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: 'inherit', env: process.env, windowsHide: true });
  process.exit(result.status ?? 1);
}
`,
        { mode: 0o755 },
      );
      const push = () => {
        writeFileSync(report, '');
        const result = spawnSync(
          'git',
          ['-c', 'core.hooksPath=.githooks', 'push', '-q', 'origin', 'feat'],
          {
            cwd: f.repo,
            env: { ...f.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30_000,
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        return {
          output: result.stdout + result.stderr,
          gates: readFileSync(report, 'utf8').trim().split('\n'),
        };
      };
      return { ...f, push };
    }

    it('runs only the cheap lanes for a clean merge of main', () => {
      const f = hookFixture();
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const { output, gates } = f.push();
      expect(output).toContain('skipped for a pure merge of main');
      for (const gate of EXPENSIVE) expect(gates).not.toContain(gate);
      expect(gates).toEqual([
        'lint:check',
        'proof:repo-governance',
        'scripts/commit-message-gate.mjs',
      ]);
    });

    it('runs every lane when origin/main was forged locally', () => {
      const f = hookFixture();
      f.git(['checkout', '-q', '--detach', 'origin/main']);
      const evil = f.commit('evil.txt', 'never gated\n', 'feat: forged main');
      f.git(['checkout', '-q', 'feat']);
      f.git(['update-ref', 'refs/remotes/origin/main', evil]);
      f.git(['merge', '-q', '--no-edit', 'origin/main']);
      const { output, gates } = f.push();
      expect(output).toContain('Pure merge of main: no');
      for (const gate of EXPENSIVE) expect(gates).toContain(gate);
    });

    it('runs every lane for a hand-edited merge resolution', () => {
      const f = hookFixture();
      f.git(['merge', '-q', '--no-commit', '--no-ff', 'origin/main']);
      f.write('feat.txt', 'feature, edited inside the merge\n');
      f.git(['add', '-A']);
      f.git(['commit', '-q', '--no-edit']);
      const { output, gates } = f.push();
      expect(output).toContain('Pure merge of main: no');
      for (const gate of EXPENSIVE) expect(gates).toContain(gate);
    });
  },
);
