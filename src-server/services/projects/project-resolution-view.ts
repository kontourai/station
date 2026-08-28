/**
 * archive#1502 — the project-level resolution view
 * (`docs/design/portable-project-identity.md` §3.6 preamble, §4.1).
 *
 * `resolveProjectResource` answers "what happened when this Station tried to
 * resolve resource X". This module answers the question that comes BEFORE it:
 * **is there a resource question to ask at all?** — and it is a separate
 * module because the two answers have different audiences, and §4.1 makes
 * conflating them a defect rather than a simplification.
 *
 * ## THE DERIVATION
 *
 * > **not-backing** := the project declares no non-blank `workingDirectory`
 * > **AND** no binding row exists for the manifest record's `id` **AND** the
 * > record declares no `git` resource — including the case where there is no
 * > record at all.
 *
 * Everything else is `backing`.
 *
 * ### Why the record's EXISTENCE is not the test (archive#1502 fix round)
 *
 * An earlier revision read only whether a record existed, on the reasoning
 * that "a manifest record means this Station declared resources for the
 * project". **That reasoning is false for the record this codebase actually
 * writes.** `ProjectService.createProject` backfills a manifest for EVERY new
 * project, and `ProjectManifestStore.deriveRepos` unconditionally returns a
 * synthetic placeholder — `repos: [{ kind: 'local-only', id: 'local:<slug>' }]`
 * — when the project has no working directory (which every create path allows).
 * Reading existence therefore made `not-backing` unreachable for any project a
 * user creates: a member who creates a project to collaborate in, with no
 * checkout, got `backing` → `unbound` → the "Not set up on this Station"
 * headline, a per-resource row naming `local:acme`, and a repair form. That is
 * three of §4.1's five forbidden things shown to the member §4.1 exists to
 * protect.
 *
 * The honest question is **does anything here name code?**, and the three
 * clauses above are the three places an answer could live: the compat-era
 * realization (§5 makes `workingDirectory` authoritative during compat), a
 * recorded binding row, and a declared `git` resource. A `local-only`
 * placeholder names no code and is not a declaration; it is the backfill's
 * receipt for a project that has none.
 *
 * ### Why counting resource KINDS off the raw record is not the `repos` trap
 *
 * {@link ProjectManifestStore.composeManifest} returns a candidate manifest
 * VERBATIM, with `repos` populated, even when validation FAILED — whenever
 * the only diagnostics are §3.5 selection ambiguities (its decision 7). The
 * returned object carries no flag and is structurally indistinguishable from
 * a valid one. **That trap is about SELECTION**: a derivation that picked a
 * resource out of `repos`, or reported how many resolved, would render a
 * manifest declaring two primaries as a cleanly-resolving project. The only
 * carrier of that signal is `resolveProjectResource`, as `state: 'ambiguous'`.
 *
 * Asking "does this record name a `git` resource at all" is a different
 * question, and one no selection ambiguity can change: two primaries, no
 * primary, and one primary all answer it identically. It is read off the RAW
 * sidecar record (`readRecord`), never off a composed manifest, and the answer
 * is a single boolean. Nothing here selects, counts, orders, or forwards a
 * resource — the guarantee that `repos` never crosses this boundary is
 * unchanged and still pinned by this module's own test. Do not "fix" this back
 * to an existence check.
 *
 * ### Why `backing` still covers "setting up to back it"
 *
 * §3.6's preamble scopes the resource states to "a Station that backs the
 * project **or is setting up to back it**". A declared `git` resource is that
 * setting-up state: something here names code, and whether it is realized on
 * this machine yet is exactly what the resource states are for (`unbound` is a
 * backing Station's honest "not set up here", not a non-backing one).
 *
 * ### THE HONEST LIMIT of this derivation
 *
 * **Membership does not exist in this codebase yet.** §4.1 is written for a
 * multi-member world — "a member whose Stations back nothing" — and archive#1392's
 * membership model has not landed, so there is no "member", no set of that
 * member's Stations, and no way to ask whether ANY of them backs the project.
 * What is implemented here is therefore the **single-Station reading** of
 * "backs nothing": nothing declared here and nothing realized here. It is the
 * whole truth on a single-Station install, which is every install today. It
 * is NOT yet the §4.1 claim, and a surface must not present it as one: once
 * membership exists, a project this Station does not back may still be backed
 * by another of the member's Stations, and that is a fact this function has no
 * source for.
 *
 * ## `unreadable`, and why it is not folded into `not-backing`
 *
 * `readRecord`/`readProjectManifest` throw for three distinct shapes —
 * `ProjectManifestSchemaVersionError`, `ProjectManifestUnreadableError`, and
 * `ProjectManifestIncompleteError`. Swallowing those would report "this
 * Station backs nothing" for a project whose manifest merely could not be
 * read, which is a lie in the most damaging direction available: §4.1
 * guarantees the `not-backing` rendering carries NO repair prompt, so the one
 * thing an operator needs would be structurally suppressed by the same
 * decision that hid the fault. See {@link ProjectResolutionView}.
 *
 * ## Dependencies are REQUIRED, not defaulted
 *
 * Unlike {@link ProjectResourceResolver}, nothing here defaults. A resolver
 * that constructs its own `FileStorageAdapter` answers from a different
 * project store than the runtime was built over — a recorded slice-3b review
 * finding (`station-runtime.ts`'s pinned `source`, FIX 6). Making every
 * dependency required means this module cannot reintroduce it by omission.
 */

import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type {
  ProjectPrimaryResourceSelection,
  ProjectRepoResource,
  ProjectResolutionView,
  ResourceResolutionResult,
} from '@kontourai/station-contracts/project-identity';
import { selectPrimaryResource } from '@kontourai/station-contracts/project-identity';
import {
  type ProjectManifestRecord,
  ProjectManifestSchemaVersionError,
  ProjectManifestUnreadableError,
} from './project-manifest-store.js';

/** The one call this module makes on the resolver. */
export interface ProjectResourceResolverLike {
  resolveProjectResource(
    projectSlug: string,
    resourceId?: string,
  ): Promise<ResourceResolutionResult>;
}

/**
 * The one call this module makes on the manifest store. `readRecord` and not
 * `readProjectManifest` on purpose: the derivation asks a boolean question of
 * the RAW sidecar and must not hold a composed manifest, whose `repos` are
 * returned verbatim even when validation failed (see the module docblock).
 */
export interface ProjectManifestRecordReader {
  readRecord(slug: string): ProjectManifestRecord | undefined;
}

/** The one project-store read this module makes. */
export interface ProjectResolutionProjectReader {
  getProject(slug: string): ProjectConfig;
}

/**
 * The one binding-store read this module makes: "does ANY row realize this
 * manifest id here". Narrower than `findBinding`, which needs a resource id
 * this derivation deliberately never selects.
 */
export interface ProjectResolutionBindingReader {
  read(): { bindings: readonly { projectId: string }[] };
}

export interface ProjectResolutionViewDeps {
  resolver: ProjectResourceResolverLike;
  manifests: ProjectManifestRecordReader;
  source: ProjectResolutionProjectReader;
  bindings: ProjectResolutionBindingReader;
}

/**
 * `ProjectManifestIncompleteError` extends `ProjectManifestUnreadableError`,
 * so the two `instanceof` checks below cover all three throw classes. Named
 * as a set rather than caught with a bare `catch` so a NEW manifest failure
 * class does not silently acquire an `unreadable` rendering it was never
 * designed for — anything else still propagates to the route, which fails the
 * request loudly.
 */
function manifestFailureReason(
  projectSlug: string,
  error: unknown,
): string | undefined {
  if (
    error instanceof ProjectManifestSchemaVersionError ||
    error instanceof ProjectManifestUnreadableError
  ) {
    return `Project "${projectSlug}"'s manifest could not be read: ${error.message}`;
  }
  return undefined;
}

/**
 * Does the RECORD name code? A `git` resource carries a portable identity —
 * something on this Station declared where the project's code lives. A
 * `local-only` resource carries none by definition (§3.2), and is what the
 * backfill writes for a project that has no directory at all, so it is a
 * receipt rather than a declaration.
 *
 * Reads one boolean off the raw record. It selects nothing, and nothing it
 * reads crosses a boundary — see the module docblock for why this is not the
 * `composeManifest` trap.
 */
function recordDeclaresCode(
  record: ProjectManifestRecord | undefined,
): boolean {
  return record?.repos.some((r) => r.kind === 'git') === true;
}

/**
 * Does any binding row realize this record here? Binding rows are keyed by
 * `(manifest.id, resource.id)` (`project-binding-store.ts`), so with NO record
 * there is no `manifest.id` and no row anything could ever find — the binding
 * store is not read at all in that case, which also keeps a corrupt binding
 * store from failing a project that has no manifest to bind against.
 */
function recordIsRealizedHere(
  record: ProjectManifestRecord | undefined,
  deps: ProjectResolutionViewDeps,
): boolean {
  if (record === undefined) return false;
  return deps.bindings
    .read()
    .bindings.some((binding) => binding.projectId === record.id);
}

/**
 * Every declared resource, resolved BY ID, plus which one a no-`resourceId`
 * caller gets (archive#1503).
 *
 * ## Why this enumerates ids and is still not the `composeManifest` trap
 *
 * The trap is about SELECTION: a derivation that picked a resource out of
 * `repos`, or reported how many resolved, would render a manifest declaring two
 * primaries as a cleanly-resolving project. This enumerates EVERY declared id in
 * declaration order, drops none, ranks none, and forwards no resource object —
 * only ids, into a resolver that answers each independently. Two primaries, no
 * primary, and one primary all produce the same id set, so no selection
 * ambiguity can change what this reads off the record.
 *
 * ## Why `primary` is carried, and is not derivable by the caller
 *
 * Resolving per id would otherwise SILENCE the ambiguity: a manifest with two
 * primaries would render as N healthy rows while every no-`resourceId` consumer
 * in Station (the session cwd, the knowledge scan, the task workspace) still
 * fails `ambiguous`. A surface cannot re-derive it either, because the view
 * deliberately does not carry `repos`. So the selection is computed here, from
 * the same `selectPrimaryResource` the resolver uses, and reported as its own
 * fact.
 *
 * ## Why the empty-manifest case still goes through the resolver
 *
 * A record that declares NO resources has no id to enumerate. Rather than
 * writing a second sentence about what that means, it asks the resolver the
 * no-`resourceId` question and reports the `ambiguous` reason it already owns —
 * one authority for the vocabulary, and `resources: []` is legal there only
 * because `primary.named === false` names it (enforced by
 * `isWellFormedProjectResolutionView`).
 */
async function describeResources(
  projectSlug: string,
  record: ProjectManifestRecord | undefined,
  deps: ProjectResolutionViewDeps,
): Promise<{
  resources: ResourceResolutionResult[];
  primary: ProjectPrimaryResourceSelection;
}> {
  const declared: ProjectRepoResource[] = record?.repos ?? [];

  if (declared.length === 0) {
    // No manifest at all (the compat branch — one working directory, reported
    // under `localProjectResourceId`), or a manifest that declares nothing. The
    // resolver answers both, and its answer IS the primary in the first case.
    const resource = await deps.resolver.resolveProjectResource(projectSlug);
    return {
      resources: resource.state === 'ambiguous' ? [] : [resource],
      primary:
        resource.state === 'ambiguous'
          ? { named: false, reason: resource.reason }
          : { named: true, resourceId: resource.resourceId },
    };
  }

  const resources: ResourceResolutionResult[] = [];
  for (const declaredResource of declared) {
    resources.push(
      await deps.resolver.resolveProjectResource(
        projectSlug,
        declaredResource.id,
      ),
    );
  }

  const selection = selectPrimaryResource(declared);
  if (!selection.ok) {
    // The resolver owns the sentence for "no single resource could be named":
    // asking it the no-`resourceId` question is how this view gets that
    // sentence without writing a second, drifting copy of it. Its answer is
    // `ambiguous` by construction here — `selectPrimaryResource` just failed on
    // the same list — but the state is CHECKED rather than assumed, because a
    // resolver that answered anything else would mean the two disagree about
    // the manifest, and reporting that as an unnamed primary would hide it.
    const ambiguous = await deps.resolver.resolveProjectResource(projectSlug);
    return {
      resources,
      primary: {
        named: false,
        reason:
          ambiguous.state === 'ambiguous'
            ? ambiguous.reason
            : `Project "${projectSlug}" declares ${declared.length} resources and no single one of them is the primary (${selection.code}), but resolving without a resource id answered "${ambiguous.state}" for "${ambiguous.resourceId}". Ask for a resource by id.`,
      },
    };
  }

  return {
    resources,
    primary: { named: true, resourceId: selection.resource.id },
  };
}

/**
 * §3.6/§4.1's project-level answer for one project on this Station.
 *
 * Throws only when the project itself does not exist (the underlying project
 * store's throw, propagated) — the route turns that into a 404. A manifest
 * that cannot be read is an `unreadable` VIEW, not a throw, because it is a
 * thing the surface must render rather than a request that failed.
 */
export async function describeProjectResolution(
  projectSlug: string,
  deps: ProjectResolutionViewDeps,
): Promise<ProjectResolutionView> {
  const project = deps.source.getProject(projectSlug);

  let record: ProjectManifestRecord | undefined;
  try {
    record = deps.manifests.readRecord(projectSlug);
  } catch (error: unknown) {
    const reason = manifestFailureReason(projectSlug, error);
    if (reason === undefined) throw error;
    return { posture: 'unreadable', reason };
  }

  // THE DERIVATION. Three clauses, cheapest first — the binding read is
  // reached only when nothing else already answers "yes".
  const backs =
    Boolean(project.workingDirectory?.trim()) ||
    recordDeclaresCode(record) ||
    recordIsRealizedHere(record, deps);
  if (!backs) return { posture: 'not-backing' };

  try {
    return {
      posture: 'backing',
      ...(await describeResources(projectSlug, record, deps)),
    };
  } catch (error: unknown) {
    // `readRecord` above validates only the sidecar RECORD. The resolver's
    // `readProjectManifest` additionally COMPOSES the manifest against the
    // live project record and validates that, which can fail for shapes the
    // record read cannot see. Both are "the manifest could not be read".
    const reason = manifestFailureReason(projectSlug, error);
    if (reason === undefined) throw error;
    return { posture: 'unreadable', reason };
  }
}
