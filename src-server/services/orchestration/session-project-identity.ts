import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { expandTilde } from '../../utils/paths.js';

/**
 * Station #90 lane D (station #122), review D5: the start-metadata key
 * carrying a session's Project identity (`ProjectConfig.id`), stamped by
 * `OrchestrationService` from this Station's own project list when the
 * session starts (`withSessionLocalProjectId`), never from caller input.
 *
 * A slug is local and reusable (`project-membership-service.ts` guards the
 * reuse case), so anything that keys authority on a Project must read this
 * recorded id rather than looking the slug up later.
 */
export const SESSION_LOCAL_PROJECT_ID_METADATA_KEY = 'localProjectId';

/**
 * Station #90 lane D (S2): stamped `true` at start when the session named a
 * Project this Station has, but its working directory could not be shown to
 * lie inside that Project. A reader must then report NO Project id rather
 * than falling back to looking the slug up: the fallback exists only for
 * sessions that predate the stamp. Restrict-only: a caller that sets it can
 * only remove its own session's Project id.
 */
export const SESSION_LOCAL_PROJECT_ID_REFUSED_METADATA_KEY =
  'localProjectIdRefused';

/**
 * #3800: the start-metadata key carrying the directory a session was
 * authorized to work in: the Project's `workingDirectory` when the start's
 * cwd lies inside it, else the cwd the start was admitted with. Stamped by
 * `OrchestrationService` at start, replacing any caller value, and carried
 * with the session's stored metadata to its respawns. The Codex adapter
 * trusts engine configuration only from a repository that contains this
 * directory, never from one inside it.
 */
export const SESSION_CONFINEMENT_ROOT_METADATA_KEY = 'confinementRoot';

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * #3800: the `SESSION_CONFINEMENT_ROOT_METADATA_KEY` value for a start in
 * `cwd`, from this Station's own Project list:
 *
 * - the named Project's directory when it contains the cwd;
 * - else the deepest configured Project directory containing the cwd (a
 *   start that names no Project, such as a station-control dispatch to a
 *   plain folder, still belongs to the Project around it);
 * - else the server-admitted workspace (a provisioned worktree) when the cwd
 *   is exactly it;
 * - else `''`: a folder outside every Project. Only a session that is not
 *   `host` is ever checked, and such a session is never the operator's own,
 *   so nothing there is trusted.
 *
 * Paths are compared canonically (`canonicalDirectory`), and the root is
 * returned canonical: an adopted place is already canonical, and a lexical
 * comparison let a Project configured through a symlink or in another case
 * miss it, leaving the place as its own root (round 6 of the #3962
 * review).
 */
export function sessionConfinementRoot(
  cwd: string | undefined,
  projects: readonly { slug: string; workingDirectory?: string }[],
  options: {
    projectSlug?: string;
    admittedCwd?: string;
  } = {},
): string {
  if (cwd === undefined) return '';
  const target = canonicalDirectory(cwd);
  const roots = projects
    .map((project) => ({
      slug: project.slug,
      root: project.workingDirectory
        ? canonicalDirectory(resolve(expandTilde(project.workingDirectory)))
        : undefined,
    }))
    .filter(
      (entry): entry is { slug: string; root: string } =>
        entry.root !== undefined && isWithin(entry.root, target),
    );
  const named = roots.find((entry) => entry.slug === options.projectSlug);
  if (named) return named.root;
  const deepest = roots.sort((a, b) => b.root.length - a.root.length)[0];
  if (deepest) return deepest.root;
  if (
    options.admittedCwd !== undefined &&
    canonicalDirectory(options.admittedCwd) === target
  )
    return target;
  return '';
}

/**
 * A stored path (literal `~` allowed) as the filesystem spells it: symlinks
 * resolved and, on a case-insensitive volume, in its on-disk case
 * (`realpathSync.native`), so a Project configured through a link or in
 * another case still contains the folders inside it. A path that does not
 * exist is only resolved.
 */
function canonicalDirectory(path: string): string {
  const resolved = resolve(expandTilde(path));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
