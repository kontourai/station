/**
 * archive#1497 — a coding layout's working directory is DERIVED from its owning
 * project, never a persisted second copy.
 *
 * Design doc: `docs/design/portable-project-identity.md` §2.2 ("the coding
 * layout carries a second, drifting copy... This is the warning about what
 * happens when a local path is copied rather than resolved"), §5 ("The layout
 * copy is the tell"), §10 slice 0.
 *
 * Three decisions here are load-bearing:
 *
 * 1. **Derivation wins over the persisted copy, unconditionally.** The previous
 *    read path backfilled `config.workingDirectory` only when it was *missing*,
 *    which meant a copy written before this change kept winning forever — a
 *    project that moved, or that cleared its working directory, could never
 *    correct its own layouts. Ignoring the persisted value is therefore the
 *    compat path for every install that upgrades: no rewrite, no migration
 *    script, and the stale bytes are inert the moment this ships.
 *    (Migration decision (a) in archive#1497.)
 * 2. **The key is removed on write, not merely ignored.** Read-side derivation
 *    alone would leave dead bytes on disk that a future reader could
 *    mistake for authority, and a GET→PUT round trip would re-plant the derived
 *    value as a fresh copy the moment a user renamed a layout. Stripping on
 *    every persisting path makes the on-disk state converge without a bulk
 *    rewrite. (Migration decision (b), applied together with (a) — neither is
 *    sufficient alone.) One recorded exception to "converge": a layout whose
 *    `type` is changed away from `coding` in the same write that carries a
 *    pre-fix copy keeps that copy, because these helpers scope themselves to
 *    coding layouts. Nothing reads it in that state, and a later
 *    `type: 'coding'` write clears it; it is a residual, not a guarantee.
 * 3. **Absent means absent.** When the owning project has no working directory
 *    the key is *removed*, not set to `undefined`. A project that clears its
 *    working directory must not leave its layouts advertising the old path, and
 *    the emitted JSON shape stays byte-identical to the pre-change shape for
 *    that case.
 *
 * Only `coding` layouts participate: they are the only type the server ever
 * copied a working directory into, and the only type whose renderer reads it
 * (`src-ui/src/components/coding-layout/CodingLayout.tsx`). Every other layout
 * type passes through untouched.
 */

/** The one config key this module owns. */
const WORKING_DIRECTORY_KEY = 'workingDirectory';

/**
 * The config key naming WHICH of the project's repos a coding layout is about
 * (archive#1503, `docs/design/portable-project-identity.md` §10:
 * "layouts reference repos by id").
 */
const REPO_ID_KEY = 'repoId';

/** The minimum shape both helpers need; deliberately structural, not nominal. */
export interface LayoutWorkingDirectoryShape {
  type?: string;
  config?: Record<string, unknown>;
}

/** True for the one layout type whose working directory is project-derived. */
export function isCodingLayout(layout: LayoutWorkingDirectoryShape): boolean {
  return layout.type === 'coding';
}

/**
 * WHICH repo this coding layout is about, or `undefined` for the ordinary
 * single-repo case (archive#1503).
 *
 * This is a REFERENCE, not a copy: it names a manifest resource id, and the
 * directory is still derived on every read — which is the whole point of
 * archive#1497 and is why this key is safe to persist where
 * `workingDirectory` is not. A resource id is a portable fact about the
 * project; a path is a machine-local one that drifts the moment a checkout
 * moves.
 *
 * Non-coding layouts answer `undefined` for the same reason they are exempt
 * from the derivation entirely: coding is the only type whose renderer reads a
 * working directory.
 */
export function codingLayoutRepoId(
  layout: LayoutWorkingDirectoryShape,
): string | undefined {
  if (!isCodingLayout(layout)) return undefined;
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
 * Removes a persisted `config.workingDirectory` from a coding layout before it
 * reaches storage. Non-coding layouts and layouts without the key are returned
 * as-is (same object identity) so callers can use this on every write path
 * without churning unrelated records.
 */
export function withoutPersistedWorkingDirectory<
  T extends LayoutWorkingDirectoryShape,
>(layout: T): T {
  if (!isCodingLayout(layout)) return layout;
  const config = layout.config;
  if (!config || !Object.hasOwn(config, WORKING_DIRECTORY_KEY)) return layout;
  const { [WORKING_DIRECTORY_KEY]: _dropped, ...rest } = config;
  return { ...layout, config: rest };
}

/**
 * Projects the owning project's working directory onto a coding layout's config
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
  if (!isCodingLayout(layout)) return layout;
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
