/**
 * #3386: where Continue in Station runs the continuation of an attached
 * session, decided again at adoption time from the folder itself.
 *
 * The continuation always runs in the conversation's own folder, the one its
 * history was recorded in. Engines confine a `workspace` session to its
 * working directory (Codex's `workspace-write` sandbox root, Claude's own
 * working-directory check), so that folder is also the confinement root.
 * Station never moves a conversation to another folder: its history names
 * files in its own folder, and Claude keeps a transcript per folder, so a
 * fork resumed elsewhere would not find it.
 *
 * Which project the continuation belongs to:
 *
 * - a folder inside a project's folder, or inside a GENUINE checkout of the
 *   project's repository (a linked worktree whose git back-pointer names it,
 *   `genuineCheckout`), belongs to that project, exactly as the attached
 *   session follow poll attributes it. The poll's stored answer is not
 *   trusted: the folder is located and its `.git` read again here, so a
 *   worktree removed, replaced by a symlink, or given a forged `.git` since
 *   discovery is refused.
 * - a folder no project claims continues only when the caller chose
 *   `own-folder`: a No project chat confined to that folder, refused for a
 *   folder too broad to confine an agent to ({@link tooBroadFolderReason}).
 */
import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AdoptSessionTarget } from '@kontourai/station-contracts/orchestration';
import { expandTilde, resolveHomeDir } from '../../utils/paths.js';
import {
  type AttachedProjectRoot,
  resolveAttachedSessionProject,
} from './attached-session-follow-service.js';
import {
  createPollRepositoryLookup,
  type RepositoryLookup,
} from './attached-session-repository.js';

/** Where the continuation runs, and the project it belongs to (none for a No project chat). */
export interface ContinuationPlace {
  /** The conversation's own folder, symlink-resolved: the child's cwd. */
  cwd: string;
  /** The project's folder, or `cwd` itself for a No project chat. */
  workingDirectory: string;
  project?: { slug: string; id?: string };
}

/** Thrown when Continue in Station refuses the folder; the message is for the person. */
export class ContinuationPlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationPlaceError';
  }
}

function realDirectory(path: string): string | undefined {
  try {
    const real = realpathSync.native(resolve(expandTilde(path)));
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** `inner` is `outer` or a folder inside it. */
function isSameOrInside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** A folder, symlink-resolved when it exists, lexically absolute otherwise. */
function canonicalOrLexical(path: string): string {
  const absolute = resolve(expandTilde(path));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Why `folder` (symlink-resolved) is too broad to confine a No project chat
 * to, or `undefined` when it is narrow enough. An agent confined to its
 * working directory may still read and change everything under it, so these
 * are refused:
 *
 * - the filesystem root, and any folder directly under it (`/tmp`,
 *   `/Users`, `/opt`, a drive's top folder);
 * - the home folder, and any folder that contains it;
 * - the system temporary folder, and any folder that contains it;
 * - Station's own data folder, anything inside it, and any folder that
 *   contains it: an agent there could rewrite Station's own state.
 */
export function tooBroadFolderReason(folder: string): string | undefined {
  const parent = dirname(folder);
  if (parent === folder) return 'it is the root of the file system';
  if (dirname(parent) === parent) return 'it is a top-level system folder';
  const home = canonicalOrLexical(homedir());
  if (isSameOrInside(folder, home))
    return folder === home
      ? 'it is your home folder'
      : 'it contains your home folder';
  const temporary = canonicalOrLexical(tmpdir());
  if (isSameOrInside(folder, temporary))
    return 'it is or contains the system temporary folder';
  const stationHome = canonicalOrLexical(resolveHomeDir());
  if (
    isSameOrInside(folder, stationHome) ||
    isSameOrInside(stationHome, folder)
  )
    return "it is or overlaps Station's own data folder";
  return undefined;
}

/**
 * The place a continuation of an attached session whose recorded folder is
 * `cwd` runs. Throws {@link ContinuationPlaceError} with a reason a person
 * can act on when Station refuses.
 */
export async function resolveContinuationPlace(input: {
  cwd: string;
  projects: readonly AttachedProjectRoot[];
  target?: AdoptSessionTarget;
  /** A hosted Station: a conversation outside every project is never continued. */
  hosted?: boolean;
  /** For tests: how a folder's repository is found. Fresh per call by default. */
  repositories?: RepositoryLookup;
}): Promise<ContinuationPlace> {
  const folder = realDirectory(input.cwd);
  if (!folder)
    throw new ContinuationPlaceError(
      `The conversation's folder ${input.cwd} no longer exists, so Station cannot continue it there.`,
    );
  const attribution = await resolveAttachedSessionProject(
    folder,
    [...input.projects],
    input.repositories ?? createPollRepositoryLookup(),
  );
  // archive#1462: adoption binds a session to one project, so an ambiguous
  // workspace refuses by name instead of adopting into an arbitrary winner.
  if (attribution.state === 'ambiguous')
    throw new ContinuationPlaceError(
      `The attached session workspace ${attribution.workingDirectory} is configured as more than one project (${attribution.candidates.join(', ')}). Continue it from the project you meant, or remove the duplicate project.`,
    );
  if (attribution.state === 'attributed') {
    if (input.target?.kind === 'own-folder')
      throw new ContinuationPlaceError(
        `This conversation belongs to the project ${attribution.slug}. Continue it in that project.`,
      );
    if (
      input.target?.kind === 'project' &&
      input.target.projectSlug !== attribution.slug
    )
      throw new ContinuationPlaceError(
        `This conversation belongs to the project ${attribution.slug}, not ${input.target.projectSlug}.`,
      );
    const id = input.projects.find(
      (project) => project.slug === attribution.slug,
    )?.id;
    return {
      // The folder the attribution matched: the conversation's own.
      cwd: attribution.cwd,
      workingDirectory: attribution.workingDirectory,
      project: { slug: attribution.slug, ...(id ? { id } : {}) },
    };
  }
  if (input.target?.kind === 'project')
    throw new ContinuationPlaceError(
      `The conversation's folder ${folder} is not part of the project ${input.target.projectSlug}: it is neither inside the project's folder nor in a worktree of its repository. Station continues a conversation only in the folder it ran in. Continue it as a No project chat, or add a project for that folder.`,
    );
  if (input.target?.kind !== 'own-folder')
    throw new ContinuationPlaceError(
      `The conversation's folder ${folder} belongs to no project. Choose to continue it as a No project chat in that folder, or add a project for it.`,
    );
  if (input.hosted)
    throw new ContinuationPlaceError(
      'This Station is hosted, so a conversation outside every project cannot be continued as a No project chat.',
    );
  const tooBroad = tooBroadFolderReason(folder);
  if (tooBroad)
    throw new ContinuationPlaceError(
      `Station will not continue this conversation as a No project chat in ${folder}: ${tooBroad}, which is too broad to confine an agent to. Continue it in the original app, or start it again from a narrower folder.`,
    );
  return { cwd: folder, workingDirectory: folder };
}
