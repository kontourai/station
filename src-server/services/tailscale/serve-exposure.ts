/**
 * #4519: whether Tailscale Serve forwards any of this server's ports, asked
 * once at startup when the managed policy allows no remote clients.
 *
 * Serve runs inside `tailscaled`, so it can forward only while the daemon
 * runs and is logged in. "Nothing forwards" is therefore proven by any of:
 * no Tailscale CLI, a daemon that reports it is not running, a backend state
 * that is not `Running` (stopped or logged out), or a Serve configuration
 * whose every target is another port. Anything else, including a CLI that
 * times out, exits with an error it does not explain, or prints a shape this
 * build does not know, is `unverifiable`: the caller refuses to start, since
 * it cannot show that nothing forwards.
 */
import { execFile } from 'node:child_process';
import {
  inspectServePort,
  TAILSCALE_MACOS_APP_CLI,
} from './public-ingress-origin.js';

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
  | { state: 'unverifiable'; detail: string };

/**
 * What the CLI prints when it cannot reach a daemon that is not running
 * ("failed to connect to local tailscaled; it doesn't appear to be
 * running"). Matched only on a normal non-zero exit; an unmatched message
 * stays unverifiable, so a wording change fails closed.
 */
const DAEMON_NOT_RUNNING = /doesn't appear to be running/i;

/** Backend states in which no Serve route forwards traffic. */
const IDLE_BACKEND_STATES: Readonly<
  Record<string, 'not-running' | 'logged-out'>
> = {
  Stopped: 'not-running',
  NoState: 'not-running',
  NeedsLogin: 'logged-out',
  NeedsMachineAuth: 'logged-out',
};

const COMMAND_TIMEOUT_MS = 5_000;

function candidates(platform: NodeJS.Platform): readonly string[] {
  return platform === 'darwin'
    ? [TAILSCALE_MACOS_APP_CLI, 'tailscale']
    : ['tailscale'];
}

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
 * The first installed reviewed executable answers; an absent one is skipped.
 * Unlike the origin resolver's CLI, a failing installed executable is the
 * answer (with its stderr), not a reason to try the next one: the macOS app
 * bundle and a PATH install talk to the same daemon.
 */
export function createTailscaleCommand(
  platform: NodeJS.Platform = process.platform,
  run: typeof runOnce = runOnce,
  executables: readonly string[] = candidates(platform),
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

/** Whether Tailscale Serve forwards any of `ports`; see the module comment. */
export async function inspectTailscaleServeExposure(
  ports: readonly number[],
  command: TailscaleCommand = createTailscaleCommand(),
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
  const idle = IDLE_BACKEND_STATES[backendState];
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
