/**
 * How plugin publishing runs git (epic #2323 S6, security review H1/H2/M1).
 *
 * The folder belongs to a Project, and a Project member may have written
 * anything into it, including its `.git` directory. Publishing runs git as
 * the OPERATOR, with the operator's credentials. So a repository's own
 * configuration must not be able to make git execute a program, reach a
 * transport other than https/ssh, or prompt:
 *
 * - `-c` overrides (command-line config beats every config file) switch off
 *   the repo-local execution hooks: `core.fsmonitor` (runs on `status`),
 *   `core.hooksPath` (every hook), `commit.gpgsign`/`tag.gpgsign`
 *   (`gpg.program`), `core.sshCommand`, submodule recursion.
 * - `credential.helper=` clears every helper collected from config files.
 *   The operator's own helpers, read from the SYSTEM and GLOBAL files only
 *   (`readOperatorCredentialHelpers`), are then re-added for the push:
 *   without them an https push to GitHub fails for almost everyone (Apple's
 *   git ships `osxkeychain` in its system file; `gh auth setup-git` writes a
 *   URL-scoped global helper). A repo-local helper is never re-added.
 * - `GIT_ALLOW_PROTOCOL` restricts transports to https and ssh and, unlike
 *   `protocol.allow`, overrides any per-protocol setting a config file makes
 *   (`protocol.ext.allow=always` in `.git/config` included). The `-c
 *   protocol.*` settings are kept beside it as a second statement of the
 *   same rule.
 * - `GIT_SSH_COMMAND` overrides `core.sshCommand` from any file and runs ssh
 *   in batch mode, so a host-key or passphrase prompt fails instead of
 *   hanging. The cost: an operator's own global `core.sshCommand` is not
 *   used for publishing.
 * - `GIT_ASKPASS=''` and `GIT_TERMINAL_PROMPT=0`: nothing prompts.
 * - `GIT_CONFIG_NOSYSTEM=1`.
 *
 * Belt and braces, `assertRepositoryConfigAllowed` refuses a repository
 * whose `.git/config` sets anything outside a short allowlist, whose `.git`
 * is not a plain directory, or which redirects to another git directory.
 * That check is what refuses repo-local `url.*.insteadOf` (H2): a rewrite
 * that still lands on https/ssh would otherwise send the push, with the
 * operator's credentials, somewhere the person never chose.
 */
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit, spawnGit } from '../../utils/git-exec.js';

export interface PublishGitOptions {
  /**
   * Also allow git's `file` transport. ONLY for tests, whose "remote" is a
   * bare repository in a temp folder reached through a global `insteadOf`.
   * The route refuses to be constructed with it outside Vitest.
   */
  allowFileProtocol?: boolean;
  /** `-c key=value` pairs re-adding the operator's credential helpers. */
  credentialHelpers?: readonly string[];
}

const HOOKS_DISABLED = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SSH_BATCH = 'ssh -o BatchMode=yes';

function hardeningArgs(options: PublishGitOptions): string[] {
  const settings = [
    'core.fsmonitor=false',
    `core.hooksPath=${HOOKS_DISABLED}`,
    'commit.gpgsign=false',
    'tag.gpgsign=false',
    `core.sshCommand=${SSH_BATCH}`,
    'submodule.recurse=false',
    'push.recurseSubmodules=no',
    'credential.helper=',
    ...(options.credentialHelpers ?? []),
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
    ...(options.allowFileProtocol ? ['protocol.file.allow=always'] : []),
  ];
  return settings.flatMap((setting) => ['-c', setting]);
}

function publishGitEnv(options: PublishGitOptions): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: SSH_BATCH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: options.allowFileProtocol
      ? 'https:ssh:file'
      : 'https:ssh',
  };
}

function publishGitArgs(
  args: readonly string[],
  options: PublishGitOptions,
): string[] {
  return [...hardeningArgs(options), ...args];
}

export async function runPublishGit(
  cwd: string,
  args: readonly string[],
  options: PublishGitOptions,
  timeout: number,
): Promise<string> {
  const { stdout } = await execGit(publishGitArgs(args, options), {
    cwd,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: publishGitEnv(options),
  });
  return stdout;
}

export interface StatusEntry {
  path: string;
  status: string;
}

/**
 * `git status --porcelain=v1 -z`, streamed and CAPPED (review M1): a folder
 * holding an un-ignored `node_modules` would otherwise overflow a buffered
 * read long before the path cap is checked. Stops git as soon as more than
 * `maxPaths` entries have arrived, or when `timeoutMs` passes, and reports
 * either as `tooMany`, which the caller words as "add it to .gitignore".
 */
export function streamPublishStatus(
  cwd: string,
  prefix: readonly string[],
  options: PublishGitOptions,
  limits: { maxPaths: number; timeoutMs: number },
): Promise<{ changes: StatusEntry[]; tooMany: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(
      publishGitArgs(
        [
          ...prefix,
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
        ],
        options,
      ),
      {
        cwd,
        env: publishGitEnv(options),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const changes: StatusEntry[] = [];
    let buffer = '';
    let stderr = '';
    // A rename's second token is its source path.
    let renameSource: 'record' | 'skip' | null = null;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const stop = () =>
      finish(() => {
        child.kill();
        resolve({ changes: changes.slice(0, limits.maxPaths), tooMany: true });
      });
    const timer = setTimeout(stop, limits.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      let end = buffer.indexOf('\0');
      while (end !== -1) {
        const token = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (renameSource !== null) {
          if (renameSource === 'record')
            changes.push({ status: 'D ', path: token });
          renameSource = null;
        } else if (token.length >= 4) {
          const status = token.slice(0, 2);
          changes.push({ status, path: token.slice(3) });
          if (status[0] === 'R') renameSource = 'record';
          else if (status[0] === 'C') renameSource = 'skip';
        }
        if (changes.length > limits.maxPaths) {
          stop();
          return;
        }
        end = buffer.indexOf('\0');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) =>
      finish(() => {
        if (code === 0) resolve({ changes, tooMany: false });
        else
          reject(
            Object.assign(new Error(`git status exited ${code}`), { stderr }),
          );
      }),
    );
  });
}

/**
 * The operator's credential helpers, as `-c` settings, from the system and
 * global config FILES only. Read with a temp directory as the working
 * directory and explicit `--system`/`--global`, so no repository's config
 * is consulted. A missing file or no helper yields nothing.
 */
export async function readOperatorCredentialHelpers(): Promise<string[]> {
  const settings: string[] = [];
  for (const scope of ['--system', '--global']) {
    try {
      const { stdout } = await execGit(
        ['config', scope, '--null', '--get-regexp', '^credential\\..*helper$'],
        {
          cwd: tmpdir(),
          encoding: 'utf-8',
          timeout: 5000,
          env: { GIT_TERMINAL_PROMPT: '0' },
        },
      );
      for (const record of stdout.split('\0')) {
        const newline = record.indexOf('\n');
        if (newline <= 0) continue;
        const key = record.slice(0, newline);
        const value = record.slice(newline + 1);
        // An empty value is a reset in that file; the leading reset above
        // already did that.
        if (value !== '') settings.push(`${key}=${value}`);
      }
    } catch {
      // Exit 1 means no match; any other failure means no helpers either.
    }
  }
  return settings;
}

const ALLOWED_LOCAL_CONFIG = [
  /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^remote\..+\.(?:url|fetch|pushurl)$/,
  /^branch\..+\.(?:remote|merge)$/,
  /^user\.(?:name|email)$/,
];

export type RepositoryConfigRefusal =
  | { code: 'git-dir-not-directory' }
  | { code: 'repository-config-refused'; keys: string[] };

/**
 * `absent` when the folder has no `.git`; `ok` when its `.git` is a plain
 * directory whose config holds only allowlisted keys; otherwise the refusal.
 * Reads the file with `git config --file`, which does not follow
 * `include.path` (an include is itself refused, by name).
 */
export async function checkRepositoryConfig(
  folder: string,
): Promise<'absent' | 'ok' | RepositoryConfigRefusal> {
  const gitDir = join(folder, '.git');
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(gitDir);
  } catch {
    return 'absent';
  }
  // A `.git` FILE (or link) points git at another directory, whose config
  // and hooks this check would never see.
  if (!status.isDirectory()) return { code: 'git-dir-not-directory' };
  try {
    await lstat(join(gitDir, 'commondir'));
    return { code: 'git-dir-not-directory' };
  } catch {
    // No redirect: the ordinary case.
  }
  const configPath = join(gitDir, 'config');
  try {
    await lstat(configPath);
  } catch {
    return 'ok';
  }
  const { stdout } = await execGit(
    ['config', '--file', configPath, '--null', '--name-only', '--list'],
    {
      cwd: tmpdir(),
      encoding: 'utf-8',
      timeout: 5000,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  const keys = [
    ...new Set(
      stdout
        .split('\0')
        .filter(Boolean)
        .filter((key) => !ALLOWED_LOCAL_CONFIG.some((rule) => rule.test(key))),
    ),
  ].sort();
  return keys.length === 0 ? 'ok' : { code: 'repository-config-refused', keys };
}
