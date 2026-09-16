/**
 * What a project's layout store will accept, decided in ONE place (#2062
 * review BLOCKING-2).
 *
 * `POST /api/projects/:slug/layouts` has always refused two shapes before
 * writing: a layout naming an agent the project cannot reach, and a coding
 * layout naming a `config.workingDirectory` of its own (archive#1497 — that
 * value is derived from the project, never a persisted second copy). Promote
 * (#2062) publishes a Board AS a project Layout through the same storage
 * writer, and it went straight to `createOwnedLayout`, which checks only
 * fingerprints and slug occupancy. So a Board carrying
 * `config.availableAgents: ['ghost-agent']` landed on disk in a project whose
 * own route would have answered 400 for the identical body, and three places
 * — the service docblock, the pairing-scope table and `docs/reference/api.md`
 * — asserted the opposite.
 *
 * The remedy is this module rather than a second copy of the checks in the
 * promote path, for the reason the divergence existed in the first place: two
 * implementations of one admission rule drift, and the drift is invisible
 * until somebody writes a record neither route meant to allow. Both callers
 * now derive their answer here, so "promote admits exactly what the project
 * route admits" is a property of the code rather than a sentence in a
 * comment.
 *
 * ## Scope of the claim
 *
 * This is the admission `POST /api/projects/:slug/layouts` performs. It is
 * deliberately NOT claimed for `PUT`, which validates a MERGED record and
 * strips on a different schedule; promote has no equivalent of that.
 *
 * The apply route (`projects.ts`, the catalog-apply handler) is a different
 * story and the reason is worth recording rather than lumping in with `PUT`:
 * it builds a FRESH record from a catalog definition, so it is a THIRD writer
 * of the same shape, and it still carries its own inline
 * `validateLayoutAgentReferences` call — the duplication this module exists to
 * remove. It was not folded in here because it raises rather than returning a
 * body, so its refusal path is genuinely different and converting it is a
 * change to a surface #2062 does not touch. A reader adding a fourth writer
 * should fold apply in at the same time.
 *
 * Note also what this does not make true: equal ADMISSION is not equal
 * AUTHORIZATION. These two routes resolve to the same pairing scope for a
 * separate reason (both write through the project transaction), recorded in
 * `pairing-route-scopes.ts`. A body both routes accept still says nothing
 * about who may send it.
 */
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type {
  AgentOwnershipRef,
  LayoutAgentReferenceShape,
  ProjectReferenceIntegrityDiagnostic,
} from '@kontourai/station-contracts/project-reference-integrity';
import { validateLayoutAgentReferences } from '@kontourai/station-contracts/project-reference-integrity';
import {
  codingLayoutRepoId,
  withoutPersistedWorkingDirectory,
} from './layout-working-directory.js';

/** The structural minimum both checks read. */
export interface AdmittableProjectLayout extends LayoutAgentReferenceShape {
  type?: string;
  config?: Record<string, unknown>;
}

/** The 400 body a refusal answers with, byte-shaped as `projects.ts` builds it. */
export interface ProjectLayoutRefusalBody {
  success: false;
  error: string;
  diagnostics?: ProjectReferenceIntegrityDiagnostic[];
}

export type ProjectLayoutAdmission<T> =
  | { readonly ok: true; readonly persisted: T }
  | { readonly ok: false; readonly body: ProjectLayoutRefusalBody };

/**
 * The agent-reference half. Extracted verbatim from `projects.ts`'s
 * `integrityError`, including its "first diagnostic is the message" rule and
 * its fallback string, because the body is a wire shape two routes now share.
 *
 * `knownAgents === undefined` SKIPS the check, matching the project route's
 * `if (knownAgents)` guard exactly. That is not a hole either route invented:
 * the agent list is unavailable only when no `listAgents` was wired, and both
 * compositions wire it in production.
 */
function refuseUnknownAgentReferences(
  project: Pick<ProjectConfig, 'slug' | 'agents'>,
  layout: AdmittableProjectLayout,
  knownAgents: readonly AgentOwnershipRef[] | undefined,
): ProjectLayoutRefusalBody | undefined {
  if (!knownAgents) return undefined;
  const diagnostics = validateLayoutAgentReferences(project, layout, {
    knownAgents,
  });
  if (diagnostics.length === 0) return undefined;
  return {
    success: false,
    error: diagnostics[0]?.message ?? 'Invalid project references',
    diagnostics,
  };
}

/**
 * The working-directory half (archive#1497), phrased against the REQUEST body
 * exactly as the project route phrases it: a supplied value that differs from
 * the derived one is refused by name, and a value equal to the derived one is
 * accepted and then stripped.
 */
function refuseConflictingWorkingDirectory(
  projectSlug: string,
  layout: AdmittableProjectLayout,
  derivedWorkingDirectory: string | undefined,
): ProjectLayoutRefusalBody | undefined {
  if (layout.type !== 'coding') return undefined;
  const supplied = layout.config?.workingDirectory;
  if (supplied === undefined || supplied === derivedWorkingDirectory) {
    return undefined;
  }
  return {
    success: false,
    error: `A coding layout's config.workingDirectory is derived from its project and cannot be set independently. Project '${projectSlug}' resolves to ${derivedWorkingDirectory ? `'${derivedWorkingDirectory}'` : 'no working directory'}; change the project's working directory instead.`,
  };
}

/**
 * Decides whether a project may hold this layout, and returns the record to
 * persist when it may.
 *
 * The refusals are ordered agent-references first, then working directory —
 * the order `projects.ts` already refused in, kept so a body that trips both
 * gets the same message from both routes rather than a different one
 * depending on which door it came through.
 */
export function admitProjectLayoutWrite<
  T extends AdmittableProjectLayout,
>(input: {
  project: Pick<ProjectConfig, 'slug' | 'agents'>;
  layout: T;
  knownAgents: readonly AgentOwnershipRef[] | undefined;
  derivedWorkingDirectory: string | undefined;
}): ProjectLayoutAdmission<T> {
  const unknownAgents = refuseUnknownAgentReferences(
    input.project,
    input.layout,
    input.knownAgents,
  );
  if (unknownAgents) return { ok: false, body: unknownAgents };

  const conflict = refuseConflictingWorkingDirectory(
    input.project.slug,
    input.layout,
    input.derivedWorkingDirectory,
  );
  if (conflict) return { ok: false, body: conflict };

  return {
    ok: true,
    persisted: withoutPersistedWorkingDirectory(input.layout),
  };
}

/**
 * Which directory a coding layout in this project resolves to.
 *
 * Extracted so promote derives it the same way the project route does rather
 * than approximating it. `resolveWorkspacePath` is optional for the same
 * reason the project route's `deps.resolution` is: a composition without a
 * resolver cannot answer a repo-scoped question, and answering `undefined`
 * there is what makes a layout that names a repo fall back to being refused
 * rather than silently anchored at the wrong checkout.
 */
export async function deriveProjectLayoutWorkingDirectory(input: {
  projectSlug: string;
  layout: AdmittableProjectLayout;
  projectWorkingDirectory: string | undefined;
  resolveWorkspacePath?: (
    projectSlug: string,
    resourceId: string,
  ) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const repoId = codingLayoutRepoId(input.layout);
  if (repoId === undefined) return input.projectWorkingDirectory;
  if (!input.resolveWorkspacePath) return undefined;
  return await input.resolveWorkspacePath(input.projectSlug, repoId);
}
