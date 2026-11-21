/**
 * #2376 slice 3: whether the installed Codex may be given Station tool
 * families (progressive disclosure) instead of the static catalog.
 *
 * Codex lists a server's tools again after `load_tool_family` only with its
 * `mcp_tool_list_changed` feature on; `npm run qualify:tool-disclosure`
 * qualified codex-cli 0.167.0 with it set in `thread/start` configuration,
 * including a resumed thread. 0.164.0 loaded a family and never showed its
 * tools. Admission therefore requires a version Station observed to be at
 * least the qualified one; an unreadable or older version keeps the static
 * catalog. Re-run the qualification after each Codex upgrade.
 */
import type { CliCommandResult } from '../auth/cli-auth.js';

/** The oldest codex-cli the live qualification passed. */
const CODEX_TOOL_FAMILIES_MIN_VERSION = [0, 167, 0] as const;

/** The `thread/start` configuration key that makes Codex re-list after a load. */
export const CODEX_TOOL_LIST_CHANGED_FEATURE = 'features.mcp_tool_list_changed';

/**
 * The version `codex --version` printed (`codex-cli 0.167.0`). Anything that
 * is not exactly one release-shaped version is unknown.
 */
export function parseCodexCliVersion(stdout: string):
  | {
      core: readonly [number, number, number];
      prerelease: boolean;
    }
  | undefined {
  const match =
    /^codex-cli (\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?$/.exec(
      stdout.trim(),
    );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/**
 * At least the qualified release. A pre-release of the qualified version
 * itself precedes it and does not qualify; a pre-release of a later version
 * does.
 */
export function codexVersionAdmitsToolFamilies(stdout: string): boolean {
  const version = parseCodexCliVersion(stdout);
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    const have = version.core[index]!;
    const need = CODEX_TOOL_FAMILIES_MIN_VERSION[index]!;
    if (have !== need) return have > need;
  }
  return !version.prerelease;
}

/** How long an answered probe stands: a shim can switch versions behind one path. */
export const CODEX_VERSION_TTL_MS = 60_000;
/** How long a failed probe (no answer, error, timeout) stands before a retry. */
export const CODEX_VERSION_FAILURE_TTL_MS = 30_000;

/**
 * Reads the version of the binary Station launches. The launcher's path says
 * nothing about the version behind it (a mise or asdf shim keeps its path,
 * size and time while the selected Codex changes), so an answer stands for
 * `CODEX_VERSION_TTL_MS` only, and a failed probe for
 * `CODEX_VERSION_FAILURE_TTL_MS`, so that repeated starts do not each wait out
 * a hanging `--version`. Concurrent callers share one probe.
 */
export class CodexToolFamilyQualification {
  private cached?: { binary: string; admitted: boolean; expiresAt: number };
  private inflight?: { binary: string; verdict: Promise<boolean> };

  constructor(
    private readonly resolveBinary: () => string | null | undefined,
    private readonly run: (
      command: string,
      args: string[],
    ) => Promise<CliCommandResult | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async admitted(): Promise<boolean> {
    const binary = this.resolveBinary();
    if (!binary) return false;
    const cached = this.cached;
    if (cached?.binary === binary && cached.expiresAt > this.now())
      return cached.admitted;
    if (this.inflight?.binary === binary) return this.inflight.verdict;
    const verdict = this.run(binary, ['--version']).then(
      (result) => {
        if (!result || result.code !== 0 || result.timedOut) return undefined;
        return codexVersionAdmitsToolFamilies(result.stdout);
      },
      () => undefined,
    );
    const shared = verdict.then((admitted) => admitted === true);
    this.inflight = { binary, verdict: shared };
    try {
      const admitted = await verdict;
      this.cached = {
        binary,
        admitted: admitted === true,
        expiresAt:
          this.now() +
          (admitted === undefined
            ? CODEX_VERSION_FAILURE_TTL_MS
            : CODEX_VERSION_TTL_MS),
      };
      return admitted === true;
    } finally {
      if (this.inflight?.verdict === shared) this.inflight = undefined;
    }
  }
}
