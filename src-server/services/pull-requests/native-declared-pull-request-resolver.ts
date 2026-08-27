/** Exact, authenticated point-read seam for native declared PR outputs. */
import type {
  IPullRequestProvider,
  PullRequest,
} from '@kontourai/station-contracts/pull-request-provider';
import type { DeclaredOutputDescriptor } from '@kontourai/station-contracts/session-output-declaration';
import type { NativeOutputCallFacts } from '../../runtime/native-output-turn-grant.js';
import { PullRequestRepositoryContextResolver } from './pull-request-repository-context-resolver.js';

type DeclaredPullRequest = Extract<
  DeclaredOutputDescriptor,
  { kind: 'pull-request' }
>;
type NativeDeclaredPullRequestProvider = Pick<
  IPullRequestProvider,
  'id' | 'canServeHost' | 'getHost' | 'getPullRequestByIdentity'
>;

/**
 * This is intentionally an injected private operation, not an HTTP route.
 * The caller already holds the native-call lease; this seam makes one exact
 * provider detail read and returns identity only, discarding body/preview data.
 */
export class NativeDeclaredPullRequestResolver {
  constructor(
    private readonly deps: {
      providers: () => NativeDeclaredPullRequestProvider[];
      contexts?: Pick<
        PullRequestRepositoryContextResolver,
        'readExactIdentity'
      >;
    },
  ) {}

  async read(input: {
    provider: string;
    host: string;
    owner: string;
    repository: string;
    ref: string;
    nativeId: string;
    facts: NativeOutputCallFacts;
  }): Promise<DeclaredPullRequest | null> {
    if (!input.facts.workspaceRoot) return null;
    // `workspaceRoot` is minted by orchestration from the live Session, not a
    // model argument. The active native lease is rechecked by the declaration
    // operation after this await before any handle is reserved.
    return this.readCurrent({
      provider: input.provider,
      host: input.host,
      owner: input.owner,
      repository: input.repository,
      ref: input.ref,
      nativeId: input.nativeId,
      workingDirectory: input.facts.workspaceRoot,
    });
  }

  /**
   * Re-authorize one kept PR at the exact owner identity. This intentionally
   * returns only the declared identity: title, body, URL, branch, and any
   * provider preview are not retention data.
   */
  async readCurrent(input: {
    provider: string;
    host: string;
    owner: string;
    repository: string;
    ref: string;
    nativeId: string;
    workingDirectory: string;
  }): Promise<DeclaredPullRequest | null> {
    const contexts =
      this.deps.contexts ?? new PullRequestRepositoryContextResolver();
    const resolved = await contexts.readExactIdentity(
      // Not expanded here: `resolveExactIdentity`
      // (pull-request-repository-context-resolver.ts) does
      // `realpathSync(resolve(expandTilde(...)))` itself before it touches
      // the filesystem. Both callers of this method also already pass an
      // expanded value — `NativeOutputCallFacts.workspaceRoot` (read()
      // above) and the Session `.cwd` passed by
      // session-outputs-module.ts's `keep()` both trace back to
      // `resolve(expandTilde(...))` at session-start cwd resolution
      // (orchestration-service.ts, `resolveStartSessionCwd`) — so this is
      // belt-and-suspenders either way.
      { workingDirectory: input.workingDirectory },
      async (context) => {
        if (
          context.host !== input.host ||
          context.repository.owner !== input.owner ||
          context.repository.name !== input.repository
        )
          return undefined;
        const provider = this.deps
          .providers()
          .find(
            (candidate) =>
              candidate.id === input.provider &&
              candidate.canServeHost(input.host) &&
              typeof candidate.getPullRequestByIdentity === 'function',
          );
        if (!provider?.getPullRequestByIdentity) return undefined;
        const result = await provider.getPullRequestByIdentity(
          context,
          input.ref,
        );
        return result.available ? result.data : undefined;
      },
    );
    if (!resolved.available) return null;
    const detail = resolved.value;
    return exactDeclaredIdentity(detail, input)
      ? {
          kind: 'pull-request',
          provider: detail.provider,
          host: detail.host,
          repository: { ...detail.repository },
          ref: detail.ref,
          nativeId: detail.nativeId,
        }
      : null;
  }
}

function exactDeclaredIdentity(
  detail: PullRequest | undefined,
  requested: {
    provider: string;
    host: string;
    owner: string;
    repository: string;
    ref: string;
    nativeId: string;
  },
): detail is PullRequest {
  return Boolean(
    detail &&
      detail.provider === requested.provider &&
      detail.host === requested.host &&
      detail.repository.owner === requested.owner &&
      detail.repository.name === requested.repository &&
      detail.ref === requested.ref &&
      detail.nativeId === requested.nativeId,
  );
}
