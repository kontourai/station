/**
 * #2494: the Seatbelt profile under the real kernel. Every case runs a real
 * `sandbox-exec` child through the production provider (`confine`) and the
 * production grant and profile builders, against a real git repository and
 * worktree, and reads what the kernel allowed.
 *
 * Skips LOUDLY (the reason is in the suite name and on stderr) on a host
 * where the production profile does not apply: Linux, Windows, or a macOS
 * without a working `sandbox-exec`. On a macOS host that can apply it, it
 * must run.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createClaudeEngineProcess } from '../../../providers/adapters/claude-code-spawn.js';
import {
  confinedClaudeSpawn,
  prepareConfinedClaudeLaunch,
} from '../../../providers/adapters/claude-seatbelt.js';
import {
  canonicalPath,
  createSeatbeltConfinementProvider,
  probeSeatbelt,
  SANDBOX_EXEC,
  seatbeltProfile,
} from '../seatbelt.js';

const probe =
  process.platform === 'darwin'
    ? probeSeatbelt()
    : {
        ok: false,
        reason: `Seatbelt is macOS-only; this host is ${process.platform}`,
      };
if (!probe.ok)
  process.stderr.write(
    `\n[seatbelt.process] SKIPPED: the production Seatbelt profile cannot apply here: ${probe.reason}\n`,
  );

/** The installed Claude Code, for the live handshake case. */
const claudeExecutable = (() => {
  if (!probe.ok) return undefined;
  const found = spawnSync('/usr/bin/which', ['claude'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return found.status === 0 && found.stdout.trim()
    ? canonicalPath(found.stdout.trim())
    : undefined;
})();
if (probe.ok && !claudeExecutable)
  process.stderr.write(
    '\n[seatbelt.process] SKIPPED live Claude handshake: no `claude` on PATH\n',
  );

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Station Test',
  GIT_AUTHOR_EMAIL: 'station-test@example.invalid',
  GIT_COMMITTER_NAME: 'Station Test',
  GIT_COMMITTER_EMAIL: 'station-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * stderr with the noise a confined git is expected to print removed: the
 * macOS `xcrun` shim's cache in the per-user system temp folder, and a
 * background `pack-refs` on the shared refs, are both writes the profile
 * denies on purpose and git does not need.
 */
function unexpectedStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(
      (line) =>
        line.trim() !== '' &&
        !/couldn't create cache file .*xcrun_db/.test(line) &&
        !/Unable to create '.*packed-refs\.lock': Operation not permitted/.test(
          line,
        ),
    )
    .join('\n');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY, HOME: cwd },
    windowsHide: true,
  }).trim();
}

describe.skipIf(!probe.ok)(
  `Seatbelt profile under the real kernel${probe.ok ? '' : ` (SKIPPED: ${probe.reason})`}`,
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    const provider = createSeatbeltConfinementProvider();
    let root: string;
    let home: string;
    let stationRoot: string;
    let stationHome: string;
    let repo: string;
    let worktree: string;
    let outside: string;

    beforeAll(() => {
      root = canonicalPath(makeTempDir('seatbelt-process-'));
      home = join(root, 'home');
      stationRoot = join(home, '.station');
      stationHome = join(stationRoot, 'instances', 'test');
      outside = join(root, 'outside');
      for (const dir of [
        join(home, '.ssh'),
        join(home, '.claude'),
        join(stationRoot, 'installs', 'stable'),
        stationHome,
        outside,
      ])
        mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'not a real key\n');
      writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
      writeFileSync(join(stationHome, 'station.sqlite'), 'station data\n');
      writeFileSync(
        join(stationRoot, 'installs', 'stable', 'engine.js'),
        'installed\n',
      );
      repo = join(root, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'hello\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'initial');
      worktree = join(root, 'feature');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    });

    /** Runs `script` in `/bin/sh` under the production profile for `workspace`. */
    async function confined(workspace: string, script: string) {
      const launch = await prepareConfinedClaudeLaunch({
        workspace: canonicalPath(workspace),
        configDir: join(stationHome, 'app-homes', 'claude-confined'),
        stationHome,
        home,
        stationRoot,
      });
      const spawn = confinedClaudeSpawn(provider, launch);
      const wrapped = spawn.wrap({
        command: '/bin/sh',
        args: ['-c', script],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', HOME: home, ...GIT_IDENTITY },
      });
      expect(wrapped.command).toBe(SANDBOX_EXEC);
      const result = spawnSync(wrapped.command, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      launch.cleanup();
      return { status: result.status, stderr: result.stderr, launch };
    }

    test('the probe ran the production profile, not a stand-in', () => {
      expect(probe.ok).toBe(true);
    });

    test('a write in the workspace is allowed; a write outside it is denied', async () => {
      expect(
        (await confined(worktree, `echo ok > "${worktree}/written.txt"`))
          .status,
      ).toBe(0);
      expect(readFileSync(join(worktree, 'written.txt'), 'utf8')).toBe('ok\n');
      const denied = await confined(worktree, `echo x > "${outside}/escape"`);
      expect(denied.status).not.toBe(0);
      expect(existsSync(join(outside, 'escape'))).toBe(false);
    });

    test('a linked worktree can commit twice and read its status', async () => {
      const result = await confined(
        worktree,
        [
          'set -e',
          `cd "${worktree}"`,
          'echo one > one.txt',
          'git add one.txt',
          'git commit -q -m one',
          'echo two > two.txt',
          'git add two.txt',
          'git commit -q -m two',
          'git status --porcelain',
        ].join('\n'),
      );
      expect(unexpectedStderr(result.stderr)).toBe('');
      expect(result.status).toBe(0);
      expect(git(repo, 'log', '-1', '--format=%s', 'feature')).toBe('two');
    });

    test.each([
      [
        'write a shared hook',
        (common: string) => `echo x > "${common}/hooks/pre-commit"`,
      ],
      [
        'write the shared config',
        () => 'git config --local core.hooksPath /tmp',
      ],
      [
        'write shared info',
        (common: string) => `echo x >> "${common}/info/exclude"`,
      ],
      ['move main', () => 'git update-ref refs/heads/main HEAD'],
      ['create another branch', () => 'git branch other'],
      ['repoint the .git pointer file', () => 'echo "gitdir: /tmp" > .git'],
      [
        'write config.worktree',
        (_common: string, gitDir: string) =>
          `echo "[core]" > "${gitDir}/config.worktree"`,
      ],
    ])('a linked worktree may not %s', async (_name, command) => {
      const common = canonicalPath(join(repo, '.git'));
      const gitDir = join(common, 'worktrees', 'feature');
      const mainBefore = git(repo, 'rev-parse', 'main');
      const configBefore = readFileSync(join(common, 'config'), 'utf8');
      const pointerBefore = readFileSync(join(worktree, '.git'), 'utf8');
      const result = await confined(
        worktree,
        `cd "${worktree}" && ${command(common, gitDir)}`,
      );
      expect(result.status).not.toBe(0);
      expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
      expect(git(repo, 'branch', '--list', 'other')).toBe('');
      expect(existsSync(join(common, 'hooks', 'pre-commit'))).toBe(false);
      expect(existsSync(join(gitDir, 'config.worktree'))).toBe(false);
      expect(readFileSync(join(common, 'config'), 'utf8')).toBe(configBefore);
      expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(pointerBefore);
    });

    test('a checkout whose .git is inside the workspace still cannot write its hooks, config or info', async () => {
      const dotGit = canonicalPath(join(repo, '.git'));
      for (const target of [
        join(dotGit, 'hooks', 'post-checkout'),
        join(dotGit, 'config'),
        join(dotGit, 'info', 'exclude'),
      ]) {
        const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
        const result = await confined(repo, `echo x >> "${target}"`);
        expect(result.status, target).not.toBe(0);
        expect(existsSync(target) ? readFileSync(target, 'utf8') : null).toBe(
          before,
        );
      }
      // The checkout itself, and its commits, stay writable.
      const commit = await confined(
        repo,
        `set -e; cd "${repo}"; echo m > m.txt; git add m.txt; git commit -q -m shared`,
      );
      expect(unexpectedStderr(commit.stderr)).toBe('');
      expect(commit.status).toBe(0);
      expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('shared');
    });

    test('secret stores and Station data are unreadable; Station installs stay readable', async () => {
      for (const secret of [
        join(home, '.ssh', 'id_ed25519'),
        join(stationHome, 'station.sqlite'),
      ]) {
        const result = await confined(worktree, `cat "${secret}" > /dev/null`);
        expect(result.status, secret).not.toBe(0);
      }
      expect(
        (
          await confined(
            worktree,
            `cat "${join(stationRoot, 'installs', 'stable', 'engine.js')}" > /dev/null`,
          )
        ).status,
      ).toBe(0);
    });

    test("the operator's login Keychain is hidden from the confined process", async () => {
      // The real Keychain folder of this host's user, listed (not read for
      // content) from inside the profile the production builder makes for
      // the real home folder.
      const launch = await prepareConfinedClaudeLaunch({
        workspace: canonicalPath(worktree),
        configDir: join(stationHome, 'app-homes', 'claude-confined'),
        stationHome,
        stationRoot,
      });
      const keychains = join(homedir(), 'Library', 'Keychains');
      const result = spawnSync(
        SANDBOX_EXEC,
        ['-p', seatbeltProfile(launch.grants), '/bin/ls', keychains],
        { encoding: 'utf8', windowsHide: true },
      );
      launch.cleanup();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    });

    test("the operator's Claude config is not writable; the Station-owned one is", async () => {
      const stationConfig = join(stationHome, 'app-homes', 'claude-confined');
      const allowed = await confined(
        worktree,
        `echo '{}' > "${stationConfig}/settings.json"`,
      );
      expect(allowed.status).toBe(0);
      const denied = await confined(
        worktree,
        `echo '{"hooks":{}}' > "${home}/.claude/settings.json"`,
      );
      expect(denied.status).not.toBe(0);
      expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(
        '{}\n',
      );
      // And this host's real operator config folder, by creating a new file
      // that would be removed again if the profile ever let it through.
      const probeFile = join(
        homedir(),
        '.claude',
        `.station-seatbelt-probe-${process.pid}`,
      );
      const real = await confined(worktree, `echo x > "${probeFile}"`);
      const leaked = existsSync(probeFile);
      if (leaked) rmSync(probeFile, { force: true });
      expect(real.status).not.toBe(0);
      expect(leaked).toBe(false);
    });

    test('the session temp directory is writable and the confined env points at it', async () => {
      const result = await confined(
        worktree,
        'echo t > "$TMPDIR/t" && test "$CLAUDE_CONFIG_DIR" != "" && test -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR"',
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.launch.writeGrants).toEqual([
        'git-branch-ref',
        'git-objects',
        'git-worktree',
        'station-config',
        'station-temp',
        'workspace',
      ]);
    });

    test.skipIf(!claudeExecutable)(
      `the installed Claude Code answers its handshake from inside the profile, and the provider observes it confined${claudeExecutable ? '' : ' (SKIPPED: no claude on PATH)'}`,
      async () => {
        // A fake env credential: no request reaches a model, and the
        // operator's own login is never involved.
        const launch = await prepareConfinedClaudeLaunch({
          workspace: canonicalPath(worktree),
          configDir: join(stationHome, 'app-homes', 'claude-confined'),
          stationHome,
          stationRoot,
        });
        const confinedSpawn = confinedClaudeSpawn(provider, launch);
        const engine = createClaudeEngineProcess(undefined, confinedSpawn.wrap);
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        // Holds stdin open and sends nothing: no turn, no model request.
        const prompt: AsyncIterable<never> = {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await held;
              return { done: true, value: undefined };
            },
          }),
        };
        const live = query({
          prompt: prompt as never,
          options: {
            pathToClaudeCodeExecutable: claudeExecutable!,
            cwd: worktree,
            settingSources: [],
            env: {
              PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
              HOME: homedir(),
              USER: process.env.USER ?? 'station',
              ANTHROPIC_API_KEY: 'sk-ant-api03-fake-for-station-tests',
              DISABLE_AUTOUPDATER: '1',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            },
            spawnClaudeCodeProcess: engine.spawn,
          },
        });
        let handshake: 'completed' | 'failed' = 'failed';
        try {
          await Promise.race([
            live.initializationResult(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timed out')), 45_000),
            ),
          ]);
          handshake = 'completed';
        } finally {
          release();
          live.close();
          await engine.terminate();
          launch.cleanup();
        }
        const spawned = engine.spawned();
        expect(spawned?.command).toBe(SANDBOX_EXEC);
        expect(spawned?.args.slice(2)).toContain(claudeExecutable);
        expect(
          confinedSpawn.pending()?.observe({
            spawned,
            handshake,
            bounds: launch.bounds,
          }),
          engine.stderrTail(),
        ).toBe('confined');
      },
      60_000,
    );

    test('signals reach only processes inside the sandbox', async () => {
      const outsider = spawn('/bin/sleep', ['30'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const pid = outsider.pid!;
      try {
        const denied = await confined(worktree, `kill -0 ${pid}`);
        expect(denied.status).not.toBe(0);
        const own = await confined(
          worktree,
          'sleep 30 & child=$!; kill $child',
        );
        expect(own.status).toBe(0);
      } finally {
        outsider.kill();
      }
    });
  },
);
