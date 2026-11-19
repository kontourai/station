/**
 * Which OpenCode a binary is, read from `<binary> --version`.
 *
 * OpenCode 1.x (npm `opencode-ai`) speaks only ACP. OpenCode 2.x also runs
 * `opencode serve` (HTTP + SSE), which Station can drive natively, and its
 * ACP is a client of that same server. 2.3.0 prints `opencode v2.3.0` and
 * 1.x a bare `1.18.18`. The reader accepts only a first non-empty line that
 * is exactly one of those forms (`[opencode ][v]X.Y.Z[-pre]`); anything else
 * (a banner, a warning, a version inside other text) is `undefined`:
 * unknown, never guessed. A pre-release keeps its suffix in `text`, so it
 * never matches an allowlist entry for the release.
 *
 * A probe runs the binary, so its answer is kept per binary identity (real
 * path, size and modification time): an upgrade in place is a new identity
 * and is probed again.
 */
import { realpath, stat } from 'node:fs/promises';
import { runCliCommand } from '../auth/cli-auth.js';

export interface OpenCodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `major.minor.patch[-pre]`, as the allowlists are keyed. */
  readonly text: string;
}

export function parseOpenCodeVersion(
  output: string,
): OpenCodeVersion | undefined {
  const line = output
    .slice(0, 4096)
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  if (!line) return undefined;
  const match =
    /^(?:opencode\s+)?v?(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/.exec(
      line,
    );
  if (!match) return undefined;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  return {
    major,
    minor,
    patch,
    text: `${major}.${minor}.${patch}${match[4] ?? ''}`,
  };
}

/** OpenCode 2.x and later run `opencode serve`; 1.x is ACP-only. */
export function openCodeServesNatively(version: OpenCodeVersion): boolean {
  return version.major >= 2;
}

/** Bounds on one `--version` run: it prints one line, at once. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_MAX_OUTPUT = 64 * 1024;

export type OpenCodeVersionRunner = (binary: string) => Promise<string | null>;

const runVersion: OpenCodeVersionRunner = async (binary) => {
  const result = await runCliCommand(
    binary,
    ['--version'],
    undefined,
    undefined,
    {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: VERSION_PROBE_MAX_OUTPUT,
      killSignal: 'SIGKILL',
    },
  );
  if (!result || result.code !== 0 || result.timedOut) return null;
  return result.stdout;
};

async function binaryIdentity(binary: string): Promise<string> {
  const real = await realpath(binary);
  const info = await stat(real);
  return JSON.stringify([real, info.size, info.mtimeMs]);
}

export interface OpenCodeVersionProbe {
  /** The binary's version; `undefined` when it cannot be read. */
  probe(binary: string): Promise<OpenCodeVersion | undefined>;
}

export function createOpenCodeVersionProbe(
  options: {
    run?: OpenCodeVersionRunner;
    identity?: (binary: string) => Promise<string>;
  } = {},
): OpenCodeVersionProbe {
  const run = options.run ?? runVersion;
  const identify = options.identity ?? binaryIdentity;
  const known = new Map<string, Promise<OpenCodeVersion | undefined>>();
  return {
    async probe(binary) {
      let identity: string;
      try {
        identity = await identify(binary);
      } catch {
        return undefined;
      }
      let answer = known.get(identity);
      if (!answer) {
        answer = run(binary).then(
          (output) =>
            output === null ? undefined : parseOpenCodeVersion(output),
          () => undefined,
        );
        known.set(identity, answer);
        // An unreadable answer is not kept: the next probe tries again.
        void answer.then((version) => {
          if (!version && known.get(identity) === answer)
            known.delete(identity);
        });
      }
      return answer;
    },
  };
}

/** The process-wide probe Station's adapters share. */
export const openCodeVersionProbe = createOpenCodeVersionProbe();

/**
 * Why Station does not apply its approval mode to OpenCode `version` over
 * ACP below host full access (ruling R1). Shown as the refusal reason.
 */
export function openCodeAcpApprovalUnsupportedReason(version: string): string {
  return `OpenCode ${version} runs over ACP here, and over ACP Station cannot verify the approval rules OpenCode 2 enforces. Use host Never ask, or start the chat without a Station approval mode to use OpenCode's own approvals`;
}
