/**
 * #4770: the bubblewrap sandbox under the real Linux kernel. Every case runs
 * a real `bwrap` child through the production provider (`confine`) and the
 * production grant and argument builders, against a real git repository and
 * worktree, and reads what the kernel allowed.
 *
 * Skips LOUDLY (the reason is on stderr) on a host where the production
 * sandbox does not apply: macOS, Windows, or a Linux host without bubblewrap
 * or without unprivileged user namespaces. On a Linux host that can apply
 * it, it must run.
 *
 * Titles are the same on every host so each test keeps one exact id:
 * `scripts/required-test-profiles.json` pins these ids (profile
 * `linux-bubblewrap-kernel`), and `scripts/check-required-tests-ran.mjs`
 * fails a report in which they were skipped or absent (#4772).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
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
  BUBBLEWRAP,
  createBubblewrapConfinementProvider,
  probeBubblewrap,
} from '../bubblewrap.js';
import { canonicalPath } from '../seatbelt.js';

const probe =
  process.platform === 'linux'
    ? probeBubblewrap()
    : {
        ok: false,
        reason: `bubblewrap is Linux-only; this host is ${process.platform}`,
      };
if (!probe.ok)
  process.stderr.write(
    `\n[bubblewrap.process] SKIPPED: the production bubblewrap sandbox cannot apply here: ${probe.reason}\n`,
  );

/**
 * A Claude Code binary for the live handshake case: `claude` on PATH, else
 * the one the Agent SDK installs for this platform.
 */
const claudeExecutable = (() => {
  if (!probe.ok) return undefined;
  const found = spawnSync('/usr/bin/which', ['claude'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (found.status === 0 && found.stdout.trim())
    return canonicalPath(found.stdout.trim());
  const bundled = join(
    process.cwd(),
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    'claude',
  );
  return existsSync(bundled) ? canonicalPath(bundled) : undefined;
})();
if (probe.ok && !claudeExecutable)
  process.stderr.write(
    '\n[bubblewrap.process] SKIPPED live Claude handshake: no `claude` on PATH and no Agent SDK binary for this platform\n',
  );

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Station Test',
  GIT_AUTHOR_EMAIL: 'station-test@example.invalid',
  GIT_COMMITTER_NAME: 'Station Test',
  GIT_COMMITTER_EMAIL: 'station-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY, HOME: cwd },
    windowsHide: true,
  }).trim();
}

/** A file's content, or `null` when it does not exist. */
function contentOf(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

describe.skipIf(!probe.ok)(
  // One title on every host, so a skipped run reports the same ids (#4772).
  'bubblewrap sandbox under the real kernel',
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    const provider = createBubblewrapConfinementProvider();
    let root: string;
    let home: string;
    let stationRoot: string;
    let stationHome: string;
    let repo: string;
    let worktree: string;
    let outside: string;

    beforeAll(() => {
      root = canonicalPath(makeTempDir('bubblewrap-process-'));
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
      // Fixture secrets: never the operator's own.
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'not a real key\n');
      writeFileSync(join(home, '.aws', 'credentials'), 'fixture aws\n');
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'fixture gh\n');
      writeFileSync(join(home, '.netrc'), 'machine fixture\n');
      writeFileSync(
        join(home, '.claude', '.credentials.json'),
        '{"fixture":true}\n',
      );
      writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
      writeFileSync(join(stationRoot, 'instances.json'), 'station root\n');
      writeFileSync(join(stationHome, 'station.sqlite'), 'station data\n');
      writeFileSync(
        join(stationRoot, 'installs', 'stable', 'engine.js'),
        'installed\n',
      );
      repo = join(root, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'hello\n');
      mkdirSync(join(repo, '.claude'));
      writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'initial');
      worktree = join(root, 'feature');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    });

    /** Runs `script` in `/bin/sh` under the production sandbox for `workspace`. */
    async function confined(workspace: string, script: string) {
      const launch = await prepareConfinedClaudeLaunch({
        workspace: canonicalPath(workspace),
        configDir: join(stationHome, 'confined-homes', 'claude'),
        stationHome,
        home,
        stationRoot,
        mechanism: 'bubblewrap',
      });
      const spawn = confinedClaudeSpawn(provider, launch);
      const wrapped = spawn.wrap({
        command: '/bin/sh',
        args: ['-c', script],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', HOME: home, ...GIT_IDENTITY },
      });
      expect(wrapped.command).toBe(BUBBLEWRAP);
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

    test('the probe passed on this host, and the provider a start consults reports the sandbox available', () => {
      expect(probe.ok).toBe(true);
      // The provider a start consults answers from the same probe.
      expect(provider.availability()).toEqual({
        available: true,
        reason: 'the bubblewrap sandbox applies and enforces on this host',
      });
    });

    test('a write in the workspace is allowed; a write outside it is denied', async () => {
      const allowed = await confined(
        worktree,
        `echo ok > "${worktree}/written.txt"`,
      );
      expect(allowed.stderr).toBe('');
      expect(allowed.status).toBe(0);
      expect(readFileSync(join(worktree, 'written.txt'), 'utf8')).toBe('ok\n');
      const denied = await confined(worktree, `echo x > "${outside}/escape"`);
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toMatch(/Read-only file system/);
      expect(existsSync(join(outside, 'escape'))).toBe(false);
      rmSync(join(worktree, 'written.txt'), { force: true });
    });

    test("a linked worktree's git metadata is read-only: status works, staging and committing are refused (a stated difference)", async () => {
      const head = git(repo, 'rev-parse', 'feature');
      const result = await confined(
        worktree,
        [
          `cd "${worktree}"`,
          'git status --porcelain > /dev/null && echo STATUS',
          'echo one > one.txt',
          'if git add one.txt; then echo STAGED; else echo STAGE_DENIED; fi',
          'if git commit -q --allow-empty -m one; then echo COMMITTED; else echo COMMIT_DENIED; fi',
        ].join('\n'),
      );
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('STAGE_DENIED');
      expect(result.stdout).toContain('COMMIT_DENIED');
      expect(git(repo, 'rev-parse', 'feature')).toBe(head);
      rmSync(join(worktree, 'one.txt'), { force: true });
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
      ['remove the .git pointer file', () => 'rm -f .git'],
      [
        'write config.worktree',
        (_common: string, gitDir: string) =>
          `echo "[core]" > "${gitDir}/config.worktree"`,
      ],
      [
        'repoint its commondir',
        (_common: string, gitDir: string) =>
          `echo /tmp/evil > "${gitDir}/commondir"`,
      ],
      [
        'write object alternates',
        (common: string) =>
          `echo /tmp/evil >> "${common}/objects/info/alternates"`,
      ],
    ])('a linked worktree may not %s', async (_name, command) => {
      const common = canonicalPath(join(repo, '.git'));
      const gitDir = join(common, 'worktrees', 'feature');
      const mainBefore = git(repo, 'rev-parse', 'main');
      const configBefore = readFileSync(join(common, 'config'), 'utf8');
      const pointerBefore = readFileSync(join(worktree, '.git'), 'utf8');
      const commondirBefore = readFileSync(join(gitDir, 'commondir'), 'utf8');
      const result = await confined(
        worktree,
        `cd "${worktree}" && ${command(common, gitDir)}`,
      );
      expect(result.status).not.toBe(0);
      expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
      expect(git(repo, 'branch', '--list', 'other')).toBe('');
      expect(existsSync(join(common, 'hooks', 'pre-commit'))).toBe(false);
      expect(existsSync(join(gitDir, 'config.worktree'))).toBe(false);
      expect(existsSync(join(common, 'objects', 'info', 'alternates'))).toBe(
        false,
      );
      expect(readFileSync(join(common, 'config'), 'utf8')).toBe(configBefore);
      expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(pointerBefore);
      expect(readFileSync(join(gitDir, 'commondir'), 'utf8')).toBe(
        commondirBefore,
      );
    });

    test.each([
      ['write a hook', (g: string) => `echo x > "${g}/hooks/post-checkout"`],
      ['write its config', (g: string) => `echo x >> "${g}/config"`],
      ['write info', (g: string) => `echo x >> "${g}/info/exclude"`],
      [
        'add a commondir redirect',
        (g: string) => `echo /tmp/evil > "${g}/commondir"`,
      ],
      [
        'add object alternates',
        (g: string) => `echo /tmp/evil >> "${g}/objects/info/alternates"`,
      ],
      [
        "repoint another worktree's gitdir",
        (g: string) => `echo /tmp/evil > "${g}/worktrees/feature/gitdir"`,
      ],
      [
        "add a submodule's config",
        (g: string) =>
          `mkdir -p "${g}/modules/sub" && echo "[core]" > "${g}/modules/sub/config"`,
      ],
      ['create a branch', () => 'git branch other'],
      ['rename the .git', (g: string) => `mv "${g}" "${g}-moved"`],
      ['remove the .git', (g: string) => `rm -rf "${g}"`],
    ])(
      'a checkout whose .git is inside the workspace cannot %s',
      async (_label, command) => {
        const dotGit = canonicalPath(join(repo, '.git'));
        const configBefore = readFileSync(join(dotGit, 'config'), 'utf8');
        const mainBefore = git(repo, 'rev-parse', 'main');
        const gitdirBefore = readFileSync(
          join(dotGit, 'worktrees', 'feature', 'gitdir'),
          'utf8',
        );
        const result = await confined(
          repo,
          `cd "${repo}" && ${command(dotGit)}`,
        );
        expect(result.status).not.toBe(0);
        expect(lstatSync(dotGit).isDirectory()).toBe(true);
        expect(existsSync(`${dotGit}-moved`)).toBe(false);
        expect(readFileSync(join(dotGit, 'config'), 'utf8')).toBe(configBefore);
        expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
        expect(git(repo, 'branch', '--list', 'other')).toBe('');
        for (const planted of [
          join(dotGit, 'commondir'),
          join(dotGit, 'modules'),
          join(dotGit, 'hooks', 'post-checkout'),
          join(dotGit, 'objects', 'info', 'alternates'),
        ])
          expect(existsSync(planted), planted).toBe(false);
        expect(
          readFileSync(join(dotGit, 'worktrees', 'feature', 'gitdir'), 'utf8'),
        ).toBe(gitdirBefore);
      },
    );

    test('a checkout whose .git is inside the workspace still has a writable workspace', async () => {
      const result = await confined(
        repo,
        `set -e; cd "${repo}"; echo m > m.txt; git status --porcelain`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('m.txt');
      rmSync(join(repo, 'm.txt'), { force: true });
    });

    test('secret stores and Station data cannot be read; Station installs stay readable', async () => {
      for (const [secret, refusal] of [
        // Inside a hidden directory: an empty mount, so no such file.
        [join(home, '.ssh', 'id_ed25519'), /No such file or directory/],
        // A hidden file: `/dev/null` on a nodev mount, so opening it fails.
        [join(home, '.netrc'), /Permission denied/],
        [join(stationHome, 'station.sqlite'), /No such file or directory/],
      ] as const) {
        const result = await confined(worktree, `cat "${secret}"`);
        expect(result.status, secret).not.toBe(0);
        expect(result.stderr, secret).toMatch(refusal);
        expect(result.stdout, secret).toBe('');
      }
      const installed = await confined(
        worktree,
        `cat "${join(stationRoot, 'installs', 'stable', 'engine.js')}"`,
      );
      expect(installed.status).toBe(0);
      expect(installed.stdout).toBe('installed\n');
    });

    test.each([
      ['an SSH key', () => join(home, '.ssh', 'id_ed25519'), 'not a real key'],
      [
        'AWS credentials',
        () => join(home, '.aws', 'credentials'),
        'fixture aws',
      ],
      [
        'the gh login',
        () => join(home, '.config', 'gh', 'hosts.yml'),
        'fixture gh',
      ],
      ['a netrc file', () => join(home, '.netrc'), 'machine fixture'],
      [
        "the operator's Claude credential file",
        () => join(home, '.claude', '.credentials.json'),
        'fixture',
      ],
      [
        "Station's runtime home",
        () => join(stationHome, 'station.sqlite'),
        'station data',
      ],
      [
        "Station's root, outside the runtime home",
        () => join(stationRoot, 'instances.json'),
        'station root',
      ],
    ])(
      '%s does not reveal its content, however it is spelled',
      async (_label, secretOf, marker) => {
        const secret = secretOf();
        // Readable from outside: the denial below is the sandbox's.
        expect(readFileSync(secret, 'utf8')).toContain(marker);
        const link = join(outside, `link-${secret.length}`);
        rmSync(link, { force: true });
        symlinkSync(secret, link);
        const spellings = [
          secret,
          link,
          `/proc/self/root${secret}`,
          secret.replace(home, `${home}/../${home.split('/').pop()}`),
        ];
        for (const spelling of spellings) {
          const result = await confined(worktree, `cat "${spelling}"`);
          expect(result.status, spelling).not.toBe(0);
          expect(result.stdout, spelling).not.toContain(marker);
        }
      },
    );

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
      // And this host's real home folder, by creating a new file that would
      // be removed again if the sandbox ever let it through.
      const probeFile = join(
        homedir(),
        `.station-bubblewrap-probe-${process.pid}`,
      );
      const real = await confined(worktree, `echo x > "${probeFile}"`);
      const leaked = existsSync(probeFile);
      if (leaked) rmSync(probeFile, { force: true });
      expect(real.status).not.toBe(0);
      expect(leaked).toBe(false);
    });

    test.each([
      [
        'write its settings',
        (w: string) => `echo '{"hooks":{}}' > "${w}/.claude/settings.json"`,
      ],
      [
        'add local settings',
        (w: string) => `echo '{}' > "${w}/.claude/settings.local.json"`,
      ],
      [
        'rename it away',
        (w: string) => `mv "${w}/.claude" "${w}/claude-moved"`,
      ],
      ['remove it', (w: string) => `rm -rf "${w}/.claude"`],
    ])(
      'an existing engine configuration directory at the workspace root is read-only: a confined process cannot %s',
      async (_label, script) => {
        const settings = join(worktree, '.claude', 'settings.json');
        const before = contentOf(settings);
        const result = await confined(worktree, script(worktree));
        expect(result.status).not.toBe(0);
        expect(contentOf(settings)).toBe(before);
        expect(
          existsSync(join(worktree, '.claude', 'settings.local.json')),
        ).toBe(false);
        expect(existsSync(join(worktree, 'claude-moved'))).toBe(false);
      },
    );

    test('a new engine configuration directory can be created in the workspace: a stated difference from Seatbelt', async () => {
      // Documented gap: a mount covers only a path that exists, so creating
      // a `.codex` or `.claude` where none was is not denied. Pinned so a
      // change is noticed.
      const result = await confined(
        worktree,
        `mkdir -p "${worktree}/pkg/.codex" && echo x > "${worktree}/pkg/.codex/config.toml"`,
      );
      const planted = existsSync(
        join(worktree, 'pkg', '.codex', 'config.toml'),
      );
      rmSync(join(worktree, 'pkg'), { recursive: true, force: true });
      expect(result.status).toBe(0);
      expect(planted).toBe(true);
    });

    test('the session temp directory is writable and the confined env points at it', async () => {
      const result = await confined(
        worktree,
        'echo t > "$TMPDIR/t" && test "$CLAUDE_CONFIG_DIR" != "" && test -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR"',
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.launch.writeGrants).toEqual([
        'station-config',
        'station-temp',
        'workspace',
      ]);
    });

    test('processes outside the sandbox are invisible and cannot be signalled', async () => {
      const outsider = spawn('/bin/sleep', ['30'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const pid = outsider.pid!;
      try {
        // No process in the sandbox's /proc runs the outsider's command, and
        // its pid (from the host's numbering) reaches nothing.
        const denied = await confined(
          worktree,
          [
            'for f in /proc/[0-9]*/cmdline; do tr "\\000" " " < "$f"; echo; done > "$TMPDIR/seen"',
            'if grep -q "^/bin/sleep 30" "$TMPDIR/seen"; then exit 3; fi',
            `if kill -0 ${pid} 2>/dev/null; then exit 4; fi`,
          ].join('\n'),
        );
        expect(denied.stderr).toBe('');
        expect(denied.status).toBe(0);
        const own = await confined(
          worktree,
          'sleep 30 & child=$!; kill $child',
        );
        expect(own.status).toBe(0);
      } finally {
        outsider.kill();
      }
    });

    test('a nested user namespace cannot be created inside, so the mounts cannot be rearranged', async (ctx) => {
      // Positive control: the same command creates one outside the sandbox,
      // so the refusal below is the sandbox's.
      const control = spawnSync('unshare', ['--user', '/bin/true'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (control.status !== 0) {
        process.stderr.write(
          `\n[bubblewrap.process] SKIPPED nested user namespace denial: unshare cannot create one even outside the sandbox here (${control.error?.message ?? control.stderr.trim()})\n`,
        );
        ctx.skip('unshare cannot create a user namespace outside the sandbox');
      }
      const result = await confined(worktree, 'unshare --user /bin/true');
      expect(result.status).not.toBe(0);
    });

    test('the confined process runs with no_new_privs, so a setuid program gains nothing', async () => {
      const result = await confined(
        worktree,
        "grep '^NoNewPrivs:' /proc/self/status",
      );
      expect(result.stdout).toMatch(/^NoNewPrivs:\s+1$/m);
    });

    test('a hidden file cannot be hard-linked into the workspace', async () => {
      for (const secret of [
        join(home, '.ssh', 'id_ed25519'),
        join(home, '.netrc'),
      ]) {
        const target = join(worktree, 'hard');
        const result = await confined(worktree, `ln "${secret}" "${target}"`);
        const linked = existsSync(target) ? readFileSync(target, 'utf8') : '';
        rmSync(target, { force: true });
        expect(result.status, secret).not.toBe(0);
        expect(linked, secret).toBe('');
      }
    });

    test('a hard link made outside the sandbox beforehand is readable: an accepted residual', async () => {
      // Documented gap, as with Seatbelt: the sandbox hides paths, and a
      // hard link is another path to the same file. Pinned so a change is
      // noticed.
      const secret = join(home, '.ssh', 'id_ed25519');
      const prelinked = join(worktree, 'prelinked');
      rmSync(prelinked, { force: true });
      execFileSync('ln', [secret, prelinked], { windowsHide: true });
      try {
        const read = await confined(worktree, `cat "${prelinked}"`);
        expect(read.status).toBe(0);
        expect(read.stdout).toBe('not a real key\n');
      } finally {
        rmSync(prelinked, { force: true });
      }
    });

    /** A client that exits 0 once `path` accepts a connection, else 3. */
    function connectScript(path: string): string {
      const client = `require('net').connect(${JSON.stringify(path)}).on('connect',()=>process.exit(0)).on('error',(e)=>{console.error(e.code);process.exit(3)})`;
      return `"${process.execPath}" -e "${client.replaceAll('"', '\\"')}"`;
    }

    test('a listening socket at a hidden path refuses a connection from inside', async () => {
      // A daemon socket the operator's user may use, created before the
      // start where the sandbox hides it (the user's Docker socket
      // directory), and a control socket outside every hidden path.
      const hiddenDir = join(home, '.docker', 'run');
      mkdirSync(hiddenDir, { recursive: true });
      const hiddenSocket = join(hiddenDir, 'docker.sock');
      const controlSocket = join(outside, 'control.sock');
      const servers = [hiddenSocket, controlSocket].map((path) => {
        rmSync(path, { force: true });
        // The clients only connect; each is closed at once.
        const server = createServer((socket) => {
          socket.on('error', () => undefined);
          socket.destroy();
        });
        server.listen(path);
        return server;
      });
      try {
        await Promise.all(
          servers.map(
            (server) =>
              new Promise((resolve) => server.once('listening', resolve)),
          ),
        );
        // Positive controls: both accept outside, and connect works inside.
        const reachable = spawnSync(
          '/bin/sh',
          ['-c', connectScript(hiddenSocket)],
          { encoding: 'utf8', windowsHide: true },
        );
        expect(reachable.status, reachable.stderr).toBe(0);
        const control = await confined(worktree, connectScript(controlSocket));
        expect(control.status, control.stderr).toBe(0);
        const hidden = await confined(worktree, connectScript(hiddenSocket));
        expect(hidden.status).toBe(3);
        expect(hidden.stderr).toMatch(/ECONNREFUSED|ENOENT|ENOTSOCK|EACCES/);
      } finally {
        for (const server of servers) server.close();
      }
    });

    test("the host's Docker socket refuses a connection from inside", async (ctx) => {
      // Runs where the Docker socket exists and this user can connect to it
      // outside the sandbox (a docker group member, or a test harness that
      // made one); the refusal inside is then the sandbox's.
      const socket = canonicalPath('/run/docker.sock');
      const outsideConnect = existsSync(socket)
        ? spawnSync('/bin/sh', ['-c', connectScript(socket)], {
            encoding: 'utf8',
            windowsHide: true,
          })
        : undefined;
      if (outsideConnect?.status !== 0) {
        process.stderr.write(
          `\n[bubblewrap.process] SKIPPED Docker socket denial: no Docker socket this user can connect to outside the sandbox (${outsideConnect ? outsideConnect.stderr.trim() : 'none'})\n`,
        );
        ctx.skip('no Docker socket this user can reach outside the sandbox');
      }
      const inside = await confined(worktree, connectScript(socket));
      expect(inside.status).toBe(3);
    });

    test('an existing .git is read-only even when its layout cannot be read', async () => {
      const scratch = join(root, 'unreadable-git');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, '.git'), 'not a git pointer\n');
      const result = await confined(
        scratch,
        `echo "gitdir: /tmp/evil" > "${scratch}/.git"`,
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(scratch, '.git'), 'utf8')).toBe(
        'not a git pointer\n',
      );
    });

    test('a granted path does not grant its sibling that shares the prefix', async () => {
      const sibling = `${worktree}-evil`;
      mkdirSync(sibling, { recursive: true });
      const result = await confined(worktree, `echo x > "${sibling}/x"`);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(sibling, 'x'))).toBe(false);
    });

    test.skipIf(!claudeExecutable)(
      // One title on every host, so a skipped run reports the same id (#4772).
      'the installed Claude Code answers its handshake from inside the sandbox, and the provider observes it confined',
      async () => {
        // A fake env credential: no request reaches a model, and the
        // operator's own login is never involved.
        const launch = await prepareConfinedClaudeLaunch({
          workspace: canonicalPath(worktree),
          configDir: join(stationHome, 'confined-homes', 'claude'),
          stationHome,
          stationRoot,
          mechanism: 'bubblewrap',
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
        expect(spawned?.command).toBe(BUBBLEWRAP);
        expect(spawned?.args).toContain(claudeExecutable);
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
  },
);
