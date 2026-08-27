/**
 * A one-shot, side-effect-free reachability probe for a prospective SSH
 * computer — the server-side half of the Connections "Test connection"
 * action (audit CI-R1/CI-R14).
 *
 * Two disciplines it is built to keep:
 *
 * 1. Every sentence it returns is DERIVED from something OpenSSH actually
 *    reported. `summary`/`action` are computed from the resolved config
 *    (`ssh -G`) plus the exit code and stderr of a real connection attempt;
 *    nothing here is a label a caller can set. CI-R14's defect was the
 *    opposite: a free-text `action` string that in practice said nothing.
 * 2. It never mutates anything, and Station is never a trust writer. No
 *    profile is written and no host key is accepted or recorded:
 *    `StrictHostKeyChecking=yes` + `UpdateHostKeys=no` against the
 *    operator's own `known_hosts` means an unknown host FAILS with a named
 *    cause. What the probe does instead is READ the key the host presents
 *    (`ssh-keyscan`, a separate bounded process that writes nothing) and
 *    hand back its fingerprint plus the exact command the OPERATOR can run
 *    to record it themselves. The remote command is a fixed literal — no
 *    caller input is ever interpolated into the remote shell.
 * 3. Everything it returns to a caller passes `redactSshDiagnostic` first:
 *    OpenSSH stderr is arbitrary third-party text (a `ProxyCommand` can
 *    print anything, including credentials), so it is secret-redacted,
 *    stripped of terminal control sequences, home-relative, and bounded
 *    before it can reach a remote authenticated caller.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ConnectionEvidenceFreshness,
  ConnectionEvidenceLevel,
} from '@kontourai/station-contracts/tool';
import { redactDeep } from '@kontourai/station-shared/redaction';
import {
  OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS,
  type OpenSshCommandRunner,
  type ResolvedOpenSshHost,
  requireOpenSshAlias,
  resolveOpenSshHost,
} from './openssh-config.js';

export type SshReachabilityFailureCode =
  | 'ssh-not-found'
  | 'host-unknown'
  | 'connection-refused'
  | 'timeout'
  | 'network-unreachable'
  | 'auth-rejected'
  | 'host-key'
  | 'agent'
  | 'interactive-required'
  | 'config'
  | 'unknown';

/**
 * The readiness-evidence shape (#3649) as it applies to a computer rather
 * than a model connection: a version, the level of proof, when it was
 * observed, a sentence describing what was proven, and — when it is not
 * ready — the single next step that would change the answer.
 *
 * `level` reuses the connection vocabulary deliberately:
 * - `smoke-passed`: a command actually ran on the remote host over SSH.
 * - `prerequisite-ready`: SSH authenticated, but a prerequisite Station
 *   needs there (Node.js) is missing.
 * - `discovered`: the host resolves in this Station's SSH config, but no
 *   session was established.
 */
export interface SshReachabilityEvidence {
  evidenceVersion: 1;
  level: ConnectionEvidenceLevel;
  freshness: ConnectionEvidenceFreshness;
  observedAt: string;
  /** True only when a remote command completed over a real SSH session. */
  reachable: boolean;
  summary: string;
  action?: string;
  /** What OpenSSH says this host resolves to — user/port/auth, derived. */
  resolved?: Pick<
    ResolvedOpenSshHost,
    'hostname' | 'user' | 'port' | 'identityAgent'
  >;
  /** Node.js version reported by the remote host, when it has one. */
  remoteNodeVersion?: string;
  /**
   * Present only when this host has never been confirmed from this computer.
   * Station will not record the key, so this is what the operator needs to
   * make that decision themselves: the fingerprint OpenSSH would have asked
   * them to compare, and the exact command that records it. `action` is
   * composed FROM `trustCommand` — one derivation, so the sentence the user
   * reads and the command the Copy button puts on the clipboard can never
   * be two different commands.
   */
  unknownHost?: SshUnknownHostKey;
  failure?: { code: SshReachabilityFailureCode; detail: string };
}

export interface SshUnknownHostKey {
  /** `SHA256:...`, base64 without padding — byte-identical to what `ssh` prints. */
  fingerprint: string;
  /** The host-key algorithm this fingerprint belongs to (`ssh-ed25519`, …). */
  keyType: string;
  /**
   * The EXACT `known_hosts` line whose fingerprint is above — host (or
   * `[host]:port`), key type, and base64 key, as `ssh-keyscan` printed it.
   * `trustCommand` appends these literal bytes, so the key the operator
   * verified is the key that gets trusted.
   */
  knownHostsLine: string;
  /** The command that records THAT line in the operator's own known_hosts. */
  trustCommand: string;
}

interface SshAttemptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnFailed: boolean;
}

export type SshReachabilityAttempt = (
  args: readonly string[],
) => Promise<SshAttemptResult>;

/**
 * Reads (never writes) the host keys a host presents, returning
 * `ssh-keyscan`'s raw stdout. Injectable so the unknown-host path is
 * testable without a network.
 */
export type SshHostKeyScanner = (input: {
  host: string;
  port: number;
  keyTypes: readonly string[];
}) => Promise<string>;

const CONNECT_TIMEOUT_SECONDS = 8;
const MAX_DETAIL_LENGTH = 400;

/**
 * One connection attempt's ceiling: OpenSSH's own connect timeout plus the
 * margin the runner allows for auth/banner exchange before it kills the
 * process tree.
 */
export const SSH_PROBE_ATTEMPT_MAX_SECONDS = CONNECT_TIMEOUT_SECONDS + 7;

/** The bounded `ssh-keyscan` run for an unknown host. */
export const SSH_HOST_KEY_SCAN_MAX_SECONDS = CONNECT_TIMEOUT_SECONDS;

/** `ssh -G`, which the probe runs first to resolve the host. */
export const SSH_CONFIG_RESOLVE_MAX_SECONDS = Math.ceil(
  OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS / 1_000,
);

/**
 * The whole probe's wall-clock ceiling — the SUM of its three sequential
 * legs, not any one of them (sol delta finding 5).
 *
 * A probe resolves the host (`ssh -G`), attempts the connection, and — for an
 * unknown host — scans its keys, one after another. `Retry-After` was the
 * attempt's ceiling alone, so a caller who waited exactly that long could
 * arrive while the first probe was still scanning and collect a second 429:
 * a header that tells you when to come back, and is wrong. Summing the legs
 * from their own constants means adding or re-timing a leg moves the header
 * with it, instead of leaving a number nobody re-derives.
 */
export const SSH_PROBE_MAX_SECONDS =
  SSH_CONFIG_RESOLVE_MAX_SECONDS +
  SSH_PROBE_ATTEMPT_MAX_SECONDS +
  SSH_HOST_KEY_SCAN_MAX_SECONDS;

/**
 * Asked of `ssh-keyscan` in OpenSSH's own preference order, so the key whose
 * fingerprint we show is the one `ssh` would negotiate on the next attempt.
 * Documented limit: a host offering none of these (or reordering them via
 * `HostKeyAlgorithms`) yields no fingerprint, and the probe then falls back
 * to the generic host-key action rather than showing a key it cannot name.
 */
const SCANNED_HOST_KEY_TYPES = ['ed25519', 'ecdsa', 'rsa'] as const;

/**
 * The remote command is a FIXED literal (never built from caller input) and
 * is the cheapest thing that proves both "a shell ran" and "Station's own
 * runtime prerequisite exists here".
 */
const REMOTE_REACHABILITY_MARKER = '__station_ssh_reachable__';

// The marker is printed by the remote shell before Node is attempted.  It is
// useful diagnostic evidence that a remote shell started, but `reachable`
// remains deliberately stricter: the complete fixed command must exit zero.
const REMOTE_COMMAND = [
  'sh',
  '-c',
  `printf '%s\\n' ${REMOTE_REACHABILITY_MARKER}; exec node --version`,
] as const;

/** OpenSSH's own default when configuration names no trust store. */
export function defaultUserKnownHostsFiles(): string[] {
  return [join(homedir(), '.ssh', 'known_hosts')];
}

/**
 * Renders a resolved store list for one `-o UserKnownHostsFile=` value.
 * OpenSSH splits that value on whitespace, so a path containing spaces has
 * to arrive quoted — the same rule `ssh_config` itself uses.
 */
export function formatUserKnownHostsFiles(files: readonly string[]): string {
  return files.map((file) => (/\s/.test(file) ? `"${file}"` : file)).join(' ');
}

export function buildSshReachabilityArgs(
  alias: string,
  /**
   * The stores `ssh -G` said THIS host resolves to (sol delta finding 3).
   * The probe used to force `~/.ssh/known_hosts` while CONNECT deliberately
   * honours the configured `UserKnownHostsFile`, so the two asked different
   * questions: a host trusted only in `~/.ssh/work_known_hosts` failed the
   * creator's probe, and appending to the default file could make the probe
   * pass while CONNECT still refused. Passing the RESOLVED list keeps them
   * on one trust store, and keeps it explicit in the argv rather than
   * ambient — `StrictHostKeyChecking=yes` + `UpdateHostKeys=no` still mean
   * the probe can only read it.
   */
  userKnownHostsFiles: readonly string[] = defaultUserKnownHostsFiles(),
): string[] {
  const safeAlias = requireOpenSshAlias(alias);
  const knownHostsFile = formatUserKnownHostsFiles(
    userKnownHostsFiles.length > 0
      ? userKnownHostsFiles
      : defaultUserKnownHostsFiles(),
  );
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'RequestTTY=no',
    '-T',
    '--',
    safeAlias,
    ...REMOTE_COMMAND,
  ];
}

/**
 * The one boundary every OpenSSH diagnostic crosses before a caller can read
 * it (sol review finding 3). `ssh` stderr is not Station's text: a
 * `ProxyCommand` is an arbitrary program whose output lands here verbatim,
 * and the surface is reachable by any authenticated remote credential, so a
 * raw tail could hand a paired phone a bearer token, a private path, or an
 * escape sequence that rewrites the reader's terminal.
 *
 * The order of the four steps is load-bearing:
 *
 * 1. Control sequences go FIRST. A CSI sequence sitting inside a token would
 *    otherwise split it across the secret patterns' character classes, and
 *    stripping afterwards would rejoin the halves into a live secret.
 * 2. The operator's home directory becomes `~` BEFORE `redactDeep`, because
 *    `redactDeep` replaces any absolute path with `[REDACTED_PATH]` — running
 *    it first would erase `/Users/<name>/.ssh/config` wholesale and the
 *    home-relative rewrite would have nothing left to match. `~/.ssh/config`
 *    is both non-identifying and the actionable half of the message.
 * 3. `redactDeep` then removes the rest: secret patterns, `key=value`
 *    secret-named fields, URLs, and any absolute path outside the home.
 * 4. Whitespace normalization and the 400-character TAIL last — OpenSSH puts
 *    its conclusion on the final line, so the tail is the informative end.
 */
/** The parameter/intermediate/final byte run that follows an ESC. */
const ESCAPE_SEQUENCE_TAIL = /^[@-_]?[0-?]*[ -/]*[@-~]?/;
const ESCAPE = '\u001b';

/**
 * Removes terminal escape sequences and the remaining C0/DEL controls,
 * keeping `\t`/`\n`/`\r` for the whitespace collapse to fold. Written
 * without control characters INSIDE a regex (`noControlCharactersInRegex`):
 * the string is split on ESC and each following segment loses its sequence
 * head, then a code-point filter drops the rest.
 */
export function stripTerminalControls(value: string): string {
  const withoutEscapes = value
    .split(ESCAPE)
    .map((segment, index) =>
      index === 0 ? segment : segment.replace(ESCAPE_SEQUENCE_TAIL, ''),
    )
    .join('');
  let stripped = '';
  for (const character of withoutEscapes) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    const isFoldableWhitespace =
      character === '\n' || character === '\r' || character === '\t';
    if (!isControl || isFoldableWhitespace) stripped += character;
  }
  return stripped;
}

export function redactSshDiagnostic(value: string): string {
  const withoutControls = stripTerminalControls(value);
  const home = homedir();
  const homeRelative = home
    ? withoutControls.replaceAll(home, '~')
    : withoutControls;
  const trimmed = String(redactDeep(homeRelative)).trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `…${trimmed.slice(-MAX_DETAIL_LENGTH)}`
    : trimmed;
}

/**
 * `ssh-keyscan` emits `<host> <keytype> <base64-key>` lines (plus `#`
 * comments). OpenSSH's fingerprint is the SHA-256 of the DECODED key blob,
 * base64-encoded without padding — computed here rather than shelling out to
 * `ssh-keygen -lf` so the value is derived from the bytes we actually read.
 */
export function parseSshKeyscanFingerprint(
  output: string,
): { fingerprint: string; keyType: string; knownHostsLine: string } | null {
  for (const candidate of output.split(/\r?\n/)) {
    const fields = candidate.trim().split(/\s+/);
    if (candidate.startsWith('#') || fields.length < 3) continue;
    const keyType = fields[1] ?? '';
    if (!/^(?:sk-)?(?:ssh-|ecdsa-)/.test(keyType)) continue;
    const encoded = fields[2] ?? '';
    const key = Buffer.from(encoded, 'base64');
    // Round-trip guard: `Buffer.from` silently drops non-base64 characters,
    // so a malformed field would otherwise hash to a confident-looking
    // fingerprint for bytes the host never sent.
    if (
      key.length === 0 ||
      key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
    )
      continue;
    return {
      keyType,
      fingerprint: `SHA256:${createHash('sha256')
        .update(key)
        .digest('base64')
        .replace(/=+$/, '')}`,
      // Rebuilt from the three validated fields rather than passed through
      // verbatim: `ssh-keyscan` may append trailing comment text, and the
      // line is about to be written into a trust store. Exactly the host
      // pattern, the key type and the key that produced the fingerprint.
      knownHostsLine: `${fields[0]} ${keyType} ${encoded}`,
    };
  }
  return null;
}

/**
 * Wraps a value so a POSIX shell passes it through byte-for-byte. Single
 * quotes suppress every expansion; the only character that cannot appear
 * inside them is `'`, which is closed, escaped and reopened.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Reads the host's keys with a bounded `ssh-keyscan`. It writes nothing —
 * `known_hosts` stays the operator's file, edited by the operator's own
 * command. The process is bounded twice (keyscan's own `-T` and the child
 * timeout) and its output is capped, because the host on the other end is by
 * definition one this computer has never trusted.
 */
export function createSystemSshHostKeyScanner(
  timeoutMs = SSH_HOST_KEY_SCAN_MAX_SECONDS * 1000,
): SshHostKeyScanner {
  return ({ host, port, keyTypes }) =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'ssh-keyscan',
        [
          '-T',
          String(Math.max(1, Math.ceil(timeoutMs / 1000))),
          '-t',
          keyTypes.join(','),
          '-p',
          String(port),
          '--',
          host,
        ],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          if (error && !stdout)
            rejectPromise(new Error(redactSshDiagnostic(stderr)));
          else resolvePromise(stdout);
        },
      );
    });
}

/**
 * The unknown-host half of the evidence: the fingerprint the operator has to
 * compare, and the ONE command that records it. Composed here so `action`
 * and the Copy button in the creator can never be two different commands.
 */
async function readUnknownHostKey(input: {
  host: string;
  port: number;
  knownHostsFile: string;
  scan: SshHostKeyScanner;
}): Promise<SshUnknownHostKey | undefined> {
  let output: string;
  try {
    output = await input.scan({
      host: input.host,
      port: input.port,
      keyTypes: SCANNED_HOST_KEY_TYPES,
    });
  } catch {
    // A host that will not answer ssh-keyscan leaves the generic host-key
    // action in place. Never invent a fingerprint.
    return undefined;
  }
  const scanned = parseSshKeyscanFingerprint(output);
  if (!scanned) return undefined;
  return {
    ...scanned,
    trustCommand: buildTrustCommand(
      scanned.knownHostsLine,
      input.knownHostsFile,
    ),
  };
}

/**
 * The command that records ONE key — the one whose fingerprint the operator
 * just read (sol delta finding 1).
 *
 * It used to be `ssh-keyscan … >> ~/.ssh/known_hosts`, which is a SECOND,
 * unrestricted scan. Nothing binds its result to the fingerprint on screen:
 * the host can answer differently the second time, and an unrestricted scan
 * returns every algorithm it offers — so a user who carefully verified an
 * Ed25519 fingerprint could end up trusting an ECDSA key they never saw,
 * which `ssh` may then negotiate. The verification ritual would be theatre.
 *
 * `printf` appends the exact bytes that produced the displayed fingerprint,
 * shell-quoted, with no network access at all.
 */
export function buildTrustCommand(
  knownHostsLine: string,
  /**
   * The file `ssh` will actually consult FIRST for this host — the same
   * store the probe just read. Appending to `~/.ssh/known_hosts` when the
   * operator configured another file produces a command that changes
   * nothing, which is worse than no command.
   */
  knownHostsFile: string = defaultUserKnownHostsFiles()[0] as string,
): string {
  return `printf '%s\\n' ${shellSingleQuote(knownHostsLine)} >> ${shellQuotePath(knownHostsFile)}`;
}

/**
 * Renders a path for a shell redirect. A path under the operator's home is
 * written `"$HOME/..."` so the command stays readable and does not carry
 * their account name; anything else, or anything with a character that would
 * mean something inside double quotes, is single-quoted absolute.
 */
export function shellQuotePath(path: string): string {
  const home = homedir();
  const prefix = home ? `${home}/` : '';
  const relative =
    prefix && path.startsWith(prefix) ? path.slice(prefix.length) : null;
  return relative !== null && /^[A-Za-z0-9._/-]+$/.test(relative)
    ? `"$HOME/${relative}"`
    : shellSingleQuote(path);
}

export function unknownHostAction(unknownHost: SshUnknownHostKey): string {
  return (
    'Station does not accept new host keys. Verify this fingerprint with the ' +
    `computer's owner, then run: ${unknownHost.trustCommand}, and test again.`
  );
}

/**
 * Maps OpenSSH's own diagnostics onto a named cause and the ONE next step
 * that would change the outcome. Pure and exported so the copy it produces
 * is directly testable — the whole point of CI-R14.
 */
export function classifySshReachabilityFailure(input: {
  host: string;
  port: number;
  stderr: string;
  exitCode: number;
  spawnFailed: boolean;
}): {
  code: SshReachabilityFailureCode;
  summary: string;
  action: string;
  /**
   * Which host-key case this is. `unknown` is the only one the fingerprint
   * path may run for: a CHANGED key is a possible interception, so offering
   * to append the new key would be Station handing the user a one-click way
   * to trust exactly the thing OpenSSH just refused.
   */
  hostKeyReason?: 'unknown' | 'changed';
} {
  const { host, port, stderr } = input;
  if (input.spawnFailed) {
    return {
      code: 'ssh-not-found',
      summary: 'Station could not run the ssh command on this computer.',
      action:
        'Install an OpenSSH client (the `ssh` command) on the computer running Station, then test again.',
    };
  }
  if (/connection refused/i.test(stderr)) {
    return {
      code: 'connection-refused',
      summary: `Connection refused on port ${port} — is sshd running on ${host}?`,
      action: `Start the SSH server on ${host} (macOS: System Settings → General → Sharing → Remote Login; Linux: \`sudo systemctl start sshd\`), then test again.`,
    };
  }
  if (
    /could not resolve hostname|name or service not known|nodename nor servname|no address associated/i.test(
      stderr,
    )
  ) {
    return {
      code: 'host-unknown',
      summary: `No computer named ${host} could be found on the network.`,
      action: `Check the spelling, or add a Host stanza for ${host} to ~/.ssh/config with its address.`,
    };
  }
  if (/operation timed out|connection timed out|timed out/i.test(stderr)) {
    return {
      code: 'timeout',
      summary: `${host} did not answer on port ${port} within ${CONNECT_TIMEOUT_SECONDS} seconds.`,
      action: `Check that ${host} is powered on and reachable from this network (a firewall or VPN can block port ${port}), then test again.`,
    };
  }
  if (/network is unreachable|no route to host/i.test(stderr)) {
    return {
      code: 'network-unreachable',
      summary: `No network route to ${host}.`,
      action: `Connect to the network ${host} is on (VPN or tailnet), then test again.`,
    };
  }
  if (/remote host identification has changed/i.test(stderr)) {
    return {
      code: 'host-key',
      hostKeyReason: 'changed',
      summary: `The host key for ${host} changed since it was last seen.`,
      action: `Review the change before trusting it: run \`ssh-keygen -R ${host}\` then \`ssh ${host}\` once in a terminal, confirm the fingerprint, and test again.`,
    };
  }
  if (
    /host key verification failed|authenticity of host|no matching host key/i.test(
      stderr,
    )
  ) {
    return {
      code: 'host-key',
      hostKeyReason: 'unknown',
      summary: `${host} has not been confirmed from this computer yet.`,
      action: `Run \`ssh ${host}\` once in a terminal, confirm the fingerprint, then test again.`,
    };
  }
  if (
    /could not open a connection to your authentication agent|agent refused operation|communication with agent failed/i.test(
      stderr,
    )
  ) {
    return {
      code: 'agent',
      summary: 'Your SSH agent did not provide a key for this connection.',
      action: `Start the agent and load your key (\`ssh-add\`), then test again.`,
    };
  }
  if (
    /permission denied|too many authentication failures|no supported authentication/i.test(
      stderr,
    )
  ) {
    return {
      code: 'auth-rejected',
      summary: `${host} refused the key Station offered.`,
      action: `Add your public key to ~/.ssh/authorized_keys on ${host} (\`ssh-copy-id ${host}\`), then test again.`,
    };
  }
  if (
    /batch mode|passphrase|password:|keyboard-interactive|confirm user presence/i.test(
      stderr,
    )
  ) {
    return {
      code: 'interactive-required',
      summary: `${host} asked for a password or passphrase, which Station cannot answer.`,
      action: `Set up key-based login (\`ssh-copy-id ${host}\`) or add the key to your agent (\`ssh-add\`), then test again.`,
    };
  }
  if (/bad configuration option|unknown (?:option|cipher)/i.test(stderr)) {
    return {
      code: 'config',
      summary: 'Your SSH configuration rejected this connection.',
      action: `Fix the reported option in ~/.ssh/config, then test again. OpenSSH said: ${redactSshDiagnostic(stderr)}`,
    };
  }
  return {
    code: 'unknown',
    summary: `Station could not reach ${host} over SSH.`,
    action: `OpenSSH reported: ${redactSshDiagnostic(stderr) || `exit code ${input.exitCode}`}. Try the same connection from a terminal (\`ssh ${host}\`) to see the full output.`,
  };
}

const NODE_MISSING =
  /command not found|not found|no such file or directory|isn't a command/i;

const MAX_ATTEMPT_OUTPUT_BYTES = 256 * 1024;

/**
 * How this platform kills a process TREE (sol delta finding 4).
 *
 * POSIX has process groups: `detached: true` makes `ssh` a group leader and
 * one negative-pid signal reaches every descendant it started. Windows has
 * neither — `process.kill(-pid)` is not supported there, so the old code fell
 * into its own catch and killed only `ssh`, leaving a `ProxyCommand`
 * descendant alive and (because it inherits the pipes) potentially holding
 * the attempt's promise open. `taskkill /T /F` walks the child list instead,
 * which is Windows' equivalent of the same intent.
 *
 * Returned as a plan rather than executed inline so the branch is testable
 * without a Windows host — the one thing a POSIX CI machine can actually
 * prove about the Windows path.
 */
export type ProcessTreeKill =
  | { kind: 'signal-group'; pid: number; signal: 'SIGKILL' }
  | { kind: 'taskkill'; command: string; args: string[] };

export function planProcessTreeKill(
  platform: NodeJS.Platform,
  pid: number,
): ProcessTreeKill {
  return platform === 'win32'
    ? {
        kind: 'taskkill',
        command: 'taskkill',
        // /T = this process and every child; /F = force, matching SIGKILL.
        args: ['/T', '/F', '/PID', String(pid)],
      }
    : { kind: 'signal-group', pid, signal: 'SIGKILL' };
}

/**
 * Runs one `ssh` attempt as its own PROCESS GROUP (sol review finding 4).
 *
 * `execFile`'s `timeout` signals the direct child only. `ssh` is rarely the
 * only process it started: a `ProxyCommand` (`ProxyJump` compiles to one) is
 * a child that OpenSSH does not necessarily reap, and it can be an arbitrary
 * long-running program — `nc`, `cloudflared`, `aws ssm start-session`. On a
 * timeout the old runner SIGKILLed `ssh` and left that descendant running,
 * which on a surface any authenticated caller can trigger is an unbounded
 * process leak rather than a bounded probe.
 *
 * `detached: true` makes the child a process-group LEADER, so every process
 * it starts inherits that group id and `process.kill(-pid)` reaches all of
 * them with one signal. The group is killed on timeout AND when the probe's
 * own promise settles early, so nothing survives this function returning.
 */
export function createSystemSshReachabilityAttempt(
  options: { sshPath?: string; timeoutMs?: number } = {},
): SshReachabilityAttempt {
  const sshPath = options.sshPath ?? 'ssh';
  const timeoutMs = options.timeoutMs ?? SSH_PROBE_ATTEMPT_MAX_SECONDS * 1000;
  return (args) =>
    new Promise((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const child = spawn(sshPath, [...args], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const collect = (
        stream: NodeJS.ReadableStream | null,
        append: (chunk: string) => void,
      ) => {
        stream?.setEncoding('utf8');
        stream?.on('data', (chunk: string) => append(chunk));
      };
      collect(child.stdout, (chunk) => {
        if (stdout.length < MAX_ATTEMPT_OUTPUT_BYTES)
          stdout += chunk.slice(0, MAX_ATTEMPT_OUTPUT_BYTES - stdout.length);
      });
      collect(child.stderr, (chunk) => {
        if (stderr.length < MAX_ATTEMPT_OUTPUT_BYTES)
          stderr += chunk.slice(0, MAX_ATTEMPT_OUTPUT_BYTES - stderr.length);
      });
      const killGroup = () => {
        if (child.pid === undefined) return;
        const plan = planProcessTreeKill(process.platform, child.pid);
        try {
          if (plan.kind === 'signal-group') {
            // Negative pid = the whole group. `detached` above is what makes
            // the group exist; without it this would signal an unrelated
            // group.
            process.kill(-plan.pid, plan.signal);
          } else {
            // Fire-and-forget: `taskkill` reports "process not found" for an
            // already-exited tree, which is the common case on a normal
            // settle and is not a failure worth surfacing.
            execFile(plan.command, plan.args, { windowsHide: true }, () => {});
          }
        } catch {
          // Already gone, or the platform refused — fall back to the direct
          // child so the ssh process itself never survives either way.
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      timer.unref?.();
      const settle = (result: SshAttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup();
        resolvePromise(result);
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        settle({
          stdout,
          stderr,
          exitCode: 1,
          spawnFailed: error.code === 'ENOENT',
        });
      });
      child.on('close', (code, signal) => {
        settle({
          stdout,
          stderr,
          // A killed process reports no exit code. `255` is OpenSSH's own
          // "connection failed" status and is what the classifier already
          // reads for a timed-out attempt.
          exitCode: code ?? (timedOut || signal ? 255 : 1),
          spawnFailed: false,
        });
      });
    });
}

/**
 * Runs the probe. `resolve` failures are reported as evidence too — a host
 * OpenSSH cannot resolve is a named cause, not an exception the UI has to
 * turn into a bare error string.
 */
export async function probeSshReachability(input: {
  hostAlias: string;
  attempt?: SshReachabilityAttempt;
  runner?: OpenSshCommandRunner;
  scanHostKey?: SshHostKeyScanner;
  now?: () => Date;
}): Promise<SshReachabilityEvidence> {
  const observedAt = (input.now?.() ?? new Date()).toISOString();
  const base = {
    evidenceVersion: 1 as const,
    freshness: 'fresh' as const,
    observedAt,
  };
  const alias = requireOpenSshAlias(input.hostAlias);
  let resolved: ResolvedOpenSshHost | undefined;
  try {
    resolved = input.runner
      ? await resolveOpenSshHost(alias, input.runner)
      : await resolveOpenSshHost(alias);
  } catch {
    // `ssh -G` resolves essentially any syntactically valid alias, so a
    // failure here means the client itself is unusable, not that the host
    // is unknown. Keep going: the connection attempt below names the cause.
  }
  const port = resolved?.port ?? 22;
  const host = resolved?.hostname ?? alias;
  // One resolution, two consumers: the argv the probe verifies against and
  // the file the trust command appends to. If `ssh -G` was unusable we fall
  // back to OpenSSH's own default rather than guessing something else.
  const knownHostsFiles =
    resolved?.userKnownHostsFiles && resolved.userKnownHostsFiles.length > 0
      ? resolved.userKnownHostsFiles
      : defaultUserKnownHostsFiles();
  const attempt = input.attempt ?? createSystemSshReachabilityAttempt();
  const result = await attempt(
    buildSshReachabilityArgs(alias, knownHostsFiles),
  );
  const resolvedSummary = resolved
    ? `${resolved.user}@${resolved.hostname} on port ${resolved.port}`
    : alias;
  const outputLines = result.stdout.split(/\r?\n/);
  const reachedRemoteShell = outputLines.includes(REMOTE_REACHABILITY_MARKER);
  const version = outputLines
    .find((line) => line !== REMOTE_REACHABILITY_MARKER)
    ?.trim();
  if (result.exitCode === 0 && reachedRemoteShell) {
    return {
      ...base,
      level: 'smoke-passed',
      reachable: true,
      resolved,
      remoteNodeVersion: version || undefined,
      summary: version
        ? `Signed in to ${resolvedSummary} and ran a command there · Node ${version}.`
        : `Signed in to ${resolvedSummary} and ran a command there.`,
    };
  }
  const failure = classifySshReachabilityFailure({
    host,
    port,
    stderr: result.stderr,
    exitCode: result.exitCode,
    spawnFailed: result.spawnFailed,
  });
  const nodeMissing = !result.spawnFailed && NODE_MISSING.test(result.stderr);
  const unknownHost =
    failure.hostKeyReason === 'unknown'
      ? await readUnknownHostKey({
          host,
          port,
          // `ssh` reads the list in order and a new key belongs in the first
          // file, which is the one it would have written itself.
          knownHostsFile: knownHostsFiles[0] as string,
          scan: input.scanHostKey ?? createSystemSshHostKeyScanner(),
        })
      : undefined;
  return {
    ...base,
    level: 'discovered',
    reachable: false,
    resolved,
    summary:
      nodeMissing && reachedRemoteShell
        ? `Station reached ${resolvedSummary}, but Node.js is not installed there.`
        : failure.summary,
    action: unknownHost
      ? unknownHostAction(unknownHost)
      : nodeMissing && reachedRemoteShell
        ? `Install Node.js 20 or newer on ${host} (Station runs its work with it), then test again.`
        : failure.action,
    ...(unknownHost ? { unknownHost } : {}),
    failure: { code: failure.code, detail: redactSshDiagnostic(result.stderr) },
  };
}
