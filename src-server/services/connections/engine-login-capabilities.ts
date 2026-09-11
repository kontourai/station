/**
 * What login mechanisms an engine's CLI actually offers — OBSERVED, not
 * declared.
 *
 * The temptation here is a table: `codex: ['device-code']`. That table is a
 * label nothing computes. It is right on the day it is written and silently
 * wrong the day the CLI renames a flag, and the failure mode is the worst
 * one available: Station spawns a login with an argument the CLI no longer
 * accepts, and reports the resulting crash as the user's problem.
 *
 * So the only static thing here is HOW TO READ each CLI — which command makes
 * it describe its own login, and which literal token in that description
 * carries which meaning. The ANSWER always comes from the CLI's own output,
 * and every mechanism this module reports carries the exact argv that
 * produced it and the exact substring that matched. {@link loginMechanisms}
 * derives the mechanism list FROM that evidence rather than beside it, so
 * there is no second field that can disagree with it.
 *
 * Two mechanisms, not four. `device-code` and `api-key-stdin` each have a
 * literal token in the CLI's own help. `browser-oauth` and `none` do not:
 * nothing either CLI prints says "this opens a browser", and reporting it
 * would be exactly the asserted-but-underived capability this module exists
 * to avoid. Absence of `device-code` evidence is reported as absence.
 *
 * Observed live on macOS 2026-09-11 (the strings the fixtures replay):
 *
 *   codex login --help        ->  "--device-auth", "--with-api-key"
 *   claude auth login --help  ->  "--claudeai", "--console", "--sso" — and
 *                                 no device or stdin token, so claude
 *                                 declares neither mechanism.
 */
import {
  type CliCommandResult,
  findCliBinaryAsync,
  runCliCommand,
} from '../../providers/auth/cli-auth.js';
import {
  type EnrolmentEngine,
  enrolmentLoginArgs,
} from './credential-enrolment.js';

/**
 * A login mechanism Station can observe a CLI declaring. Deliberately not the
 * full space of ways an engine can be signed in — only the ones whose presence
 * a literal token in the CLI's own output establishes.
 */
export type EngineLoginMechanism = 'device-code' | 'api-key-stdin';

export interface EngineLoginMechanismEvidence {
  readonly mechanism: EngineLoginMechanism;
  /** The exact argv Station ran to observe this. */
  readonly observedCommand: readonly string[];
  /** The exact substring of that command's output that carried the mechanism. */
  readonly observedMatch: string;
  /**
   * The argument to append to the engine's own login when invoking this
   * mechanism — captured FROM {@link observedMatch}, never transcribed
   * alongside it. Absent when the mechanism needs no extra argument.
   */
  readonly argument?: string;
}

export interface EngineLoginCapabilities {
  readonly engine: EnrolmentEngine;
  /**
   * Empty when the probe observed nothing — either because no token matched
   * or because {@link unavailableReason} says the probe could not run.
   */
  readonly evidence: readonly EngineLoginMechanismEvidence[];
  /** When the probe ran. A caller showing this is showing its own staleness. */
  readonly observedAt: string;
  /** Present only when the CLI could not be asked at all. */
  readonly unavailableReason?: string;
}

interface EngineLoginMatcher {
  readonly mechanism: EngineLoginMechanism;
  /**
   * Capture group 1, when present, is the argument to pass. Keeping the
   * argument inside the pattern is what binds "we saw this flag" to "we will
   * pass this flag": they cannot drift, because they are the same string.
   */
  readonly pattern: RegExp;
}

interface EngineLoginProbe {
  /** Appended to the engine's command to make it describe its own login. */
  readonly helpArgs: readonly string[];
  readonly matchers: readonly EngineLoginMatcher[];
}

/**
 * `helpArgs` is the engine's own login command plus `--help`, built from
 * {@link enrolmentLoginArgs} so there is one definition of "this engine's
 * login" in the codebase rather than two that can disagree.
 *
 * The device matcher is spelled loosely on purpose (`--device-<word>`): it
 * has to keep matching if a CLI renames `--device-auth` to `--device-code`,
 * and because the flag it passes is the capture, a rename is followed rather
 * than transcribed. It is still bounded to device-ish spellings so an
 * unrelated `--device-id` style flag cannot be mistaken for a login
 * mechanism.
 */
const LOGIN_MATCHERS: readonly EngineLoginMatcher[] = [
  { mechanism: 'device-code', pattern: /(--device-(?:auth|code|login)\b)/ },
  {
    mechanism: 'api-key-stdin',
    pattern: /(--(?:with-api-key|api-key-stdin)\b)/,
  },
];

function probeFor(engine: EnrolmentEngine): EngineLoginProbe {
  return {
    helpArgs: [...enrolmentLoginArgs(engine), '--help'],
    matchers: LOGIN_MATCHERS,
  };
}

export interface EngineLoginCapabilityDeps {
  runCommand: (
    command: string,
    args: string[],
  ) => Promise<CliCommandResult | null>;
  findBinary: (command: string) => Promise<string | null>;
  now: () => Date;
}

export function defaultEngineLoginCapabilityDeps(): EngineLoginCapabilityDeps {
  return {
    runCommand: (command, args) => runCliCommand(command, args),
    findBinary: findCliBinaryAsync,
    now: () => new Date(),
  };
}

/**
 * The mechanisms this observation establishes, DERIVED from its evidence.
 * Callers ask this rather than reading a stored list, so no field exists that
 * could claim a mechanism no evidence carries.
 */
export function loginMechanisms(
  capabilities: EngineLoginCapabilities,
): EngineLoginMechanism[] {
  const seen = new Set<EngineLoginMechanism>();
  for (const item of capabilities.evidence) seen.add(item.mechanism);
  return [...seen];
}

/** The evidence for one mechanism, or `undefined` when nothing established it. */
export function mechanismEvidence(
  capabilities: EngineLoginCapabilities,
  mechanism: EngineLoginMechanism,
): EngineLoginMechanismEvidence | undefined {
  return capabilities.evidence.find((item) => item.mechanism === mechanism);
}

async function observeEngineLoginCapabilities(
  engine: EnrolmentEngine,
  deps: EngineLoginCapabilityDeps,
): Promise<EngineLoginCapabilities> {
  const probe = probeFor(engine);
  const observedAt = deps.now().toISOString();
  const binary = await deps.findBinary(engine);
  if (!binary) {
    return {
      engine,
      evidence: [],
      observedAt,
      unavailableReason: `The ${engine} command was not found on this host.`,
    };
  }
  const result = await deps.runCommand(binary, [...probe.helpArgs]);
  if (!result) {
    return {
      engine,
      evidence: [],
      observedAt,
      unavailableReason: `The ${engine} CLI could not be asked how it signs in.`,
    };
  }
  // Some CLIs print help to stderr and exit non-zero. The exit code is not
  // the observation; the text is.
  const output = `${result.stdout}\n${result.stderr}`;
  const evidence: EngineLoginMechanismEvidence[] = [];
  for (const matcher of probe.matchers) {
    const match = matcher.pattern.exec(output);
    if (!match) continue;
    const argument = match[1];
    evidence.push({
      mechanism: matcher.mechanism,
      observedCommand: [engine, ...probe.helpArgs],
      observedMatch: match[0],
      ...(argument ? { argument } : {}),
    });
  }
  return { engine, evidence, observedAt };
}

/**
 * Probing spawns a process, so it is cached — but a cache that never expires
 * would reintroduce the static table this module refuses, one process
 * lifetime at a time. Ten minutes is long enough that a UI polling an
 * enrolment screen pays for one probe, and short enough that upgrading the
 * CLI is reflected without restarting Station.
 */
export const ENGINE_LOGIN_CAPABILITY_TTL_MS = 10 * 60_000;

interface CacheEntry {
  readonly observedAtMs: number;
  readonly value: EngineLoginCapabilities;
}

const cache = new Map<EnrolmentEngine, CacheEntry>();
const inFlight = new Map<EnrolmentEngine, Promise<EngineLoginCapabilities>>();

/**
 * Ask this engine's CLI how it can be signed in.
 *
 * Bounded (the probe inherits `runCliCommand`'s timeout), cached for
 * {@link ENGINE_LOGIN_CAPABILITY_TTL_MS}, and single-flight: concurrent
 * callers share one process rather than each spawning their own.
 */
export async function engineLoginCapabilities(
  engine: EnrolmentEngine,
  deps: EngineLoginCapabilityDeps = defaultEngineLoginCapabilityDeps(),
): Promise<EngineLoginCapabilities> {
  const nowMs = deps.now().getTime();
  const cached = cache.get(engine);
  if (cached && nowMs - cached.observedAtMs < ENGINE_LOGIN_CAPABILITY_TTL_MS) {
    return cached.value;
  }
  const existing = inFlight.get(engine);
  if (existing) return existing;
  const pending = observeEngineLoginCapabilities(engine, deps)
    .then((value) => {
      cache.set(engine, { observedAtMs: nowMs, value });
      return value;
    })
    .finally(() => {
      inFlight.delete(engine);
    });
  inFlight.set(engine, pending);
  return pending;
}

/** Test seam: forget every observation so the next call re-probes. */
export function resetEngineLoginCapabilityCache(): void {
  cache.clear();
  inFlight.clear();
}
