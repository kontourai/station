import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import { describe, expect, test, vi } from 'vitest';
import { NativeDeclaredPullRequestResolver } from '../native-declared-pull-request-resolver.js';

const facts = {
  threadId: 'session-a',
  turnId: 'turn-a',
  callId: 'call-a',
  adapterId: 'station-agent',
  configurationLease: {},
  workspaceRoot: '/workspace',
  principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
} satisfies Parameters<NativeDeclaredPullRequestResolver['read']>[0]['facts'];
const request = {
  provider: 'github',
  host: 'github.com',
  owner: 'kontourai',
  repository: 'station',
  ref: '44',
  nativeId: '44',
  facts,
} satisfies Parameters<NativeDeclaredPullRequestResolver['read']>[0];

const result = (data: PullRequest): PullRequestResult<PullRequest> => ({
  available: true,
  data,
  effectiveCapabilities: {
    list: true,
    detail: true,
    open: false,
    comment: false,
    approve: false,
    merge: false,
    autoMerge: false,
  },
  effectiveMergeMethods: [],
  mergeMethodsSource: 'provider-default',
});

const pullRequest = (
  detail: Pick<
    PullRequest,
    'provider' | 'host' | 'repository' | 'ref' | 'nativeId'
  > &
    Partial<PullRequest>,
): PullRequest => ({
  url: 'https://github.com/kontourai/station/pull/44',
  title: 'Title',
  body: null,
  state: 'open',
  author: { login: 'owner-a' },
  sourceBranch: 'feature',
  targetBranch: 'main',
  commits: 1,
  reviewStatus: 'pending',
  comments: 0,
  mergeability: 'unknown',
  ...detail,
});

function resolver(detail: PullRequest) {
  const getPullRequestByIdentity = vi.fn(async () => result(detail));
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    getHost: () => 'github.com',
    getPullRequestByIdentity,
  } satisfies Pick<
    IPullRequestProvider,
    'id' | 'canServeHost' | 'getHost' | 'getPullRequestByIdentity'
  >;
  const identity: PullRequestRepositoryIdentityContext = {
    host: 'github.com',
    repository: { owner: 'kontourai', name: 'station' },
  };
  const contexts = {
    readExactIdentity: async <T>(
      _input: { workingDirectory?: string },
      read: (
        publicIdentity: PullRequestRepositoryIdentityContext,
      ) => Promise<T>,
    ) => ({
      available: true as const,
      identity,
      value: await read(identity),
    }),
  } satisfies Pick<
    import('../pull-request-repository-context-resolver.js').PullRequestRepositoryContextResolver,
    'readExactIdentity'
  >;
  return {
    resolver: new NativeDeclaredPullRequestResolver({
      providers: () => [provider],
      contexts,
    }),
    getPullRequestByIdentity,
  };
}

describe('NativeDeclaredPullRequestResolver', () => {
  test('performs one exact identity point read and discards protected body data', async () => {
    const { resolver: subject, getPullRequestByIdentity } = resolver(
      pullRequest({
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: '44',
        nativeId: '44',
        body: 'never persisted',
        title: 'also not persisted',
      }),
    );
    await expect(subject.read(request)).resolves.toEqual({
      kind: 'pull-request',
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      ref: '44',
      nativeId: '44',
    });
    expect(getPullRequestByIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'github.com' }),
      '44',
    );
  });

  test('refuses repository substitution or a changed native id', async () => {
    const { resolver: subject } = resolver(
      pullRequest({
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'attacker', name: 'station' },
        ref: '44',
        nativeId: 'changed',
      }),
    );
    await expect(subject.read(request)).resolves.toBeNull();
  });
});
