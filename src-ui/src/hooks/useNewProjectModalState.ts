import {
  describeProjectSlugConflict,
  findProjectSlugConflict,
  type ProjectMetadata,
} from '@kontourai/station-contracts/project';
import {
  useProjectIconCandidatesQuery,
  useProjectsQuery,
} from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useNewProjectDraft } from './useNewProjectDraft';
import { useNewProjectStarter } from './useNewProjectStarter';
import { useNewProjectSubmit } from './useNewProjectSubmit';

interface ProjectsQueryResult {
  data?: ProjectMetadata[];
  isSuccess: boolean;
  refetch: () => Promise<{ data?: ProjectMetadata[] }>;
}

/**
 * 4-HOME-007. The duplicate-name answer comes from the projects the user
 * already has, through the same contracts helper `POST /api/projects` uses for
 * its 409 — so the modal and the route cannot describe the same collision
 * differently.
 *
 * This one reads the CACHE, so it is advisory and never blocks :
 * `['projects']` stays fresh for five minutes and the app disables both
 * refetch-on-mount and refetch-on-focus, so an entry deleted by another device,
 * the CLI, or another tab survives here long after the name became free. A veto
 * from that would refuse a legitimate name for minutes and never attempt the
 * POST, which is the only authority on whether a slug is taken.
 *
 * `undefined` means "nothing cached is known to be taken" — never "the name is
 * free". Only the refreshed check at submit (and then the server) can say that.
 */
function useCachedSlugConflictNotice(
  derivedSlug: string,
  resolvedName: string,
  projects: readonly ProjectMetadata[] | undefined,
): string | undefined {
  if (!derivedSlug || !projects) return undefined;
  const conflict = findProjectSlugConflict(
    derivedSlug,
    projects.map((project) => project.slug),
  );
  if (!conflict) return undefined;
  // Deliberately NOT `describeProjectSlugConflict`: that sentence states a
  // conflict as fact and names the free slug to move to. This one says only
  // what a possibly-stale cache can support.
  return `A project called '${resolvedName}' may already exist. Station checks with the server when you create it.`;
}

export function useNewProjectModalState(isOpen: boolean, onClose: () => void) {
  const { apiBase } = useApiBase();
  const { setProject } = useNavigation();
  const draft = useNewProjectDraft(isOpen);
  const directoryLikelyExists = draft.directory.trim().endsWith('/');
  const starter = useNewProjectStarter({
    isOpen,
    normalizedDirectory: draft.normalizedDirectory,
    directoryLikelyExists,
  });
  const iconCandidates = useProjectIconCandidatesQuery(
    draft.normalizedDirectory || undefined,
    { enabled: isOpen && directoryLikelyExists },
  );
  // Shares the `['projects']` cache the sidebar already holds, so opening the
  // modal usually costs no request at all.
  const projects = useProjectsQuery({ enabled: isOpen }) as ProjectsQueryResult;
  const nameAdvisory = useCachedSlugConflictNotice(
    draft.derivedSlug,
    draft.resolvedName,
    projects.isSuccess ? projects.data : undefined,
  );

  /**
   * The only client-side check allowed to refuse a submission: it re-reads the
   * project list from the server first, so the veto is a fresh fact rather than
   * a cache entry. Returns the sentence to show, or `null` to let the POST go.
   *
   * Every uncertain outcome resolves to `null` — a refetch that threw, or that
   * answered with anything other than a list, tells us nothing, and the server's
   * own 409 (same helper, same sentence) is the correct place for the answer to
   * come from when the client cannot know.
   */
  async function verifySlugAvailability(candidate: {
    name: string;
    slug: string;
  }): Promise<string | null> {
    let refreshed: ProjectMetadata[] | undefined;
    try {
      refreshed = (await projects.refetch())?.data;
    } catch {
      return null;
    }
    if (!Array.isArray(refreshed)) return null;
    const conflict = findProjectSlugConflict(
      candidate.slug,
      refreshed.map((project) => project.slug),
    );
    return conflict
      ? describeProjectSlugConflict(candidate.name, conflict)
      : null;
  }

  const submission = useNewProjectSubmit({
    apiBase,
    isOpen,
    derivedSlug: draft.derivedSlug,
    normalizedDirectory: draft.normalizedDirectory,
    resolveLayoutId: starter.resolveLayoutId,
    verifySlugAvailability,
    onComplete: (slug) => {
      setProject(slug);
      onClose();
    },
  });

  return { apiBase, draft, iconCandidates, nameAdvisory, starter, submission };
}
