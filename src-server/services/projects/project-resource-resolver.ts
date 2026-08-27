/**
 * station#1499 slice 2 — `resolveProjectResource`, the one function the rest
 * of the codebase should call for "where is this project's code on this
 * machine" (`docs/design/portable-project-identity.md` §3.5, §3.6, §5).
 *
 * NOTHING is wired to it yet. Migrating the five consumer seams
 * (`orchestration-service.ts`, `runtime-routes.ts`, `knowledge-scan-utils.ts`,
 * `task-graph-service.ts`, and the layout copy) is slice 3; this slice lands
 * the resolver behind the existing `project.workingDirectory` read path so
 * nothing user-visible changes.
 *
 * Load-bearing decisions:
 *
 * 1. **THIS FUNCTION NEVER WRITES.** `docs/strategy/multi-agent-delivery-protocol.md`
 *    §6 is unconditional: "a projection/join that mutates state on read is a
 *    defect EVEN WHEN THE WRITE LOOKS IDEMPOTENT". An earlier revision called
 *    `ensureProjectManifest` from here on the argument that an exclusive create
 *    of derived content is exempt; that argument is exactly what the quoted
 *    sentence anticipates, so it is gone. §5 point 4 of the design asks for
 *    lazy backfill "the first time something asks for their resources"; this
 *    module deliberately does not satisfy that clause, because the backfill
 *    needs a WRITE boundary to hang on. It has one already
 *    (`ProjectService.createProject`, which is what §5's "the earlier path
 *    shrinks monotonically" defence actually requires) and gets an explicit
 *    one in slice 3 (`updateProject`, which is also where re-derivation
 *    belongs — see the STALE-FOREVER gap below). A project with no manifest
 *    resolves through the local-only branch, exactly as it did before manifests
 *    existed.
 * 2. **Exact match or an honest unavailable — never a guess** (§3.6, and the
 *    honesty bar in the delivery protocol §6). An explicit `resourceId` the
 *    manifest does not name resolves to a non-`bound` state that names it and
 *    the ids that ARE declared; it never falls back to the primary. A manifest
 *    with several resources and no unique `primary` is AMBIGUOUS: the result
 *    names every candidate rather than taking `repos[0]` or "the newest",
 *    which is a coin flip presented as fact.
 * 3. **`bound` is grounded in a LIVE check on EVERY branch, never in a stored
 *    timestamp.** A binding's `verifiedAt` is an observation (§3.5), so this
 *    resolver re-checks the path and (for a git resource) the checkout's
 *    remote set on every resolution. That check is not optional on the
 *    working-directory compat branch either: nothing writes bindings in this
 *    slice, so the compat branch is the ONLY live one, and returning `bound`
 *    there without checking meant a project whose `workingDirectory` pointed
 *    at a checkout of a DIFFERENT repository reported `bound` under the
 *    manifest's resource id — §3.6's `drifted` row reported as `bound`, and,
 *    once slice 3 wires `resolveWorkspacePath`/`resolveStartSessionCwd`, an
 *    operation targeting a named repo running inside a different one.
 *    It follows that an ancient `verifiedAt` does not downgrade a resource
 *    that verifies right now — and that the resolver never rewrites
 *    `verifiedAt`, because a read path does not write.
 * 4. **`stale` means "could not verify", not "verified a while ago".** §3.6
 *    defines `stale` as not verified recently enough *for the asking
 *    consumer*, but no consumer supplies a freshness bound until §6.1's
 *    routing constraint (slice 6). Emitting an age-based `stale` here would be
 *    a claim with no source, so the only `stale` this slice produces is the
 *    one it can source truthfully: the live re-check could not be performed
 *    (no `git`, unreadable checkout). On the binding branch the recorded
 *    `verifiedAt` is reported as the observation it is; on the compat branch
 *    there is no observation to report and the reason says so rather than
 *    inventing one.
 * 5. **`missing` NEVER silently re-binds** (§3.6). A RECORDED realization
 *    whose path is gone reports `missing`, names the record (`binding` or
 *    `working-directory`) and the path it declared; falling back to
 *    `project.workingDirectory` from a dead binding would repair a broken
 *    binding by pointing somewhere the operator never chose.
 *    station#1594 widened the state to cover the compat branch's declared
 *    `workingDirectory` too, because §5 makes that the compat-era binding and
 *    a declared-but-gone directory is the same fact with the same repair —
 *    see decision 9.
 * 6. **Host aliases apply to the CHECKOUT side only** (§3.3(a)). The local
 *    checkout's remotes are rewritten then canonicalized; the manifest's
 *    `canonicalRemote`/`aliases` are compared verbatim. Rewriting the manifest
 *    side would let one member's ssh config change what a shared manifest
 *    means.
 * 7. **A manifest this Station cannot READ is a THROW; a manifest it cannot
 *    SELECT FROM is `ambiguous`.** With an unreadable or unknown-version
 *    manifest there is no resource to name truthfully and nothing in the
 *    document can be trusted, so the resolver fails closed and loudly instead
 *    of inventing a state or silently downgrading to the earlier read path. A
 *    manifest that parses cleanly but declares two primaries, or several
 *    resources and none, is a different failure: it is readable, and the
 *    honest answer is the `ambiguous` state naming every candidate. Slice 1's
 *    validator refuses both at write time, so neither shape can be produced
 *    here — but a resolver reads manifests off disk, where they may predate
 *    the rule, have been hand-edited, or have been written by another member's
 *    older Station (§3.5). Classification lives in `ProjectManifestStore`, on
 *    slice 1's structured diagnostics rather than on its message text.
 * 8. **Every path is `resolve(expandTilde(...))`, never `expandTilde` alone.**
 *    `expandTilde` handles `~` and nothing else, so a relative value stays
 *    relative — and `existsSync`/`execGit({ cwd })` would then be evaluated
 *    against the SERVER PROCESS's cwd. `workingDirectory` is stored verbatim
 *    (UI-only normalization) so a relative value is reachable through the API,
 *    and the seam slice 3 replaces already absolutizes
 *    (`orchestration-service.ts:625,646`).
 *
 * 9. **The two axes are REPORTED, not just folded into a label**
 *    (station#1594, slice 3c-pre). Every result here is derived from two
 *    independent facts — whether anything on this Station DECLARES a
 *    realization, and what was OBSERVED at the declared place — and the
 *    contract now carries both rather than only the derived state:
 *    - `unbound` means, exactly, *nothing is recorded*: no binding row and no
 *      declared `workingDirectory` (and, for an explicitly-asked resourceId,
 *      nothing by that name).
 *    - `missing` means *a record exists and its path does not*, and says which
 *      record (`binding` or `working-directory`) and what it declared.
 *    - `stale`/`drifted` carry `unverifiedPath`, the directory both branches
 *      have ALREADY `existsSync`'d before `verifyGitCheckout` is reached.
 *    This is what lets a consumer answer the directory-question ("where is
 *    this project's realized directory") without either parsing `reason` prose
 *    or 404ing a directory that is plainly there — see
 *    `project-workspace-path.ts`, which owns that derivation for the whole
 *    repo.
 *
 * STATES THIS MODULE EMITS: `bound`, `unbound`, `missing`, `drifted`, `stale`,
 * `ambiguous` (whose `resourceId` is empty by contract — the state exists
 * because no single resource could be named, and the candidates are in the
 * `reason`). It emits `unresolvable` NOWHERE — §3.6 scopes it to an attempt
 * that was DENIED and says "it is asserted, never inferred", and this slice
 * performs no authenticated operation that can be denied. It emits
 * `not-portable` nowhere either: §3.6 defines that as "a `local-only` resource
 * authored by SOMEONE ELSE", and until #1392 introduces membership every
 * manifest this Station reads is its own. A local-only resource with no local
 * realization is reported as `unbound` with a reason that says exactly that.
 *
 * DOC GAP (§3.6, for the owner) — ONE remains, one closed. STILL OPEN: there
 * is no state for "local-only, mine, not realized here". `unbound` is the
 * closest honest label and its §3.6 repair prompt ("clone it") is wrong for a
 * resource with nothing to clone, so the reason carries the real repair
 * ("Point it at a directory, or leave it as a purely organizational scope").
 * CLOSED: §3.6 also had no state for "a declared working directory that is
 * gone" — that was station#1594, and decision 9's split landed it as `missing`
 * with `record: 'working-directory'`. Note for slice 3c:
 * `resolveStartSessionCwd` deliberately treats a directory-less project as a
 * valid organizational scope, so a naive "not `bound` → error" mapping would
 * regress a documented contract (#1023). The flip maps `unbound` to `$HOME`
 * and `missing` to the fail-closed throw (#791) — only expressible because
 * they are now different states.
 *
 * 10. **The working-directory substitute stands in for AT MOST ONE
 *    resource** (station#1503, slice 5). §5 makes `workingDirectory` the
 *    pre-manifest binding, and one declared directory can realize one repo. A
 *    multi-resource manifest therefore uses it only for THE primary; every
 *    other unbound resource is `unbound`, never verified against the primary's
 *    checkout (which reports `drifted` and sends the operator to repair a
 *    directory that is doing its job). See the branch in {@link resolve}.
 *
 * DISCLOSED GAP — resource identity before a manifest exists: the
 * project has exactly one resource, its working directory, and this module
 * reports it under {@link localProjectResourceId} — the same id the backfill assigns
 * a `local-only` resource. For a git checkout the eventually-persisted id is
 * the canonical remote instead, so an id observed in that window is not the id
 * the manifest will settle on. Nothing joins on it in this slice.
 *
 * DISCLOSED GAP — STALE FOREVER: the backfill runs once, from a write path,
 * and nothing re-derives afterwards. A manifest can therefore outlive the
 * facts it was derived from. The full accepted set, for the record: a project
 * that gains a working directory, clones into it, `git init`s it, or adds a
 * remote AFTER backfill keeps its `local-only` resource; a checkout git could
 * not read, a local-path origin, and a host with no `git` at all all leave the
 * project on the earlier read path (the first two as `local-only`); and an origin URL
 * that later changes leaves the manifest naming the old identity. The fix is a
 * re-derivation trigger on `updateProject` in slice 3 — a WRITE path, so it
 * costs nothing under §6.
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  isWellFormedResolution,
  localProjectResourceId,
  type ProjectManifest,
  type ProjectPrimarySelection,
  type ProjectRepoResource,
  type ResourceResolutionResult,
  selectPrimaryResource,
} from '@kontourai/station-contracts/project-identity';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { projectResourceResolutions } from '../../telemetry/metrics.js';
import { expandTilde, resolveHomeDir } from '../../utils/paths.js';
import {
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from './checkout-remote-reader.js';
import {
  canonicalizeCheckoutRemotes,
  ProjectBindingsStore,
} from './project-binding-store.js';
import {
  type ProjectManifestSource,
  ProjectManifestStore,
} from './project-manifest-store.js';

/**
 * The id a project's single compat resource carries before (and, for a
 * `local-only` project, after) backfill. See the DISCLOSED GAP above.
 *
 * Defined in `@kontourai/station-contracts/project-identity` and re-exported
 * here: the settings surface must recognise this id in order not to print it
 * (station#1502 fix round, LOW-5), and two independent spellings of a
 * transient internal id is exactly the drift that gap warns about.
 */
export { localProjectResourceId };

export interface ProjectResourceResolverOptions {
  homeDir?: string;
  source?: ProjectManifestSource;
  manifests?: ProjectManifestStore;
  bindings?: ProjectBindingsStore;
  readRemotes?: CheckoutRemoteReader;
}

type ResourceSelection =
  | { ok: true; resource: ProjectRepoResource }
  | { ok: false; result: ResourceResolutionResult };

export class ProjectResourceResolver {
  private readonly source: ProjectManifestSource;
  private readonly bindings: ProjectBindingsStore;
  private readonly manifests: ProjectManifestStore;
  private readonly readRemotes: CheckoutRemoteReader;

  constructor(options: ProjectResourceResolverOptions = {}) {
    const homeDir = options.homeDir ?? resolveHomeDir();
    this.source = options.source ?? new FileStorageAdapter(homeDir);
    this.bindings = options.bindings ?? new ProjectBindingsStore(homeDir);
    this.readRemotes = options.readRemotes ?? readCheckoutRemotes;
    this.manifests =
      options.manifests ??
      new ProjectManifestStore(homeDir, this.source, {
        bindings: this.bindings,
        readRemotes: this.readRemotes,
      });
  }

  /**
   * §3.5's single entry point. `resourceId` is optional so today's single-repo
   * projects keep working by resolving the `primary` repo.
   *
   * Throws when the project does not exist, or when its manifest exists but
   * cannot be read (decision 6).
   */
  async resolveProjectResource(
    projectSlug: string,
    resourceId?: string,
  ): Promise<ResourceResolutionResult> {
    const result = await this.resolve(projectSlug, resourceId);
    if (!isWellFormedResolution(result)) {
      // Slice 1's predicate exists so a producer cannot silently leak a path
      // on a non-bound state or drop the reason on a repair state.
      throw new Error(
        `resolveProjectResource produced a malformed resolution for ${projectSlug}: ${JSON.stringify(result)}`,
      );
    }
    projectResourceResolutions.add(1, { state: result.state });
    return result;
  }

  private async resolve(
    projectSlug: string,
    resourceId?: string,
  ): Promise<ResourceResolutionResult> {
    const project = this.source.getProject(projectSlug);
    // Decision 1: read only. A project with no manifest stays on the compat
    // branch until a WRITE path backfills it.
    const manifest = this.manifests.readProjectManifest(projectSlug);

    if (!manifest) {
      if (resourceId !== undefined) {
        return {
          state: 'unbound',
          resourceId,
          reason: `Project "${projectSlug}" declares no resources yet (it has no manifest), so nothing here is named "${resourceId}". It resolves only through its working directory until its resources are declared.`,
        };
      }
      // The compat resource is treated as local-only: there is no manifest
      // identity to check the directory against, so there is nothing to
      // verify and nothing to claim beyond "this is where it is".
      return this.resolveThroughWorkingDirectory(project, {
        kind: 'local-only',
        id: localProjectResourceId(projectSlug),
      });
    }

    const selection = selectResource(manifest, resourceId);
    if (!selection.ok) return selection.result;
    const resource = selection.resource;

    const binding = this.bindings.findBinding(manifest.id, resource.id);
    if (binding) {
      const absolute = resolvePath(expandTilde(binding.path));
      if (!existsSync(absolute)) {
        // Decision 5: named, and never quietly re-pointed at the project's
        // working directory.
        return {
          state: 'missing',
          resourceId: resource.id,
          record: 'binding',
          declaredPath: binding.path,
          reason: `The binding for "${resource.id}" points at "${binding.path}", which no longer exists (last observed ${new Date(binding.verifiedAt).toISOString()}). Re-point or re-clone it.`,
        };
      }
      if (resource.kind === 'local-only') {
        return { state: 'bound', resourceId: resource.id, path: absolute };
      }
      return await this.verifyGitCheckout(resource, binding.path, absolute, {
        kind: 'binding',
        verifiedAt: binding.verifiedAt,
      });
    }

    // station#1503 slice 5 — the working-directory substitute stands in for AT MOST ONE
    // resource, and it is the primary.
    //
    // §5 makes `workingDirectory` the pre-manifest binding: ONE declared
    // directory, which can only ever be a realization of one repo. With a
    // single-resource manifest that is unambiguous and this branch is unchanged.
    // With several, handing the same directory to every unbound resource claims
    // it realizes all of them — and the claim is not merely unproven, it is
    // usually wrong in a way that reads as a DIFFERENT fault: a secondary repo
    // with no binding would be verified against the primary's checkout and
    // report `drifted` ("a different repository is at that path"), sending the
    // operator to confirm an identity or re-point a directory that is doing
    // exactly what it should. The honest answer is `unbound` — nothing here
    // records a location for THIS resource — which is also the state slice 5's
    // acceptance criterion needs a partially-bound project to be able to reach.
    //
    // When no single resource is THE primary (two declared, or none), no
    // resource inherits the directory. That is fail-closed in the only
    // direction available: the alternative is picking one, which is the coin
    // flip presented as fact that decision 2 refuses.
    // Gated on MORE THAN ONE resource, deliberately (station#1503 review, L10).
    // A single-resource manifest whose sole resource declares `role:
    // 'secondary'` still inherits the working directory here, even though
    // `selectPrimaryResource` refuses to call it the primary. That is
    // behaviour-preserving and it is the right answer for this branch: the
    // project has exactly one resource and exactly one declared directory, so
    // there is no second resource for the directory to be confused with — the
    // ambiguity this guard exists to prevent cannot arise. The `role` still
    // governs SELECTION (a no-`resourceId` call gets `ambiguous`), which is the
    // question `role` is about.
    if (manifest.repos.length > 1) {
      const primary = selectPrimaryResource(manifest.repos);
      if (!primary.ok || primary.resource.id !== resource.id) {
        return {
          state: 'unbound',
          resourceId: resource.id,
          reason: `Resource "${resource.id}" has no binding on this Station. Project "${project.slug}" declares ${manifest.repos.length} resources, so its single working directory stands in only for ${primary.ok ? `the primary resource ("${primary.resource.id}")` : 'the primary resource, and no single resource is declared primary'} — it is never assumed to realize this one. Point at an existing checkout of it.`,
        };
      }
    }

    // §5 point 2: `workingDirectory` stays authoritative during compat, and a
    // backfilled binding row duplicating it is exactly the second copy this
    // design exists to avoid.
    return this.resolveThroughWorkingDirectory(project, resource);
  }

  private async resolveThroughWorkingDirectory(
    project: ProjectConfig,
    resource: ProjectRepoResource,
  ): Promise<ResourceResolutionResult> {
    const resourceId = resource.id;
    const workingDirectory = project.workingDirectory?.trim();
    if (!workingDirectory) {
      if (resource.kind === 'local-only') {
        // NOT `not-portable`: §3.6 defines that state as a local-only resource
        // authored by SOMEONE ELSE, and showing "it was never shareable, there
        // is nothing you can do" to the author of the resource on the machine
        // that owns it is the §4.1 "not for you" affordance shown to a purely
        // local user. The seeded `default` project lands here.
        return {
          state: 'unbound',
          resourceId,
          reason: `Resource "${resourceId}" is local-only — it carries no portable identity — and nothing on this Station realizes it: it has no binding, and project "${project.slug}" has no working directory. Point it at a directory, or leave it as a purely organizational scope.`,
        };
      }
      return {
        state: 'unbound',
        resourceId,
        reason: `Resource "${resourceId}" has no binding on this Station, and project "${project.slug}" has no working directory to fall back to. Clone it, or point at an existing checkout.`,
      };
    }
    // Decision 8.
    const absolute = resolvePath(expandTilde(workingDirectory));
    if (!existsSync(absolute)) {
      // station#1594 — THIS is `missing`, not `unbound`. §5 makes the declared
      // `workingDirectory` the compat-era binding ("workingDirectory stays
      // authoritative during compat"), so a declared directory that is gone is
      // a recorded realization that failed live verification at existence —
      // the same fact as a dead binding row, with the same repair. Reporting
      // it as `unbound` conflated it with "nothing is recorded here", which
      // the session-cwd seam treats OPPOSITELY: #1023 requires a project with
      // no directory to terminate at `$HOME`, and #791 requires a project
      // whose directory is gone to fail closed naming the project and the
      // path. One state could not serve both.
      return {
        state: 'missing',
        resourceId,
        record: 'working-directory',
        declaredPath: workingDirectory,
        reason: `Resource "${resourceId}" has no binding on this Station, and project "${project.slug}"'s working directory "${workingDirectory}" — the record standing in for one — does not exist. Re-point it or re-clone; it is never silently re-bound.`,
      };
    }
    if (resource.kind === 'git') {
      // Decision 3: the compat branch gets the SAME live identity check as the
      // binding branch. A working directory is a place, not a claim about
      // which repository lives there.
      return await this.verifyGitCheckout(
        resource,
        workingDirectory,
        absolute,
        {
          kind: 'working-directory',
        },
      );
    }
    return { state: 'bound', resourceId, path: absolute };
  }

  private async verifyGitCheckout(
    resource: ProjectRepoResource & { kind: 'git' },
    recordedPath: string,
    absolutePath: string,
    observation:
      | { kind: 'binding'; verifiedAt: number }
      | { kind: 'working-directory' },
  ): Promise<ResourceResolutionResult> {
    const remotes = await this.readRemotes(absolutePath);
    if (!remotes.ok) {
      // Decision 4: a recorded timestamp is REPORTED as an observation; it is
      // never accepted as a substitute for the check we could not run. Where
      // there is no recorded observation at all, that is what the reason says.
      return {
        state: 'stale',
        resourceId: resource.id,
        // station#1594: the observation, not the answer. Existence was checked
        // and passed on BOTH branches before this point — the binding branch
        // at the `existsSync` above, the compat branch at
        // `resolveThroughWorkingDirectory` — so the resolver holds a real
        // directory here and the pre-#1594 contract forbade it from saying so.
        // Withholding it 404'd every `.flow`/`.veritas`-reading route on any
        // host where `git` could not be run (the slice-3b S2 revert).
        unverifiedPath: absolutePath,
        reason:
          observation.kind === 'binding'
            ? `The binding for "${resource.id}" at "${recordedPath}" could not be verified now (${remotes.reason}); it was last observed ${new Date(observation.verifiedAt).toISOString()}, which is a record of that observation and not a guarantee. Re-verify it.`
            : `Project "${resource.id}" has no binding, and the working directory "${recordedPath}" standing in for it could not be verified now (${remotes.reason}). It has NEVER been verified as this resource — there is no earlier observation to fall back on. Re-verify it, or bind the resource explicitly.`,
      };
    }
    // Decision 6: aliases rewrite the checkout side only.
    const checkoutRemotes = canonicalizeCheckoutRemotes(
      remotes.remotes.map((remote) => remote.url),
      this.bindings.hostAliases(),
    );
    const manifestRemotes = [
      resource.canonicalRemote,
      ...(resource.aliases ?? []),
    ];
    const intersects = checkoutRemotes.some((remote) =>
      manifestRemotes.includes(remote),
    );
    if (!intersects) {
      return {
        state: 'drifted',
        resourceId: resource.id,
        // station#1594: the directory is real and was observed; what could not
        // be confirmed is WHOSE repository lives in it. A consumer asking the
        // repo-question must not use this; a consumer asking only "where is
        // this project's directory" legitimately may. Naming the slot
        // `unverifiedPath` is what keeps the two apart.
        unverifiedPath: absolutePath,
        reason: `The checkout at "${recordedPath}" advertises ${describeCheckoutRemotes(remotes.remotes, checkoutRemotes)}, which does not intersect the manifest's [${manifestRemotes.join(', ')}]. Confirm the new identity or re-point ${observation.kind === 'binding' ? 'the binding' : "the project's working directory"}.`,
      };
    }
    return { state: 'bound', resourceId: resource.id, path: absolutePath };
  }
}

/**
 * "It has no remotes" and "its remotes all canonicalized to nothing" are
 * different observations with different repairs, and reporting them with one
 * byte-identical sentence hides the second (LOW-3 of the slice-2 review).
 *
 * EXPORTED because `project-resource-binder.ts` performs the same comparison
 * on the write side and must describe its result the same way. It had
 * re-implemented the description with a bare `[${joined}]`, which printed a
 * blank `[]` for a directory that is not a repository at all — regressing this
 * finding one module over (station#1502 fix round, HIGH-4).
 */
export function describeCheckoutRemotes(
  rawRemotes: { name: string; url: string }[],
  canonicalRemotes: string[],
): string {
  if (canonicalRemotes.length > 0) return `[${canonicalRemotes.join(', ')}]`;
  if (rawRemotes.length === 0) return 'no remotes';
  return `${rawRemotes.length} remote(s) (${rawRemotes
    .map((remote) => `${remote.name} = "${remote.url}"`)
    .join(', ')}) whose URLs canonicalize to nothing`;
}

function selectResource(
  manifest: ProjectManifest,
  resourceId?: string,
): ResourceSelection {
  if (resourceId !== undefined) {
    const found = manifest.repos.find((repo) => repo.id === resourceId);
    if (found) return { ok: true, resource: found };
    // Decision 2: an unknown id is never quietly answered with the primary.
    // NOT `unresolvable` — nothing was attempted and nothing was denied; this
    // Station simply has no binding for a resource by that name (§3.6 rule 2:
    // "unbound" is "not set up here", which is a different sentence from "you
    // don't have access").
    return {
      ok: false,
      result: {
        state: 'unbound',
        resourceId,
        reason: `Project "${manifest.slug}" does not name resource "${resourceId}". Its resources are: ${describeCandidates(manifest.repos)}.`,
      },
    };
  }

  // §3.5's cardinality rule is slice 1's, applied — not re-decided here. The
  // two would otherwise drift, and had already: this filtered `kind === 'git'`
  // while the validator counts `role` across both kinds, so a manifest with a
  // local-only primary and a git secondary validated and then resolved
  // `ambiguous`.
  const selection = selectPrimaryResource(manifest.repos);
  if (selection.ok) return { ok: true, resource: selection.resource };
  return {
    ok: false,
    // `ambiguous`: the manifest cannot name ONE resource for this request. The
    // repair is the operator's and it is local (declare a primary, or ask by
    // resourceId), which is precisely what `unresolvable` —
    // attempted-and-denied, "nothing local; the gap is upstream" — would
    // misreport. `resourceId` is empty because there is no single resource to
    // name; every candidate is in the reason.
    result: {
      state: 'ambiguous',
      resourceId: '',
      reason: describeAmbiguity(manifest, selection),
    },
  };
}

/**
 * One sentence per §3.5 failure, each naming every candidate and the repair
 * that actually applies to it. They differ because the repairs differ:
 * "declare a primary" is wrong advice for a manifest that declares two, and
 * "declare a resource" is wrong for one that declares three.
 */
function describeAmbiguity(
  manifest: ProjectManifest,
  selection: Extract<ProjectPrimarySelection, { ok: false }>,
): string {
  const candidates = describeCandidates(selection.candidates);
  switch (selection.code) {
    case 'no-resources-declared':
      return `Project "${manifest.slug}"'s manifest names no resources, so there is nothing to resolve. Declare one, or ask for one by resourceId.`;
    case 'multiple-primaries-declared':
      return `Project "${manifest.slug}" names ${manifest.repos.length} resources and ${selection.candidates.length} of them declare role "primary" (${candidates}), so no single resource is THE primary. Ask for one by resourceId, or leave exactly one marked primary.`;
    case 'no-primary-declared':
      return `Project "${manifest.slug}" names ${manifest.repos.length} resources and none declares role "primary"; candidates: ${candidates}. Ask for one by resourceId, or declare exactly one primary.`;
    case 'sole-resource-declared-secondary':
      return `Project "${manifest.slug}"'s sole resource (${candidates}) declares role "secondary", so nothing here claims to be the primary and this resolver will not overrule it. Ask for it by resourceId, or declare it primary.`;
  }
}

function describeCandidates(repos: ProjectRepoResource[]): string {
  if (repos.length === 0) return '(none)';
  return repos.map((repo) => repo.id).join(', ');
}

/**
 * Convenience wrapper over {@link ProjectResourceResolver} for callers that do
 * not hold one — the shape §3.5 names.
 */
export async function resolveProjectResource(
  projectSlug: string,
  resourceId?: string,
  options?: ProjectResourceResolverOptions,
): Promise<ResourceResolutionResult> {
  return new ProjectResourceResolver(options).resolveProjectResource(
    projectSlug,
    resourceId,
  );
}
