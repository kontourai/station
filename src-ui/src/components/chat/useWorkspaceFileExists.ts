import {
  listExistingProjectWorkspaceFiles,
  WORKSPACE_FILE_EXISTENCE_MAX_PATHS,
} from '@kontourai/station-sdk/workspace-file-preview';
import { useQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

interface PendingBatch {
  scope: Scope;
  projectSlug: string;
  thread: string | undefined;
  waiters: Map<string, ((exists: boolean) => void)[]>;
  rejecters: ((error: unknown) => void)[];
}

/**
 * One request per project per tick, however many path mentions a transcript
 * renders: every mention asks through its own query (so the cache, retries and
 * authority partitioning are React Query's), and the queries' fetchers meet
 * here and share a request. Exported for tests.
 */
export const workspaceFileExistenceBatcher = (() => {
  const pending = new Map<string, PendingBatch>();

  async function flush(key: string) {
    const batch = pending.get(key);
    pending.delete(key);
    if (!batch) return;
    const paths = [...batch.waiters.keys()];
    const found = new Set<string>();
    try {
      for (
        let offset = 0;
        offset < paths.length;
        offset += WORKSPACE_FILE_EXISTENCE_MAX_PATHS
      ) {
        const chunk = paths.slice(
          offset,
          offset + WORKSPACE_FILE_EXISTENCE_MAX_PATHS,
        );
        const answer = await listExistingProjectWorkspaceFiles(
          batch.scope.apiBase,
          batch.projectSlug,
          chunk,
          { requestScope: batch.scope },
          batch.thread,
        );
        for (const file of answer.files) found.add(file);
      }
    } catch (error) {
      for (const reject of batch.rejecters) reject(error);
      return;
    }
    for (const [path, resolvers] of batch.waiters)
      for (const resolve of resolvers) resolve(found.has(path));
  }

  return {
    exists(
      scope: Scope,
      projectSlug: string,
      path: string,
      thread?: string,
    ): Promise<boolean> {
      const key = JSON.stringify([
        scope.apiBase,
        scope.authorityKey,
        projectSlug,
        thread ?? null,
      ]);
      let batch = pending.get(key);
      if (!batch) {
        batch = {
          scope,
          projectSlug,
          thread,
          waiters: new Map(),
          rejecters: [],
        };
        pending.set(key, batch);
        setTimeout(() => void flush(key), 0);
      }
      const current = batch;
      return new Promise<boolean>((resolve, reject) => {
        const resolvers = current.waiters.get(path) ?? [];
        resolvers.push(resolve);
        current.waiters.set(path, resolvers);
        current.rejecters.push(reject);
      });
    },
  };
})();

/**
 * Whether `path` is a previewable file in `projectSlug`'s checkout: `true`,
 * `false`, or `undefined` while unknown (no project, no current authority, the
 * answer in flight, or the check failed). Only `true` makes a path mention a
 * link — an unknown is not evidence the file is there.
 */
export function useWorkspaceFileExists(
  projectSlug: string | null,
  path: string | null,
  thread?: string | null,
): boolean | undefined {
  const scope = useHostRequestAuthorityScope();
  const enabled = !!scope?.isCurrent() && !!projectSlug && !!path;
  const query = useQuery({
    queryKey: [
      'workspace-file-exists',
      scope?.apiBase,
      scope?.authorityKey,
      projectSlug,
      thread ?? null,
      path,
    ],
    queryFn: () =>
      workspaceFileExistenceBatcher.exists(
        scope!,
        projectSlug!,
        path!,
        thread ?? undefined,
      ),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return enabled ? query.data : undefined;
}
