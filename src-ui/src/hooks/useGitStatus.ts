import { useGitLogQuery, useGitStatusQuery } from '@kontourai/station-sdk';

/**
 * #2412: git reads name the Project they read in, and the server refuses a
 * folder outside it. Either value missing means no read.
 */
function gitReadLocation(
  projectSlug: string | null | undefined,
  workingDirectory: string | null | undefined,
) {
  return projectSlug && workingDirectory
    ? { projectSlug, workingDir: workingDirectory }
    : null;
}

export function useGitStatus(
  projectSlug: string | null | undefined,
  workingDirectory: string | null | undefined,
) {
  return useGitStatusQuery(gitReadLocation(projectSlug, workingDirectory));
}

export function useGitLog(
  projectSlug: string | null | undefined,
  workingDirectory: string | null | undefined,
  count = 5,
) {
  return useGitLogQuery(gitReadLocation(projectSlug, workingDirectory), count);
}
