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
 *   `own-folder`: a No project chat confined to that folder, and only in a
 *   folder {@link noProjectFolderRefusal} allows.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
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

/**
 * #3386: Station will not continue this conversation where it asked, and
 * asking again will not change that until the folder or the projects do.
 * The code reaches callers through the dispatch wrapper, not retryable, so
 * no client offers a retry that cannot succeed.
 */
export class ContinuationPlaceRefusedError extends Error {
  readonly code = 'continuation_place_refused';
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationPlaceRefusedError';
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
 * Folders directly in the home folder that hold an operating system's
 * per-user application data, settings and keychains: macOS `Library`,
 * Windows `AppData`. Compared without case, as both file systems do.
 */
const PROTECTED_HOME_FOLDERS = new Set(['library', 'appdata']);

/**
 * Why a No project chat may not be confined to `folder` (symlink-resolved),
 * or `undefined` when it may. An agent confined to its working directory may
 * still read and change everything under it, so this is an ALLOW rule, not a
 * list of dangerous places: only a folder strictly inside the home folder is
 * allowed, and not one of these:
 *
 * - inside a hidden folder directly in the home folder (`~/.ssh`, `~/.aws`,
 *   `~/.config`, `~/.claude`, `~/.codex`, `~/.kube`, ...). Every one of
 *   them, not a list of known credential stores: which tools keep secrets in
 *   a dot-folder is open-ended, and none is a place people keep their work;
 * - inside {@link PROTECTED_HOME_FOLDERS} (`~/Library`, `~/AppData`);
 * - the system temporary folder, or a folder containing it;
 * - Station's own data folder, anything inside it, or a folder containing
 *   it: an agent there could rewrite Station's own state.
 *
 * Everything else, system folders such as `/etc`, `/tmp` and `/usr/local`
 * included, is outside the home folder and refused.
 */
export function noProjectFolderRefusal(folder: string): string | undefined {
  const home = canonicalOrLexical(homedir());
  if (folder === home) return 'it is your home folder';
  if (!isSameOrInside(home, folder)) return 'it is outside your home folder';
  const [first = ''] = relative(home, folder).split(sep);
  if (first.startsWith('.'))
    return `it is inside ~${sep}${first}, a hidden folder where tools keep their settings and credentials`;
  if (PROTECTED_HOME_FOLDERS.has(first.toLowerCase()))
    return `it is inside ~${sep}${first}, where the system keeps application data`;
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
 * Whether reaching `recorded` (absolute, lexically resolved) goes through a
 * symbolic link INSIDE the home folder: a component that is a link and sits
 * in the home folder or below it. A link above home is the system's own (a
 * home under a linked `/home`, an automounted home), not the conversation's
 * folder leading elsewhere, so it is allowed; where a link sits is decided
 * by its parent's resolved path, so another spelling of the home folder's
 * path does not change the answer.
 *
 * `lstat` looks each component up the way the file system does, so a
 * spelling that differs only by case or Unicode normalization finds the
 * same entry and is not a link. A component that cannot be read counts as a
 * link: the caller then refuses.
 */
function recordedPathFollowsLink(recorded: string): boolean {
  const home = canonicalOrLexical(homedir());
  const { root } = parse(recorded);
  let current = root;
  for (const component of recorded.slice(root.length).split(sep)) {
    if (!component) continue;
    const parent = current;
    current = join(current, component);
    try {
      if (!lstatSync(current).isSymbolicLink()) continue;
      if (isSameOrInside(home, realpathSync.native(parent))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * The place a continuation of an attached session whose recorded folder is
 * `cwd` runs. Throws {@link ContinuationPlaceRefusedError} with a message a
 * person can act on when Station refuses. Messages name no path: routes
 * redact paths from errors, and the person already sees the folder.
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
    throw new ContinuationPlaceRefusedError(
      "This conversation's folder no longer exists, so Station cannot continue it there.",
    );
  const attribution = await resolveAttachedSessionProject(
    folder,
    [...input.projects],
    input.repositories ?? createPollRepositoryLookup(),
  );
  // archive#1462: adoption binds a session to one project, so an ambiguous
  // workspace refuses by name instead of adopting into an arbitrary winner.
  if (attribution.state === 'ambiguous')
    throw new ContinuationPlaceRefusedError(
      `This conversation's folder is configured as more than one project (${attribution.candidates.join(', ')}). Continue it from the project you meant, or remove the duplicate project.`,
    );
  if (attribution.state === 'attributed') {
    if (input.target?.kind === 'own-folder')
      throw new ContinuationPlaceRefusedError(
        `This conversation belongs to the project ${attribution.slug}. Continue it in that project.`,
      );
    if (
      input.target?.kind === 'project' &&
      input.target.projectSlug !== attribution.slug
    )
      throw new ContinuationPlaceRefusedError(
        `This conversation belongs to the project ${attribution.slug}, not ${input.target.projectSlug}.`,
      );
    const id = input.projects.find(
      (project) => project.slug === attribution.slug,
    )?.id;
    return {
      // The folder the attribution matched: the conversation's own.
      cwd: attribution.cwd,
      // Already canonical from the attribution; expanded again so a stored
      // `~/...` can never reach here raw (station#3155).
      workingDirectory: resolve(expandTilde(attribution.workingDirectory)),
      project: { slug: attribution.slug, ...(id ? { id } : {}) },
    };
  }
  if (input.target?.kind === 'project')
    throw new ContinuationPlaceRefusedError(
      `This conversation's folder is not part of the project ${input.target.projectSlug}: it is neither inside the project's folder nor in a worktree of its repository. Station continues a conversation only in the folder it ran in. Continue it as a No project chat, or add a project for that folder.`,
    );
  if (input.target?.kind !== 'own-folder')
    throw new ContinuationPlaceRefusedError(
      "This conversation's folder belongs to no project. Choose to continue it as a No project chat in that folder, or add a project for it.",
    );
  if (input.hosted)
    throw new ContinuationPlaceRefusedError(
      'This Station is hosted, so a conversation outside every project cannot be continued as a No project chat.',
    );
  const refusal = noProjectFolderRefusal(folder);
  if (refusal)
    throw new ContinuationPlaceRefusedError(
      `Station will not continue this conversation as a No project chat in its folder, because ${refusal}. A No project chat may only work in a folder inside your home folder. Add a project for that folder, or keep working in the original app.`,
    );
  // The person confirmed the folder Activity showed them, which is the one
  // the conversation recorded. A No project chat runs only there: when that
  // path reaches another folder through a symbolic link, refuse rather than
  // run somewhere they did not see. A path that differs from the folder's
  // own spelling only by letter case or Unicode normalization (a shell's
  // spelling on a file system that ignores both) is the same folder.
  const recorded = resolve(expandTilde(input.cwd));
  if (recorded !== folder && recordedPathFollowsLink(recorded))
    throw new ContinuationPlaceRefusedError(
      "This conversation's folder leads to another folder through a symbolic link. Station will not continue it as a No project chat in a folder other than the one it shows. Add a project for the folder it leads to, or keep working in the original app.",
    );
  return { cwd: folder, workingDirectory: folder };
}
