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

  // Each case changes exactly one field of an otherwise exact match, so a
  // dropped check cannot hide behind another one.
  test.each([
    ['repository substitution', { owner: 'attacker', nativeId: '44' }],
    ['a changed native id', { owner: 'kontourai', nativeId: 'changed' }],
  ])('refuses %s', async (_case, { owner, nativeId }) => {
    const { resolver: subject } = resolver(
      pullRequest({
        provider: 'github',
        host: 'github.com',
        repository: { owner, name: 'station' },
        ref: '44',
        nativeId,
      }),
    );
    await expect(subject.read(request)).resolves.toBeNull();
  });
});

// #3161: the same exact read for a caller that names a pull request by the
// link store's identity and has no provider-native id.
describe('NativeDeclaredPullRequestResolver.readIdentity', () => {
  const named = {
    provider: 'github',
    host: 'github.com',
    owner: 'kontourai',
    repository: 'station',
    ref: '44',
    workingDirectory: '/workspace',
  };
  const exact = pullRequest({
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'kontourai', name: 'station' },
    ref: '44',
    nativeId: '9044',
  });

  test('returns the provider-observed identity, native id included', async () => {
    const { resolver: subject } = resolver(exact);
    await expect(subject.readIdentity(named)).resolves.toEqual({
      kind: 'pull-request',
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
      ref: '44',
      nativeId: '9044',
    });
  });

  test('names differing only in case are the same repository; the provider casing is returned', async () => {
    const { resolver: subject } = resolver(exact);
    await expect(
      subject.readIdentity({
        ...named,
        owner: 'Kontourai',
        repository: 'STATION',
      }),
    ).resolves.toMatchObject({
      repository: { owner: 'kontourai', name: 'station' },
    });
  });

  // The native declaration tool keeps its exact comparison.
  test('the native read stays exact about case', async () => {
    const { resolver: subject } = resolver(exact);
    await expect(
      subject.read({ ...request, owner: 'Kontourai', nativeId: '9044' }),
    ).resolves.toBeNull();
  });

  // `station-2` is not `station`: the workspace's repository is compared as
  // its own owner and name, so a longer name sharing a prefix is refused
  // before any provider is asked.
  test.each([
    [
      'a repository whose name extends the workspace repository',
      { repository: 'station-2' },
    ],
    [
      'a repository whose name is a prefix of the workspace repository',
      { repository: 'stat' },
    ],
    ['another owner', { owner: 'kontourai-2' }],
  ])('refuses %s without reading the provider', async (_case, change) => {
    const { resolver: subject, getPullRequestByIdentity } = resolver(exact);
    await expect(
      subject.readIdentity({ ...named, ...change }),
    ).resolves.toBeNull();
    expect(getPullRequestByIdentity).not.toHaveBeenCalled();
  });

  // The provider's own answer is checked too: each case changes one field.
  test.each([
    ['another pull request number', { ref: '45' }],
    [
      'another repository',
      { repository: { owner: 'kontourai', name: 'station-2' } },
    ],
    ['another provider', { provider: 'gitlab' }],
  ])('refuses a provider answer for %s', async (_case, change) => {
    const { resolver: subject } = resolver({ ...exact, ...change });
    await expect(subject.readIdentity(named)).resolves.toBeNull();
  });
});
