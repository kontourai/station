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
  | {
      kind: 'current';
      pullRequest: PullRequest;
      /** When the forge was read, when the provider reports it (cached). */
      observedAt?: string;
    }
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
  /**
   * `status`: the narrow, shared read a status surface needs, where the
   * provider offers one (`getPullRequestStatusByIdentity`); otherwise the
   * full read.
   */
  options: { status?: true } = {},
): Promise<PullRequestIdentityRead> {
  const provider = providers().find(
    (candidate) =>
      candidate.id === identity.provider &&
      candidate.canServeHost(identity.host),
  );
  const read =
    (options.status &&
      provider?.getPullRequestStatusByIdentity?.bind(provider)) ||
    provider?.getPullRequestByIdentity?.bind(provider);
  if (!read) return { kind: 'unsupported' };
  try {
    const result = await read(
      { host: identity.host, repository: identity.repository },
      identity.ref,
    );
    return result.available && result.data
      ? {
          kind: 'current',
          pullRequest: result.data,
          ...('observedAt' in result && typeof result.observedAt === 'string'
            ? { observedAt: result.observedAt }
            : {}),
        }
      : {
          kind: 'unavailable',
          thrown: false,
          ...(result.reason ? { reason: result.reason } : {}),
        };
  } catch {
    return { kind: 'unavailable', thrown: true };
  }
}
