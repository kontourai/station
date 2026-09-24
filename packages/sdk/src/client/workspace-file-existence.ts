import type { WorkspaceFileExistence } from '@kontourai/station-contracts/workspace-file-preview';
import { type ClientRequestOptions, mutateJson } from './http';
import { unwrapProjectResponse as unwrapOrThrow } from './project-response';

/**
 * Which of `paths` the project's preview route would serve as files. POST for
 * the same reason as the preview: paths stay out of URLs and proxy caches.
 *
 * Its own module rather than a sibling in `projects.ts`: that module is in the
 * UI's entry chunk, and a function placed there ships in it even when its only
 * caller is lazy.
 */
export async function listExistingProjectWorkspaceFiles(
  apiBase: string,
  projectSlug: string,
  paths: readonly string[],
  opts?: ClientRequestOptions,
  thread?: string,
): Promise<WorkspaceFileExistence> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/file-preview/exists`,
    'POST',
    { ...opts, readOnly: true },
    thread ? { paths, thread } : { paths },
  );
  return unwrapOrThrow<WorkspaceFileExistence>(
    response,
    'Failed to check file existence',
  );
}
