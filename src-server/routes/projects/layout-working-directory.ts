/**
 * Repository-bound layouts derive their working directory from the owning
 * Project, never a persisted second copy (archive#1497, archive#1503).
 * Legacy Coding records retain that binding even without the Coding plugin.
 * Reads discard stale copies, writes remove them, and an unbound Project or
 * named repository produces no path. See docs/design/portable-project-identity.md.
 */
import {
  type LayoutWorkspaceBinding,
  layoutUsesRepositoryWorkspace,
} from '@kontourai/station-contracts/layout';

/** The one config key this module owns. */
const WORKING_DIRECTORY_KEY = 'workingDirectory';

/**
 * The config key naming WHICH of the project's repos a repository-bound layout is about
 * (archive#1503, `docs/design/portable-project-identity.md` §10:
 * "layouts reference repos by id").
 */
const REPO_ID_KEY = 'repoId';

/** The minimum shape both helpers need; deliberately structural, not nominal. */
interface LayoutWorkingDirectoryShape {
  type?: string;
  workspaceBinding?: LayoutWorkspaceBinding;
  config?: Record<string, unknown>;
}

/**
 * WHICH repo this repository-bound layout is about, or `undefined` for the ordinary
 * single-repo case (archive#1503).
 *
 * This is a REFERENCE, not a copy: it names a manifest resource id, and the
 * directory is still derived on every read — which is the whole point of
 * archive#1497 and is why this key is safe to persist where
 * `workingDirectory` is not. A resource id is a portable fact about the
 * project; a path is a machine-local one that drifts the moment a checkout
 * moves.
 *
 * Layouts without a repository binding answer `undefined`; an arbitrary config
 * field cannot opt a layout into Project workspace derivation.
 */
export function layoutRepositoryId(
  layout: LayoutWorkingDirectoryShape,
): string | undefined {
  if (!layoutUsesRepositoryWorkspace(layout)) return undefined;
  const value = layout.config?.[REPO_ID_KEY];
  // Exact shape or nothing. A non-string (or blank) value is not a resource id,
  // and coercing one would send the derivation at a resource nobody named — the
  // caller then falls back to the project's own directory, which on a
  // multi-repo project is a DIFFERENT repo's checkout.
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // RECORDED, not overlooked (archive#1503 review, L8): this trims for
  // RESOLUTION and does not rewrite what is stored, so a layout persisted with
  // `" api "` keeps those bytes and resolves `"api"`. That asymmetry is
  // deliberate and it is the same one every read-derivation in this module
  // has: a read path does not write. Normalizing on read and persisting the
  // normalized form would make a GET→PUT round trip silently rewrite an
  // operator's record — archive#1497's defect, in the field this slice added.
  // The stored bytes are inert; nothing but this function reads the key.
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Strip a repository-bound layout's copied path before storage. Legacy Coding
 * records acquire the explicit binding on write; unbound layouts pass through.
 */
export function withoutPersistedWorkingDirectory<
  T extends LayoutWorkingDirectoryShape,
>(layout: T): T {
  if (!layoutUsesRepositoryWorkspace(layout)) return layout;
  const bound =
    layout.workspaceBinding === 'repository'
      ? layout
      : { ...layout, workspaceBinding: 'repository' as const };
  const config = layout.config;
  if (!config || !Object.hasOwn(config, WORKING_DIRECTORY_KEY)) return bound;
  const { [WORKING_DIRECTORY_KEY]: _dropped, ...rest } = config;
  return { ...bound, config: rest };
}

/**
 * Projects the owning project's working directory onto a repository-bound layout's config
 * for the response. The persisted value — if any — is discarded rather than
 * preferred: this is the read-derivation that makes pre-fix copies inert.
 *
 * `projectWorkingDirectory` is passed in rather than read here so this stays a
 * pure function and so the caller reads the project once per request.
 * Truthiness (not trimming) mirrors the pre-change condition exactly, so an
 * empty-string working directory keeps meaning "none" as it always has.
 */
export function withDerivedWorkingDirectory<
  T extends LayoutWorkingDirectoryShape,
>(layout: T, projectWorkingDirectory: string | undefined): T {
  if (!layoutUsesRepositoryWorkspace(layout)) return layout;
  const stripped = withoutPersistedWorkingDirectory(layout);
  if (!projectWorkingDirectory) return stripped;
  return {
    ...stripped,
    config: {
      ...stripped.config,
      [WORKING_DIRECTORY_KEY]: projectWorkingDirectory,
    },
  };
}
