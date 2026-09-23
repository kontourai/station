/**
 * Central git execution helper.
 *
 * Every production git invocation MUST go through one of the helpers here, so
 * three things are applied uniformly:
 *
 * 1. ENVIRONMENT SCRUB. An inherited `GIT_DIR` / `GIT_WORK_TREE` silently
 *    retargets every spawned `git` at the wrong repository, which has caused
 *    real `core.bare` corruption of the surrounding checkout (archive#104).
 *    The same is true of `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
 *    `GIT_CONFIG_PARAMETERS` and the rest of `INHERITED_GIT_ENV`, so those
 *    are removed from what this process INHERITED. A caller may still pass
 *    one deliberately through `opts.env` (the checkpoint store uses a
 *    temporary `GIT_INDEX_FILE`); only `GIT_DIR`/`GIT_WORK_TREE` are refused
 *    even then.
 *
 * 2. HARDENING (#2363). A Project folder can be written by people other than
 *    the operator (a shared Project member, an agent session, a synced
 *    folder), and Station runs git in it as the operator, with the
 *    operator's keys. A repository's own `.git/config` must not be able to
 *    run a program or send the operator's credentials somewhere. Every call
 *    therefore carries command-line settings, which outrank every config
 *    file:
 *
 *    - `core.fsmonitor=false`: a repo-local fsmonitor hook would otherwise
 *      run on `git status`, which the Project page calls on mount.
 *    - `core.pager=cat`, `core.editor=true`: no pager or editor program from
 *      the repository (and `GIT_PAGER`/`GIT_EDITOR` are not inherited).
 *    - `core.sshCommand` = batch-mode ssh, doubled by `GIT_SSH_COMMAND`
 *      (the environment variable outranks config; the `-c` keeps the value
 *      should a tool drop the variable). Removing only one of the two
 *      leaves the other holding the line, deliberately.
 *    - `protocol.allow=never` with https and ssh allowed. On its own that is
 *      NOT enough: a repo-local `protocol.ext.allow=always` outranks the
 *      general `protocol.allow`. `GIT_ALLOW_PROTOCOL=https:ssh` overrides
 *      every config file, and is the setting that actually holds the line
 *      against `ext::` (runs a command), `fd::` and `file://` (a push to a
 *      local path runs the TARGET repository's hooks). A plain local path is
 *      the `file` transport too. `allowFileProtocol` is the one opt-in; see
 *      {@link GitHardeningOptions}.
 *    - `safe.bareRepository=explicit`: a folder whose own files make it look
 *      like a bare repository is not treated as one by discovery.
 *    - `commit.gpgSign=false`, `tag.gpgSign=false`, `log.showSignature=false`:
 *      with signing and signature display off, nothing Station runs invokes
 *      `gpg.program`, so a repo-local program is never reached (an empty
 *      `gpg.program=` override would instead break the one commit that is
 *      meant to sign). The explicit operator commit opts back into the
 *      operator's own signing (`operatorSigning`), and that route refuses a
 *      repository whose own config sets any `gpg.*` key.
 *    - `submodule.recurse=false`, `push.recurseSubmodules=no`,
 *      `fetch.recurseSubmodules=false`: git never walks into a submodule,
 *      whose config and hooks nothing here has looked at.
 *    - `GIT_TERMINAL_PROMPT=0` and an EMPTY `GIT_ASKPASS` (git then skips
 *      `core.askPass` as well).
 *
 *    Repository hooks are NOT disabled (owner decision on #2363): read-only
 *    commands run none, and an explicit operator commit runs them exactly as
 *    `git commit` in the operator's terminal would.
 *
 *    `GIT_CONFIG_NOSYSTEM` is deliberately NOT set. The system file is not
 *    writable by anyone this defends against (writing it takes the
 *    operator's own account or an administrator's), and it carries settings
 *    git needs: Git for Windows keeps `core.autocrlf`, its TLS backend and
 *    its credential manager there, and Apple's Xcode git keeps `osxkeychain`
 *    in a distribution file that NOSYSTEM also drops. Setting it would make
 *    `status` report every CRLF checkout dirty on Windows and break https
 *    fetch and clone, for no gain against a Project member.
 *
 * 3. CREDENTIALS, for commands that can talk to a remote
 *    (`NETWORK_SUBCOMMANDS`): a command-scope `credential.helper=` (passed
 *    as `GIT_CONFIG_COUNT` pairs, see `credentialEnv`) clears every helper
 *    collected from config files, then the operator's own
 *    `credential.*.helper|useHttpPath|username` settings are re-added in the
 *    order plain git reads them, empty resets included, from every scope
 *    except the repository's (`local`, `worktree`) and the command line. So a
 *    repo-local `credential.helper=!cmd` never runs, and the operator's
 *    helpers (system, global, and Xcode's distribution file, which git
 *    reports as scope "unknown") behave as they do in a terminal.
 *
 * What this layer does NOT do, stated so nobody assumes it does:
 * - It does not stop a repo-local clean/smudge filter or diff driver. Those
 *   are selected per file by `.gitattributes` and cannot be neutralized
 *   generically; the coding routes refuse such a repository instead
 *   (`git-repository-config.ts`). Other callers that run `add` or `diff` in
 *   a Project folder (checkpoints) are not covered by that refusal.
 * - It does not stop a repo-local `url.*.insteadOf` rewriting a remote to
 *   another https/ssh address. The coding push route refuses one.
 * - The operator's OWN global configuration applies, by design.
 */
import {
  type ExecFileOptions,
  type ExecFileSyncOptions,
  execFile as execFileCb,
  execFileSync,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubBootInternalSecrets } from './child-process-environment.js';

const execFileAsync = promisify(execFileCb);

/**
 * Inherited variables that would retarget or reconfigure a spawned git, or
 * replace one of the overrides (`GIT_PAGER` outranks `core.pager`). Removed
 * from what this process inherited; see the header.
 */
const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_EXTERNAL_DIFF',
] as const;
const INHERITED_GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** Batch mode: never prompt, fail instead. */
const SSH_BATCH_COMMAND = 'ssh -o BatchMode=yes';

/**
 * Subcommands that can reach a remote, and so need the operator's
 * credential helpers. `credential` consults the helpers directly; `remote`
 * because `remote update`/`remote show` fetch.
 */
const NETWORK_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'remote',
  'submodule',
  'credential',
]);

export interface GitHardeningOptions {
  /**
   * Also allow git's `file` transport (local paths and `file://`). Every
   * caller that sets this says why at the call site. In production: cloning
   * or updating a PLUGIN from a local git path the operator, or a registry
   * the operator configured, named. Never a Project folder: a push to a
   * local path runs the target repository's hooks.
   */
  allowFileProtocol?: boolean;
  /**
   * Leave `commit.gpgSign` to the operator's own configuration instead of
   * forcing it off. ONLY for the explicit operator commit, which refuses a
   * repository whose own config sets any `gpg.*` key.
   */
  operatorSigning?: boolean;
}

/**
 * The environment for a spawned git (or a tool, such as `gh`, that runs git
 * to discover a repository). `extra` is layered over the scrubbed inherited
 * environment; `GIT_DIR`/`GIT_WORK_TREE` are removed even from `extra`, so
 * git always discovers the repository from its `cwd` or an explicit
 * `--git-dir`.
 */
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_GIT_ENV) delete inherited[key];
  for (const key of Object.keys(inherited)) {
    if (INHERITED_GIT_CONFIG_PAIR.test(key)) delete inherited[key];
  }
  const env = scrubBootInternalSecrets({ ...inherited, ...extra });
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/** {@link gitEnv} plus the hardening variables. Applied last, so no
 * caller-supplied `env` can undo them. */
export function hardenedGitEnv(
  extra?: NodeJS.ProcessEnv,
  options: GitHardeningOptions = {},
): NodeJS.ProcessEnv {
  return {
    ...gitEnv(extra),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: SSH_BATCH_COMMAND,
    GIT_ALLOW_PROTOCOL: options.allowFileProtocol
      ? 'https:ssh:file'
      : 'https:ssh',
  };
}

/** The `-c key=value` settings every git call carries. See the header. */
function hardeningSettings(options: GitHardeningOptions): string[] {
  return [
    'core.fsmonitor=false',
    'core.pager=cat',
    'core.editor=true',
    `core.sshCommand=${SSH_BATCH_COMMAND}`,
    'safe.bareRepository=explicit',
    'log.showSignature=false',
    ...(options.operatorSigning
      ? []
      : ['commit.gpgSign=false', 'tag.gpgSign=false']),
    'submodule.recurse=false',
    'push.recurseSubmodules=no',
    'fetch.recurseSubmodules=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
    ...(options.allowFileProtocol ? ['protocol.file.allow=always'] : []),
  ];
}

/** Global options that take a separate value, so the value is not the verb. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

/** The git subcommand in `args` (the first non-option argument). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

const CREDENTIAL_READ_ARGS = [
  'config',
  '--show-scope',
  '--null',
  '--get-regexp',
  '^credential\\.(.*\\.)?(helper|usehttppath|username)$',
];
const DROPPED_CREDENTIAL_SCOPES = new Set(['local', 'worktree', 'command']);

/** Parses `git config --show-scope --null --get-regexp` output into
 * `key=value` settings, dropping the repository and command-line scopes. */
function parseCredentialSettings(stdout: string): string[] {
  const tokens = stdout.split('\0');
  const settings: string[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index];
    const record = tokens[index + 1];
    if (DROPPED_CREDENTIAL_SCOPES.has(scope)) continue;
    const newline = record.indexOf('\n');
    // A key with no value at all is a bare boolean, not a helper setting.
    if (newline <= 0) continue;
    settings.push(`${record.slice(0, newline)}=${record.slice(newline + 1)}`);
  }
  return settings;
}

/**
 * The environment for reading the operator's credential settings: run from
 * a fresh empty directory whose PARENT is a ceiling, so no repository is
 * discovered and no repository scope can appear at all.
 */
function credentialReadEnv(directory: string): NodeJS.ProcessEnv {
  return gitEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: dirname(directory),
  });
}

/**
 * The operator's credential settings, as `key=value` strings in the order
 * plain git reads them. Empty values are kept: in git an empty `helper`
 * clears the helpers collected so far, so dropping it would change which
 * helpers run. `[]` when there are none, or when they cannot be read (the
 * command then runs with no helper and fails to authenticate, which is safe).
 */
export async function readOperatorCredentialSettings(): Promise<string[]> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'station-git-credentials-'));
    const { stdout } = await execFileAsync('git', CREDENTIAL_READ_ARGS, {
      cwd: directory,
      env: credentialReadEnv(directory),
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    return parseCredentialSettings(stdout);
  } catch {
    return []; // exit 1 means no credential settings at all
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Synchronous twin of {@link readOperatorCredentialSettings}. */
export function readOperatorCredentialSettingsSync(): string[] {
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), 'station-git-credentials-'));
    const stdout = execFileSync('git', CREDENTIAL_READ_ARGS, {
      cwd: directory,
      env: credentialReadEnv(directory),
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseCredentialSettings(stdout);
  } catch {
    return [];
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function toConfigArgs(settings: readonly string[]): string[] {
  return settings.flatMap((setting) => ['-c', setting]);
}

/** Full argv for a call: the hardening settings, then the caller's args. */
function hardenedArgs(
  args: readonly string[],
  options: GitHardeningOptions,
): string[] {
  return [...toConfigArgs(hardeningSettings(options)), ...args];
}

/**
 * The credential settings as `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, which git
 * reads as command-line scope exactly like `-c`, in order. Passed in the
 * environment rather than argv because a failed command's error message
 * quotes its argv, and a helper setting can carry a token
 * (`!f() { echo password=…; }; f`); the environment is never quoted.
 */
function credentialEnv(
  credentials: readonly string[] | null,
): NodeJS.ProcessEnv {
  if (credentials === null) return {};
  const settings = ['credential.helper=', ...credentials];
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach((setting, index) => {
    const equals = setting.indexOf('=');
    env[`GIT_CONFIG_KEY_${index}`] = setting.slice(0, equals);
    env[`GIT_CONFIG_VALUE_${index}`] = setting.slice(equals + 1);
  });
  return env;
}

function needsCredentials(args: readonly string[]): boolean {
  const verb = gitSubcommand(args);
  return verb !== undefined && NETWORK_SUBCOMMANDS.has(verb);
}

type Hardened<T> = T & { hardening?: GitHardeningOptions };

function splitHardening<T extends object>(
  opts: Hardened<T>,
): [T, GitHardeningOptions] {
  const { hardening, ...rest } = opts;
  return [rest as T, hardening ?? {}];
}

/** Promisified `execFile('git', …)`, scrubbed and hardened (see header). */
export async function execGit(
  args: string[],
  opts: Hardened<ExecFileOptions & { encoding?: BufferEncoding }> = {},
): Promise<{ stdout: string; stderr: string }> {
  const [execOptions, hardening] = splitHardening(opts);
  const credentials = needsCredentials(args)
    ? await readOperatorCredentialSettings()
    : null;
  return execFileAsync('git', hardenedArgs(args, hardening), {
    ...execOptions,
    env: {
      ...hardenedGitEnv(execOptions.env, hardening),
      ...credentialEnv(credentials),
    },
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * Promisified command execution for tools (such as `gh`) which discover a
 * repository from their cwd. It shares git's environment scrub and the
 * hardening variables, which reach any git such a tool spawns; the `-c`
 * settings cannot be passed through another program's argv.
 */
export function execGitContextCommand(
  command: string,
  args: string[],
  opts: ExecFileOptions & { encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    ...opts,
    env: hardenedGitEnv(opts.env),
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/** `execFileSync('git', …)`, scrubbed and hardened (see header). */
export function execGitSync(
  args: string[],
  opts: Hardened<ExecFileSyncOptions> = {},
): string | Buffer {
  const [execOptions, hardening] = splitHardening(opts);
  const credentials = needsCredentials(args)
    ? readOperatorCredentialSettingsSync()
    : null;
  return execFileSync('git', hardenedArgs(args, hardening), {
    ...execOptions,
    env: {
      ...hardenedGitEnv(execOptions.env, hardening),
      ...credentialEnv(credentials),
    },
    windowsHide: true,
  });
}

/** `spawn('git', …)`, scrubbed and hardened (see header). */
export function spawnGit(args: string[], opts: Hardened<SpawnOptions> = {}) {
  const [spawnOptions, hardening] = splitHardening(opts);
  const credentials = needsCredentials(args)
    ? readOperatorCredentialSettingsSync()
    : null;
  return spawn('git', hardenedArgs(args, hardening), {
    ...spawnOptions,
    env: {
      ...hardenedGitEnv(spawnOptions.env, hardening),
      ...credentialEnv(credentials),
    },
    windowsHide: true,
  });
}

/**
 * True when `source` names a repository on this machine (a path, or
 * `file://`) rather than an https, ssh or scp-style remote. For the callers
 * that may clone from a local path the operator named, so they can opt into
 * the `file` transport for exactly that case.
 */
export function isLocalGitSource(source: string): boolean {
  if (/^file:\/\//i.test(source)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(source)) return false; // remote helper
  if (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(source)) {
    return true;
  }
  // scp-style `[user@]host:path`; a path with a colon after a slash is local.
  return !/^[^/:]+:/.test(source);
}
