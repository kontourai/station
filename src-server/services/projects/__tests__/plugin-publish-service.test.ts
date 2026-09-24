/**
 * Plugin publishing as an export (#2374, epic #2323 S6), with real git and
 * real bare repositories, and no network.
 *
 * "The remote" is a bare repository reached through a GLOBAL `insteadOf`
 * (the operator's own routing, which Station honours), so the production
 * guard validates an ordinary https address while the push lands somewhere
 * this test can read. The operator's identity lives in that same throwaway
 * global config.
 *
 * Every git process the service starts is recorded (the real `execGit`
 * still runs it), so each probe can show that none of them ran in, or named
 * a path inside, the Project folder; and the folder, `.git` included, is
 * fingerprinted before and after to show nothing under it was written.
 *
 * The probes ported from the three review rounds of the first design
 * (branch `feat/plugin-publish-git-s6`) are marked with their round.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: string[]; cwd: unknown }>,
}));

vi.mock('../../../utils/git-exec.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/git-exec.js')>();
  const record =
    <A extends unknown[], R>(fn: string, real: (...args: A) => R) =>
    (...args: A): R => {
      const [argv, opts] = args as unknown as [
        string[] | string,
        { cwd?: unknown } | string[] | undefined,
      ];
      recorded.calls.push({
        fn,
        args: Array.isArray(argv)
          ? argv
          : [argv, ...((opts as string[]) ?? [])],
        cwd: Array.isArray(opts) ? undefined : opts?.cwd,
      });
      return real(...args);
    };
  return {
    ...actual,
    execGit: record('execGit', actual.execGit),
    execGitSync: record('execGitSync', actual.execGitSync),
    spawnGit: record('spawnGit', actual.spawnGit),
    execGitContextCommand: record(
      'execGitContextCommand',
      actual.execGitContextCommand,
    ),
  };
});

const { inspectPluginPublish, publishPlugin, summarizePluginPublish } =
  await import('../plugin-publish-service.js');
const { unsafeRelativePathReason } = await import(
  '../plugin-publish-snapshot.js'
);
const { exportFailureCode } = await import('../plugin-publish-export.js');

const REMOTE_URL = 'https://git.example.test/acme/pulse.git';
const ATTACKER_URL = 'https://git.example.test/acme/attacker.git';
const OPTIONS = { allowFileProtocol: true } as const;
const SECRET = 'OUTSIDE-THE-FOLDER-SECRET';

let root: string;
let folder: string;
let bare: string;
let attacker: string;
let outside: string;
let marker: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The folder's own repository is built by the TEST, as its author
    // would; the global identity is Station's, so it gets its own.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Folder Author',
      GIT_AUTHOR_EMAIL: 'folder@example.test',
      GIT_COMMITTER_NAME: 'Folder Author',
      GIT_COMMITTER_EMAIL: 'folder@example.test',
    },
  }).trim();
}

function heads(repo: string): string {
  return git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

/** Every path in the pushed tree, with its blob's content. */
function pushedFiles(ref = 'refs/heads/main'): Record<string, string> {
  const listing = git(bare, ['ls-tree', '-r', '-z', '--name-only', ref]);
  const files: Record<string, string> = {};
  for (const path of listing.split('\0').filter(Boolean)) {
    files[path] = git(bare, ['cat-file', 'blob', `${ref}:${path}`]);
  }
  return files;
}

/** A script that records that it ran, then behaves like `cat`. */
function markerScript(): string {
  const script = join(root, 'planted.sh');
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {
    mode: 0o755,
  });
  return script;
}

/** Type, size, mode, mtime and content (or link target) of every entry
 * under `dir`, links not followed. */
function fingerprint(dir: string): string {
  const lines: string[] = [];
  const walk = (path: string, rel: string) => {
    const status = lstatSync(path);
    let body = '';
    if (status.isSymbolicLink()) body = `-> ${readlinkSync(path)}`;
    else if (status.isFile()) {
      body = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    lines.push(
      `${rel} ${status.mode.toString(8)} ${status.size} ${status.mtimeMs} ${body}`,
    );
    if (status.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name), rel === '' ? name : `${rel}/${name}`);
      }
    }
  };
  walk(dir, '');
  return lines.join('\n');
}

/** No git process ran in the folder, or named anything under it. */
function expectNoGitTouchedFolder(): void {
  expect(recorded.calls.length).toBeGreaterThan(0);
  // The folder as given and as macOS's /var -> /private/var link spells it.
  const spellings = [folder, folder.replace(/^\/private\//, '/')];
  for (const call of recorded.calls) {
    expect(call.fn).toBe('execGit');
    // Always Station's own temporary directory (removed by now).
    expect(String(call.cwd)).toMatch(/station-plugin-publish-[^/]+$/);
    for (const text of [String(call.cwd), ...call.args]) {
      for (const spelling of spellings) {
        expect(text.includes(spelling)).toBe(false);
      }
    }
  }
}

/**
 * Runs `publish` with the folder's `.git` unreadable (mode 000), so a read
 * of it anywhere, by git or by Station, would fail the publish.
 */
async function withSealedGitDir<T>(publish: () => Promise<T>): Promise<T> {
  const gitDir = join(folder, '.git');
  const mode = lstatSync(gitDir).mode & 0o7777;
  chmodSync(gitDir, 0o000);
  try {
    return await publish();
  } finally {
    chmodSync(gitDir, mode);
  }
}

function writePlugin(): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({ name: 'pulse', version: '1.0.0' }),
  );
  writeFileSync(join(folder, 'index.ts'), 'export {};\n');
}

const REQUEST = {
  remoteUrl: REMOTE_URL,
  branch: 'main',
  message: 'Publish pulse 1.0.0',
};

beforeEach(() => {
  recorded.calls.length = 0;
  root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-plugin-publish-service-')),
  );
  folder = join(root, 'pulse');
  bare = join(root, 'remote.git');
  attacker = join(root, 'attacker.git');
  outside = join(root, 'outside');
  marker = join(root, 'planted-ran');
  writePlugin();
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.ts'), `${SECRET}\n`);
  // `main` explicitly: a host with no `init.defaultBranch` (a CI runner) would
  // leave the bare HEAD on `master`, and a clone of it would start unborn.
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', attacker]);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(
    globalConfig,
    [
      '[user]',
      '\tname = Station Operator',
      '\temail = operator@example.test',
      '[init]',
      '\tdefaultBranch = main',
      `[url "${bare}"]`,
      `\tinsteadOf = ${REMOTE_URL}`,
      `[url "${attacker}"]`,
      `\tinsteadOf = ${ATTACKER_URL}`,
      '',
    ].join('\n'),
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  // A test may leave a folder unreadable or unwritable.
  execFileSync('chmod', ['-R', 'u+rwx', root]);
  rmSync(root, { recursive: true, force: true });
});

/** Seeds the remote's `main` with one commit from a separate clone. */
function seedRemote(files: Record<string, string>, message = 'seed'): string {
  const clone = join(root, `clone-${Date.now()}-${Math.random()}`);
  git(root, ['clone', '--quiet', bare, clone]);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(clone, path), content);
  }
  git(clone, ['add', '--all']);
  git(clone, ['commit', '--quiet', '-m', message]);
  git(clone, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  const tip = git(clone, ['rev-parse', 'HEAD']);
  rmSync(clone, { recursive: true, force: true });
  return tip;
}

describe('history: the commit is a child of the remote tip (owner decision)', () => {
  test('a first publish creates the branch with a root commit', async () => {
    const before = fingerprint(folder);
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.result.parent).toBeNull();
    expect(heads(bare)).toBe(`refs/heads/main ${published.result.commit}`);
    expect(git(bare, ['rev-list', '--parents', '-n1', 'main'])).toBe(
      published.result.commit,
    );
    expect(pushedFiles()).toEqual({
      'index.ts': 'export {};',
      'plugin.json': JSON.stringify({ name: 'pulse', version: '1.0.0' }),
    });
    expect(published.result.installSource).toBe(REMOTE_URL);
    expect(fingerprint(folder)).toBe(before);
    expectNoGitTouchedFolder();
  });

  test('a first publish to a new branch leaves the other branches alone', async () => {
    const tip = seedRemote({ 'README.md': 'hello\n' });
    const published = await publishPlugin(
      folder,
      { ...REQUEST, branch: 'release/pulse' },
      OPTIONS,
    );
    expect(published.ok && published.result.parent).toBeNull();
    const commit = published.ok ? published.result.commit : '';
    expect(heads(bare).split('\n').sort()).toEqual(
      [`refs/heads/main ${tip}`, `refs/heads/release/pulse ${commit}`].sort(),
    );
    expect(published.ok && published.result.installSource).toBe(
      `${REMOTE_URL}#release/pulse`,
    );
    expectNoGitTouchedFolder();
  });

  test('a publish to an existing branch parents its commit on the fetched tip', async () => {
    const tip = seedRemote({ 'README.md': 'from elsewhere\n' });
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.result.parent).toBe(tip);
    expect(git(bare, ['rev-parse', 'main^'])).toBe(tip);
    expect(git(bare, ['rev-parse', 'main'])).toBe(published.result.commit);
    // An export: the commit holds the folder's files, not a merge.
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      'index.ts',
      'plugin.json',
    ]);
    expectNoGitTouchedFolder();
  });

  test('publishing unchanged files again pushes nothing', async () => {
    const first = await publishPlugin(folder, REQUEST, OPTIONS);
    const tip = first.ok ? first.result.commit : null;
    const again = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(again.ok && again.result).toMatchObject({
      commit: null,
      parent: tip,
    });
    expect(heads(bare)).toBe(`refs/heads/main ${tip}`);
  });

  test('the remote moving during the publish is refused, and nothing is overwritten', async () => {
    const tip = seedRemote({ 'README.md': 'v1\n' });
    let moved = '';
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        beforePush: () => {
          moved = seedRemote({ 'README.md': 'v2\n' }, 'someone else');
        },
      },
    });
    expect(moved).not.toBe('');
    expect(git(bare, ['rev-parse', `${moved}^`])).toBe(tip);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'remote-moved' },
    });
    expect(heads(bare)).toBe(`refs/heads/main ${moved}`);
  });

  test.each([
    ['deleted', false],
    ['deleted and collected', true],
  ])(
    'the branch %s during the publish is refused as moved',
    async (_label, collect) => {
      seedRemote({ 'README.md': 'v1\n' });
      const published = await publishPlugin(folder, REQUEST, {
        ...OPTIONS,
        testHooks: {
          beforePush: () => {
            git(bare, ['update-ref', '-d', 'refs/heads/main']);
            if (collect) {
              git(bare, ['reflog', 'expire', '--expire=now', '--all']);
              git(bare, ['gc', '--quiet', '--prune=now']);
            }
          },
        },
      });
      expect(published).toEqual({
        ok: false,
        refusal: { code: 'remote-moved' },
      });
      expect(heads(bare)).toBe('');
    },
  );

  test('a server that cannot serve a shallow fetch (dumb HTTP) is named, not a generic failure', () => {
    expect(
      exportFailureCode({
        stderr:
          'fatal: dumb http transport does not support shallow capabilities',
      }),
    ).toBe('remote-unsupported');
    expect(
      exportFailureCode({
        stderr: ' ! [remote rejected] x -> main (shallow update not allowed)',
      }),
    ).toBe('remote-moved');
  });

  test('the remote rewound during the publish is refused too, not fast-forwarded over', async () => {
    const older = seedRemote({ 'README.md': 'v1\n' });
    const tip = seedRemote({ 'README.md': 'v2\n' }, 'v2');
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        // Someone force-pushes main back to its parent. The older tip is an
        // ancestor of the new commit, so a push from a repository that also
        // held it would fast-forward and bring the dropped commit back;
        // Station's holds only the fetched tip (depth 1), so git refuses.
        beforePush: () => {
          git(bare, ['update-ref', 'refs/heads/main', older]);
        },
      },
    });
    expect(git(bare, ['rev-parse', `${tip}^`])).toBe(older);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'remote-moved' },
    });
    expect(heads(bare)).toBe(`refs/heads/main ${older}`);
  });

  test('a branch created by someone else during a first publish is refused', async () => {
    let created = '';
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        beforePush: () => {
          created = seedRemote({ 'README.md': 'first\n' });
        },
      },
    });
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'remote-moved' },
    });
    expect(heads(bare)).toBe(`refs/heads/main ${created}`);
  });
});

describe('the committer is the operator’s global identity', () => {
  test('never the Project folder’s own user.name, nor its author', async () => {
    git(folder, ['init', '--quiet']);
    git(folder, ['config', 'user.name', 'Folder Person']);
    git(folder, ['config', 'user.email', 'folder-person@example.test']);
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok && published.result.committer).toEqual({
      name: 'Station Operator',
      email: 'operator@example.test',
    });
    expect(
      git(bare, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'main']),
    ).toBe(
      'Station Operator <operator@example.test>|Station Operator <operator@example.test>|Publish pulse 1.0.0',
    );
    expectNoGitTouchedFolder();
  });

  test('no global identity is refused before anything is pushed', async () => {
    const bareOnly = join(root, 'gitconfig-no-user');
    writeFileSync(bareOnly, `[url "${bare}"]\n\tinsteadOf = ${REMOTE_URL}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', bareOnly);
    git(folder, ['init', '--quiet']);
    git(folder, ['config', 'user.name', 'Folder Person']);
    git(folder, ['config', 'user.email', 'folder-person@example.test']);
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'git-identity-missing' },
    });
    expect(heads(bare)).toBe('');
  });
});

describe('what may be published', () => {
  test('secret-looking names and private-key blocks are refused, named', async () => {
    writeFileSync(join(folder, '.env'), 'TOKEN=abc\n');
    writeFileSync(
      join(folder, 'notes.txt'),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n',
    );
    const expected = [
      { path: '.env', reason: 'environment file' },
      { path: 'notes.txt', reason: 'contains a private key' },
    ];
    const view = await inspectPluginPublish(folder, OPTIONS);
    expect(view.plugin && view.secrets).toEqual(expected);
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'secrets', secrets: expected },
    });
    expect(heads(bare)).toBe('');
  });

  test('a .gitattributes that names a filter (git-lfs) is refused, named', async () => {
    mkdirSync(join(folder, 'assets'));
    writeFileSync(
      join(folder, 'assets', '.gitattributes'),
      '# large files\n*.bin filter=lfs diff=lfs merge=lfs -text\n',
    );
    writeFileSync(join(folder, 'assets', 'model.bin'), 'binary');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'filter-attributes', paths: ['assets/.gitattributes'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('.gitignore is honoured, and an ignored folder is never read', async () => {
    writeFileSync(join(folder, '.gitignore'), 'node_modules/\n*.log\n');
    mkdirSync(join(folder, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', 'dep', 'id_rsa'), 'x');
    // Unreadable: reading it at all would fail the publish.
    chmodSync(join(folder, 'node_modules'), 0o000);
    writeFileSync(join(folder, 'debug.log'), 'noise');
    mkdirSync(join(folder, 'lib'));
    writeFileSync(join(folder, 'lib', '.gitignore'), '!keep.log\n');
    writeFileSync(join(folder, 'lib', 'keep.log'), 'kept');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      '.gitignore',
      'index.ts',
      'lib/.gitignore',
      'lib/keep.log',
      'plugin.json',
    ]);
  });

  test('an upper-case .GITATTRIBUTES naming a filter is refused too', async () => {
    writeFileSync(join(folder, '.GITATTRIBUTES'), '*.bin filter=lfs -text\n');
    writeFileSync(join(folder, 'big.bin'), 'RAW\n');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'filter-attributes', paths: ['.GITATTRIBUTES'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('an upper-case .GITIGNORE is honoured', async () => {
    writeFileSync(join(folder, '.GITIGNORE'), 'private-notes.md\n');
    writeFileSync(join(folder, 'private-notes.md'), 'notes\n');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      '.GITIGNORE',
      'index.ts',
      'plugin.json',
    ]);
  });

  test('a file larger than the size limit is refused without being read', async () => {
    // Sparse: 1 GiB on paper, nothing on disk.
    const big = join(folder, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 1024 * 1024 * 1024);
    const read: string[] = [];
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: { afterRead: (path) => void read.push(path) },
    });
    expect(published).toEqual({ ok: false, refusal: { code: 'too-large' } });
    expect(read).not.toContain('big.bin');
    expect(heads(bare)).toBe('');
  });

  test('executable bits are published', async () => {
    writeFileSync(join(folder, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await publishPlugin(folder, REQUEST, OPTIONS);
    expect(git(bare, ['ls-tree', 'main', 'run.sh'])).toMatch(/^100755 /);
    expect(git(bare, ['ls-tree', 'main', 'index.ts'])).toMatch(/^100644 /);
  });
});

describe('special entries', () => {
  test('a link is skipped and not followed; a named pipe is skipped unopened', async () => {
    symlinkSync(join(outside, 'a.ts'), join(folder, 'linked.ts'));
    symlinkSync(outside, join(folder, 'linked-dir'));
    execFileSync('mkfifo', [join(folder, 'pipe')]);
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok && published.result.skipped).toEqual([
      { path: 'linked-dir', reason: 'symbolic-link' },
      { path: 'linked.ts', reason: 'symbolic-link' },
      { path: 'pipe', reason: 'special-file' },
    ]);
    expect(JSON.stringify(pushedFiles())).not.toContain(SECRET);
    expectNoGitTouchedFolder();
  });

  test('a file with another hard link is refused, named', async () => {
    linkSync(join(outside, 'a.ts'), join(folder, 'hard.ts'));
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'linked-file', paths: ['hard.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a name with a control character is refused, named', async () => {
    writeFileSync(join(folder, 'bad\nname.ts'), 'x');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'unsafe-path', paths: ['bad\nname.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a folder with a name git cannot hold is refused, named', async () => {
    mkdirSync(join(folder, 'bad\\dir'));
    writeFileSync(join(folder, 'bad\\dir', 'a.ts'), 'x\n');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'unsafe-path', paths: ['bad\\dir'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('an ignored file whose name git cannot hold (Finder’s Icon\\r) does not block the publish', async () => {
    // GitHub's macOS .gitignore template ignores it as `Icon?`.
    writeFileSync(join(folder, '.gitignore'), 'Icon?\n');
    writeFileSync(join(folder, 'Icon\r'), '');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      '.gitignore',
      'index.ts',
      'plugin.json',
    ]);
  });

  test('an ignored folder whose name git cannot hold does not block the publish', async () => {
    writeFileSync(join(folder, '.gitignore'), 'bad*\n');
    mkdirSync(join(folder, 'bad\\dir'));
    writeFileSync(join(folder, 'bad\\dir', 'a.ts'), 'x\n');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok).toBe(true);
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      '.gitignore',
      'index.ts',
      'plugin.json',
    ]);
  });

  test('a .git entry in any case, at any depth, is never read or published', async () => {
    mkdirSync(join(folder, 'sub', '.GIT'), { recursive: true });
    writeFileSync(join(folder, 'sub', '.GIT', 'config'), `${SECRET}\n`);
    writeFileSync(join(folder, 'sub', 'ok.ts'), 'ok');
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok && published.result.skipped).toEqual([
      { path: 'sub/.GIT', reason: 'git-metadata' },
    ]);
    expect(Object.keys(pushedFiles()).sort()).toEqual([
      'index.ts',
      'plugin.json',
      'sub/ok.ts',
    ]);
  });

  test('the path guard refuses absolute, empty, "." and ".." forms', () => {
    // No directory listing produces these; the guard still stands between
    // any path and git.
    expect(unsafeRelativePathReason('../secret')).not.toBeNull();
    expect(unsafeRelativePathReason('a/../../secret')).not.toBeNull();
    expect(unsafeRelativePathReason('./a')).not.toBeNull();
    expect(unsafeRelativePathReason('a//b')).not.toBeNull();
    expect(unsafeRelativePathReason('/etc/passwd')).not.toBeNull();
    expect(unsafeRelativePathReason('C:/x')).not.toBeNull();
    expect(unsafeRelativePathReason('a\\..\\b')).not.toBeNull();
    expect(unsafeRelativePathReason('a/.Git/config')).not.toBeNull();
    expect(unsafeRelativePathReason('a/.g\u200cit/config')).not.toBeNull();
    expect(unsafeRelativePathReason('')).not.toBeNull();
    expect(unsafeRelativePathReason('lib/index.ts')).toBeNull();
  });
});

describe('a writer racing the read (round 3: symlinked parent)', () => {
  function plantLib(): void {
    mkdirSync(join(folder, 'lib'));
    writeFileSync(join(folder, 'lib', 'a.ts'), 'inside\n');
  }

  test('a parent that is a link to outside the folder is skipped, never followed', async () => {
    symlinkSync(outside, join(folder, 'lib'));
    const published = await publishPlugin(folder, REQUEST, OPTIONS);
    expect(published.ok && published.result.skipped).toEqual([
      { path: 'lib', reason: 'symbolic-link' },
    ]);
    expect(JSON.stringify(pushedFiles())).not.toContain(SECRET);
    expectNoGitTouchedFolder();
  });

  test('a parent swapped for an outside link before the open, and back after the read, is refused', async () => {
    plantLib();
    const swap = () => {
      renameSync(join(folder, 'lib'), join(root, 'lib.real'));
      symlinkSync(outside, join(folder, 'lib'));
    };
    const restore = () => {
      rmSync(join(folder, 'lib'));
      renameSync(join(root, 'lib.real'), join(folder, 'lib'));
    };
    let swapped = false;
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        beforeOpen: (path) => {
          if (path !== 'lib/a.ts') return;
          swap();
          swapped = true;
        },
        // Swapped back before the post-read check of the parents, so only
        // the open descriptor's identity can notice.
        afterRead: (path) => {
          if (path !== 'lib/a.ts') return;
          restore();
          swapped = false;
        },
      },
    });
    expect(lstatSync(join(folder, 'lib')).isDirectory() || swapped).toBe(true);
    if (swapped) restore();
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'folder-changed', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  /** Review of #2374, MEDIUM: the link count was checked only on the open
   * descriptor. The in-folder hard link is removed just before the open (so
   * the count reads 1) and the parent swapped for a link to where the
   * other name lives, then swapped back after the read. */
  test('a hard link removed and its parent swapped before the open is refused at the walk', async () => {
    mkdirSync(join(folder, 'lib'));
    linkSync(join(outside, 'a.ts'), join(folder, 'lib', 'a.ts'));
    let swapped = false;
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        beforeOpen: (path) => {
          if (path !== 'lib/a.ts') return;
          unlinkSync(join(folder, 'lib', 'a.ts'));
          renameSync(join(folder, 'lib'), join(root, 'lib.real'));
          symlinkSync(outside, join(folder, 'lib'));
          swapped = true;
        },
        afterRead: (path) => {
          if (path !== 'lib/a.ts') return;
          rmSync(join(folder, 'lib'));
          renameSync(join(root, 'lib.real'), join(folder, 'lib'));
          swapped = false;
        },
      },
    });
    if (swapped) {
      rmSync(join(folder, 'lib'));
      renameSync(join(root, 'lib.real'), join(folder, 'lib'));
    }
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'linked-file', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a file moved out of the folder during the read is refused', async () => {
    plantLib();
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        // Moved (same inode, one link) out through a swapped parent, and
        // the parent put back without it: only the file's own name,
        // looked up again after the read, is gone.
        beforeOpen: (path) => {
          if (path !== 'lib/a.ts') return;
          mkdirSync(join(root, 'lens'));
          renameSync(join(folder, 'lib', 'a.ts'), join(root, 'lens', 'a.ts'));
          renameSync(join(folder, 'lib'), join(root, 'lib.real'));
          symlinkSync(join(root, 'lens'), join(folder, 'lib'));
        },
        afterRead: (path) => {
          if (path !== 'lib/a.ts') return;
          rmSync(join(folder, 'lib'));
          renameSync(join(root, 'lib.real'), join(folder, 'lib'));
        },
      },
    });
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'folder-changed', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a second hard link added after the read is refused', async () => {
    plantLib();
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        afterRead: (path) => {
          if (path === 'lib/a.ts') {
            linkSync(join(folder, 'lib', 'a.ts'), join(root, 'second-name'));
          }
        },
      },
    });
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'linked-file', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a file that grows between its size check and its read is refused', async () => {
    plantLib();
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        afterStat: (path) => {
          if (path === 'lib/a.ts') {
            appendFileSync(join(folder, 'lib', 'a.ts'), 'appended\n');
          }
        },
      },
    });
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'folder-changed', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });

  test('a parent turned into a link during the read is refused even when it leads to the same file', async () => {
    plantLib();
    const published = await publishPlugin(folder, REQUEST, {
      ...OPTIONS,
      testHooks: {
        afterRead: (path) => {
          if (path !== 'lib/a.ts') return;
          renameSync(join(folder, 'lib'), join(folder, 'lib.moved'));
          symlinkSync(join(folder, 'lib.moved'), join(folder, 'lib'));
        },
      },
    });
    expect(published).toEqual({
      ok: false,
      refusal: { code: 'folder-changed', paths: ['lib/a.ts'] },
    });
    expect(heads(bare)).toBe('');
  });
});

describe('the folder’s .git is never read or written (rounds 1-3)', () => {
  /** Round 2: the folder laid out as its own bare repository, whose config
   * names a filter and rewrites the remote to the attacker. */
  test('a bare-layout folder: no filter runs and the push goes only to the validated address', async () => {
    mkdirSync(join(folder, '.git'));
    writeFileSync(
      join(folder, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n',
    );
    mkdirSync(join(folder, 'objects'));
    mkdirSync(join(folder, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(folder, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(folder, 'config'),
      [
        '[core]',
        '\tbare = false',
        `\tworktree = ${folder}`,
        '[filter "x"]',
        `\tclean = ${markerScript()}`,
        `[url "${attacker}"]`,
        `\tinsteadOf = ${REMOTE_URL}`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(folder, '.git', 'info-attributes'), '* filter=x\n');
    const before = fingerprint(folder);
    const view = await inspectPluginPublish(folder, OPTIONS);
    expect(view.plugin).toEqual({ name: 'pulse', version: '1.0.0' });
    const published = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(published.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(heads(attacker)).toBe('');
    // The layout's files are just files in an export.
    expect(pushedFiles().HEAD).toBe('ref: refs/heads/main');
    expect(fingerprint(folder)).toBe(before);
    expectNoGitTouchedFolder();
  });

  /** Round 3: an index entry naming `..` read a file outside the folder. */
  test('a ".." entry planted in the folder’s index reaches nothing', async () => {
    mkdirSync(join(folder, 'aa'));
    writeFileSync(join(folder, 'aa', 'secret.txt'), 'inside');
    git(folder, ['init', '--quiet']);
    git(folder, ['add', '--all']);
    writeFileSync(join(folder, 'secret.txt'), 'x');
    writeFileSync(join(root, 'secret.txt'), `${SECRET}\n`);
    const indexPath = join(folder, '.git', 'index');
    const index = readFileSync(indexPath);
    const at = index.indexOf('aa/secret.txt');
    expect(at).toBeGreaterThan(0);
    index.write('../secret.txt', at);
    createHash('sha1')
      .update(index.subarray(0, index.length - 20))
      .digest()
      .copy(index, index.length - 20);
    writeFileSync(indexPath, index);
    const before = fingerprint(folder);
    const published = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(published.ok).toBe(true);
    expect(JSON.stringify(pushedFiles())).not.toContain(SECRET);
    expect(fingerprint(folder)).toBe(before);
    expectNoGitTouchedFolder();
  });

  /** Round 3: git's writes into the folder's `.git` followed planted links
   * (a copy-back overwrote an `authorized_keys`). */
  test('links planted under .git are never followed or written through', async () => {
    git(folder, ['init', '--quiet']);
    const keys = join(outside, 'authorized_keys');
    writeFileSync(keys, 'ssh-ed25519 AAAA operator\n');
    mkdirSync(join(outside, 'heads'));
    mkdirSync(join(outside, 'pack'));
    rmSync(join(folder, '.git', 'refs', 'heads'), {
      recursive: true,
      force: true,
    });
    symlinkSync(keys, join(folder, '.git', 'index'));
    symlinkSync(join(outside, 'heads'), join(folder, '.git', 'refs', 'heads'));
    rmSync(join(folder, '.git', 'objects', 'pack'), {
      recursive: true,
      force: true,
    });
    symlinkSync(join(outside, 'pack'), join(folder, '.git', 'objects', 'pack'));
    const outsideBefore = fingerprint(outside);
    const before = fingerprint(folder);
    const published = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(published.ok).toBe(true);
    expect(fingerprint(outside)).toBe(outsideBefore);
    expect(fingerprint(folder)).toBe(before);
    expectNoGitTouchedFolder();
  });

  /** Round 3: fake remote-tracking refs hid a secret committed earlier from
   * the unpushed-history scan. An export pushes no folder history at all. */
  test('fake tracking refs and a secret in the folder’s history push nothing of that history', async () => {
    git(folder, ['init', '--quiet']);
    writeFileSync(join(folder, '.env'), 'TOKEN=abc\n');
    git(folder, ['add', '--all']);
    git(folder, ['commit', '--quiet', '-m', 'oops']);
    git(folder, ['rm', '--quiet', '.env']);
    git(folder, ['commit', '--quiet', '-m', 'remove it']);
    git(folder, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const folderCommits = git(folder, ['rev-list', '--all']).split('\n');
    const before = fingerprint(folder);
    const published = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(published.ok).toBe(true);
    const pushedObjects = git(bare, ['rev-list', '--objects', '--all']);
    expect(pushedObjects).not.toContain('.env');
    for (const commit of folderCommits) {
      expect(pushedObjects).not.toContain(commit);
    }
    expect(fingerprint(folder)).toBe(before);
    expectNoGitTouchedFolder();
  });

  /** Round 2: a filter named by the folder's attributes ran on commit. */
  test('filter attributes in the folder’s .git never run, and a published one is refused', async () => {
    git(folder, ['init', '--quiet']);
    git(folder, ['config', 'filter.x.clean', markerScript()]);
    writeFileSync(join(folder, '.git', 'info', 'attributes'), '* filter=x\n');
    const published = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(published.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    // The bytes on disk, not a filter's output.
    expect(pushedFiles()['index.ts']).toBe('export {};');

    writeFileSync(join(folder, '.gitattributes'), '*.ts filter=x\n');
    const refused = await withSealedGitDir(() =>
      publishPlugin(folder, REQUEST, OPTIONS),
    );
    expect(refused).toEqual({
      ok: false,
      refusal: { code: 'filter-attributes', paths: ['.gitattributes'] },
    });
    expect(existsSync(marker)).toBe(false);
    expectNoGitTouchedFolder();
  });
});

describe('the Project page’s summary', () => {
  test('reads plugin.json and runs no git', async () => {
    expect(await summarizePluginPublish(folder)).toEqual({
      plugin: { name: 'pulse', version: '1.0.0' },
    });
    expect(recorded.calls).toEqual([]);
  });

  test('a plugin.json that is a link is not followed', async () => {
    rmSync(join(folder, 'plugin.json'));
    writeFileSync(
      join(outside, 'plugin.json'),
      JSON.stringify({ name: 'elsewhere', version: '9.9.9' }),
    );
    symlinkSync(join(outside, 'plugin.json'), join(folder, 'plugin.json'));
    expect(await summarizePluginPublish(folder)).toEqual({
      plugin: null,
      reason: 'not-a-plugin',
    });
    expect(await publishPlugin(folder, REQUEST, OPTIONS)).toEqual({
      ok: false,
      refusal: { code: 'not-a-plugin' },
    });
  });
});
