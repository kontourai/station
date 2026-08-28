import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { ensureEngineSpawnTmpDir } from '../../services/infra/engine-spawn-tmpdir.js';
import { throwIfAborted } from '../../utils/bounded-async.js';
import { scrubBootInternalSecrets } from '../../utils/child-process-environment.js';
import { expandTilde } from '../../utils/paths.js';

const execFile = promisify(execFileCallback);
const CLI_PROBE_TIMEOUT_MS = 10_000;
const LOGIN_PATH_RESOLVE_TIMEOUT_MS = 5_000;

export type CliAuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export interface CliCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// archive#977: Station may run as a launchd/systemd service, which starts
// with a MINIMAL PATH -- not the users interactive-shell PATH. Tools like
// mise/nvm/asdf/direnv export PATH from .zshrc/.bashrc, which a shell only
// sources when INTERACTIVE (-i), not merely a login shell (-l) -- so an
// engine CLI the user installed and can run interactively (e.g. codex at
// /run/current-system/sw/bin/codex, a nix-darwin path, or a mise shim
// activated in .zshrc) then reports "missing" even though codex --version
// works fine in their shell.
//
// Set this to "1" to disable the login-shell/well-known-dir fallback and
// search only process.env.PATH (for hardened/pinned deployments that want
// exactly todays behavior).
export const STATION_DISABLE_LOGIN_PATH_RESOLVE_ENV =
  'STATION_DISABLE_LOGIN_PATH_RESOLVE';

function isLoginPathResolveDisabled(): boolean {
  return process.env[STATION_DISABLE_LOGIN_PATH_RESOLVE_ENV] === '1';
}

function isWindows(): boolean {
  return platform() === 'win32';
}

function pathDelimiter(): string {
  return isWindows() ? ';' : ':';
}

function splitPath(pathValue: string): string[] {
  return pathValue.split(pathDelimiter()).filter(Boolean);
}

function dedupe(dirs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

// Directories a users login shell commonly adds that a service-managed
// launch will not have -- only included when they actually exist, so a
// dead entry never bloats every PATH search. POSIX-only (mirrors the
// login-shell resolve itself; Windows keeps todays behavior unchanged).
function wellKnownInstallDirs(): string[] {
  if (isWindows()) return [];
  const home = homedir();
  const candidates = [
    '/run/current-system/sw/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.nix-profile/bin`,
    `${home}/.local/share/mise/shims`,
  ];
  return candidates.filter((dir) => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  });
}

// A shell run with -l (login) but not -i (interactive) does NOT source
// .zshrc/.bashrc -- only .zprofile/.zlogin. That is exactly where
// mise/nvm/asdf/direnv usually export PATH (e.g. mise's own
// `eval "$(mise activate zsh)"` line), so a login-only capture misses the
// PATH this fix exists to find. -i makes the spawned shell interactive so
// those files are sourced too -- at the cost of possible banner/prompt/
// rc-file stdout noise, which the sentinel wrapper below strips out.
export const LOGIN_PATH_START_SENTINEL = '__STATION_LOGIN_PATH_START_7f3a9c__';
export const LOGIN_PATH_END_SENTINEL = '__STATION_LOGIN_PATH_END_7f3a9c__';

// Extracts the PATH value strictly between the two sentinels, discarding
// any banner/prompt/rc-file noise an interactive shell may have written to
// stdout before or after it. Returns '' if either sentinel is missing (a
// shell that failed to run our printf at all) -- callers degrade to
// process.env.PATH alone exactly as on any other failure.
function extractSentinelValue(output: string): string {
  const start = output.indexOf(LOGIN_PATH_START_SENTINEL);
  const end = output.indexOf(LOGIN_PATH_END_SENTINEL);
  if (start === -1 || end === -1 || end < start) return '';
  return output.slice(start + LOGIN_PATH_START_SENTINEL.length, end).trim();
}

// Runs the users login shell INTERACTIVELY once to capture its real PATH
// (see the sentinel comment above for why -i, not just -l). Bounded by a
// timeout; NEVER throws -- any failure (missing shell, timeout, non-zero
// exit, sentinel not found) degrades to an empty string so callers fall
// back to process.env.PATH alone. POSIX-only: returns an empty string
// immediately on win32, where login-shell resolution is not meaningful and
// the existing PATH lookup stays untouched.
export async function resolveLoginShellPath(): Promise<string> {
  if (isWindows()) return '';
  const shell = process.env.SHELL || '/bin/zsh';
  const script = `printf '${LOGIN_PATH_START_SENTINEL}%s${LOGIN_PATH_END_SENTINEL}' "$PATH"`;
  try {
    const { stdout } = await execFile(shell, ['-ic', script], {
      encoding: 'utf-8',
      timeout: LOGIN_PATH_RESOLVE_TIMEOUT_MS,
      windowsHide: true,
    });
    return extractSentinelValue(stdout);
  } catch {
    return '';
  }
}

// Resolved at most once per process lifetime -- this is what makes an
// otherwise-expensive spawn-a-login-shell operation safe to call from a
// hot path like findCliBinary.
let cachedLoginPathPromise: Promise<string> | null = null;
let cachedLoginPathValue: string | null = null;

function ensureLoginPathResolutionStarted(): Promise<string> {
  if (cachedLoginPathValue !== null) {
    return Promise.resolve(cachedLoginPathValue);
  }
  if (isLoginPathResolveDisabled()) {
    cachedLoginPathValue = '';
    return Promise.resolve(cachedLoginPathValue);
  }
  if (!cachedLoginPathPromise) {
    cachedLoginPathPromise = resolveLoginShellPath().then((resolved) => {
      cachedLoginPathValue = resolved;
      return resolved;
    });
  }
  return cachedLoginPathPromise;
}

// The combined search-PATH directories: process.env.PATH first (so a
// pinned/hardened deployments own PATH always wins -- never displaced),
// then the resolved login-shell PATH (once available), then the
// well-known install-dir backstop. Deduped. process.env.PATH and the
// well-known dirs are always read live (never cached) so a caller that
// mutates process.env.PATH at runtime, or a test that stubs it, is
// reflected immediately; only the expensive login-shell spawn itself is
// cached.
function combinedPathDirs(): string[] {
  const processDirs = splitPath(process.env.PATH ?? '');
  if (isLoginPathResolveDisabled()) return dedupe(processDirs);
  const loginDirs = splitPath(cachedLoginPathValue ?? '');
  return dedupe([...processDirs, ...loginDirs, ...wellKnownInstallDirs()]);
}

// Resolve the fully combined PATH (as a single delimited string), awaiting
// login-shell resolution if it has not completed yet. Use from async call
// sites (the CLI prerequisite probe, subprocess spawn env) so a
// still-in-flight login-shell resolve cannot cause a false "missing"
// report or a spawn with an incomplete PATH.
export async function resolveAugmentedPath(): Promise<string> {
  await ensureLoginPathResolutionStarted();
  return combinedPathDirs().join(pathDelimiter());
}

// process.env layered with the fully-resolved augmented PATH -- for
// passing to execFile/spawn calls that need the spawned process itself
// (not just Stations own PATH search) to see the login-shell PATH.
export async function augmentedSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const combined = await resolveAugmentedPath();
  // archive#1908: every caller of this helper spawns (or PATH-probes) an
  // external engine binary -- claude-adapter.ts's Claude Agent SDK spawn,
  // acp-process.ts's ACP-connected engines (OpenCode, Kiro, ...), and this
  // module's own `runCliCommand` auth/version probes. Handing the child a
  // Station-owned TMPDIR (instead of leaving it to inherit the service's
  // ambient, unreaped tmp) is what makes `reapEngineSpawnTmpDir` able to
  // reclaim its self-extracted working files on a schedule Station controls.
  return scrubBootInternalSecrets({
    ...baseEnv,
    PATH: combined,
    TMPDIR: ensureEngineSpawnTmpDir(),
  });
}

/**
 * Answers the absolute-path case only, so both twins can share one answer
 * without either of them paying for PATH resolution it does not need.
 *
 * `undefined` means "not an absolute command, keep searching" -- distinct from
 * `null`, which means "absolute, and it is not there". Collapsing those two
 * into `null` is what would send an absolute miss back down the PATH search to
 * be answered by a same-named binary somewhere else.
 *
 * archive#766: a fully qualified command names the binary directly. Joining it
 * onto each PATH dir builds `/usr/bin//abs/path`, which never exists, so an
 * absolute command reported "missing" while the ACP spawn launched that same
 * path successfully -- detection and launch disagreeing about one string.
 * archive#3155: a `~/…` command is an absolute path in the shell's spelling.
 * Unexpanded it is not `isAbsolute`, so it fell through to the PATH search and
 * came back as "~/bin/agent not found on PATH" -- true of PATH, false about
 * the binary. Expanding first lets the absolute branch handle it.
 */
function resolveAbsoluteCommand(command: string): string | null | undefined {
  const direct = expandTilde(command);
  if (!isAbsolute(direct)) return undefined;
  return existsSync(direct) ? direct : null;
}

export function findCliBinary(command: string): string | null {
  // archive#977: lazy, not module-load-eager -- kicking this off on first
  // use (fire-and-forget; the returned promise never rejects) instead of
  // at import means a vitest suite that never calls findCliBinary/
  // resolveAugmentedPath never spawns a real shell just by importing this
  // module, while a real caller still gets it started before the first
  // search. The tradeoff: the very first call after process start can read
  // a cold cache (process.env.PATH + well-known dirs only) and report a
  // false "missing" for a login-shell-only tool; it self-heals on the next
  // call once resolution lands. Acceptable -- see the degrade-then-
  // self-heal test in cli-auth-login-path.test.ts.
  void ensureLoginPathResolutionStarted();
  const direct = resolveAbsoluteCommand(command);
  if (direct !== undefined) return direct;
  const suffixes = isWindows() ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of combinedPathDirs()) {
    for (const suffix of suffixes) {
      const candidate = `${dir}/${command}${suffix}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Async twin of findCliBinary. The only thing it adds is AWAITING the
// augmented-PATH resolution (including the login-shell PATH) instead of
// racing it -- use it from async call sites so a slow-to-resolve login shell
// cannot make a probe report a false "missing". Resolution itself, absolute
// and `~/…` commands included, is findCliBinary's; keeping one implementation
// is what guarantees the two answer identically.
export async function findCliBinaryAsync(
  command: string,
): Promise<string | null> {
  // An absolute command needs no PATH at all, so it must not wait on
  // login-shell resolution -- that is a `$SHELL -ic` spawn bounded at 5s, and
  // the caller here is the ACP process spawn (acp-process.ts), which is the
  // very path a fully qualified engine command takes. Awaiting first would
  // spend up to half the probe's per-phase deadline resolving a PATH this
  // command will never be looked up in.
  const direct = resolveAbsoluteCommand(command);
  if (direct !== undefined) return direct;
  await ensureLoginPathResolutionStarted();
  return findCliBinary(command);
}

async function runCliCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CliCommandResult | null> {
  try {
    const env = await augmentedSpawnEnv();
    const { stdout, stderr } = await execFile(command, args, {
      encoding: 'utf-8',
      // User-managed launchers may resolve the real CLI through mise/npx.
      // Keep the probe bounded, but allow that indirection to finish on a
      // cold cache (observed at ~6s on the brian-media dogfood host).
      timeout: CLI_PROBE_TIMEOUT_MS,
      windowsHide: true,
      signal,
      env,
    });
    return {
      stdout,
      stderr,
      code: 0,
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error && typeof error === 'object') {
      const result = error as {
        stdout?: string;
        stderr?: string;
        code?: number | null;
      };
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.code ?? 1,
      };
    }
    return null;
  }
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractAuthBoolean(item);
      if (extracted !== undefined) return extracted;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['auth', 'authenticated', 'loggedIn', 'logged_in']) {
    const candidate = extractAuthBoolean(
      (value as Record<string, unknown>)[key],
    );
    if (candidate !== undefined) return candidate;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    const candidate = extractAuthBoolean(nested);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function parseCliAuthState(
  result: CliCommandResult,
  command: string,
): CliAuthState {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    lowerOutput.includes('not logged in') ||
    lowerOutput.includes('login required') ||
    lowerOutput.includes('authentication required') ||
    lowerOutput.includes(`run \`${command} login\``) ||
    lowerOutput.includes(`run ${command} login`)
  ) {
    return 'unauthenticated';
  }

  const trimmed = result.stdout.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const auth = extractAuthBoolean(parsed);
      if (auth === true) return 'authenticated';
      if (auth === false) return 'unauthenticated';
    } catch {
      // Fall through to exit-code heuristics.
    }
  }

  if (result.code === 0) {
    return 'authenticated';
  }

  return 'unknown';
}

export async function buildCliRuntimePrerequisites(input: {
  command: string;
  displayName: string;
  versionArgs: string[];
  authArgs: string[];
  installStep: string;
  authStep: string;
  runCommand?: (
    command: string,
    args: string[],
    signal?: AbortSignal,
  ) => Promise<CliCommandResult | null>;
  /**
   * Resolves the CLI's absolute path. Injectable so an adapter's own
   * readiness derivation (e.g. muse's credential-store observation) can be
   * tested for the INSTALLED branch on a host where the CLI is absent — the
   * `!binary` early return below otherwise short-circuits every derivation,
   * which makes a passing "unauthenticated" assertion prove nothing.
   */
  findBinary?: (command: string) => string | null;
  detectAuthState?: () => Promise<CliAuthState>;
  signal?: AbortSignal;
}): Promise<Prerequisite[]> {
  throwIfAborted(input.signal);
  const binary = (input.findBinary ?? findCliBinary)(input.command);
  const installStatus = binary ? 'installed' : 'missing';

  const prerequisites: Prerequisite[] = [
    {
      id: `${input.command}-cli`,
      name: `${input.displayName} CLI`,
      description: `Required to launch the ${input.displayName} runtime.`,
      status: installStatus,
      category: 'required',
      installGuide: {
        steps: [input.installStep],
      },
    },
  ];

  if (!binary) {
    prerequisites.push({
      id: `${input.command}-auth`,
      name: `${input.displayName} login`,
      description: `${input.displayName} CLI must be installed before authentication can be verified.`,
      status: 'missing',
      category: 'required',
      installGuide: {
        steps: [input.installStep, input.authStep],
      },
    });
    return prerequisites;
  }

  const execute = input.runCommand ?? runCliCommand;
  // Version and authentication are independent, read-only probes. Running
  // them concurrently keeps slow user-managed CLI launchers from doubling
  // connection inventory latency. Some runtimes use the version command as
  // their capability probe, so reuse identical requests instead of
  // spawning the same launcher twice.
  const versionProbe = execute(binary, input.versionArgs, input.signal);
  const authProbe = input.detectAuthState
    ? input.detectAuthState()
    : JSON.stringify(input.authArgs) === JSON.stringify(input.versionArgs)
      ? versionProbe
      : execute(binary, input.authArgs, input.signal);
  const [versionResult, authResult] = await Promise.all([
    versionProbe,
    authProbe,
  ]);
  if (versionResult?.code !== 0) {
    prerequisites.push({
      id: `${input.command}-auth`,
      name: `${input.displayName} login`,
      description: `${input.displayName} CLI is installed but failed to run cleanly.`,
      status: 'error',
      category: 'required',
      installGuide: {
        steps: [input.authStep],
      },
    });
    return prerequisites;
  }

  const authState = input.detectAuthState
    ? (authResult as CliAuthState)
    : authResult
      ? parseCliAuthState(authResult as CliCommandResult, input.command)
      : 'unknown';

  prerequisites.push({
    id: `${input.command}-auth`,
    name: `${input.displayName} login`,
    description:
      authState === 'authenticated'
        ? `${input.displayName} CLI authentication is managed by the local CLI session.`
        : authState === 'unauthenticated'
          ? `${input.displayName} CLI is not authenticated.`
          : `${input.displayName} CLI authentication could not be verified safely.`,
    status:
      authState === 'authenticated'
        ? 'installed'
        : authState === 'unauthenticated'
          ? 'missing'
          : 'error',
    category: 'required',
    installGuide: {
      steps: [input.authStep],
    },
  });

  return prerequisites;
}
