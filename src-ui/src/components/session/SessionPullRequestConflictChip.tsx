import type {
  OrchestrationSessionSummary,
  PullRequestBranchMergeability,
  PullRequestResult,
} from '@kontourai/station-sdk';
import {
  usePullRequestContextQuery,
  usePullRequestMergeabilityQuery,
} from '@kontourai/station-sdk';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

/**
 * Conflicts change on the forge's schedule, not this client's; two minutes
 * keeps the indicator honest without spending the operator's forge quota
 * (#2937). A return to the window refetches an answer older than this, and
 * TanStack skips interval fetches while the document is hidden.
 */
export const OBSERVATION_INTERVAL_MS = 120_000;

const observed = {
  refetchInterval: OBSERVATION_INTERVAL_MS,
  refetchOnWindowFocus: true,
  staleTime: OBSERVATION_INTERVAL_MS,
};

interface RepositoryObservation {
  project: string;
  provider: string;
  host: string;
  owner: string;
  name: string;
}

type RegisterObservation = (observation: RepositoryObservation) => () => void;

const ObservationRegistry = createContext<RegisterObservation | null>(null);

/**
 * The one polling observer of a repository's branch mergeability. Chips of
 * the same repository read its cache entry without observing it themselves:
 * TanStack runs one interval timer per observer, so a poller per row would
 * still fetch once per row per interval.
 */
function RepositoryMergeabilityPoller(observation: RepositoryObservation) {
  usePullRequestMergeabilityQuery(
    observation.provider,
    observation.host,
    observation.owner,
    observation.name,
    observation.project,
    observed,
  );
  return null;
}

/**
 * Observes each repository the rows below it name once, however many rows
 * name it (#2937).
 */
export function SessionPullRequestObservationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [repositories, setRepositories] = useState<
    ReadonlyMap<string, { observation: RepositoryObservation; rows: number }>
  >(() => new Map());
  const register = useCallback<RegisterObservation>((observation) => {
    const key = JSON.stringify([
      observation.project,
      observation.provider,
      observation.host,
      observation.owner,
      observation.name,
    ]);
    setRepositories((previous) => {
      const next = new Map(previous);
      next.set(key, { observation, rows: (previous.get(key)?.rows ?? 0) + 1 });
      return next;
    });
    return () =>
      setRepositories((previous) => {
        const entry = previous.get(key);
        if (!entry) return previous;
        const next = new Map(previous);
        if (entry.rows <= 1) next.delete(key);
        else next.set(key, { ...entry, rows: entry.rows - 1 });
        return next;
      });
  }, []);
  return (
    <ObservationRegistry.Provider value={register}>
      {children}
      {[...repositories].map(([key, { observation }]) => (
        <RepositoryMergeabilityPoller key={key} {...observation} />
      ))}
    </ObservationRegistry.Provider>
  );
}

/**
 * A live forge observation for one session's recorded worktree. The chip is
 * intentionally absent until both the checkout context and the mergeability
 * answer are available: an old creation-time value would be a false claim.
 */
export function SessionPullRequestConflictChip({
  session,
}: {
  session: OrchestrationSessionSummary;
}) {
  const register = useContext(ObservationRegistry);
  const project = session.projectSlug ?? '';
  const context = usePullRequestContextQuery(
    { project, thread: session.threadId },
    { ...observed, enabled: Boolean(session.projectSlug) },
  );
  const identity = context.data?.available ? context.data : undefined;
  const observable = Boolean(identity);
  const provider = identity?.provider ?? '';
  const host = identity?.host ?? '';
  const owner = identity?.repository.owner ?? '';
  const name = identity?.repository.name ?? '';
  useEffect(() => {
    if (!register || !observable) return;
    return register({ project, provider, host, owner, name });
  }, [register, observable, project, provider, host, owner, name]);
  // Inside a provider the chip only reads the shared entry; outside one it is
  // its own repository's poller.
  const mergeability = usePullRequestMergeabilityQuery(
    provider,
    host,
    owner,
    name,
    project,
    register ? { enabled: false } : { ...observed, enabled: observable },
  );
  const result = mergeability.data as
    | PullRequestResult<PullRequestBranchMergeability[]>
    | undefined;
  const isConflicted =
    result?.available === true &&
    result.data?.some(
      (pullRequest) =>
        pullRequest.sourceBranch === identity?.branch &&
        pullRequest.mergeability === 'conflicting',
    );

  if (!isConflicted) return null;
  return (
    <span
      className="session-pr-conflict-chip"
      title="The pull request for this session's branch has conflicts"
    >
      PR conflict
    </span>
  );
}
