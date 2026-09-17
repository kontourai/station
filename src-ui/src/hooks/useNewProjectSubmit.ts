import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import {
  applyProjectLayout,
  useCreateProjectMutation,
  useFileSystemBrowseQuery,
} from '@kontourai/station-sdk';
import { type FormEvent, useEffect, useState } from 'react';
import { trackRecentLayout } from './useRecentLayouts';

interface ProjectDraft {
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  workingDirectory?: string;
  defaultEnvironment?: EnvironmentRef;
}

/**
 * A directory this submission checked, with the outcome's strength.
 *
 * `verdict: true` — the server ANSWERED about this path (a 4xx from the
 * browse route's `pathAccessFailure`: not found, not permitted, not a
 * folder). A fact about the draft: Create disables until the path is edited.
 *
 * `verdict: false` — the check FAILED TO HAPPEN (network refusal, 5xx, an
 * answer with neither data nor error). Nothing was established about the
 * path, so it must not disable Create: the message says "Try again", and a
 * disabled Create made that sentence a lie — the exact click-eating the
 * #765 audit hit twice on a loaded host (clicks silently dead against a
 * refusal the user never saw the reason for, then a later attempt working).
 * The POST is still withheld on this submission; the NEXT click re-checks.
 */
interface RejectedDirectory {
  path: string;
  message: string;
  verdict: boolean;
}

/** A slug a REFRESHED project list said was taken, and the sentence for it. */
interface RejectedSlug {
  slug: string;
  message: string;
}

interface CreatedProject {
  slug: string;
  layoutId: string | null;
}

interface UseNewProjectSubmitOptions {
  apiBase: string;
  isOpen: boolean;
  /** The slug the draft currently derives; a refusal older than it is stale. */
  derivedSlug: string;
  normalizedDirectory: string;
  /**
   * The starter layout the picker currently shows as selected, or `null` for
   * "Start without a layout". #1536 E4: this used to be a
   * `resolveLayoutId()` callback that could answer with a layout the picker
   * showed as unselected, so the created project got a layout the user had
   * visibly declined. A value, read at submit, cannot diverge from the
   * rendered selection.
   */
  starterLayoutId: string | null;
  /**
   * Re-reads the project list from the SERVER and returns the sentence to show
   * if the slug is still taken, or `null` to proceed. Anything it cannot
   * establish must be `null`: the POST is the authority
   */
  verifySlugAvailability?: (candidate: {
    name: string;
    slug: string;
  }) => Promise<string | null>;
  onComplete: (slug: string) => void;
}

/**
 * Creates once, then retains the returned identity until its optional starter
 * layout is applied. A retry never repeats the creation POST.
 */
export function useNewProjectSubmit({
  apiBase,
  isOpen,
  derivedSlug,
  normalizedDirectory,
  starterLayoutId,
  verifySlugAvailability,
  onComplete,
}: UseNewProjectSubmitOptions) {
  const createProjectMutation = useCreateProjectMutation();
  const { refetch: validateDirectory } = useFileSystemBrowseQuery(
    normalizedDirectory || undefined,
    { enabled: false },
  );
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(
    null,
  );
  const [applyingStarter, setApplyingStarter] = useState(false);
  const [checkingDirectory, setCheckingDirectory] = useState(false);
  const [checkingSlug, setCheckingSlug] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectedDirectory, setRejectedDirectory] =
    useState<RejectedDirectory | null>(null);
  const [rejectedSlug, setRejectedSlug] = useState<RejectedSlug | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setCreatedProject(null);
      setApplyingStarter(false);
      setCheckingDirectory(false);
      setCheckingSlug(false);
      setError(null);
      setRejectedDirectory(null);
      setRejectedSlug(null);
    }
  }, [isOpen]);

  /**
   * 4-HOME-008. Returns the message to show against the Working Directory
   * field, or `null` when the folder was confirmed to exist.
   *
   * Every branch answers with a sentence. The old code did
   * `if (result.error) throw result.error`, which left two silent exits — a
   * settled query with neither data nor an error, and an `error` that was not
   * an `Error` — and submitting a nonexistent folder produced no POST, no
   * message, and no field state at all.
   */
  async function checkDirectory(): Promise<{
    message: string;
    verdict: boolean;
  } | null> {
    const result = await validateDirectory();
    if (result.error) {
      // `requestFileSystemBrowse` stamps the HTTP status on a server-refused
      // browse; a transport failure carries none. Only a 4xx is the server's
      // verdict ABOUT THE PATH — a 5xx or status-less failure is a check
      // that did not happen (see `RejectedDirectory`).
      const status = (result.error as { status?: unknown }).status;
      return {
        message:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
        verdict: typeof status === 'number' && status >= 400 && status < 500,
      };
    }
    if (result.data !== undefined) return null;
    // Neither an answer nor a reason: say exactly that rather than claim the
    // folder is missing (or, as before, say nothing).
    return {
      message: 'Station could not check this folder. Try again.',
      verdict: false,
    };
  }

  async function submit(event: FormEvent, draft: ProjectDraft) {
    event.preventDefault();
    setError(null);
    try {
      let project = createdProject;
      if (!project) {
        if (normalizedDirectory) {
          setCheckingDirectory(true);
          const directoryProblem = await checkDirectory().finally(() =>
            setCheckingDirectory(false),
          );
          if (directoryProblem) {
            setRejectedDirectory({
              path: normalizedDirectory,
              ...directoryProblem,
            });
            return;
          }
          setRejectedDirectory(null);
        }

        if (verifySlugAvailability) {
          setCheckingSlug(true);
          const slugProblem = await verifySlugAvailability(draft).finally(() =>
            setCheckingSlug(false),
          );
          if (slugProblem) {
            setRejectedSlug({ slug: draft.slug, message: slugProblem });
            return;
          }
          setRejectedSlug(null);
        }

        const created = await createProjectMutation.mutateAsync(draft);
        // Retained with the created identity so a retry applies the SAME
        // starter this attempt chose, even if the picker moves underneath.
        project = { slug: created.slug, layoutId: starterLayoutId };
        setCreatedProject(project);
      }

      if (project.layoutId) {
        setApplyingStarter(true);
        try {
          await applyProjectLayout(apiBase, project.slug, project.layoutId);
          trackRecentLayout(project.layoutId);
        } finally {
          setApplyingStarter(false);
        }
      }

      onComplete(project.slug);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    hasCreatedProject: createdProject !== null,
    error,
    /**
     * The folder this submission PROVED inaccessible (a server 4xx verdict),
     * and what to say about it. Read as a field error only while the typed
     * directory is still that same path — editing the field makes the
     * verdict stale, and a stale verdict must not keep Create disabled.
     */
    directoryError:
      rejectedDirectory?.verdict &&
      rejectedDirectory.path === normalizedDirectory
        ? rejectedDirectory.message
        : null,
    /**
     * A check that failed to HAPPEN for the still-current path. Rendered in
     * the same field slot, but it must never disable Create — "Try again."
     * with the retry control disabled is the #765 click-eater. Clicking
     * Create re-runs the check.
     */
    directoryNotice:
      rejectedDirectory &&
      !rejectedDirectory.verdict &&
      rejectedDirectory.path === normalizedDirectory
        ? rejectedDirectory.message
        : null,
    /**
     * A duplicate refusal that a REFRESHED project list actually supported,
     * scoped to the slug it was made about — editing the name makes it stale,
     * and a stale refusal must not keep Create disabled.
     */
    slugError:
      rejectedSlug && rejectedSlug.slug === derivedSlug
        ? rejectedSlug.message
        : null,
    submit,
    submitting:
      createProjectMutation.isPending ||
      applyingStarter ||
      checkingDirectory ||
      checkingSlug,
  };
}
