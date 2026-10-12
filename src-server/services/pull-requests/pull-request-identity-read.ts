import type {
  IPullRequestProvider,
  PullRequest,
} from '@kontourai/station-contracts/pull-request-provider';

/** A pull request as a person or tool names it: the link store's identity. */
interface PullRequestIdentityQuery {
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
}

type PullRequestIdentityRead =
  | { kind: 'current'; pullRequest: PullRequest }
  | { kind: 'unsupported' }
  /** `thrown`: the provider call failed outright, rather than answering no. */
  | { kind: 'unavailable'; thrown: boolean; reason?: string };

/**
 * The one provider read of an explicitly named pull request. The
 * conversation link refresh and the Task close-out both go through it, so
 * "what state is this pull request in" has a single answer to ask for.
 * It reads exactly the identity it is given and never searches by branch.
 */
export async function readPullRequestByIdentity(
  providers: () => IPullRequestProvider[],
  identity: PullRequestIdentityQuery,
): Promise<PullRequestIdentityRead> {
  const provider = providers().find(
    (candidate) =>
      candidate.id === identity.provider &&
      candidate.canServeHost(identity.host),
  );
  if (!provider?.getPullRequestByIdentity) return { kind: 'unsupported' };
  try {
    const result = await provider.getPullRequestByIdentity(
      { host: identity.host, repository: identity.repository },
      identity.ref,
    );
    return result.available && result.data
      ? { kind: 'current', pullRequest: result.data }
      : {
          kind: 'unavailable',
          thrown: false,
          ...(result.reason ? { reason: result.reason } : {}),
        };
  } catch {
    return { kind: 'unavailable', thrown: true };
  }
}
