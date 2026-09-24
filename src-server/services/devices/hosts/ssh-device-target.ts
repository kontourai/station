/**
 * SSH device hosts: the target grammar and every ssh argument vector
 * (#1973, D11).
 *
 * Station reaches an operator-managed device host with the system OpenSSH
 * client, the same one the SSH environments use (`services/ssh/`), and on
 * the same terms:
 *
 * - Authentication is the operator's own ssh agent and config. Station
 *   stores no key, password or passphrase, and never answers a prompt:
 *   `BatchMode=yes` makes any prompt a failure.
 * - Station is never a trust writer. `StrictHostKeyChecking=yes` and
 *   `UpdateHostKeys=no` on EVERY invocation, so an unknown host fails with a
 *   typed `host-key-unverified` (the operator confirms the key in a terminal)
 *   instead of being silently accepted under an ambient `accept-new`. The
 *   known_hosts LOCATION is left to the operator's config, as the SSH
 *   environments do (`openssh-environment-adapter.ts`).
 * - Fixed argument vectors only. The target is parsed by a strict grammar
 *   and passed as separate `-l`/`-p` values and a host after `--`, so a
 *   target can never become an option (`-oProxyCommand=…`). The remote
 *   command is a constant (`remoteLoaderCommand`); every per-call value
 *   travels on stdin as data, never through a shell.
 */

import { isIPv6 } from 'node:net';
import type { DeviceSshHostFailure } from '@kontourai/station-contracts/mobile-device';
import { requireOpenSshAlias } from '../../ssh/openssh-config.js';
import { classifySshReachabilityFailure } from '../../ssh/openssh-reachability.js';

export interface SshDeviceTarget {
  /** Remote login name, when the target names one. */
  user?: string;
  /** A DNS name, an IPv4 address, an IPv6 address (unbracketed), or an ssh config alias. */
  host: string;
  port?: number;
}

export class SshDeviceTargetError extends Error {
  constructor() {
    super(
      'SSH target must be user@host[:port], host[:port], or an ssh config alias.',
    );
    this.name = 'SshDeviceTargetError';
  }
}

const MAX_TARGET_LENGTH = 255;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** DNS name, IPv4 or alias: never a leading `-`, no `%`, `=`, `/`, `@`, space. */
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;
const PORT = /^[1-9][0-9]{0,4}$/;

function parsePort(value: string): number {
  if (!PORT.test(value)) throw new SshDeviceTargetError();
  const port = Number(value);
  if (port > 65_535) throw new SshDeviceTargetError();
  return port;
}

/**
 * Parse `user@host[:port]`, `host[:port]`, `user@[v6]:port`, `[v6]` or an ssh
 * config alias. Anything else — an option, whitespace, a shell character, a
 * second `@` — throws {@link SshDeviceTargetError}.
 */
export function parseSshDeviceTarget(value: unknown): SshDeviceTarget {
  if (typeof value !== 'string') throw new SshDeviceTargetError();
  if (value.length === 0 || value.length > MAX_TARGET_LENGTH)
    throw new SshDeviceTargetError();
  if (value !== value.trim()) throw new SshDeviceTargetError();
  let rest = value;
  let user: string | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!USER.test(user)) throw new SshDeviceTargetError();
  }
  let host: string;
  let port: number | undefined;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) throw new SshDeviceTargetError();
    host = rest.slice(1, close);
    if (!isIPv6(host)) throw new SshDeviceTargetError();
    const after = rest.slice(close + 1);
    if (after !== '') {
      if (!after.startsWith(':')) throw new SshDeviceTargetError();
      port = parsePort(after.slice(1));
    }
  } else {
    const colon = rest.indexOf(':');
    host = colon === -1 ? rest : rest.slice(0, colon);
    if (colon !== -1) port = parsePort(rest.slice(colon + 1));
    if (!HOST.test(host)) throw new SshDeviceTargetError();
    // The alias grammar the SSH environments already enforce, once more.
    try {
      requireOpenSshAlias(host);
    } catch {
      throw new SshDeviceTargetError();
    }
  }
  return {
    ...(user !== undefined ? { user } : {}),
    host,
    ...(port !== undefined ? { port } : {}),
  };
}

/** Whether `value` is a well-formed SSH target (see {@link parseSshDeviceTarget}). */
export function isSshDeviceTarget(value: unknown): value is string {
  try {
    parseSshDeviceTarget(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Options on every invocation. The trust and prompt policy is not the
 * operator's ambient config's to relax: see the module docblock.
 */
export const SSH_DEVICE_BASE_OPTIONS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'RemoteCommand=none',
];

/** `-l`, `-p`, then `--` and the host: a target never reaches the option parser. */
function targetArgs(target: SshDeviceTarget): string[] {
  const parsed = parseSshDeviceTarget(formatSshDeviceTarget(target));
  return [
    ...(parsed.user !== undefined ? ['-l', parsed.user] : []),
    ...(parsed.port !== undefined ? ['-p', String(parsed.port)] : []),
    '--',
    parsed.host,
  ];
}

function formatSshDeviceTarget(target: SshDeviceTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${target.user !== undefined ? `${target.user}@` : ''}${host}${target.port !== undefined ? `:${target.port}` : ''}`;
}

/**
 * The remote command: a CONSTANT. It resolves `node` for a non-interactive
 * session (without sourcing the user's shell files) and starts a tiny loader
 * that reads ONE line of JSON from stdin — `{s: <script>, p: <params>}` —
 * and runs the script with the params. The rest of stdin stays with the
 * script (the install payload, or the lifetime of a hub session).
 *
 * stdin ending before a header line exits (status 2) rather than waiting.
 *
 * The loader is written without `"`, `$`, backslash or backtick so it sits
 * inside a double-quoted `node -e` argument, and the whole program is one
 * single-quoted `sh -c` argument for the login shell.
 */
/**
 * ssh's own report that it holds the local forward listener (DEBUG1, see
 * {@link buildSshDeviceForwardArgs}). The port must be the one requested.
 * Anchored to a whole `debug1:` line of ssh's own: a message the SERVER
 * relays is prefixed `debug1: Remote:` and never matches. (A pre-auth
 * banner is raw text a hostile server could shape; the device host is the
 * operator's own machine, which already runs the hub, so that is outside
 * this check's threat model — the threat is another LOCAL process.)
 */
export function forwardListeningPort(line: string): number | undefined {
  const match =
    /^debug1: Local forwarding listening on 127\.0\.0\.1 port ([0-9]{1,5})\.\r?$/.exec(
      line,
    );
  return match ? Number(match[1]) : undefined;
}

const REMOTE_LOADER_JS =
  "let b=Buffer.alloc(0),r=0;const f=(c)=>{b=Buffer.concat([b,c]);const i=b.indexOf(10);if(i<0)return;r=1;process.stdin.removeListener('data',f);process.stdin.pause();const m=JSON.parse(b.subarray(0,i).toString('utf8'));require('vm').runInThisContext(m.s)(require,b.subarray(i+1),m.p)};process.stdin.on('data',f);process.stdin.on('end',()=>{if(!r)process.exit(2)})";

const REMOTE_PRELUDE_SH = [
  'PATH="$HOME/.local/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
  'if [ -z "$ANDROID_HOME" ]; then if [ -d "$HOME/Library/Android/sdk" ]; then ANDROID_HOME="$HOME/Library/Android/sdk"; elif [ -d "$HOME/Android/Sdk" ]; then ANDROID_HOME="$HOME/Android/Sdk"; fi; fi',
  'if [ -n "$ANDROID_HOME" ]; then PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; export ANDROID_HOME; fi',
  'export PATH',
  'command -v node >/dev/null 2>&1 || { echo STATION_DEVICE_HOST_NODE_MISSING >&2; exit 97; }',
  `exec node -e "${REMOTE_LOADER_JS}"`,
].join('; ');

/** Quote one word for a POSIX login shell: single quotes, `'` closed and reopened. */
function quoteForRemoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The fixed remote command words (ssh joins them with spaces for the login shell). */
export function remoteLoaderCommand(): string[] {
  return ['sh', '-c', quoteForRemoteShell(REMOTE_PRELUDE_SH)];
}

/** Exit status the prelude uses when `node` is not on the session PATH. */
export const REMOTE_NODE_MISSING_EXIT = 97;

/** One remote-script run (probe, install, AVD lookup, or a hub session). */
export function buildSshDeviceCommandArgs(target: SshDeviceTarget): string[] {
  return [
    '-T',
    ...SSH_DEVICE_BASE_OPTIONS,
    // THIS (command) session binds no forward at all, the config's
    // LocalForward/RemoteForward/DynamicForward included. The forward
    // session below cannot say the same: see its docblock.
    '-o',
    'ClearAllForwardings=yes',
    ...targetArgs(target),
    ...remoteLoaderCommand(),
  ];
}

function safePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new SshDeviceTargetError();
  return value;
}

/**
 * The hub forward: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`. Both
 * ends are numeric loopback, so the forward never listens beyond this
 * machine and never reaches past the remote's loopback.
 *
 * `LogLevel=DEBUG1` (this invocation only) is what makes ssh report
 * "Local forwarding listening on 127.0.0.1 port <local>." once IT holds the
 * listener; the supervisor sends nothing to the port before that line
 * (`ssh-device-hub.ts`). VERBOSE does not print it (checked against
 * OpenSSH on macOS, 2026-09-23). The rest of stderr is read bounded and
 * discarded; nothing Station sends appears in ssh's own log.
 *
 * Disclosed: `ClearAllForwardings=yes` cannot be used here (it would clear
 * this `-L` too), so any `LocalForward`, `RemoteForward` or
 * `DynamicForward` the operator's ssh config declares for this host ALSO
 * opens on this `-N` process, for as long as the hub runs. That is the
 * operator's own config; Station neither adds to it nor can remove it.
 */
export function buildSshDeviceForwardArgs(
  target: SshDeviceTarget,
  localPort: number,
  remotePort: number,
): string[] {
  return [
    '-N',
    '-T',
    ...SSH_DEVICE_BASE_OPTIONS,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'GatewayPorts=no',
    '-o',
    'LogLevel=DEBUG1',
    '-L',
    `127.0.0.1:${safePort(localPort)}:127.0.0.1:${safePort(remotePort)}`,
    ...targetArgs(target),
  ];
}

/**
 * The environment ssh runs with: what it needs to find the operator's agent
 * and config, nothing else. No Station credential reaches it, so no
 * `SendEnv` pattern in the operator's config could forward one.
 */
const SSH_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
];

export function sshDeviceEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SSH_ENV_ALLOWLIST)
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}

/**
 * ssh's own failure, typed. Only OpenSSH's diagnostics are read (the
 * remote script reports its own failures on stdout as JSON), and nothing
 * raw is ever returned.
 */
export function classifySshDeviceFailure(input: {
  stderr: string;
  exitCode: number | null;
  spawnFailed?: boolean;
}): DeviceSshHostFailure {
  if (input.spawnFailed) return 'ssh-unavailable';
  // ssh's own debug lines (the forward runs at DEBUG1) describe the
  // negotiation, not the failure: a successful public-key login prints
  // "debug1: Authentications that can continue: …keyboard-interactive",
  // which would otherwise read as a prompt (review D1). Only the lines ssh
  // prints at its normal levels are classified.
  const stderr = input.stderr
    .split('\n')
    .filter((line) => !/^debug[1-3]: /.test(line))
    .join('\n');
  if (
    input.exitCode === REMOTE_NODE_MISSING_EXIT ||
    stderr.includes('STATION_DEVICE_HOST_NODE_MISSING')
  )
    return 'node-missing';
  const classified = classifySshReachabilityFailure({
    host: 'host',
    port: 22,
    stderr,
    exitCode: input.exitCode ?? 255,
    spawnFailed: false,
  });
  switch (classified.code) {
    case 'ssh-not-found':
      return 'ssh-unavailable';
    case 'host-key':
      return classified.hostKeyReason === 'changed'
        ? 'host-key-changed'
        : 'host-key-unverified';
    case 'auth-rejected':
    case 'agent':
    case 'interactive-required':
      return 'auth-failed';
    case 'timeout':
      return 'timeout';
    case 'host-unknown':
    case 'connection-refused':
    case 'network-unreachable':
      return 'unreachable';
    default:
      if (
        /cannot listen|address already in use|forwarding failed/i.test(stderr)
      )
        return 'forward-failed';
      return input.exitCode === 255 ? 'unreachable' : 'protocol';
  }
}
