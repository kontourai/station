/**
 * station#1501 slice 3a — SHADOW the new resolver at the session-cwd seam.
 *
 * `resolveStartSessionCwd` (`orchestration-service.ts`) is fail-closed by
 * design and EVERY engine family reaches its adapter through it, which is why
 * `docs/design/portable-project-identity.md` §10 names slice 3 "the largest
 * single risk in the arc". Migrating it first would put the biggest blast
 * radius at the moment `resolveProjectResource` has seen the least real
 * traffic — nothing but the unit tests slice 2 shipped with it.
 *
 * So this module does the repo's own `veritas:shadow` posture, applied to a
 * migration: at the seam, compute BOTH resolutions, record where they
 * disagree, and leave the baseline answer authoritative. Nothing about any
 * session changes. What it buys is the only evidence that can justify the
 * flip (slice 3c): an observed divergence record over real traffic, rather
 * than an argument that the two code paths "should" agree.
 *
 * Load-bearing decisions:
 *
 * 1. **The shadow can never change, delay, or fail a session start.**
 *    `resolveStartSessionCwd` is synchronous and `resolveProjectResource` is
 *    not (it shells out to `git` for a git-kind resource), so the comparison
 *    is dispatched fire-and-forget and every throw inside it is swallowed and
 *    counted. A shadow that can break the thing it observes is worse than no
 *    shadow. {@link observeCwdShadow} therefore returns a promise the CALLER
 *    may await (tests do) while the seam deliberately does not.
 *
 *    "Delay" is load-bearing and was nearly false: an async function body runs
 *    SYNCHRONOUSLY up to its first `await`, so simply CALLING this from the
 *    seam put the resolver's `readFileSync`s — and a `git` spawn syscall for a
 *    manifested resource, measured at ~3.4ms — on the session-start stack.
 *    The seam's `dispatchCwdShadow` therefore hands the call to
 *    `setImmediate`. The guarantee is structural, not documentary.
 *
 *    WHAT "NEVER DISTURBS" DOES AND DOES NOT CLAIM (review round 1,
 *    MEDIUM 7). The guarantee is about the session-start STACK, and it is
 *    structural: `setImmediate` means no work here — not the resolver's
 *    reads, not its `git` spawn, not the record write — is on it. It has
 *    never meant the observation is free. In the deferred tick this module
 *    does bounded SYNCHRONOUS filesystem work on the event loop, and while
 *    that runs, every concurrent request waits.
 *
 *    That cost was measured rather than assumed, because decision 6's record
 *    write silently became the largest part of it: at `JsonFileStore`'s
 *    default durability it cost ~15.4ms per session start (four fsyncs at
 *    ~3.6ms each), against the ~3.4ms `git` spawn this very decision cites as
 *    too expensive to leave on the seam. The record is now written
 *    `tear-safe` — atomic rename kept, fsyncs dropped — which takes it to
 *    ~0.4ms; see `project-resource-shadow-record.ts`. The honest statement of
 *    the remaining cost is: one `git` spawn and a handful of small synchronous
 *    reads and one small synchronous write, one tick after a session start.
 *    Not zero, and not on the session's own stack.
 *
 *    What dropping the fsyncs risks is stated where it is implemented, not
 *    here, and it is NOT "losing the last few observations": it is a primary
 *    that exists and is garbage after a power loss. That is survivable only
 *    because `readShadowRecord` recovers from the retained `.previous` and
 *    says so — see that module's durability note (round 2, MEDIUM 2).
 *
 *    SCOPE, so the slice-3c gate is not read as broader than it is: this
 *    shadow observes the seam's `projectSlug -> project directory` sub-step
 *    ONLY. Caller-supplied-cwd precedence and its containment check, the
 *    `$HOME`/ACP/degenerate-host terminus, and the final existence check on
 *    the EFFECTIVE cwd are deliberately unshadowed, because a flip only
 *    replaces the project resolution. "The record is empty" is a statement
 *    about that sub-step and nothing else.
 * 2. **Agreement is defined against what the baseline seam ACTUALLY DOES, not
 *    against the resolver's vocabulary.** The seam's own contract has three
 *    distinct project outcomes — a resolved directory, the deliberate
 *    `$HOME`/`cwdDefaulted` terminus for a directory-less project (#1023),
 *    and a fail-closed throw for a directory that does not exist (#791) — and
 *    the resolver expresses the last two both as `unbound`. Comparing raw
 *    strings would report a divergence on every directory-less project on the
 *    install, which is exactly the noise that makes a shadow log unreadable
 *    and its emptiness meaningless. {@link compareCwdShadow} maps the baseline
 *    side to the same three-way {@link BaselineCwdOutcome} the resolver can be
 *    projected onto, and compares THAT.
 * 3. **Divergence is reported, never repaired.** This module has no authority
 *    and takes no action on a session, a project, or a binding; it emits a
 *    counter point, one warn line naming the project, both paths and the
 *    resolver's own reason, and (see decision 6) an entry in its own
 *    observation record.
 *
 *    This decision originally also said the record must not be a file, citing
 *    §6 of `docs/strategy/multi-agent-delivery-protocol.md` ("read paths do
 *    not write"). That was the wrong reading and station#1686 is what it
 *    cost. §6 forbids a PROJECTION mutating the state it reports — a join
 *    that writes back what it just derived, opening a lost-update window on
 *    somebody else's data. An observer appending to its OWN observation
 *    record is not that: it writes nothing about the session, the project or
 *    the binding, and no consumer of any of those reads it. What the old
 *    wording actually bought was a divergence record whose only reader was an
 *    OTLP collector nobody has attached, i.e. no reader at all.
 * 6. **The record must be readable without a collector (station#1686).** The
 *    counter is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so
 *    slice 3c's population-coverage evidence has been discarded since 3a
 *    merged, and `CONFLATED_UNBOUND_NOTE`'s fail-open tripwire has had no way
 *    to report that it fired. Every comparison is therefore ALSO written to a
 *    durable per-home record with the same dimensions
 *    (`project-resource-shadow-record.ts`), where a never-observed outcome is
 *    ABSENT rather than zero — so "the observer ran and saw agreement" and
 *    "the observer never ran" can never render as the same number. The
 *    counter is unchanged and still exported; nothing about what this module
 *    OBSERVES changed.
 * 4. **An unresolvable shadow is its own outcome, not an agreement.** If
 *    `resolveProjectResource` throws (an unreadable or unknown-version
 *    manifest fails closed by design, per slice 2 decision 7), the comparison
 *    records `shadow-threw` and names the error. Folding that into "agree"
 *    would let the flip be justified by a log that is empty because the
 *    shadow never ran.
 * 5. **Off by one env var.** `STATION_PROJECT_RESOURCE_SHADOW=off` disables
 *    the dispatch entirely. The shadow spawns `git remote` for a manifested
 *    git resource on a path that previously touched only `existsSync`, so an
 *    operator who sees it cost something must be able to stop it without a
 *    downgrade. `disabled` is a distinct counter outcome, so a quiet log
 *    caused by a kill-switch can never be read as a quiet log caused by
 *    agreement.
 *
 *    THE KILL SWITCH DOES NOT STOP THE RECORD WRITE, ON PURPOSE (review
 *    round 1, LOW 8 — accepted with rationale rather than "fixed", so the
 *    next reader does not re-litigate it). `off` short-circuits the
 *    comparison, but still emits one `disabled` observation. That is the
 *    whole mechanism by which the switch stays honest: it is precisely what
 *    lets a home that was switched off be told apart from a home where the
 *    observer never ran, and a switch that erased its own footprint would
 *    hand slice 3c's gate the emptiness-as-clearance reading that
 *    station#1686 exists to close — this time with a cause nothing in the
 *    record could name.
 *
 *    The cost objection is answered on its own terms rather than waved away,
 *    since decision 5 is a COST argument. `off` still removes what the
 *    operator turned it off for: the resolver's three `readFileSync`s and the
 *    `git` spawn. What remains is one read and one `tear-safe` write of a
 *    small file, ~0.4ms (decision 1). If that ever needs to reach zero, the
 *    answer is a second, explicit "record nothing either" value — not making
 *    `off` silently indistinguishable from never-installed.
 */

import { existsSync } from 'node:fs';
import type { ResourceResolutionResult } from '@kontourai/station-contracts/project-identity';
import { projectResourceShadowComparisons } from '../../telemetry/metrics.js';
import { resolveProjectResource } from './project-resource-resolver.js';
import {
  recordShadowComparison,
  type ShadowRecordDimensions,
} from './project-resource-shadow-record.js';
import { projectDirectoryPath } from './project-workspace-path.js';

/** The seam this module observes; see decision 1's SCOPE paragraph. */
const SEAM = 'start_session_cwd';

/**
 * What the BASELINE seam does with a project's `workingDirectory`, reduced to
 * the three outcomes its docblock actually distinguishes. See decision 2.
 */
export type BaselineCwdOutcome =
  /** A directory that resolves and exists: the session launches there. */
  | { kind: 'directory'; path: string }
  /**
   * The project declares no directory. Deliberately NOT an error: the project
   * is an organizational scope and the chat terminates at `$HOME` with
   * `cwdDefaulted: true`.
   */
  | { kind: 'no-directory' }
  /**
   * The project declares a directory that is not there. The seam fails closed
   * (#791), naming the project and the path.
   */
  | { kind: 'missing-directory'; path: string }
  /**
   * This Station has no such project. The seam fails closed and loudly — a
   * `projectSlug` it does not have is "a broken binding, not a global chat".
   *
   * Shadowed deliberately rather than skipped: the two sides read the project
   * store through DIFFERENT APIs (the seam through the injected
   * `listProjects()`, the resolver through `FileStorageAdapter.getProject`),
   * and "they must agree, they read the same directory" is precisely the kind
   * of assumption this shadow exists to stop taking on faith.
   */
  | { kind: 'project-not-found' };

/** How the shadow resolution compared with the baseline one. */
export type CwdShadowOutcome =
  /** Both sides agree about where (or whether) this project resolves. */
  | 'agree'
  /**
   * Both sides name the SAME directory, and the resolver's answer is the
   * weaker `unverifiedPath` of a `stale` result — it could not run the
   * identity check at all — rather than a live-verified `bound` path
   * (station#1594). A `drifted` result is {@link CwdShadowOutcome}
   * `agree-drifted`; see there for why the two are counted apart.
   *
   * This is an agreement, not a divergence: the baseline seam never
   * identity-checked anything, so "the directory is there, I could not confirm
   * whose repo it is" is *exactly* as strong a claim as the baseline seam ever
   * made. It is counted separately because slice 3c's gate requires evidence
   * that the manifested-git population was exercised, and this is the outcome
   * that population produces on a host where `git` cannot be run — the
   * population whose flip behavior the directory-question exists to preserve.
   */
  | 'agree-unverified'
  /**
   * Same as {@link CwdShadowOutcome} `agree-unverified`, but the resolver
   * CHECKED and found a different repository (`drifted`) rather than being
   * unable to check (`stale`).
   *
   * Split out on review: folded together, a `drifted` sample could satisfy
   * #1501's gate clause that was written for the `stale` leg specifically, and
   * the gate would then read as covered by a population it never observed.
   * Both are non-divergent — post-flip behaviour is identical to baseline on
   * both, because the baseline seam never identity-checked anything — but they
   * are different facts and the counter now says which.
   *
   * NOT logged here, deliberately: drift is a real operator concern and a
   * RESOURCE-STATUS one (§3.6's repair prompt, slice 4's surface), not a
   * migration divergence, and a migration shadow that logs it makes the
   * slice-3c record unreadable for a fact the flip does not affect. Note for
   * S2's re-migration: this is the population that would serve
   * `<dir>/.flow` and `<dir>/.veritas` out of a checkout the resolver KNOWS is
   * a different repository, with only `verified: false` between it and
   * presenting another project's evidence as this one's.
   */
  | 'agree-drifted'
  /**
   * The regression TRIPWIRE for station#1594. Baseline says "a directory is
   * declared and it is gone"; the resolver says `unbound`, which since #1594
   * means "nothing is recorded" — a different fact, and the conflation that
   * blocked slice 3c. See {@link CONFLATED_UNBOUND_NOTE}.
   *
   * **This must read ZERO before slice 3c flips**, because post-flip that
   * combination sends the project to `$HOME` where the seam fails closed
   * today. Before #1594 it was the expected outcome for that population.
   *
   * It watches TWO causes — see {@link CONFLATED_UNBOUND_NOTE}: the state
   * split being undone, and a declaration-detection mismatch (the resolver
   * trims `workingDirectory`, the seam does not). Do not read a firing as
   * "the split regressed" without checking the second.
   */
  | 'conflated-unbound'
  /**
   * The resolver named no directory, and the state it DID name is not the one
   * that reproduces what the baseline side does. Post-flip behaviour would
   * therefore change for this project.
   *
   * Generalised on review from "baseline resolved a directory and the shadow
   * named none": agreement is defined against what the seam ACTUALLY DOES
   * (decision 2), and since station#1594 the flip mapping is per state —
   * `unbound` to `$HOME`, `missing`/`ambiguous`/the access states to a throw.
   * So "named no directory" is no longer a sufficient comparison on either
   * no-path branch.
   */
  | 'shadow-unresolved'
  /** Baseline resolves nothing; the resolver names a directory. */
  | 'shadow-resolved'
  /** Both name a directory, and they are different directories. */
  | 'path-mismatch'
  /** `resolveProjectResource` threw where baseline resolved (decision 4). */
  | 'shadow-threw'
  /**
   * Baseline has no such project AND the resolver could not answer either.
   * Both fail closed, but this does NOT assert they failed for the same
   * reason — the resolver also throws on an unreadable manifest and a corrupt
   * bindings store, which are different facts with different repairs.
   *
   * DISCLOSED GAP: the `detail` on the returned comparison carries the
   * resolver's own message, and NOTHING IN THE RECORD READS IT. This outcome
   * is non-divergent, so it is not logged, and the counter carries no
   * free-text dimension. A corrupt manifest on a Station where someone opens
   * a stale chat for a deleted project is therefore filed here and stays
   * invisible. Surfacing it needs a channel this slice does not have; it is
   * a real gap, not a claim to fold away.
   */
  | 'both-failed-closed'
  /** Baseline has no such project; the resolver answered for one anyway. */
  | 'shadow-found-project'
  /** The kill switch is set (decision 5). */
  | 'disabled';

/**
 * WHY `conflated-unbound` EXISTED, AND WHY IT IS NOW A REGRESSION TRIPWIRE.
 *
 * The seam has two outcomes for "this project resolves to no usable
 * directory", and they demand OPPOSITE post-flip behavior:
 *
 * - `no-directory` — the project is an organizational/knowledge scope. The
 *   chat is a global chat and must terminate at `$HOME` with
 *   `cwdDefaulted: true` (#1023). Failing here would break the seeded
 *   `default` project and every scope-only project on the install.
 * - `missing-directory` — the project declares a directory and it is gone.
 *   The seam fails closed, naming the project and the path (#791). Silently
 *   starting at `$HOME` here is precisely the #1011 fail-open class the seam
 *   was written to close: a chat the UI shows as project-bound reading and
 *   writing the wrong files.
 *
 * Until station#1594, `resolveProjectResource` returned the SAME `unbound`
 * state for both, with the difference living only in the prose of `reason`.
 * No mapping from state alone could serve both contracts: `unbound -> $HOME`
 * regressed #791, `unbound -> throw` regressed #1023. A shadow that called
 * that `agree` would have left the divergence record empty for exactly the
 * population that made the flip unsafe — and that record is slice 3c's gate.
 *
 * **station#1594 split the state.** `unbound` now means, exactly, "nothing on
 * this Station records a realization"; a declared-but-gone `workingDirectory`
 * is `missing` with `record: 'working-directory'`. So baseline
 * `missing-directory` vs shadow `missing` is now the honest `agree` this
 * comparison previously could not express, and the flip has the discriminator
 * it needed.
 *
 * `conflated-unbound` is deliberately KEPT rather than deleted, and its
 * meaning inverts: it now fires only when the resolver answers `unbound` for a
 * directory the baseline seam found declared-and-gone. **It must read zero
 * before slice 3c flips**, because post-flip that combination sends the
 * project to `$HOME` where the seam fails closed today. A tripwire that is
 * removed once it stops firing cannot tell you when it starts again.
 *
 * It watches TWO causes, not one (review round 1). The obvious one is the
 * state split being undone. The other is a DECLARATION-DETECTION mismatch: the
 * resolver trims (`project.workingDirectory?.trim()`) and the seam does not
 * (`resolve(expandTilde(project.workingDirectory))`), and the route schema
 * accepts an untrimmed string — so a whitespace-only `workingDirectory` is
 * "nothing declared" to one side and "declared and gone" to the other. That is
 * a genuine fail-open hazard for the flip, not tripwire noise, and it is
 * exactly what a tripwire is for. It is pinned by a test rather than repaired
 * here: repairing it means changing either the resolver's trim (slice 2
 * behaviour) or the seam itself (slice 3c's surface), and both are somebody
 * else's slice to review.
 */
export const CONFLATED_UNBOUND_NOTE =
  'The resolver answered `unbound` ("nothing is recorded") for a working directory the seam found declared-and-gone, which station#1594 defines as `missing`. Post-flip the seam would default this project to $HOME instead of failing closed (#791 vs #1023), so this is a FAIL-OPEN TRIPWIRE and must read zero before slice 3c flips. Two known causes: the state split has been undone, or the two sides disagree about whether a directory was DECLARED at all — the resolver trims `workingDirectory` and the seam does not, so a whitespace-only value is `unbound` to one and declared-and-gone to the other.';

export interface CwdShadowComparison {
  outcome: CwdShadowOutcome;
  projectSlug: string;
  baseline: BaselineCwdOutcome;
  /** Absent when the resolver threw. */
  shadowState?: ResourceResolutionResult['state'];
  shadowPath?: string;
  /** The resolver's own sentence, or the thrown error's message. */
  detail?: string;
}

/**
 * What the seam knows at the moment it has settled the project's directory,
 * BEFORE any filesystem question has been asked about it. Deliberately not a
 * {@link CwdShadowSample}: turning this into one costs an `existsSync`, and
 * that stat must not happen on the session-start stack — see
 * {@link dispatchCwdShadow}.
 */
export type CwdShadowObservation =
  | {
      projectSlug: string;
      provider: string;
      /**
       * The seam's own `resolve(expandTilde(project.workingDirectory))`, or
       * `undefined` when the project declares none. Never re-derived here.
       */
      projectCwd: string | undefined;
    }
  | { projectSlug: string; provider: string; projectNotFound: true };

/**
 * Hand one observation to the shadow, off the session-start stack.
 *
 * TWO things are deferred, and both matter:
 *
 * 1. `observeCwdShadow` is an async function, and an async function body runs
 *    SYNCHRONOUSLY up to its first `await`. Calling it directly would put the
 *    resolver's `readFileSync` of `project.json`, the manifest sidecar and
 *    the bindings store — plus, for a manifested git resource, the
 *    synchronous `git` spawn syscall — on the stack of a fail-closed seam
 *    every engine family reaches.
 * 2. `baselineCwdOutcome`'s `existsSync`. The seam stats `suppliedCwd ??
 *    projectCwd`, so when a caller supplies a cwd the project's own directory
 *    is NEVER stat'd by the baseline path. Building the sample at the seam
 *    would add a stat of a directory the seam had no reason to touch — on a
 *    stale network mount, an unbounded one. So the sample is built HERE.
 *
 * Also swallows a sync throw from the observer: the option contract forbids
 * it, but "the observer is well-behaved" is exactly the class of assumption
 * this shadow exists to stop taking on faith.
 *
 * Safe to defer because nothing in the server calls `process.chdir`, so a
 * path resolved a tick later resolves identically, and because the
 * observation is snapshotted synchronously — nothing about the baseline side
 * can change under the shadow.
 */
export function dispatchCwdShadow(
  observeShadow: ((sample: CwdShadowSample) => void) | undefined,
  observation: CwdShadowObservation,
  defer: (callback: () => void) => void = setImmediate,
): void {
  if (!observeShadow) return;
  defer(() => {
    try {
      observeShadow({
        projectSlug: observation.projectSlug,
        provider: observation.provider,
        baseline:
          'projectNotFound' in observation
            ? { kind: 'project-not-found' }
            : baselineCwdOutcome(observation.projectCwd),
      });
    } catch {
      // Deliberately silent and deliberately not counted: the observer owns
      // its own instrumentation, and a shadow that cannot report is strictly
      // less important than the session it must not disturb.
    }
  });
}

export interface CwdShadowSample {
  projectSlug: string;
  /** Only for the metric's dimensionality; never part of the comparison. */
  provider: string;
  baseline: BaselineCwdOutcome;
}

export interface CwdShadowDeps {
  /**
   * The Station home whose project store the seam is actually reading.
   *
   * REQUIRED, and deliberately not optional-with-a-default: the
   * `resolveProjectResource` convenience wrapper defaults to
   * `resolveHomeDir()` (`STATION_HOME` or `~/.station`), while the runtime's
   * project store comes from `configLoader.getProjectHomeDir()`. Those are
   * the same directory on a default install and different ones for any
   * instance started with a custom home (`--temp-home`, a second instance).
   * A shadow reading a DIFFERENT home than the seam reports EVERY project as
   * a divergence — a fabricated record, and one that reads as "do not flip".
   * Making the field mandatory turns forgetting it into a type error instead
   * of a wiring test nobody wrote.
   */
  homeDir: string;
  resolve?: (projectSlug: string) => Promise<ResourceResolutionResult>;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  /**
   * Per-process memory of which `(slug, outcome)` pairs have already been
   * logged. Injected so a test can observe the dedupe; production shares one
   * module-level set. See {@link SHADOW_LOG_DEDUPE}.
   */
  logged?: Set<string>;
  /**
   * station#1686: where the durable observation record goes. Optional ONLY
   * as a test seam — the default is the real production behaviour (append to
   * `<homeDir>/project-resource-shadow.json`), never a bypass, so a caller
   * that forgets it still gets a readable record rather than silently
   * getting the pre-fix no-op. Pass `() => {}` to observe without recording.
   */
  record?: (dimensions: ShadowRecordDimensions) => void;
}

/**
 * Per-process latch for the "the record itself could not be written" warning.
 *
 * A record that has silently stopped being written is the station#1686
 * failure wearing a new coat, so it must be said out loud — but the observer
 * runs once per session start, and an unwritable home would otherwise emit a
 * warn line per start forever and bury everything else. One line per process,
 * naming the path, is the readable form of the same fact.
 *
 * Exported for the same reason {@link SHADOW_LOG_DEDUPE} is: it outlives a
 * test.
 */
export const SHADOW_RECORD_FAILURE_LATCH = { warned: false };

/**
 * The divergence record is what slice 3c is gated on, so it has to be
 * READABLE. Without dedupe, one misconfigured project on a busy Station emits
 * a warn line per session start forever, and a second, genuinely distinct
 * divergence is drowned in it — the record becomes a count of occurrences
 * when what the gate needs is the SET of projects. First occurrence per
 * `(slug, outcome)` per process; the counter still records every occurrence,
 * so nothing is lost, it just stops being the thing a human has to read.
 *
 * Exported because it is process-wide state that OUTLIVES a test: a suite that
 * asserts a warn line for a `(slug, outcome)` an earlier test already logged
 * would silently observe zero. Clear it between tests, or inject
 * `deps.logged`.
 *
 * Two disclosed properties of being process-wide rather than per-service:
 * two `OrchestrationService`s in one process share it, so the second never
 * re-logs a divergence the first already logged; and `projectSlug` comes from
 * client chat metadata, so the set's size is bounded only because an unknown
 * slug makes the resolver throw (`both-failed-closed`, which is never
 * memoized). That bound is a property of a collaborator, not of this module.
 */
export const SHADOW_LOG_DEDUPE = new Set<string>();

/**
 * Outcomes that are not a disagreement and must not be logged as one.
 *
 * Exported since station#1686 so the record reader's own copy
 * (`NON_DIVERGENT_RECORD_OUTCOMES`) can be pinned against it in BOTH
 * directions. Two independently-maintained copies of "what counts as a
 * divergence" is the exact shape that makes a divergence record read empty
 * for the wrong reason.
 */
export const NON_DIVERGENT_OUTCOMES: ReadonlySet<CwdShadowOutcome> = new Set([
  'agree',
  // Same directory, weaker claim — and the baseline seam's claim was never
  // stronger. Counted (slice 3c reads them for population coverage), not
  // logged. Kept distinct so a `drifted` sample cannot stand in for the `stale`
  // leg the gate asks for.
  'agree-unverified',
  'agree-drifted',
  // Both sides failed closed on an unknown project. That is the seam working,
  // and it happens for any stale chat; logging it would bury real findings.
  'both-failed-closed',
  // Defensive only: the disabled branch returns before the logging block, so
  // this membership is unreachable today. Kept so a later restructure of that
  // branch cannot start logging a kill switch as a divergence.
  'disabled',
]);

/**
 * Project a project's stored `workingDirectory` onto the baseline seam's own
 * three outcomes. Kept here rather than inline at the seam so the seam's
 * behavior and the shadow's model of it are read together — a shadow whose
 * model of the baseline side drifts reports divergences that are its own.
 *
 * `absolutePath` is what the seam computed (`resolve(expandTilde(...))`), so
 * this function never re-derives it and cannot disagree with the seam about
 * tilde expansion.
 */
export function baselineCwdOutcome(
  absolutePath: string | undefined,
  exists: (path: string) => boolean = existsSync,
): BaselineCwdOutcome {
  if (!absolutePath) return { kind: 'no-directory' };
  return exists(absolutePath)
    ? { kind: 'directory', path: absolutePath }
    : { kind: 'missing-directory', path: absolutePath };
}

/**
 * The comparison itself — pure, so the agreement rules are testable without
 * a store, a manifest, or a `git` binary.
 */
export function compareCwdShadow(
  sample: CwdShadowSample,
  shadow:
    | { ok: true; result: ResourceResolutionResult }
    | { ok: false; error: unknown },
): CwdShadowComparison {
  const base = { projectSlug: sample.projectSlug, baseline: sample.baseline };
  if (!shadow.ok) {
    return {
      ...base,
      // A throw is the RIGHT answer when the seam already decided this
      // Station has no such project — both sides fail closed on the same
      // fact. Anywhere else it means the resolver could not answer at all.
      outcome:
        sample.baseline.kind === 'project-not-found'
          ? 'both-failed-closed'
          : 'shadow-threw',
      detail:
        shadow.error instanceof Error
          ? shadow.error.message
          : String(shadow.error),
    };
  }
  const result = shadow.result;
  // station#1594: compare on the DIRECTORY-question, through the repo's one
  // derivation point. The baseline seam never identity-checked anything, so
  // comparing its answer against `bound`-only would report a divergence for
  // every manifested-git project on a host where `git` cannot be run — a
  // fabricated record, and one that reads as "do not flip".
  const shadowPath = projectDirectoryPath(result);
  const verified = result.state === 'bound';
  const detail = 'reason' in result ? result.reason : undefined;
  const observed = {
    ...base,
    shadowState: result.state,
    ...(shadowPath ? { shadowPath } : {}),
    ...(detail ? { detail } : {}),
  };

  switch (sample.baseline.kind) {
    case 'directory':
      if (shadowPath === undefined) {
        return { ...observed, outcome: 'shadow-unresolved' };
      }
      if (shadowPath !== sample.baseline.path) {
        return { ...observed, outcome: 'path-mismatch' };
      }
      // Same directory. `agree-unverified` when the resolver could only offer
      // the weaker observation — an agreement at the strength the baseline seam
      // itself always had, and the counter slice 3c reads for manifested-git
      // population coverage.
      if (verified) return { ...observed, outcome: 'agree' };
      // Explicit per state, with a throw for anything unclassified — the same
      // discipline `resolveProjectDirectoryOutcome` uses (delta review, LOW).
      // A silent `: 'agree-unverified'` else-branch would file any FUTURE
      // state that starts yielding a directory as a non-divergent agreement,
      // unlogged, in the record slice 3c is gated on.
      switch (result.state) {
        case 'stale':
          return { ...observed, outcome: 'agree-unverified' };
        case 'drifted':
          return { ...observed, outcome: 'agree-drifted' };
        default:
          throw new Error(
            `projectDirectoryPath named a directory for the unclassified state "${result.state}" of project "${sample.projectSlug}".`,
          );
      }
    case 'no-directory':
      // A shadow that names a directory here would send a session somewhere
      // the seam never would.
      if (shadowPath !== undefined) {
        return { ...observed, outcome: 'shadow-resolved' };
      }
      // `unbound` — and ONLY `unbound` — is the honest match for #1023's
      // deliberate `$HOME` terminus, because `unbound` is the one state slice
      // 3c's mapping sends there.
      //
      // Review round 1, MEDIUM: this branch used to fold on "did the resolver
      // name a directory", which was right while every no-path state flipped
      // the same way and is wrong now that the mapping is per-state. Baseline
      // `no-directory` defaults to `$HOME`; shadow `missing` would THROW
      // naming the project and `declaredPath`. Recording that as `agree` is
      // structurally the emptiness trap the 3a review caught, mirrored — the
      // record would be empty for a population whose flip behaviour changes.
      // `missing` gets there once slice 4 writes binding rows; `ambiguous` is
      // reachable today through a hand-authored or foreign manifest.
      return observed.shadowState === 'unbound'
        ? { ...observed, outcome: 'agree' }
        : { ...observed, outcome: 'shadow-unresolved' };
    case 'missing-directory':
      if (shadowPath !== undefined) {
        // The resolver names a directory the seam found gone. Either a race
        // (it was recreated between the two stats) or a real disagreement;
        // both are worth a line.
        return { ...observed, outcome: 'shadow-resolved' };
      }
      // station#1594: THIS is the agreement the comparison previously could
      // not express. Baseline says "a directory is declared and it is gone";
      // `missing` says exactly that, and says which record declared it. Before
      // the split the resolver could only answer `unbound` here, which meant
      // the same thing as "no directory was ever declared" — the #791/#1023
      // conflation that blocked slice 3c.
      if (observed.shadowState === 'missing') {
        return { ...observed, outcome: 'agree' };
      }
      // The tripwire. Attaching the note only on `unbound` is deliberate: the
      // note asserts a specific fact about re-conflation, and hanging it on a
      // `stale`/`ambiguous` result would bury a real finding under the wrong
      // prescription.
      if (observed.shadowState === 'unbound') {
        return {
          ...observed,
          outcome: 'conflated-unbound',
          detail: observed.detail
            ? `${observed.detail} — ${CONFLATED_UNBOUND_NOTE}`
            : CONFLATED_UNBOUND_NOTE,
        };
      }
      // `ambiguous` / `unresolvable` / `not-portable`: the seam had a declared
      // directory and the resolver neither found one nor recognised it as
      // gone. Both sides fail closed, but not on the same fact, so it is a
      // divergence and it is logged.
      return { ...observed, outcome: 'shadow-unresolved' };
    case 'project-not-found':
      // The seam threw; the resolver did not. Whatever it returned, the two
      // sides disagree about whether this project exists at all, which is the
      // one divergence a flip could not paper over.
      return { ...observed, outcome: 'shadow-found-project' };
  }
}

/**
 * Emit ONE comparison to both readers — the OTel counter and the durable
 * record (decision 6) — from a single dimension tuple, so the two can never
 * describe different facts. The record failure is caught here rather than at
 * the call site because the shadow must never disturb the session it
 * observes (decision 1), and latched so it is said once rather than per
 * start.
 */
function emitComparison(
  comparison: CwdShadowComparison,
  sample: CwdShadowSample,
  deps: CwdShadowDeps,
): void {
  const dimensions: ShadowRecordDimensions = {
    seam: SEAM,
    provider: sample.provider,
    outcome: comparison.outcome,
    baseline: sample.baseline.kind,
    ...(comparison.shadowState ? { shadow: comparison.shadowState } : {}),
  };
  projectResourceShadowComparisons.add(1, dimensions);
  const record =
    deps.record ??
    ((entry: ShadowRecordDimensions) =>
      recordShadowComparison(deps.homeDir, entry));
  try {
    record(dimensions);
  } catch (error) {
    if (SHADOW_RECORD_FAILURE_LATCH.warned) return;
    SHADOW_RECORD_FAILURE_LATCH.warned = true;
    deps.logger?.warn(
      'Project resource shadow could not write its observation record; population evidence for station#1501 slice 3c is NOT being accumulated in this home',
      {
        seam: SEAM,
        homeDir: deps.homeDir,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function shadowEnabled(): boolean {
  return (
    process.env.STATION_PROJECT_RESOURCE_SHADOW?.trim().toLowerCase() !== 'off'
  );
}

/**
 * Run one shadow comparison and record it. Never throws, never rejects (see
 * decision 1) — the caller at the seam discards the promise.
 */
export async function observeCwdShadow(
  sample: CwdShadowSample,
  deps: CwdShadowDeps,
): Promise<CwdShadowComparison> {
  if (!shadowEnabled()) {
    const comparison: CwdShadowComparison = {
      outcome: 'disabled',
      projectSlug: sample.projectSlug,
      baseline: sample.baseline,
    };
    emitComparison(comparison, sample, deps);
    return comparison;
  }

  let comparison: CwdShadowComparison;
  try {
    const resolve =
      deps.resolve ??
      ((slug: string) =>
        resolveProjectResource(slug, undefined, { homeDir: deps.homeDir }));
    const result = await resolve(sample.projectSlug);
    comparison = compareCwdShadow(sample, { ok: true, result });
  } catch (error) {
    comparison = compareCwdShadow(sample, { ok: false, error });
  }

  emitComparison(comparison, sample, deps);

  const logged = deps.logged ?? SHADOW_LOG_DEDUPE;
  const dedupeKey = `${comparison.projectSlug} ${comparison.outcome}`;
  if (
    !NON_DIVERGENT_OUTCOMES.has(comparison.outcome) &&
    !logged.has(dedupeKey)
  ) {
    logged.add(dedupeKey);
    // One line, and it names every side of the disagreement: slice 3c is
    // gated on this record, so a line that cannot be acted on is a line that
    // will be waved away.
    deps.logger?.warn(
      // Not "diverged": `conflated-unbound` is an agreement about today's
      // outcome that still blocks the flip, and calling it a divergence in
      // the operator-facing line would overstate what was observed.
      'Project resource shadow recorded a non-agreement at the session cwd seam',
      {
        seam: 'start_session_cwd',
        projectSlug: comparison.projectSlug,
        outcome: comparison.outcome,
        baselineKind: comparison.baseline.kind,
        baselinePath:
          'path' in comparison.baseline ? comparison.baseline.path : undefined,
        shadowState: comparison.shadowState,
        shadowPath: comparison.shadowPath,
        detail: comparison.detail,
      },
    );
  }
  return comparison;
}
