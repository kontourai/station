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
  lstatSync,
  mkdirSync,
  readdirSync,
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
        join(home, '.aws'),
        join(home, '.config', 'gh'),
        join(home, '.claude'),
        join(stationRoot, 'installs', 'stable'),
        stationHome,
        outside,
      ])
        mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'not a real key\n');
      // Fixture secrets: never the operator's own.
      writeFileSync(join(home, '.aws', 'credentials'), 'fixture\n');
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'fixture\n');
      writeFileSync(join(home, '.claude', '.credentials.json'), '{}\n');
      writeFileSync(join(stationRoot, 'instances.json'), 'station root\n');
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
        configDir: join(stationHome, 'confined-homes', 'claude'),
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
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        launch,
      };
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
        configDir: join(stationHome, 'confined-homes', 'claude'),
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
      const stationConfig = join(stationHome, 'confined-homes', 'claude');
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

    test.each([
      [
        'write a Codex project config',
        (w: string) =>
          `mkdir -p "${w}/.codex" && printf '[sandbox_workspace_write]\\nwritable_roots = ["/"]\\n' > "${w}/.codex/config.toml"`,
        '.codex/config.toml',
      ],
      [
        'write a Claude project settings file',
        (w: string) =>
          `mkdir -p "${w}/.claude" && echo '{"hooks":{}}' > "${w}/.claude/settings.json"`,
        '.claude/settings.json',
      ],
      [
        'write Claude local settings',
        (w: string) =>
          `mkdir -p "${w}/.claude" && echo '{}' > "${w}/.claude/settings.local.json"`,
        '.claude/settings.local.json',
      ],
      [
        'move a prepared directory into place',
        (w: string) =>
          `mkdir -p "${w}/prepared" && echo '{}' > "${w}/prepared/settings.json" && mv "${w}/prepared" "${w}/.claude"`,
        '.claude/settings.json',
      ],
      [
        'create it in another case',
        (w: string) =>
          `mkdir -p "${w}/.CODEX" && echo x > "${w}/.CODEX/config.toml"`,
        '.codex/config.toml',
      ],
      [
        'write a Codex config in a subdirectory a later session may start in',
        (w: string) =>
          `mkdir -p "${w}/pkg/.codex" && echo x > "${w}/pkg/.codex/config.toml"`,
        'pkg/.codex/config.toml',
      ],
      [
        'write Claude settings in a subdirectory, in another case',
        (w: string) =>
          `mkdir -p "${w}/pkg/.Claude" && echo '{}' > "${w}/pkg/.Claude/settings.json"`,
        'pkg/.claude/settings.json',
      ],
      [
        'prepare one in its temp directory and move it into the workspace',
        (w: string) =>
          `mkdir -p "$TMPDIR/q/.codex" && echo x > "$TMPDIR/q/.codex/config.toml"; mv "$TMPDIR/q" "${w}/pkg2"`,
        'pkg2/.codex/config.toml',
      ],
    ])(
      'the workspace engine configuration is read-only: a confined process cannot %s (#3800)',
      async (_label, script, planted) => {
        const result = await confined(worktree, script(worktree));
        const leaked = existsSync(join(worktree, planted));
        for (const dir of ['prepared', 'pkg', 'pkg2'])
          rmSync(join(worktree, dir), { recursive: true, force: true });
        expect(result.status).not.toBe(0);
        expect(leaked).toBe(false);
        // The rest of the workspace stays writable, names that merely share
        // the prefix included.
        expect(
          (
            await confined(
              worktree,
              `echo ok > "${worktree}/beside.txt" && mkdir -p "${worktree}/sub/.codex-notes" && echo ok > "${worktree}/sub/.claude.json"`,
            )
          ).status,
        ).toBe(0);
        rmSync(join(worktree, 'sub'), { recursive: true, force: true });
      },
    );

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
          configDir: join(stationHome, 'confined-homes', 'claude'),
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

    test('a linked worktree can commit but not stash: refs/stash is shared, by design (L1)', async () => {
      const result = await confined(
        worktree,
        [
          `cd "${worktree}"`,
          'echo stash-me > stash.txt',
          'git add stash.txt',
          'if git stash push -q -m confined; then echo STASHED; else echo STASH_DENIED; fi',
          'git commit -q -m after-stash-attempt && echo COMMITTED',
        ].join('\n'),
      );
      expect(result.stdout).toContain('STASH_DENIED');
      expect(result.stdout).toContain('COMMITTED');
      expect(git(repo, 'stash', 'list')).toBe('');
      expect(git(repo, 'log', '-1', '--format=%s', 'feature')).toBe(
        'after-stash-attempt',
      );
    });

    test('a checkout whose .git is inside the workspace can stash and switch to an existing branch', async () => {
      git(repo, 'branch', '-f', 'topic', 'main');
      const result = await confined(
        repo,
        [
          'set -e',
          `cd "${repo}"`,
          'echo dirty >> README.md',
          'git stash push -q -m confined',
          'git switch -q topic',
          'git switch -q main',
          'git stash pop -q',
          'git checkout -q -- README.md',
        ].join('\n'),
      );
      expect(unexpectedStderr(result.stderr)).toBe('');
      expect(result.status).toBe(0);
      expect(git(repo, 'branch', '--show-current')).toBe('main');
    });

    test.each([
      ['an SSH key', () => join(home, '.ssh', 'id_ed25519')],
      ['AWS credentials', () => join(home, '.aws', 'credentials')],
      ['the gh login', () => join(home, '.config', 'gh', 'hosts.yml')],
      [
        "the operator's Claude credential file",
        () => join(home, '.claude', '.credentials.json'),
      ],
      ["Station's runtime home", () => join(stationHome, 'station.sqlite')],
      [
        "Station's root, outside the runtime home",
        () => join(stationRoot, 'instances.json'),
      ],
    ])('%s is unreadable, however it is spelled', async (_label, secretOf) => {
      const secret = secretOf();
      // Readable from outside: the denial below is the profile's.
      expect(readFileSync(secret, 'utf8').length).toBeGreaterThan(0);
      const link = join(outside, `link-${secret.length}`);
      rmSync(link, { force: true });
      execFileSync('ln', ['-s', secret, link], { windowsHide: true });
      const spellings = [
        secret,
        `/System/Volumes/Data${secret}`,
        link,
        // APFS is case-insensitive.
        secret
          .replace(home, `${home}`)
          .replace(/\/\.([a-z])/, (m) => m.toUpperCase()),
      ];
      for (const spelling of spellings) {
        const result = await confined(worktree, `cat "${spelling}"`);
        expect(result.status, spelling).not.toBe(0);
      }
    });

    test('a hidden file cannot be hard-linked or cloned into the workspace', async () => {
      const secret = join(home, '.ssh', 'id_ed25519');
      const hard = await confined(
        worktree,
        `ln "${secret}" "${worktree}/hard"`,
      );
      const clone = await confined(
        worktree,
        `cp -c "${secret}" "${worktree}/clone"`,
      );
      expect(hard.status).not.toBe(0);
      expect(clone.status).not.toBe(0);
      expect(existsSync(join(worktree, 'hard'))).toBe(false);
      expect(existsSync(join(worktree, 'clone'))).toBe(false);
    });

    test('a hard link made outside the sandbox beforehand is readable: an accepted residual', async () => {
      // Documented gap: Seatbelt matches the path used, and a hard link is
      // another path to the same file. Pinned so a change is noticed.
      const secret = join(home, '.ssh', 'id_ed25519');
      const prelinked = join(worktree, 'prelinked');
      rmSync(prelinked, { force: true });
      execFileSync('ln', [secret, prelinked], { windowsHide: true });
      try {
        const read = await confined(worktree, `cat "${prelinked}"`);
        expect(read.status).toBe(0);
      } finally {
        rmSync(prelinked, { force: true });
      }
    });

    test('a granted path does not grant its sibling that shares the prefix', async () => {
      const sibling = `${worktree}-evil`;
      mkdirSync(sibling, { recursive: true });
      const result = await confined(worktree, `echo x > "${sibling}/x"`);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(sibling, 'x'))).toBe(false);
    });

    test('a denied git path is denied in another case', async () => {
      const dotGit = canonicalPath(join(repo, '.git'));
      const result = await confined(
        repo,
        `echo x > "${dotGit}/HOOKS/pre-commit"`,
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(join(dotGit, 'hooks', 'pre-commit'))).toBe(false);
    });

    test.each([
      ['commondir', 'commondir'],
      ['gitdir', 'gitdir'],
      ['a config', 'config'],
      ['hooks', 'hooks/post-checkout'],
    ])(
      "a linked worktree's git directory keeps its %s read-only (R1)",
      async (_label, file) => {
        const gitDir = join(
          canonicalPath(join(repo, '.git')),
          'worktrees',
          'feature',
        );
        const target = join(gitDir, file);
        const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
        try {
          const write = await confined(
            worktree,
            `mkdir -p "$(dirname "${target}")" 2>/dev/null; echo /tmp/evil > "${target}"`,
          );
          expect(write.status).not.toBe(0);
          await confined(worktree, `rm -f "${target}"`);
          expect(existsSync(target) ? readFileSync(target, 'utf8') : null).toBe(
            before,
          );
        } finally {
          // Each case starts from git's own files, so one that leaked cannot
          // hide another (a broken commondir would drop every git grant).
          if (before === null) rmSync(target, { force: true });
          else writeFileSync(target, before);
        }
      },
    );

    test.each([
      [
        "another worktree's commondir",
        (g: string) => `echo /tmp/evil > "${g}/worktrees/feature/commondir"`,
      ],
      [
        "another worktree's gitdir",
        (g: string) => `echo /tmp/evil > "${g}/worktrees/feature/gitdir"`,
      ],
      [
        "a submodule's config",
        (g: string) =>
          `mkdir -p "${g}/modules/sub" && echo "[core]" > "${g}/modules/sub/config"`,
      ],
      [
        'a commondir redirect',
        (g: string) => `echo /tmp/evil > "${g}/commondir"`,
      ],
      [
        'object alternates',
        (g: string) => `echo /tmp/evil >> "${g}/objects/info/alternates"`,
      ],
      ['a renamed .git', (g: string) => `mv "${g}" "${g}-moved"`],
    ])(
      'a checkout whose .git is inside the workspace cannot change %s (R2)',
      async (_label, command) => {
        const dotGit = canonicalPath(join(repo, '.git'));
        const pointerBefore = readFileSync(
          join(dotGit, 'worktrees', 'feature', 'commondir'),
          'utf8',
        );
        const result = await confined(repo, command(dotGit));
        expect(result.status).not.toBe(0);
        expect(existsSync(join(dotGit, 'HEAD'))).toBe(true);
        expect(existsSync(`${dotGit}-moved`)).toBe(false);
        expect(existsSync(join(dotGit, 'commondir'))).toBe(false);
        expect(existsSync(join(dotGit, 'modules'))).toBe(false);
        expect(
          readFileSync(
            join(dotGit, 'worktrees', 'feature', 'commondir'),
            'utf8',
          ),
        ).toBe(pointerBefore);
        expect(git(repo, 'status', '--porcelain')).toBeDefined();
      },
    );

    test('a .git emptied from inside is never replaced by a pointer file or given config (R2)', async () => {
      // A throwaway checkout: emptying its .git is allowed workspace damage.
      const scratch = join(root, 'scratch');
      mkdirSync(scratch, { recursive: true });
      git(scratch, 'init', '-q', '-b', 'main');
      const dotGit = canonicalPath(join(scratch, '.git'));
      const configBefore = readFileSync(join(dotGit, 'config'), 'utf8');
      const hooksBefore = readdirSync(join(dotGit, 'hooks')).sort();
      const result = await confined(
        scratch,
        [
          `rm -rf "${dotGit}" 2>/dev/null`,
          `printf 'gitdir: /tmp/evil\n' > "${dotGit}" 2>/dev/null`,
          `printf '[core]\n\tfsmonitor = touch /tmp/pwned\n' > "${dotGit}/config" 2>/dev/null`,
          `mkdir -p "${dotGit}/hooks" 2>/dev/null`,
          'true',
        ].join('; '),
      );
      expect(result.status).toBe(0);
      // The directory stays a directory; its config and hooks survive
      // unchanged (they cannot be removed or rewritten).
      expect(lstatSync(dotGit).isDirectory()).toBe(true);
      expect(readFileSync(join(dotGit, 'config'), 'utf8')).toBe(configBefore);
      expect(readdirSync(join(dotGit, 'hooks')).sort()).toEqual(hooksBefore);
    });

    test('an app in the workspace cannot be launched outside the sandbox', async (ctx) => {
      const marker = join(outside, 'launched');
      const app = join(worktree, 'Probe.app');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(
        join(app, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>dev.station.seatbelt-probe</string></dict></plist>\n`,
      );
      const executable = join(app, 'Contents', 'MacOS', 'probe');
      writeFileSync(executable, `#!/bin/sh\necho launched > "${marker}"\n`, {
        mode: 0o755,
      });
      const markerWritten = async () => {
        for (let waited = 0; waited < 10_000; waited += 250) {
          if (existsSync(marker)) return true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
      };
      try {
        // Positive control: the same probe launched unconfined writes its
        // marker, so the denial below is the profile's, not a broken app.
        const control = spawnSync('/usr/bin/open', ['-n', app], {
          encoding: 'utf8',
          windowsHide: true,
        });
        const launched = control.status === 0 && (await markerWritten());
        if (!launched) {
          process.stderr.write(
            `\n[seatbelt.process] SKIPPED app-launch denial: the probe app does not launch unconfined on this host (${control.stderr.trim() || `exit ${control.status}`})\n`,
          );
          ctx.skip('the probe app does not launch unconfined on this host');
        }
        rmSync(marker, { force: true });
        const result = await confined(worktree, `open -n "${app}"`);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/-54/);
        expect(await markerWritten()).toBe(false);
      } finally {
        rmSync(marker, { force: true });
        rmSync(app, { recursive: true, force: true });
      }
    });

    test('a setuid program cannot be run from inside', async () => {
      const result = await confined(worktree, '/usr/bin/crontab -l');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Operation not permitted/);
    });

    test('the login Keychain is unreachable through the security tool', async (ctx) => {
      // An item this host's login Keychain holds (any), found from outside.
      const outsideFind = spawnSync(
        '/usr/bin/security',
        ['find-generic-password', '-a', process.env.USER ?? ''],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      if (outsideFind.status !== 0) {
        process.stderr.write(
          '\n[seatbelt.process] SKIPPED Keychain comparison: this host has no readable login Keychain item\n',
        );
        ctx.skip('this host has no readable login Keychain item to compare');
      }
      const result = await confined(
        worktree,
        `/usr/bin/security find-generic-password -a "${process.env.USER ?? ''}" > /dev/null`,
      );
      expect(result.status).toBe(44);
    });

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
