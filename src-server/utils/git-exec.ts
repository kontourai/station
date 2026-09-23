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
 *    - `core.hooksPath` = the null device: NO repository hook runs, from
 *      `.git/hooks` or from the repository's own `core.hooksPath`. Even
 *      "read-only" commands write: `diff` refreshes the index and ran a
 *      planted `post-index-change` hook despite `GIT_OPTIONAL_LOCKS=0`;
 *      `checkout` and `worktree add` run `post-checkout`; ref updates run
 *      `reference-transaction`. The one opt-in is `operatorHooks`, for the
 *      operator-clicked Commit and Push, which run hooks as the operator's
 *      terminal would (owner decision on #2363).
 *    - `core.fsmonitor=false`: a repo-local fsmonitor hook would otherwise
 *      run on `git status`, which the Project page calls on mount.
 *    - `diff.ignoreSubmodules=dirty`, and `--ignore-submodules=dirty` added
 *      to `status`/`diff`/`diff-files`/`diff-index` (the flag, because a
 *      `.gitmodules` `submodule.<name>.ignore=none` outranks the setting):
 *      git never looks inside a nested repository's or submodule's work
 *      tree, whose own config (filters, fsmonitor) nothing here has read.
 *    - `core.pager=cat`, `core.editor=true`: no pager or editor program from
 *      the repository (and `GIT_PAGER`/`GIT_EDITOR` are not inherited).
 *    - `core.sshCommand` = batch-mode ssh, doubled by `GIT_SSH_COMMAND`
 *      (the environment variable outranks config; the `-c` keeps the value
 *      should a tool drop the variable). Removing only one of the two
 *      leaves the other holding the line, deliberately. For a network
 *      command the variable carries the OPERATOR's choice instead, when
 *      they made one (see 3).
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
 *    - `GIT_OPTIONAL_LOCKS=0`: `status` otherwise refreshes and rewrites
 *      the index opportunistically. It does not stop every index write
 *      (`diff` still refreshed it); the hooks setting above is what keeps
 *      a write from running anything.
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
 * 3. OPERATOR SETTINGS, for commands that can talk to a remote
 *    (`NETWORK_SUBCOMMANDS`). They are read with `git config --show-scope`
 *    IN THE SAME REPOSITORY the command runs in (same cwd, same `-C` or
 *    `--git-dir`), so a global `includeIf "gitdir:…"` selects the same
 *    work identity it would in a terminal; the repository's own scopes
 *    (`local`, `worktree`) and the command line are dropped.
 *    - Credentials: a command-scope `credential.helper=` (passed as
 *      `GIT_CONFIG_COUNT` pairs, see `credentialSettings`) clears every helper
 *      collected from config files, then the operator's
 *      `credential.*.helper|useHttpPath|username` settings are re-added in
 *      the order plain git reads them, empty resets included. So a
 *      repo-local `credential.helper=!cmd` never runs, and the operator's
 *      helpers (system, global, included, and Xcode's distribution file,
 *      which git reports as scope "unknown") run as in a terminal.
 *    - ssh: the operator's own `GIT_SSH_COMMAND` or `GIT_SSH` (this
 *      process's environment), else their own `core.sshCommand`, else
 *      batch-mode ssh (`operatorSshEnv`). A repo-local `core.sshCommand`
 *      is never used.
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
  type ExecFileSyncOptions,
  execFileSync,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubBootInternalSecrets } from './child-process-environment.js';

/** SIGTERM first; SIGKILL the group if anything is still there after this. */
const GROUP_KILL_GRACE_MS = 1000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** A child started in its own process group (POSIX). */
const OWN_PROCESS_GROUP = process.platform !== 'win32';

/**
 * Signals `child`'s whole process group: git and everything under it
 * (#2363 review round 3). Signalling the child alone stops git itself but
 * orphans what git started: a hook's shell and its children, a filter, the
 * processes a tool such as gh runs. (Checked on macOS: `/usr/bin/git`'s
 * xcrun shim EXECs the real git, so the pid is git's; the orphans are
 * further down the chain.) Falls back to the child itself where there are
 * no process groups.
 */
export function killGitProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (OWN_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/** Group leaders Station started that have not exited yet. */
const liveGroups = new Set<ReturnType<typeof spawn>>();

function trackGroup<T extends ReturnType<typeof spawn>>(child: T): T {
  if (!OWN_PROCESS_GROUP || child.pid === undefined) return child;
  liveGroups.add(child);
  child.once('exit', () => liveGroups.delete(child));
  child.once('error', () => liveGroups.delete(child));
  return child;
}

/**
 * SIGTERMs every process group Station started that is still running (git,
 * gh, glab, and whatever they started), for server shutdown. They are
 * detached into their own groups, so they would otherwise outlive Station.
 * Returns how many groups were signalled.
 */
export function stopLiveGitProcessGroups(): number {
  let signalled = 0;
  for (const child of liveGroups) {
    killGitProcessTree(child, 'SIGTERM');
    signalled += 1;
  }
  liveGroups.clear();
  return signalled;
}

/** SIGTERM the group, then SIGKILL it if the leader has not closed. */
function stopGitProcessTree(child: ReturnType<typeof spawn>): void {
  killGitProcessTree(child, 'SIGTERM');
  const escalate = setTimeout(() => {
    killGitProcessTree(child, 'SIGKILL');
  }, GROUP_KILL_GRACE_MS);
  escalate.unref();
  child.once('close', () => {
    // Anything the leader left behind in the group still goes.
    killGitProcessTree(child, 'SIGKILL');
    clearTimeout(escalate);
  });
}

interface GroupRunOptions {
  cwd?: string | URL;
  env: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

type GroupRunError = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  cmd?: string;
};

/**
 * `execFile`'s promise contract (resolves `{ stdout, stderr }` as strings;
 * rejects with `code`, `killed`, `signal`, `stdout`, `stderr`), but the
 * child runs in its own process group and a deadline or an overflowing
 * output kills the GROUP. See `killGitProcessTree`.
 */
function runInProcessGroup(
  file: string,
  args: readonly string[],
  options: GroupRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = trackGroup(
      spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: OWN_PROCESS_GROUP,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    // Collected as bytes, so `maxBuffer` bounds bytes (as execFile's does).
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let overflow = false;
    let settled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    const stop = () => {
      if (killed || exited) return;
      killed = true;
      stopGitProcessTree(child);
    };
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(stop, options.timeout)
        : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        overflow = true;
        stop();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        overflow = true;
        stop();
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    // The LEADER's exit is the command's outcome. A process it started that
    // left the group (setsid), or one it backgrounded (a post-commit hook's
    // job), can hold our pipes open long after, so 'close' may be late or
    // never come: once the leader has exited, the deadline no longer
    // applies, and after a short grace the pipes are closed from our side.
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (timer) clearTimeout(timer);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, GROUP_KILL_GRACE_MS * 2).unref();
    });
    child.on('close', (closeCode, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const code = exited ? exited.code : closeCode;
      const signal = exited ? exited.signal : closeSignal;
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0 && !killed) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      const error: GroupRunError = new Error(
        overflow
          ? `${file} output exceeded maxBuffer`
          : `Command failed: ${[file, ...args].join(' ')}\n${err}`,
      );
      error.code = overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code;
      error.killed = killed;
      error.signal = killed ? (signal ?? 'SIGTERM') : signal;
      error.stdout = out;
      error.stderr = err;
      error.cmd = [file, ...args].join(' ');
      reject(error);
    });
  });
}

/**
 * Inherited variables that would retarget or reconfigure a spawned git, or
 * replace one of the overrides (`GIT_PAGER` outranks `core.pager`). Removed
 * from what this process inherited; see the header. This is a FIXED list of
 * the variables known to matter (git reads many `GIT_*` variables; tracing
 * and similar ones are left alone), not a scrub of every `GIT_*` name.
 * `GIT_SSH`/`GIT_SSH_COMMAND` are the operator's own and are re-applied for
 * network commands only (`operatorSshEnv`).
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
  'GIT_ATTR_SOURCE',
  'GIT_PROXY_COMMAND',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
] as const;
const INHERITED_GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/** Batch mode: never prompt, fail instead. */
const SSH_BATCH_COMMAND = 'ssh -o BatchMode=yes';

/** A hooks path with no hooks in it: git looks for `<path>/<hook>`, and
 * finds nothing under the null device. */
const HOOKS_DISABLED = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Subcommands that compare against the working tree and would otherwise
 * enter a nested repository or submodule (`--ignore-submodules=none`, which
 * a `.gitmodules` `submodule.<name>.ignore` can select over any
 * `diff.ignoreSubmodules` setting). Measured on git 2.50: `status` and
 * `diff` in the parent ran a clean filter defined in the NESTED
 * repository's own config. `dirty` still reports a changed submodule
 * commit; it only stops git looking inside the submodule's work tree.
 */
const SUBMODULE_COMPARING_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'diff-files',
  'diff-index',
]);

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
  /**
   * Run the repository's hooks (its `.git/hooks`, or its own
   * `core.hooksPath`, such as husky's). Every other call runs with hooks
   * off. ONLY for the operator-clicked Commit and Push, which behave as
   * `git commit`/`git push` in the operator's terminal would (owner
   * decision on #2363).
   */
  operatorHooks?: boolean;
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
    // No opportunistic index write, so a read-only `status` never writes
    // the index and never runs a planted `post-index-change` hook.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: options.allowFileProtocol
      ? 'https:ssh:file'
      : 'https:ssh',
  };
}

/** The `-c key=value` settings every git call carries. See the header. */
function hardeningSettings(options: GitHardeningOptions): string[] {
  return [
    ...(options.operatorHooks ? [] : [`core.hooksPath=${HOOKS_DISABLED}`]),
    'diff.ignoreSubmodules=dirty',
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

const OPERATOR_NETWORK_KEYS =
  '^(credential\\.(.*\\.)?(helper|usehttppath|username)|core\\.sshcommand)$';
const REPOSITORY_SCOPES = new Set(['local', 'worktree', 'command']);

/** The operator's own settings that matter to a network command. */
interface OperatorNetworkSettings {
  /** `key=value` credential settings, in the order git reads them. */
  credentials: string[];
  /** The operator's own `core.sshCommand`, if any (last one wins). */
  sshCommand?: string;
}

/** Parses `git config --show-scope --null --get-regexp`, dropping the
 * repository's and the command line's scopes. */
function parseOperatorSettings(stdout: string): OperatorNetworkSettings {
  const tokens = stdout.split('\0');
  const settings: OperatorNetworkSettings = { credentials: [] };
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index];
    const record = tokens[index + 1];
    if (REPOSITORY_SCOPES.has(scope)) continue;
    const newline = record.indexOf('\n');
    // A key with no value at all is a bare boolean, not a setting we use.
    if (newline <= 0) continue;
    const key = record.slice(0, newline);
    const value = record.slice(newline + 1);
    if (key.toLowerCase() === 'core.sshcommand') settings.sshCommand = value;
    else settings.credentials.push(`${key}=${value}`);
  }
  return settings;
}

/** The global options (`-C`, `--git-dir`, …) before the subcommand. */
function globalOptions(args: readonly string[]): string[] {
  const verb = gitSubcommand(args);
  const index = verb === undefined ? args.length : args.indexOf(verb);
  return args.slice(0, index).filter((arg, i, all) => {
    // `-c key=value` pairs are the caller's own settings, not a location.
    return arg !== '-c' && all[i - 1] !== '-c';
  });
}

/**
 * Reads the operator's credential and ssh settings AS GIT WOULD SEE THEM FOR
 * THIS COMMAND: in the same directory, with the same `--git-dir`/`-C`, so a
 * global `includeIf "gitdir:…"` (a work identity's helper) applies exactly
 * as it does in a terminal. The repository's own scopes are dropped. The
 * read runs with the hardening settings (hooks off, no fsmonitor), and
 * `git config` itself runs no filter, hook or helper.
 */
function operatorReadArgs(args: readonly string[]): string[] {
  return hardenedArgs(
    [
      ...globalOptions(args),
      'config',
      '--show-scope',
      '--null',
      '--get-regexp',
      OPERATOR_NETWORK_KEYS,
    ],
    {},
  );
}

async function readOperatorSettings(
  args: readonly string[],
  cwd: string | URL | undefined,
): Promise<OperatorNetworkSettings> {
  try {
    const { stdout } = await runInProcessGroup('git', operatorReadArgs(args), {
      cwd,
      env: hardenedGitEnv(),
      timeout: 5000,
    });
    return parseOperatorSettings(stdout);
  } catch {
    // Exit 1: none set. Anything else: the command then runs with no
    // helper and fails to authenticate, which is safe.
    return { credentials: [] };
  }
}

function readOperatorSettingsSync(
  args: readonly string[],
  cwd: string | URL | undefined,
): OperatorNetworkSettings {
  try {
    const stdout = execFileSync('git', operatorReadArgs(args), {
      cwd,
      env: hardenedGitEnv(),
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseOperatorSettings(stdout);
  } catch {
    return { credentials: [] };
  }
}

function toConfigArgs(settings: readonly string[]): string[] {
  return settings.flatMap((setting) => ['-c', setting]);
}

/**
 * Full argv for a call: the hardening settings, then the caller's args,
 * with `--ignore-submodules=dirty` added to a working-tree comparison that
 * does not choose its own.
 */
function hardenedArgs(
  args: readonly string[],
  options: GitHardeningOptions,
): string[] {
  const command = [...args];
  const verb = gitSubcommand(command);
  if (
    verb !== undefined &&
    SUBMODULE_COMPARING_SUBCOMMANDS.has(verb) &&
    !command.some((arg) => arg.startsWith('--ignore-submodules'))
  ) {
    command.splice(command.indexOf(verb) + 1, 0, '--ignore-submodules=dirty');
  }
  return [...toConfigArgs(hardeningSettings(options)), ...command];
}

/**
 * The operator's ssh choice, for a network command, in git's own order:
 * `GIT_SSH_COMMAND`, then `GIT_SSH`, from THIS process's environment (the
 * operator's), then the operator's own `core.sshCommand`, else batch-mode
 * ssh. A repository's `core.sshCommand` never gets a say: the environment
 * variable set here outranks every config file.
 */
/** POSIX single-quoting, which git's `sh -c` for `GIT_SSH_COMMAND` reads. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function operatorSshEnv(settings: OperatorNetworkSettings): NodeJS.ProcessEnv {
  const inheritedCommand = process.env.GIT_SSH_COMMAND;
  if (inheritedCommand) return { GIT_SSH_COMMAND: inheritedCommand };
  const inheritedProgram = process.env.GIT_SSH;
  if (inheritedProgram) {
    // `GIT_SSH` ranks BELOW `core.sshCommand` in git, so the batch-mode
    // `-c core.sshCommand` would silently replace it. Carried as
    // `GIT_SSH_COMMAND` (which outranks config) naming the same program,
    // shell-quoted; git's ssh-variant detection (plink, tortoiseplink)
    // reads the program name either way.
    return { GIT_SSH_COMMAND: shellQuote(inheritedProgram) };
  }
  return { GIT_SSH_COMMAND: settings.sshCommand ?? SSH_BATCH_COMMAND };
}

/** The ssh choice for a network command (`operatorSshEnv`). */
function networkEnv(
  settings: OperatorNetworkSettings | null,
): NodeJS.ProcessEnv {
  if (settings === null) return {};
  return operatorSshEnv(settings);
}

/**
 * Appends `key=value` settings to `env` as `GIT_CONFIG_COUNT`/`KEY_n`/
 * `VALUE_n` pairs, after any pairs `env` already carries. git reads them as
 * command-line scope, exactly like `-c`, in order; and they reach every git
 * a tool spawns, which `-c` in that tool's argv could not.
 */
function appendConfigPairs(
  env: NodeJS.ProcessEnv,
  settings: readonly string[],
): NodeJS.ProcessEnv {
  if (settings.length === 0) return env;
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const next: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_COUNT: String(start + settings.length),
  };
  settings.forEach((setting, offset) => {
    const equals = setting.indexOf('=');
    next[`GIT_CONFIG_KEY_${start + offset}`] = setting.slice(0, equals);
    next[`GIT_CONFIG_VALUE_${start + offset}`] = setting.slice(equals + 1);
  });
  return next;
}

/**
 * The credential settings for a network command: a `credential.helper=`
 * that clears every helper collected from config files (including the
 * repository's), then the operator's own. Passed as environment pairs
 * rather than argv because a failed command's error message quotes its
 * argv, and a helper setting can carry a token.
 */
function credentialSettings(
  settings: OperatorNetworkSettings | null,
): string[] {
  return settings === null
    ? []
    : ['credential.helper=', ...settings.credentials];
}

function needsOperatorSettings(args: readonly string[]): boolean {
  const verb = gitSubcommand(args);
  return verb !== undefined && NETWORK_SUBCOMMANDS.has(verb);
}

/** Merges, deleting the keys whose value is `undefined`. */
function mergeEnv(...layers: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

type Hardened<T> = T & { hardening?: GitHardeningOptions };

/**
 * What `execGit` and `execGitContextCommand` honour. Deliberately narrow:
 * the process-group runner decodes output as UTF-8, has no stdin, and
 * stops a call only by its own deadline, so `encoding` other than UTF-8,
 * `input`, `killSignal` and an `AbortSignal` are not accepted rather than
 * silently ignored. `maxBuffer` bounds bytes on each of stdout and stderr.
 */
export interface GitRunOptions {
  cwd?: string | URL;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  encoding?: 'utf8' | 'utf-8';
  windowsHide?: boolean;
}

function splitHardening<T extends object>(
  opts: Hardened<T>,
): [T, GitHardeningOptions] {
  const { hardening, ...rest } = opts;
  return [rest as T, hardening ?? {}];
}

/** Promisified `execFile('git', …)`, scrubbed and hardened (see header). */
export async function execGit(
  args: string[],
  opts: Hardened<GitRunOptions> = {},
): Promise<{ stdout: string; stderr: string }> {
  const [execOptions, hardening] = splitHardening(opts);
  const operator = needsOperatorSettings(args)
    ? await readOperatorSettings(args, execOptions.cwd)
    : null;
  return runInProcessGroup('git', hardenedArgs(args, hardening), {
    cwd: execOptions.cwd,
    timeout: execOptions.timeout,
    maxBuffer: execOptions.maxBuffer,
    env: appendConfigPairs(
      mergeEnv(
        hardenedGitEnv(execOptions.env, hardening),
        networkEnv(operator),
      ),
      credentialSettings(operator),
    ),
  });
}

/**
 * Command execution for tools (such as `gh` and `glab`) which run git
 * themselves. Two defences:
 * - The tool runs in a FRESH EMPTY directory, removed afterwards, never in
 *   a Project folder: every call names its repository (`--repo`) and the
 *   branch it means (`--head`), so the tool has no reason to inspect a
 *   checkout, and none to inspect. (`gh pr create` without `--head` runs its
 *   own `git status` in its cwd, which a submodule's config can steer.)
 * - Any git it does spawn inherits the scrubbed environment, the hardening
 *   variables, and the hardening settings as `GIT_CONFIG_COUNT` pairs (git
 *   reads them like `-c`), appended after pairs the caller passed.
 * The tool runs in its own process group, killed as a group on the deadline.
 */
export async function execGitContextCommand(
  command: string,
  args: string[],
  opts: Omit<GitRunOptions, 'cwd'> = {},
): Promise<{ stdout: string; stderr: string }> {
  const neutral = await mkdtemp(join(tmpdir(), 'station-git-tool-'));
  try {
    return await runInProcessGroup(command, args, {
      cwd: neutral,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      env: appendConfigPairs(hardenedGitEnv(opts.env), hardeningSettings({})),
    });
  } finally {
    await rm(neutral, { recursive: true, force: true });
  }
}

/** `execFileSync('git', …)`, scrubbed and hardened (see header). */
export function execGitSync(
  args: string[],
  opts: Hardened<ExecFileSyncOptions> = {},
): string | Buffer {
  const [execOptions, hardening] = splitHardening(opts);
  const operator = needsOperatorSettings(args)
    ? readOperatorSettingsSync(args, execOptions.cwd)
    : null;
  return execFileSync('git', hardenedArgs(args, hardening), {
    ...execOptions,
    env: appendConfigPairs(
      mergeEnv(
        hardenedGitEnv(execOptions.env, hardening),
        networkEnv(operator),
      ),
      credentialSettings(operator),
    ),
    windowsHide: true,
  });
}

/** `spawn('git', …)`, scrubbed and hardened (see header). */
export function spawnGit(args: string[], opts: Hardened<SpawnOptions> = {}) {
  const [spawnOptions, hardening] = splitHardening(opts);
  const operator = needsOperatorSettings(args)
    ? readOperatorSettingsSync(args, spawnOptions.cwd)
    : null;
  // Its own process group, so a caller that stops it can stop everything
  // under it (`killGitProcessTree`).
  return trackGroup(
    spawn('git', hardenedArgs(args, hardening), {
      detached: OWN_PROCESS_GROUP,
      ...spawnOptions,
      env: appendConfigPairs(
        mergeEnv(
          hardenedGitEnv(spawnOptions.env, hardening),
          networkEnv(operator),
        ),
        credentialSettings(operator),
      ),
      windowsHide: true,
    }),
  );
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
