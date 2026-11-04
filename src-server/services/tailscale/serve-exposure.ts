/**
 * #4519: whether Tailscale Serve forwards any of this server's ports, asked
 * once at startup when the managed policy allows no remote clients.
 *
 * Serve runs inside `tailscaled`, so it can forward only while the daemon
 * runs and is logged in. "Nothing forwards" is therefore proven by any of:
 * no Tailscale on the machine at all, a trusted CLI that reports the daemon
 * is not running, a backend state that is not `Running` (stopped or logged
 * out), or a Serve configuration whose every target is another port.
 * Anything else, including a CLI that times out, exits with an error it
 * does not explain, or prints a shape this build does not know, is
 * `unverifiable`: the caller refuses to start, since it cannot show that
 * nothing forwards. Which CLI is trusted, and what "no Tailscale" means, is
 * `tailscale-authority.ts`.
 */
import { execFile } from 'node:child_process';
import { inspectServePort } from './public-ingress-origin.js';
import {
  resolveTailscaleAuthority,
  type TailscaleAuthority,
} from './tailscale-authority.js';

export interface TailscaleCommandResult {
  /** `null` when the command did not exit normally (a timeout, a signal). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True only when no Tailscale executable exists. */
  readonly unavailable?: boolean;
}

export type TailscaleCommand = (
  args: readonly string[],
) => Promise<TailscaleCommandResult>;

export type TailscaleServeExposure =
  | {
      state: 'clear';
      reason: 'not-installed' | 'not-running' | 'logged-out' | 'no-route';
    }
  | { state: 'mapped'; ports: number[] }
  | { state: 'unverifiable'; detail: string; remedy?: string };

/**
 * What the CLI prints when it cannot reach a daemon that is not running
 * ("failed to connect to local tailscaled; it doesn't appear to be
 * running"). Matched only on a normal non-zero exit; an unmatched message
 * stays unverifiable, so a wording change fails closed.
 */
const DAEMON_NOT_RUNNING = /doesn't appear to be running/i;

/**
 * Backend states in which no Serve route forwards traffic. A switch, not an
 * object lookup: `constructor` or `__proto__` must not find an inherited
 * member and read as idle (#4519 round 1).
 */
function idleBackendState(
  state: string,
): 'not-running' | 'logged-out' | undefined {
  switch (state) {
    case 'Stopped':
    case 'NoState':
      return 'not-running';
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return 'logged-out';
    default:
      return undefined;
  }
}

const COMMAND_TIMEOUT_MS = 5_000;

function runOnce(
  executable: string,
  args: readonly string[],
): Promise<TailscaleCommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: !error ? 0 : typeof code === 'number' ? code : null,
          ...(error && (code === 'ENOENT' || code === 'ENOTDIR')
            ? { unavailable: true }
            : {}),
        });
      },
    );
  });
}

/**
 * Test seam only: a command that runs `executables` in order, the first
 * installed one answering (with its failure, if it fails). Production never
 * builds one; it runs the trusted CLI `resolveTailscaleAuthority` finds.
 */
export function createTailscaleCommand(
  executables: readonly string[],
  run: typeof runOnce = runOnce,
): TailscaleCommand {
  return async (args) => {
    for (const executable of executables) {
      const result = await run(executable, args);
      if (result.unavailable !== true) return result;
    }
    return { exitCode: null, stdout: '', stderr: '', unavailable: true };
  };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

function failureDetail(
  command: string,
  result: TailscaleCommandResult,
): string {
  const said = firstLine(result.stderr);
  return result.exitCode === null
    ? `\`tailscale ${command}\` did not answer`
    : `\`tailscale ${command}\` exited ${result.exitCode}${said ? ` (${said})` : ''}`;
}

let verifiedAuthority: TailscaleAuthority | undefined;

/**
 * The production authority for this process. A CLI once verified (the
 * macOS signature check takes about a second) is reused by later listener
 * admissions; an absent or untrusted answer is not kept, so a Tailscale
 * installed later is still seen.
 */
async function resolveProcessAuthority(): Promise<TailscaleAuthority> {
  if (verifiedAuthority) return verifiedAuthority;
  const authority = await resolveTailscaleAuthority();
  if (authority.kind === 'trusted') verifiedAuthority = authority;
  return authority;
}

/**
 * The production check: asks only the Tailscale `resolveTailscaleAuthority`
 * trusts. No Tailscale at all is clear; signs of one without a trusted CLI
 * are unverifiable, with what to install or stop.
 */
export async function inspectTrustedTailscaleServeExposure(
  ports: readonly number[],
  resolveAuthority: () => Promise<TailscaleAuthority> = resolveProcessAuthority,
): Promise<TailscaleServeExposure> {
  const authority = await resolveAuthority();
  if (authority.kind === 'absent')
    return { state: 'clear', reason: 'not-installed' };
  if (authority.kind === 'untrusted')
    return {
      state: 'unverifiable',
      detail: `Tailscale may be installed (${authority.signs.slice(0, 4).join('; ').slice(0, 400)}), but there is no Tailscale CLI it can trust`,
      remedy: authority.remedy,
    };
  return inspectTailscaleServeExposure(ports, authority.command);
}

/**
 * Whether Tailscale Serve forwards any of `ports`, asking `command`; see the
 * module comment. `command` is the trusted CLI, or a test's stand-in, whose
 * "no executable" answer is taken as Tailscale being absent.
 */
export async function inspectTailscaleServeExposure(
  ports: readonly number[],
  command: TailscaleCommand,
): Promise<TailscaleServeExposure> {
  const status = await command(['status', '--json']);
  if (status.unavailable === true)
    return { state: 'clear', reason: 'not-installed' };
  if (status.exitCode !== 0) {
    if (status.exitCode !== null && DAEMON_NOT_RUNNING.test(status.stderr))
      return { state: 'clear', reason: 'not-running' };
    return {
      state: 'unverifiable',
      detail: failureDetail('status --json', status),
    };
  }
  let backendState: unknown;
  try {
    backendState = (JSON.parse(status.stdout) as { BackendState?: unknown })
      ?.BackendState;
  } catch {
    backendState = undefined;
  }
  if (typeof backendState !== 'string')
    return {
      state: 'unverifiable',
      detail: '`tailscale status --json` did not report a backend state',
    };
  const idle = idleBackendState(backendState);
  if (idle) return { state: 'clear', reason: idle };
  if (backendState !== 'Running')
    return {
      state: 'unverifiable',
      detail: `Tailscale reported the unknown backend state ${JSON.stringify(backendState.slice(0, 40))}`,
    };

  const serve = await command(['serve', 'status', '--json']);
  if (serve.exitCode !== 0)
    return {
      state: 'unverifiable',
      detail: failureDetail('serve status --json', serve),
    };
  // An unconfigured Serve prints nothing at all.
  const text = serve.stdout.trim() === '' ? '{}' : serve.stdout;
  const answer = async () => ({ stdout: text, exitCode: 0 });
  const mapped: number[] = [];
  for (const port of ports) {
    const verdict = await inspectServePort(port, answer);
    if (verdict === 'unverifiable')
      return {
        state: 'unverifiable',
        detail:
          '`tailscale serve status --json` has a shape this version of Station cannot check',
      };
    if (verdict === 'mapped') mapped.push(port);
  }
  return mapped.length > 0
    ? { state: 'mapped', ports: mapped }
    : { state: 'clear', reason: 'no-route' };
}
