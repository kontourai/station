/**
 * station#1501 slice 3b — the ONE adapter between
 * {@link resolveProjectResource}'s state machine and what a path-consuming
 * seam actually needs: an absolute path, or an honest absence that carries
 * the resolver's own words.
 *
 * Three of the five seams in `docs/design/portable-project-identity.md` §2.2
 * (as corrected by §2.2.1) want `string | undefined | null` — S3 (knowledge
 * scanning), S4 (Task workspace bindings, including its A7 second input), and
 * S5 (attached-session candidate roots). The resolver is async and answers
 * with one of six states. Written three times, that mapping would be three
 * independently-drifting opinions about what `drifted` means to a knowledge
 * scan; written once, it is one decision with one review.
 *
 * Seam S2 (`resolveWorkspacePath` in `runtime-routes.ts`) was migrated in this
 * slice's first round and **reverted** — see §2.2.1's S2 row. It was deferred
 * until `ResourceResolutionResult` could express "the directory is there, I
 * could not verify whose repo it is". station#1594 (slice 3c-pre) added that
 * — `stale`/`drifted` now carry `unverifiedPath` — and this module now owns
 * the derivation, as {@link resolveProjectDirectoryOutcome}. S2's
 * re-migration onto it is a separate follow-up; nothing here presumes it has
 * happened.
 *
 * ## TWO QUESTIONS, ONE DERIVATION POINT (station#1594)
 *
 * There are two different questions a caller can be asking, and conflating
 * them is what produced both the S2 revert and station#1594:
 *
 * 1. **The repo-question** — "where is the VERIFIED checkout of resource X?"
 *    Answered by {@link resolveProjectWorkspaceOutcome} /
 *    {@link resolveProjectWorkspacePath}, from `path`, on `bound` only. The
 *    strong claim; unchanged by #1594.
 * 2. **The directory-question** — "where is this project's realized directory,
 *    so I can read `.flow`/`.veritas` in it, or start a session there?"
 *    Answered by {@link resolveProjectDirectoryOutcome}, from
 *    `path ?? unverifiedPath`. The weaker claim, and it is the honest one for
 *    a caller that never needed the repo identity: a route reading
 *    `<dir>/.flow` does not care whose remote the checkout advertises, and
 *    404ing it because `git` is absent from a service `PATH` is a regression
 *    dressed as rigour.
 *
 * That `path ?? unverifiedPath` fold is written exactly ONCE, in
 * {@link projectDirectoryPath} below. **Seams should call
 * {@link resolveProjectDirectoryOutcome}, not the bare fold** — the fold is
 * exported because the shadow holds a raw result and must fold it the same
 * way, but it returns a plain `string | undefined` and a seam that takes it
 * directly never sees `verified: false`, i.e. never learns that the directory
 * it is about to run in holds a different repository. S2's re-migration and
 * slice 3c's flip both want the outcome. Written per-seam the fold would
 * become several independently-drifting opinions about what `drifted` means,
 * which is the failure this module was created to prevent.
 *
 * ## Why every non-`bound` state maps to "no path" (the REPO-question)
 *
 * The resolver's contract (`project-resource-resolver.ts`, decision 2 and
 * §3.6) is **exact match or an honest unavailable**. `bound` is the only state
 * that carries a `path` — `isWellFormedResolution` enforces that a non-`bound`
 * result has NO path at all, so there is nothing here to "recover" even if we
 * wanted to. Concretely, per state:
 *
 * - `bound` — the live check passed just now. This is the path.
 * - `unbound` — no binding and no usable working directory. Today's seams
 *   already answer `undefined`/`null` for a project with no (or a
 *   non-existent) `workingDirectory`, so this is the behavior-preserving map.
 * - `missing` — a recorded realization (a binding row, or the compat branch's
 *   declared `workingDirectory`) whose path is gone. Falling back to
 *   `project.workingDirectory` here is exactly the silent re-bind §3.6
 *   forbids: it would repair a broken record by pointing at a directory the
 *   operator never chose for that resource.
 * - `drifted` — the directory exists, but it is a checkout of a DIFFERENT
 *   repository than the manifest names. This is the state most tempting to
 *   collapse into "well, the path exists" — and the one where doing so is
 *   worst FOR THIS QUESTION: the caller asked where resource X lives and would
 *   be handed a working directory containing Y. A knowledge scan would index
 *   the wrong repo; a dispatch would run in it. (The directory-question is a
 *   different question and legitimately takes the path — see
 *   {@link resolveProjectDirectoryOutcome}.)
 * - `stale` — the live re-check could not be PERFORMED (no `git`, unreadable
 *   checkout), not "verified a while ago". There is no observation of the
 *   repo IDENTITY to stand on, so there is no verified path we can claim here.
 * - `ambiguous` — several resources and no unique primary. Naming one would
 *   be the coin-flip-presented-as-fact the delivery protocol §6 names.
 * - `unresolvable` / `not-portable` — the resolver emits neither in this
 *   slice, but they are handled rather than left to a fallthrough, because a
 *   `default:` that silently returns a path would be the failure mode this
 *   whole module exists to prevent.
 *
 * ## Why this is behavior-preserving for projects without a manifest
 *
 * Essentially every project on disk today predates slice 2 and has no manifest
 * sidecar. For those, `resolveProjectResource` takes its local-only branch: the
 * single resource is `local-only`, so **no git check runs**, and the result is
 * `bound` with `resolve(expandTilde(project.workingDirectory))` iff that
 * directory exists; `missing` when a directory is declared and is not there
 * (station#1594 — this was `unbound` before the split); and `unbound` when no
 * directory is declared at all. So a project without a manifest still resolves to exactly
 * two outcomes AT THIS ADAPTER — a path, or nothing — because every non-`bound`
 * state maps to "no path" for the repo-question. `drifted`/`stale`/`ambiguous`
 * remain unreachable for it. Those only start firing once a manifest exists,
 * which is the point at which a caller SHOULD stop being handed a directory it
 * cannot vouch for.
 *
 * The `unbound` → `missing` reclassification is therefore **behavior-neutral
 * at every seam this adapter serves**: S3, S4 and S5 treat every non-`bound`
 * state identically (no path / `unavailable`). It matters to the seams that
 * must tell the two apart — slice 3c's cwd flip, and the shadow's comparison.
 *
 * Two deltas do fall out of the compat branch, and they are real:
 *
 * 1. **Tilde expansion and absolutization.** The compat branch returns
 *    `resolve(expandTilde(...))`. Seams that previously returned the raw
 *    stored string (`knowledge-scan-utils`, `task-graph-service`) now get a
 *    real path for a project stored as `~/dev/repo`. That is a bug fix, not a
 *    regression, and it is disclosed per seam.
 * 2. **The existence check.** The compat branch returns `unbound` when the
 *    directory does not exist. Seams that previously returned the string
 *    unconditionally now get "no path" — which is what they were already
 *    computing one line later via their own `existsSync`.
 *
 * ## Why this NEVER throws
 *
 * `resolveProjectResource` fails closed on two inputs: an unknown project, and
 * a manifest that exists but cannot be read. That is correct for the resolver.
 * It is NOT correct for the seams this adapter serves — the injected
 * `resolveProjectWorkspace` (A7) and S5's root sourcing are both non-throwing
 * today, and making them throw would turn a missing project into a failed
 * attached-session poll or a failed claim release. So a resolver throw becomes
 * an `error` outcome carrying the thrown message verbatim — a named gap, never
 * a swallowed one.
 *
 * `task-graph-service.readProjectWorkingDirectory` is the deliberate
 * exception: it throws `Project not found: ${projectId}` and callers depend on
 * it. It does not get a different adapter — it answers existence with its own
 * `getProject` call and re-throws every OTHER `error` outcome under that
 * error's own message.
 *
 * ## Disclosed residual: `error` is broader than "resolution failed"
 *
 * The `catch` is unconditional, so a genuine programming error inside the
 * resolver (not just an unknown project or an unreadable manifest) also
 * arrives as `error`. This is not theoretical: during this slice's own
 * development a test's `vi.mock` of the telemetry module left an instrument
 * undefined, and the resulting `TypeError` surfaced as an unresolvable
 * project. It was caught because eighteen tests said a project that plainly
 * existed did not.
 *
 * The narrowing was considered and rejected: `resolveProjectResource` throws
 * plain `Error`s, so any discrimination would be a match on message prose —
 * a stringly-typed join between modules, which is the failure mode
 * `ProjectManifestDiagnosticCode` exists in the contracts package to avoid.
 * Instead: the message is carried through VERBATIM so the real fault is always
 * legible in whatever the caller does with it, and a caller that must
 * distinguish existence from failure (S4) asks the question it actually
 * means.
 *
 * ## Disclosed residual: `error` FLATTENS the resolver's typed errors
 *
 * `resolveProjectResource` can throw `ProjectManifestUnreadableError`,
 * `ProjectManifestSchemaVersionError`, or `ProjectManifestIncompleteError`
 * (`project-manifest-store.ts`).
 * This adapter keeps only their `message`, and a caller that re-throws — S4's
 * `readProjectWorkingDirectory` does — raises a plain `Error`. The subclass,
 * and any structured field it carries, is lost at this boundary.
 *
 * That is accepted rather than fixed because **no consumer branches on the
 * type today**: every caller in the repo either reads the message or maps the
 * failure to "no path". Preserving the instance would mean either re-throwing
 * the original (which changes this function from "never throws" to "sometimes
 * throws", the property three seams depend on) or carrying a `cause` that
 * nothing reads. If a consumer ever needs to distinguish an unreadable
 * manifest from a schema-version mismatch, add a discriminator to the outcome
 * union — do not re-derive it by matching on message prose.
 */

import type {
  ResourceRealizationRecord,
  ResourceResolution,
  ResourceResolutionResult,
} from '@kontourai/station-contracts/project-identity';
import {
  ProjectResourceResolver,
  type ProjectResourceResolverOptions,
} from './project-resource-resolver.js';

/**
 * A resolved workspace path, or a named reason there is none.
 *
 * `reason` is always the resolver's OWN sentence (or the thrown error's
 * message) — never a re-worded or invented one. Collapsing it to a boolean was
 * the alternative considered and rejected: the reasons are the repair prompts
 * §3.6 specifies, and a seam that logs or surfaces one is the only way an
 * operator learns that a directory drifted rather than vanished.
 */
export type ProjectWorkspacePathOutcome =
  | {
      available: true;
      path: string;
      /** The resource the path belongs to — `localProjectResourceId(slug)` on the local-only branch. */
      resourceId: string;
    }
  | {
      available: false;
      /**
       * The resolver's own state, or `'error'` when `resolveProjectResource`
       * threw (unknown project, unreadable manifest). `'error'` is distinct
       * from every resolution state precisely so a caller that must preserve a
       * throw (`task-graph-service`) can tell "the resolver answered
       * negatively" from "the resolver could not answer".
       */
      state: ResourceResolution | 'error';
      /** Empty for `ambiguous` (by contract) and for `error` (nothing was selected). */
      resourceId: string;
      reason: string;
    };

export interface ProjectWorkspacePathOptions {
  /**
   * A pre-built resolver. Seams that resolve repeatedly (route handlers, the
   * follow-service poll) should hold one rather than constructing a
   * `FileStorageAdapter` + two stores per call.
   */
  resolver?: Pick<ProjectResourceResolver, 'resolveProjectResource'>;
  /** Construction options, used only when `resolver` is absent. */
  resolverOptions?: ProjectResourceResolverOptions;
  /** §3.5's optional resource selector. Omitted resolves the primary. */
  resourceId?: string;
}

/**
 * Run the resolver once and flatten its throw into a message. Shared by both
 * questions so the `error` outcome is produced in exactly one place — the
 * disclosed residuals below (the unconditional `catch`, and the flattening of
 * the resolver's typed manifest errors) are properties of THIS function.
 */
async function resolveResource(
  projectSlug: string,
  options: ProjectWorkspacePathOptions,
): Promise<
  { ok: true; result: ResourceResolutionResult } | { ok: false; reason: string }
> {
  const resolver =
    options.resolver ?? new ProjectResourceResolver(options.resolverOptions);
  try {
    return {
      ok: true,
      result: await resolver.resolveProjectResource(
        projectSlug,
        options.resourceId,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The full outcome. Use this when the caller needs the reason (to log it, to
 * re-throw it, or to render it).
 */
export async function resolveProjectWorkspaceOutcome(
  projectSlug: string,
  options: ProjectWorkspacePathOptions = {},
): Promise<ProjectWorkspacePathOutcome> {
  const resolved = await resolveResource(projectSlug, options);
  if (!resolved.ok) {
    return {
      available: false,
      state: 'error',
      resourceId: '',
      reason: resolved.reason,
    };
  }
  const result = resolved.result;

  if (result.state === 'bound') {
    // `isWellFormedResolution` (asserted inside the resolver) guarantees a
    // non-empty `path` here, and since station#1594 the union does too. The
    // guard is belt-and-braces against a producer the compiler never saw (a
    // `vi.fn()` double, a result read off disk), and it degrades to a named
    // gap rather than to `path!`.
    //
    // KEEP THE `typeof` CHECK. Review round 1 caught it removed: the union
    // makes it look redundant, and it is — for exactly the producers the
    // comment above says this guard is NOT for. For the ones it IS for,
    // `result.path` is `undefined` and `.length` throws a TypeError past
    // `resolveResource`'s catch, turning a named gap into a crash in four
    // seams. A guard that the type system makes look unnecessary is precisely
    // the guard whose remaining job is the untyped case.
    if (typeof result.path === 'string' && result.path.length > 0) {
      return {
        available: true,
        path: result.path,
        resourceId: result.resourceId,
      };
    }
    return {
      available: false,
      state: 'bound',
      resourceId: result.resourceId,
      reason: `Resource "${result.resourceId}" of project "${projectSlug}" resolved as bound but carried no path.`,
    };
  }

  return {
    available: false,
    state: result.state,
    resourceId: result.resourceId,
    // Required by contract on every non-`bound` state, and since station#1594
    // required by the TYPE as well. The fallback stays for the same reason the
    // `typeof` guard above does: `ProjectWorkspacePathOutcome.reason` is typed
    // `string`, and an untyped producer would otherwise put `undefined` behind
    // that type — which `task-graph-service` and `knowledge-scan-utils` hand
    // straight to `new Error(...)`.
    reason: namedReason(result, projectSlug),
  };
}

// ---------------------------------------------------------------------------
// THE DIRECTORY-QUESTION (station#1594, slice 3c-pre).
//
// See the module docblock: this is the WEAKER of the two questions, and it is
// the one a caller asks when it needs somewhere to read `.flow`/`.veritas` in,
// or somewhere to start a session — not a verified claim about which repository
// lives there.
// ---------------------------------------------------------------------------

/**
 * `path ?? unverifiedPath` — **the one derivation point**, for the whole repo.
 *
 * Exported so the shadow's comparison and (next) S2 and slice 3c's flip all
 * fold the same way. A seam that re-writes this fold is a second opinion about
 * what `drifted` means, and the two will diverge.
 *
 * `bound` answers with a live-verified path. `stale`/`drifted` answer with the
 * directory the resolver ALREADY `existsSync`'d on its way to that state — the
 * observation, not the answer, which is why the field it comes from is named
 * for the warning. Every other state genuinely has no directory to name:
 * `missing` has a declared path that is GONE (a caller handed `declaredPath`
 * would stat a hole), and `unbound`/`ambiguous`/`unresolvable`/`not-portable`
 * never had one.
 */
export function projectDirectoryPath(
  result: ResourceResolutionResult,
): string | undefined {
  switch (result.state) {
    case 'bound':
      return result.path;
    case 'stale':
    case 'drifted':
      return result.unverifiedPath;
    case 'missing':
    case 'unbound':
    case 'ambiguous':
    case 'unresolvable':
    case 'not-portable':
      return undefined;
  }
}

/**
 * The directory-question's answer, with everything a fail-closed seam needs to
 * act on a negative without re-deriving it.
 *
 * `missing` is deliberately its own variant rather than a `state` value with
 * optional fields: slice 3c's flip must throw naming the project AND the path
 * the record declared (#791), and an optional `declaredPath` would let that
 * seam compile with the path silently absent.
 */
export type ProjectDirectoryOutcome =
  | {
      available: true;
      path: string;
      /**
       * `true` when `path` came from `bound` — a live check passed just now.
       * `false` when it came from `unverifiedPath` on `stale`/`drifted`: the
       * directory is really there, but which repository it holds is either
       * unconfirmable (`stale`) or confirmed DIFFERENT (`drifted`). A caller
       * that cares about repo identity must ask the repo-question instead;
       * one that only needs a directory may proceed, and should log `reason`.
       */
      verified: boolean;
      state: 'bound' | 'stale' | 'drifted';
      resourceId: string;
      /** The resolver's own sentence. Absent only when `verified` is true. */
      reason?: string;
    }
  | {
      available: false;
      state: 'missing';
      /** Which record declared a path that is not there. */
      record: ResourceRealizationRecord;
      /** What that record declared — verbatim, tilde-preserved. */
      declaredPath: string;
      resourceId: string;
      reason: string;
    }
  | {
      available: false;
      state:
        | 'unbound'
        | 'ambiguous'
        | 'unresolvable'
        | 'not-portable'
        /**
         * `resolveProjectResource` threw (unknown project, unreadable
         * manifest), OR an untyped producer returned a result that claimed a
         * directory and did not carry one. Both mean "I cannot answer", and a
         * fail-closed seam owes that a throw — never the `unbound` default.
         */
        | 'error';
      resourceId: string;
      reason: string;
    };

/**
 * Ask the directory-question. Never throws, for the same reason
 * {@link resolveProjectWorkspaceOutcome} does not — a resolver throw becomes
 * the `error` state carrying the thrown message verbatim.
 */
export async function resolveProjectDirectoryOutcome(
  projectSlug: string,
  options: ProjectWorkspacePathOptions = {},
): Promise<ProjectDirectoryOutcome> {
  const resolved = await resolveResource(projectSlug, options);
  if (!resolved.ok) {
    return {
      available: false,
      state: 'error',
      resourceId: '',
      reason: resolved.reason,
    };
  }
  const result = resolved.result;
  const path = projectDirectoryPath(result);
  // `typeof`, not `!== undefined` (delta review, HIGH): the untyped producers
  // this whole degradation path exists for include results read off disk, and
  // `JSON.parse` yields `null` — not `undefined` — for an explicitly-null
  // field. `null.length` throws past `resolveResource`'s catch, out of a
  // function whose docblock promises it never throws, at the seam slice 3c
  // flips. Round 1 hardened the sibling repo-question and missed this one.
  if (typeof path === 'string' && path.length > 0) {
    // `result.state` is narrowed by the fold above, but TypeScript cannot see
    // that through a function boundary, so the states are re-named here. The
    // `default` case is a throw, not a silent path: a new state that starts
    // yielding a directory must be classified deliberately.
    switch (result.state) {
      case 'bound':
        return {
          available: true,
          path,
          verified: true,
          state: 'bound',
          resourceId: result.resourceId,
        };
      case 'stale':
      case 'drifted':
        return {
          available: true,
          path,
          verified: false,
          state: result.state,
          resourceId: result.resourceId,
          reason: result.reason,
        };
      default:
        throw new Error(
          `projectDirectoryPath named a directory for the unclassified state "${result.state}" of project "${projectSlug}".`,
        );
    }
  }
  if (result.state === 'missing') {
    // The `missing` variant exists so slice 3c's #791 throw cannot compile
    // with the path silently absent. An untyped producer can still leave it
    // absent at RUNTIME, and a throw reading `Error("")` that names no path is
    // exactly the blank-cell failure the honesty bar forbids — so a `missing`
    // that cannot carry its own record degrades to `error` (which still fails
    // closed) rather than to a repair prompt with nothing in it.
    if (
      (result.record === 'binding' || result.record === 'working-directory') &&
      typeof result.declaredPath === 'string' &&
      result.declaredPath.length > 0
    ) {
      return {
        available: false,
        state: 'missing',
        record: result.record,
        declaredPath: result.declaredPath,
        resourceId: result.resourceId,
        reason: namedReason(result, projectSlug),
      };
    }
    return {
      available: false,
      state: 'error',
      resourceId: result.resourceId,
      reason: `Resource "${result.resourceId}" of project "${projectSlug}" resolved as "missing" without the record and path it is required to name, so there is nothing to re-point.`,
    };
  }
  // The two degradation paths below are reachable only through an untyped
  // producer (a `vi.fn()` double, a result off disk, a build against an older
  // `@kontourai/station-contracts`) that bypassed `isWellFormedResolution`.
  //
  // THEY MUST NOT DEGRADE TO `unbound` (review round 1, HIGH). `unbound` is the
  // one state slice 3c's mapping sends to `$HOME` + `cwdDefaulted: true`, so
  // reporting it for a result that CLAIMED a directory is fail-OPEN: a chat the
  // UI shows as project-bound would silently read and write $HOME — verbatim
  // the #1011 class this seam exists to close, reintroduced in the adapter's
  // own vocabulary. `error` is the honest degradation and it maps to a throw,
  // which is what "I cannot answer" owes a fail-closed seam. The whole point of
  // station#1594 is that `unbound` means exactly one thing; this adapter does
  // not get to re-blur it.
  if (result.state === 'bound') {
    return {
      available: false,
      state: 'error',
      resourceId: result.resourceId,
      reason: `Resource "${result.resourceId}" of project "${projectSlug}" resolved as bound but carried no path.`,
    };
  }
  if (result.state === 'stale' || result.state === 'drifted') {
    return {
      available: false,
      state: 'error',
      resourceId: result.resourceId,
      reason: `Resource "${result.resourceId}" of project "${projectSlug}" resolved as "${result.state}" but carried no unverifiedPath. ${result.reason}`,
    };
  }
  return {
    available: false,
    state: result.state,
    resourceId: result.resourceId,
    reason: namedReason(result, projectSlug),
  };
}

/**
 * The resolver's own sentence, or a named gap — never `undefined` behind a
 * field typed `string`. Both outcome types declare `reason` required and both
 * have consumers that hand it to `new Error(...)`; an untyped producer that
 * omits it would otherwise raise `Error("")`.
 */
function namedReason(
  result: Exclude<ResourceResolutionResult, { state: 'bound' }>,
  projectSlug: string,
): string {
  return typeof result.reason === 'string' && result.reason.length > 0
    ? result.reason
    : `Resource "${result.resourceId}" of project "${projectSlug}" resolved as "${result.state}" without a reason.`;
}

/**
 * The callback shape a path-consuming seam accepts.
 *
 * It is deliberately a UNION with the synchronous form rather than a flat
 * `Promise<...>`: every consumer widened for slice 3b already had a
 * synchronous test double, and forcing those to become async would have been
 * churn that proves nothing. Consumers `await` it either way — `await` on a
 * non-promise is an identity — so there is no sync-over-async bridge anywhere
 * in this seam.
 */
export type WorkspacePathResolver = (
  slug: string,
) => string | undefined | Promise<string | undefined>;

/**
 * The path, or `undefined`. The shape three of the four migrated seams want.
 * Never throws.
 */
export async function resolveProjectWorkspacePath(
  projectSlug: string,
  options: ProjectWorkspacePathOptions = {},
): Promise<string | undefined> {
  const outcome = await resolveProjectWorkspaceOutcome(projectSlug, options);
  return outcome.available ? outcome.path : undefined;
}
