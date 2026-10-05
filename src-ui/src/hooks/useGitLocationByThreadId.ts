import {
  type GitReadLocation,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';

/**
 * Where an inbox row's hover card reads its git facts: the local session's
 * working directory and its Project, keyed by orchestration thread id. The
 * ONE derivation — the dock's inbox, its mobile task switcher and Home's work
 * rows all read it, so a row shows the same branch wherever it appears.
 *
 * Only local sessions have a working directory worth answering:
 * `useOrchestrationSessionsQuery` never carries remote environments'
 * sessions, so a remote row resolves nothing. #2412: a git read names its
 * Project, so only a session bound to one gets a git section; an unbound
 * chat's folder is not read.
 *
 * Referentially stable while the query's data is, which the dock panel's
 * `memo()` wrap relies on.
 */
export function useGitLocationByThreadId(): ReadonlyMap<
  string,
  GitReadLocation
> {
  const { data: sessions } = useOrchestrationSessionsQuery();
  return useMemo(
    () =>
      new Map(
        (sessions ?? [])
          .filter((session) => !!session.cwd && !!session.projectSlug)
          .map((session) => [
            session.threadId,
            {
              projectSlug: session.projectSlug as string,
              workingDir: session.cwd as string,
            },
          ]),
      ),
    [sessions],
  );
}
