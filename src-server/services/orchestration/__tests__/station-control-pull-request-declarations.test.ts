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
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { NativeDeclaredPullRequestResolver } from '../../pull-requests/native-declared-pull-request-resolver.js';
import type { PullRequestRepositoryContextResolver } from '../../pull-requests/pull-request-repository-context-resolver.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  createStationControlPullRequestDeclarations,
  StationControlPullRequestUnavailableError,
} from '../station-control-pull-request-declarations.js';

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

const harnesses: {
  service: OrchestrationService;
  store: EventStore;
  engineEvents: AsyncEventQueue<CanonicalRuntimeEvent>;
}[] = [];

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
  const engineEvents = new AsyncEventQueue<CanonicalRuntimeEvent>();
  const adapter = {
    provider: 'codex',
    metadata: { displayName: 'Codex' },
    stopAll: async () => {},
    hasSession: async () => true,
    stopSession: async () => {},
    // Station reads an engine's events from `streamEvents`; the test
    // publishes the turn's events itself, so this one has none to say.
    streamEvents: (options?: { signal?: AbortSignal }) =>
      engineEvents.iterable(options),
    interruptTurn: async () => ({
      outcome: 'cancelled' as const,
      turnId: 'turn-1',
    }),
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
    engineEvents,
    getPullRequestByIdentity,
    startTurn: (turnId: string) =>
      emit({ method: 'turn.started', turnId, prompt: 'open a pull request' }),
    completeTurn: (turnId: string) =>
      emit({ method: 'turn.completed', turnId, finishReason: 'stop' }),
    exitSession: () =>
      emit({ method: 'session.exited', sessionId: THREAD, exitCode: 1 }),
    runtimeError: (turnId: string, retriable: boolean) =>
      emit({
        method: 'runtime.error',
        turnId,
        severity: 'error',
        message: 'engine error',
        retriable,
      }),
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
    made.engineEvents.close();
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

  // An external engine goes on working long after it declares: waiting on CI,
  // answering review. The native engine's 60 second wait does not apply.
  test('a declaration waits for its turn, not for 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = harness();
      h.startTurn('turn-1');
      await h.declare(named('station', '44'));
      vi.setSystemTime(Date.now() + 30 * 60_000);
      // Still pending, so still a repeat rather than a silent second chance.
      await expect(h.declare(named('station', '44'))).resolves.toBe(
        'already-declared',
      );
      h.completeTurn('turn-1');
      expect(h.declared().map((row) => (row.descriptor as any).ref)).toEqual([
        '44',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Owner and repository names are case-insensitive at the forge.
  test('Owner/Station names the workspace repository kontourai/station', async () => {
    const h = harness();
    h.startTurn('turn-1');
    const written = { ...named('Station', '44'), owner: 'Kontourai' };
    await expect(h.declare(written)).resolves.toBe('declared');
    await expect(h.declare(named('station', '44'))).resolves.toBe(
      'already-declared',
    );
    h.completeTurn('turn-1');
    // The provider's own casing is what is recorded.
    expect(h.declared()[0]?.descriptor).toMatchObject({
      repository: { owner: 'kontourai', name: 'station' },
    });
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

  test('an aborted turn records nothing, even if the engine then completes that same turn', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.abortTurn('turn-1');
    expect(h.declared()).toEqual([]);
    // The engine's late completion of the aborted turn admits nothing...
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
    // ...and a later turn is not admitted for the aborted one's declaration.
    h.startTurn('turn-2');
    h.completeTurn('turn-2');
    expect(h.declared()).toEqual([]);
  });

  // The lease follows the running turn. A turn another turn has superseded
  // (its terminal arrives late, after the engine started the next) is no
  // longer the live one, whatever its adapter still says.
  test('a declaration from a turn that is no longer the running one is not admitted', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.startTurn('turn-2');
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  // A terminal retires the turn's grant. The authority holds at most 256
  // live grants, so a grant left behind by every turn would end declaring
  // after 256 turns.
  test('each terminal releases its turn: 260 turns in a row can each declare', async () => {
    const h = harness();
    for (let turn = 1; turn <= 260; turn += 1) {
      FORGE.add(`kontourai/station#${1000 + turn}`);
      h.startTurn(`turn-${turn}`);
      await expect(
        h.declare(named('station', String(1000 + turn))),
      ).resolves.toBe('declared');
      h.completeTurn(`turn-${turn}`);
    }
    const row = (h.store as any).db
      .prepare('SELECT COUNT(*) AS n FROM orchestration_declared_outputs')
      .get() as { n: number };
    expect(row.n).toBe(260);
  }, 120_000);

  // The interrupt command revokes the running turn's declarations, as it
  // revokes a native turn's grants. The engine acknowledges the stop, and
  // then (as some do) completes the turn anyway.
  test('the interrupt command revokes the turn: a late completion records nothing', async () => {
    const h = harness();
    (h.service as any).threadProviders.set(THREAD, 'codex');
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    const stopped = await h.service.dispatch({
      type: 'interruptTurn',
      threadId: THREAD,
    } as never);
    expect(stopped).toMatchObject({ outcome: 'cooperative' });
    // A declaration made after the stop is refused...
    await expect(h.declare(named('station', '45'))).rejects.toBeInstanceOf(
      StationControlPullRequestUnavailableError,
    );
    // ...and the engine completing the turn anyway admits neither.
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  // Codex reports a transient failure as a deferred-retriable error and goes
  // on to complete the same turn. The turn is still live; a declaration made
  // in it was reported `declared` and must land.
  test('a deferred-retriable engine error does not drop a declaration: the retried turn completes', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.runtimeError('turn-1', true);
    h.completeTurn('turn-1');
    expect(h.declared().map((row) => (row.descriptor as any).ref)).toEqual([
      '44',
    ]);
  });

  test('a non-retriable engine error ends the turn, and the declaration with it', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    h.runtimeError('turn-1', false);
    h.completeTurn('turn-1');
    expect(h.declared()).toEqual([]);
  });

  // An engine that exits mid-turn ends with `session.exited` and no turn
  // terminal. The authority admits 256 live grants service-wide.
  test('an engine exiting mid-turn releases its grant: 260 turns that end in an exit can each declare', async () => {
    const h = harness();
    for (let turn = 1; turn <= 260; turn += 1) {
      FORGE.add(`kontourai/station#${2000 + turn}`);
      h.startTurn(`turn-${turn}`);
      await expect(
        h.declare(named('station', String(2000 + turn))),
      ).resolves.toBe('declared');
      h.exitSession();
    }
  }, 120_000);

  test('session.exited retires the session at the retirement boundary', async () => {
    const h = harness();
    h.startTurn('turn-1');
    await h.declare(named('station', '44'));
    const retire = vi.spyOn(
      (h.service as any).stationControlPullRequests,
      'retireSession',
    );
    h.exitSession();
    expect(retire).toHaveBeenCalledWith(THREAD);
    // Nothing the exited turn declared lands if a late completion arrives.
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

// The sweep, on its own: turns whose lease has failed with no terminal and no
// retirement call (an adapter replaced, a thread quarantined) must not hold
// the authority's 256 grants.
describe('declaration grants of turns that are no longer live', () => {
  test('260 turns whose lease failed without any retirement can each declare', async () => {
    let issued = 0;
    const current = new Set<number>();
    const descriptor = (ref: string) => ({
      kind: 'pull-request' as const,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'o', name: 'r' },
      ref,
      nativeId: ref,
    });
    const declarations = createStationControlPullRequestDeclarations({
      activeTurn: () => {
        if (current.size === 0) {
          issued += 1;
          current.add(issued);
        }
        const mine = [...current][0]!;
        return {
          turnId: `turn-${mine}`,
          adapterId: 'codex',
          isCurrent: () => current.has(mine),
        };
      },
      workspaceRoot: () => '/workspace',
      declaredPullRequests: () => [],
      resolver: {
        read: async (input) => descriptor(input.ref),
        readIdentity: async (input) => descriptor(input.ref),
      },
    });
    for (let turn = 1; turn <= 260; turn += 1) {
      await expect(
        declarations.declare({
          sessionId: 'session-x',
          pullRequest: {
            provider: 'github',
            host: 'github.com',
            owner: 'o',
            repository: 'r',
            ref: String(turn),
          },
        }),
      ).resolves.toBe('declared');
      // The turn ends with no terminal and no retirement call.
      current.clear();
    }
    declarations.dispose();
  }, 60_000);
});
