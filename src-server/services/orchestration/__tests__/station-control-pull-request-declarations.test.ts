/**
 * #3161: `declare_pull_request`'s admission, over the REAL orchestration
 * service, event store, grant authority, declaration operation and
 * `NativeDeclaredPullRequestResolver`. Only the forge (a fake provider whose
 * pull requests are listed below), the repository the workspace is (the
 * exact-identity context) and the engine's adapter are stand-ins.
 *
 * The session is an external engine's (provider `codex`): it holds no native
 * output grant, so what admits a declaration is the Station Control
 * authority this suite exercises, and what lands it is the same terminal
 * savepoint a native declaration lands in.
 */
import { join } from 'node:path';
import type {
  IPullRequestProvider,
  PullRequest,
  PullRequestRepositoryIdentityContext,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NativeDeclaredPullRequestResolver } from '../../pull-requests/native-declared-pull-request-resolver.js';
import type { PullRequestRepositoryContextResolver } from '../../pull-requests/pull-request-repository-context-resolver.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { StationControlPullRequestUnavailableError } from '../station-control-pull-request-declarations.js';

const makeTempDir = trackTempDirs();
const THREAD = 'codex-thread';
const AT = '2026-10-04T00:00:00.000Z';

/** Pull requests the fake forge knows, as `owner/name#ref`. */
const FORGE = new Set([
  'kontourai/station#44',
  'kontourai/station#45',
  'kontourai/station-2#44',
]);

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

function forgeProvider() {
  const getPullRequestByIdentity = vi.fn(
    async (
      context: PullRequestRepositoryIdentityContext,
      ref: string,
    ): Promise<PullRequestResult<PullRequest>> => {
      const key = `${context.repository.owner}/${context.repository.name}#${ref}`;
      if (!FORGE.has(key))
        return { available: false, reason: 'not found' } as never;
      return result({
        provider: 'github',
        host: context.host,
        repository: context.repository,
        ref,
        nativeId: `native-${ref}`,
        url: `https://${context.host}/${context.repository.owner}/${context.repository.name}/pull/${ref}`,
        title: 'Title',
        body: 'never persisted',
        state: 'OPEN',
        author: { login: 'someone' },
        sourceBranch: 'feature',
        targetBranch: 'main',
        commits: 1,
        reviewStatus: 'NONE',
        comments: 0,
        mergeability: 'unknown',
      });
    },
  );
  const provider = {
    id: 'github',
    canServeHost: (host: string) => host === 'github.com',
    getHost: () => 'github.com',
    getPullRequestByIdentity,
  } satisfies Pick<
    IPullRequestProvider,
    'id' | 'canServeHost' | 'getHost' | 'getPullRequestByIdentity'
  >;
  return { provider, getPullRequestByIdentity };
}

/** The workspace is the repository `kontourai/station`. */
const contexts = {
  readExactIdentity: async <T>(
    _input: { workingDirectory?: string },
    read: (identity: PullRequestRepositoryIdentityContext) => Promise<T>,
  ) => {
    const identity: PullRequestRepositoryIdentityContext = {
      host: 'github.com',
      repository: { owner: 'kontourai', name: 'station' },
    };
    return { available: true as const, identity, value: await read(identity) };
  },
} satisfies Pick<PullRequestRepositoryContextResolver, 'readExactIdentity'>;

const named = (repository: string, ref: string) => ({
  provider: 'github',
  host: 'github.com',
  owner: 'kontourai',
  repository,
  ref,
});

const harnesses: { service: OrchestrationService; store: EventStore }[] = [];

function harness() {
  const root = makeTempDir('station-control-declare-pr-');
  const workspace = makeTempDir('station-control-declare-pr-workspace-');
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  store.upsertSession({
    provider: 'codex',
    threadId: THREAD,
    status: 'running',
    cwd: workspace,
    createdAt: AT,
    updatedAt: AT,
  });
  const adapter = {
    provider: 'codex',
    metadata: { displayName: 'Codex' },
    stopAll: async () => {},
  };
  const { provider, getPullRequestByIdentity } = forgeProvider();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: (id: string) => (id === 'codex' ? adapter : undefined),
      list: () => [adapter],
    } as never,
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    nativeDeclaredPullRequestResolver: new NativeDeclaredPullRequestResolver({
      providers: () => [provider],
      contexts,
    }),
  });
  const priv = service as any;
  // The engine's adapter is the one the session runs on.
  priv.sessionAdapters.set(THREAD, adapter);
  let eventNumber = 0;
  const emit = (event: Partial<CanonicalRuntimeEvent> & { method: string }) => {
    eventNumber += 1;
    priv.projectAndPublishEvent({
      eventId: `event-${eventNumber}`,
      provider: 'codex',
      threadId: THREAD,
      createdAt: AT,
      ...event,
    });
    return `event-${eventNumber}`;
  };
  const made = {
    service,
    store,
    adapter,
    getPullRequestByIdentity,
    startTurn: (turnId: string) =>
      emit({ method: 'turn.started', turnId, prompt: 'open a pull request' }),
    completeTurn: (turnId: string) =>
      emit({ method: 'turn.completed', turnId, finishReason: 'stop' }),
    abortTurn: (turnId: string) =>
      emit({ method: 'turn.aborted', turnId, reason: 'user' }),
    declared: () =>
      store
        .listDeclaredOutputDescriptors({ threadId: THREAD, limit: 50 })
        .rows.map((row) => ({
          turnId: row.turnId,
          label: row.label,
          descriptor: row.descriptor,
        })),
    declare: (
      pullRequest: ReturnType<typeof named>,
      label?: string,
    ): Promise<string> =>
      service.declareStationControlPullRequest({
        sessionId: THREAD,
        pullRequest,
        ...(label === undefined ? {} : { label }),
      }),
  };
  harnesses.push(made);
  return made;
}

afterEach(async () => {
  for (const made of harnesses.splice(0)) {
    await made.service.shutdown();
    made.store.close();
  }
});

describe('declare_pull_request admission for an external engine session', () => {
  test('declares in the running turn and lands when that turn completes', async () => {
    const h = harness();
    h.startTurn('turn-1');

    await expect(h.declare(named('station', '44'), 'The fix')).resolves.toBe(
      'declared',
    );
    // Waiting, not durable: the declaration lands with the turn's terminal.
    expect(h.declared()).toEqual([]);

    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([
      {
        turnId: 'turn-1',
        label: 'The fix',
        // The provider-observed identity, native id included; none of the
        // pull request's title or body is retained.
        descriptor: {
          kind: 'pull-request',
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'kontourai', name: 'station' },
          ref: '44',
          nativeId: 'native-44',
        },
      },
    ]);
  });

  test('a session that is running no turn answers no-active-turn and records nothing', async () => {
    const h = harness();
    // Never started.
    await expect(h.declare(named('station', '44'))).resolves.toBe(
      'no-active-turn',
    );
    // Started and finished.
    h.startTurn('turn-1');
    h.completeTurn('turn-1');
    await expect(h.declare(named('station', '44'))).resolves.toBe(
      'no-active-turn',
    );
    expect(h.getPullRequestByIdentity).not.toHaveBeenCalled();
    expect(h.declared()).toEqual([]);
  });

  test('a repeat in the same turn is already-declared and records one declaration', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await expect(h.declare(named('station', '44'))).resolves.toBe('declared');
    await expect(h.declare(named('station', '44'))).resolves.toBe(
      'already-declared',
    );
    // Concurrent repeats too: one wins, none doubles.
    await expect(
      Promise.all([
        h.declare(named('station', '45')),
        h.declare(named('station', '45')),
      ]),
    ).resolves.toEqual(['declared', 'already-declared']);
    h.completeTurn('turn-1');
    // Declarations in one terminal are ordered by id, not by call.
    expect(
      h
        .declared()
        .map((row) => (row.descriptor as any).ref)
        .sort(),
    ).toEqual(['44', '45']);
  });

  test('a pull request declared in an earlier turn is already-declared in a later one', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.completeTurn('turn-1');
    h.startTurn('turn-2');
    await expect(h.declare(named('station', '44'))).resolves.toBe(
      'already-declared',
    );
    // A different pull request in the same repository is not a repeat.
    await expect(h.declare(named('station', '45'))).resolves.toBe('declared');
  });

  // The repeat check compares owner, name and number one by one. A name that
  // merely begins with the declared one is a different repository.
  test('owner/repo-2 is not owner/repo', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await expect(h.declare(named('station', '44'))).resolves.toBe('declared');
    h.completeTurn('turn-1');
    h.startTurn('turn-2');
    // The workspace is `station`, so `station-2#44` is refused rather than
    // taken for the pull request already declared...
    await expect(h.declare(named('station-2', '44'))).rejects.toBeInstanceOf(
      StationControlPullRequestUnavailableError,
    );
    // ...and it never reached the forge: the workspace repository was
    // compared first, as owner and name.
    expect(h.getPullRequestByIdentity).toHaveBeenCalledTimes(2);
    expect(
      h.getPullRequestByIdentity.mock.calls.every(
        ([context]) => context.repository.name === 'station',
      ),
    ).toBe(true);
    h.completeTurn('turn-2');
    expect(h.declared()).toHaveLength(1);
  });

  test('a pull request the forge does not know at that identity is refused', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await expect(h.declare(named('station', '999'))).rejects.toBeInstanceOf(
      StationControlPullRequestUnavailableError,
    );
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  test('a turn that is aborted records nothing, even if the engine goes on to complete it', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.abortTurn('turn-1');
    expect(h.declared()).toEqual([]);

    // A later turn is not admitted for the aborted one's declaration.
    h.startTurn('turn-2');
    h.completeTurn('turn-2');
    expect(h.declared()).toEqual([]);
  });

  test('a revoked turn admits nothing more, even if the engine goes on to complete it', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    (h.service as any).stationControlPullRequests.retireSession(THREAD);
    // A declaration made after the revoke is refused...
    await expect(h.declare(named('station', '45'))).rejects.toBeInstanceOf(
      StationControlPullRequestUnavailableError,
    );
    // ...and the engine completing the turn anyway admits neither.
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  test('a session whose adapter was replaced mid-turn records nothing', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    (h.service as any).sessionAdapters.set(THREAD, {
      provider: 'codex',
      metadata: { displayName: 'Codex (replaced)' },
    });
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  test('the declaration appears in the session outputs with no workspace file', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'), 'The fix');
    const eventId = h.completeTurn('turn-1');
    const row = h.store.readDeclaredOutputDescriptor(THREAD, eventId);
    expect(row).toMatchObject({
      eventId,
      threadId: THREAD,
      turnId: 'turn-1',
      label: 'The fix',
    });
    // The call id is server-minted, never an engine's.
    expect(row?.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
