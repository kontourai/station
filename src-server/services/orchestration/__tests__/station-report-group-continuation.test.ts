import assert from 'node:assert/strict';
import fs, {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {
  flowRunHead,
  flowTransitionRef,
  loadRun,
  startRun,
} from '@kontourai/flow';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { reservedStationSessionRecipient } from '../../../runtime/conversation/reserved-station-turn.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import * as sdkSource from '../delegation-group-sdk-source-wire-owner.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupCustody } from '../station-report-group-custody.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { StationReportRetainedTurns } from '../station-report-retained-turn.js';
import {
  reportTerminalWitnessSchema,
  verifyReportTerminalWitness,
} from '../station-report-terminal-witness.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';

test.each([
  'normal',
  'cleanup-masks-primary',
  'cleanup-after-commit',
  'replace-session-before-turn-retention',
  'interrupt-contention-before-guard',
  'interrupt-response-held',
  'interrupt-target-ended',
  'sdk-body-retirement-failure',
] as const)(
  'returning report sync and paid cancellation keep exact same-Session invocation custody (%s)',
  async (control) => {
    const heldInterrupt =
      control === 'interrupt-response-held' ||
      control === 'interrupt-target-ended';
    const h = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    installControl(h);
    const definition = join(h.f.repo, 'continuation.json');
    writeFileSync(
      definition,
      JSON.stringify({
        id: 'retained-report',
        version: '1',
        execution: { mode: 'multi-cursor', claim_contract_version: '1' },
        steps: [{ id: 'review', next: null, mutable_resources: [] }],
        gates: {
          review: {
            step: 'review',
            on_route_back: { missing_evidence: 'review' },
            route_back_policy: { max_attempts: 1, on_exceeded: 'block' },
            expects: [
              {
                id: 'external',
                kind: 'trust.bundle',
                required: true,
                description: 'A report is not accepted external evidence.',
                bundle_claim: {
                  claimType: 'fixture.external',
                  accepted_statuses: ['assumed'],
                },
              },
            ],
          },
        },
      }),
    );
    writeFileSync(join(h.f.repo, '.gitignore'), '.kontourai/\n');
    await h.f.git('add', 'continuation.json', '.gitignore');
    await h.f.git('commit', '-qm', 'real retained report continuation fixture');
    await startRun(definition, { cwd: h.f.repo, runId: 'retained-report-run' });
    const bus = new EventBus();
    const eventStore = new EventStore(join(h.f.root, 'continuation.sqlite'));
    const logger = { debug() {}, warn() {} };
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('reserved request must not relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://report-control.test',
      hasAgent: () => true,
      eventBus: bus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
      fetch: relay,
    });
    const starts = vi.spyOn(adapter, 'startSession');
    const adapterInterrupts = vi.spyOn(adapter, 'interruptTurn');
    const adapterStops = vi.spyOn(adapter, 'stopSession');
    const orchestration = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore,
      logger,
      personalConversationAccess: {
        canRead: (requesterId, ownerId) =>
          h.f.environment.canSharePersonalConversation(requesterId, ownerId),
        ownerIds: (requesterId) =>
          h.f.environment.personalConversationOwnerIds(requesterId),
      },
      ...(heldInterrupt ? { cooperativeStopBudgetMs: 1000 } : {}),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let releaseFault: { mockRestore(): void } | undefined;
    let refused!: () => void;
    const refusal = new Promise<void>((resolve) => {
      refused = resolve;
    });
    const refusedWires = new Map<object, object>();
    const refuseResponse = sdkSource.refuseSdkResponse;
    const refusalObserver =
      control === 'sdk-body-retirement-failure'
        ? vi
            .spyOn(sdkSource, 'refuseSdkResponse')
            .mockImplementation((owner, handle) => {
              refusedWires.set(handle, owner);
              const result = refuseResponse(owner, handle);
              refused();
              return result;
            })
        : undefined;
    h.rawFetch.mockImplementation(async (_url, options) => {
      const wire = JSON.parse(String(options?.body));
      const prompt = JSON.parse(wire.messages[0].content[0].text);
      const text = Object.hasOwn(prompt, 'context')
        ? prompt.brief.split('Reply exactly ')[1]
        : 'Controlled initial report';
      const response = controlledTextStream(
        'anthropic',
        'claude-sonnet-4-6',
        text,
        {
          input_tokens: 4,
          output_tokens: 32,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      );
      if (
        control === 'sdk-body-retirement-failure' &&
        Object.hasOwn(prompt, 'context')
      ) {
        assert.ok(response.body);
        assert.equal(bodyReader, undefined);
        bodyReader = response.body.getReader();
        void bodyReader.closed.catch(() => {});
        const remove = fs.rmSync;
        releaseFault = vi
          .spyOn(fs, 'rmSync')
          .mockImplementation((path, options) => {
            if (
              String(path).startsWith(
                join(
                  h.f.home,
                  'security',
                  '.home-writer.mutation.guard.stale-',
                ),
              )
            )
              throw Error('controlled continuation launch retirement failure');
            return remove(path, options);
          });
        syncBuiltinESMExports();
      }
      return response;
    });
    const owners = {
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
    };
    const runtimeOwner = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(
      runtimeOwner,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(participant));
    const runtime = new StationReportGroupRuntime({
      ...owners,
      publicationParticipant: participant,
    });
    const input = {
      ...h.input,
      deadlineAt: NOW + 240_000,
      maxConcurrent: 1,
      flow: { runId: 'retained-report-run', steps: { left: 'review' } },
      continuation: {
        attemptsPerMember: 4,
        maxRounds: 3,
        maxSyncs: 1,
        maxRenewals: 0,
        maxEvaluations: 2,
        maxRecoveries: 0,
      },
      budget: {
        inputTokens: 4 * 1_048_576,
        outputTokens: 4 * 256,
        costMicros: 4 * (1_048_576 * 3 + 256 * 15),
      },
      members: [{ ...h.input.members[0], maxOutputTokens: 256 }],
    };
    const operationAbort = new AbortController();
    const operations: Promise<unknown>[] = [];
    const releaseGates: Array<() => void> = [];
    const ownedCleanup: Array<() => void | Promise<void>> = [];
    if (refusalObserver) ownedCleanup.push(() => refusalObserver.mockRestore());
    let verifyTransactions = () => {};
    let bodyFailure: unknown;
    const ownedRequest = () => {
      const original = requestFor(h, 'POST');
      const request = new Request(original, { signal: operationAbort.signal });
      const principal = getRuntimeAuthenticatedRequestPrincipal(original);
      assert.ok(principal);
      setRuntimeAuthenticatedRequestPrincipal(request, principal);
      bindRuntimeLocalOperator(request);
      return request;
    };
    try {
      const initial = await runtime.create(h.f.context(), input);
      assert.equal(h.rawFetch.mock.calls.length, 1);
      const member = initial.group.members[0];
      assert.ok(member.attempts[0].terminal);
      const scope = {
        principalId: 'human:local:operator',
        environmentId: h.f.record.environmentId,
        threadId: member.taskId,
      };
      const original = reservedStationSessionRecipient(
        orchestration.captureReservedStationSession(member.taskId, {
          userId: scope.principalId,
        }),
        scope,
      );
      const before = await loadRun('retained-report-run', h.f.repo);
      assert.equal(before.state.status, 'active');
      const command = {
        operationKey: 'sync-findings',
        expectedRevision: initial.group.revision,
        seatId: member.seatId,
        flowHead: flowRunHead(before.state),
        text: 'Private corrected context for the existing reviewer.',
      };
      await assert.rejects(
        new StationReportGroupRuntime(owners).sync(
          h.f.context(requestFor(h, 'POST')),
          initial.group.groupId,
          command,
        ),
        { code: 'group_preparation_unavailable' },
      );
      assert.equal(h.rawFetch.mock.calls.length, 1);
      const returning = new StationReportGroupRuntime({
        ...owners,
        publicationParticipant: participant,
      });

      if (
        control === 'cleanup-masks-primary' ||
        control === 'cleanup-after-commit'
      ) {
        const primary = Error('controlled continuation publication failure');
        const cleanup = Error('controlled prepared-turn cleanup failure');
        const prepare = StationReportRetainedTurns.prototype.prepare;
        const roundsStore = StationDelegationPersistence.prototype.roundsStore;
        let prepared = false;
        let primaryReached = false;
        let cleanupReached = false;
        const prepareFault = vi
          .spyOn(StationReportRetainedTurns.prototype, 'prepare')
          .mockImplementation(async function (
            this: StationReportRetainedTurns,
            ...args
          ) {
            const turn = await prepare.apply(this, args);
            prepared = true;
            return {
              ...turn,
              close: async () => {
                await turn.close();
                cleanupReached = true;
                throw cleanup;
              },
            };
          });
        const publicationFault = vi
          .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
          .mockImplementation(function (
            this: StationDelegationPersistence,
            ...args
          ) {
            const store = roundsStore.apply(this, args);
            const wrapped: ReturnType<
              StationDelegationPersistence['roundsStore']
            > = {
              ...store,
              transact: (id, body) =>
                store.transact(id, async (journal) => {
                  if (
                    control === 'cleanup-masks-primary' &&
                    prepared &&
                    !primaryReached
                  ) {
                    primaryReached = true;
                    throw primary;
                  }
                  return body(journal);
                }),
            };
            return wrapped;
          });
        ownedCleanup.push(() => {
          prepareFault.mockRestore();
          publicationFault.mockRestore();
        });
        await assert.rejects(
          returning.sync(
            h.f.context(ownedRequest()),
            initial.group.groupId,
            command,
          ),
          (error: unknown) => {
            assert.equal(primaryReached, control === 'cleanup-masks-primary');
            assert.ok(cleanupReached, 'actual prepared-turn cleanup reached');
            assert.ok(
              error instanceof DelegationRoundsTransactionUncertainError,
            );
            assert.equal(
              error.status,
              control === 'cleanup-masks-primary'
                ? 'publication-unknown'
                : 'returned-cleanup-unknown',
            );
            assert.equal(
              error.cause,
              control === 'cleanup-masks-primary' ? primary : cleanup,
            );
            assert.deepEqual(
              error.errors,
              control === 'cleanup-masks-primary'
                ? [primary, cleanup]
                : [cleanup],
            );
            return true;
          },
        );
        assert.equal(
          h.rawFetch.mock.calls.length,
          control === 'cleanup-masks-primary' ? 1 : 2,
        );
        prepareFault.mockRestore();
        publicationFault.mockRestore();
        if (control === 'cleanup-after-commit') {
          const replay = await returning.sync(
            h.f.context(ownedRequest()),
            initial.group.groupId,
            command,
          );
          assert.equal(
            replay.replayed,
            true,
            'committed command must replay after cleanup uncertainty',
          );
          assert.equal(
            h.rawFetch.mock.calls.length,
            2,
            'cleanup retry cannot invoke the provider again',
          );
        }
      } else if (control === 'replace-session-before-turn-retention') {
        const firstStart = starts.mock.results[0];
        assert.ok(firstStart && firstStart.type === 'return');
        const originalSession = await firstStart.value;
        const startInput = starts.mock.calls[0]?.[0];
        assert.ok(startInput);
        const startSession = StationAgentAdapter.prototype.startSession;
        const retain =
          StationDelegationPersistence.prototype.retainReportContinuationTurn;
        let replacementObserved = false;
        const replacement = vi
          .spyOn(
            StationDelegationPersistence.prototype,
            'retainReportContinuationTurn',
          )
          .mockImplementation(async function (
            this: StationDelegationPersistence,
            ...args
          ) {
            await startSession.call(adapter, {
              ...startInput,
              resumeCursor: structuredClone(originalSession.resumeCursor),
            });
            assert.throws(() =>
              orchestration.captureReservedStationSession(member.taskId, {
                userId: scope.principalId,
              }),
            );
            replacementObserved = true;
            return retain.apply(this, args);
          });
        ownedCleanup.push(() => replacement.mockRestore());
        await assert.rejects(
          returning.sync(
            h.f.context(requestFor(h, 'POST')),
            initial.group.groupId,
            command,
          ),
        );
        assert.equal(
          replacementObserved,
          true,
          'real adapter Session replacement reached the persistence boundary',
        );
        const directory = join(
          h.f.home,
          'report-groups',
          'station-report-continuation-turns-v1',
        );
        const files = existsSync(directory)
          ? readdirSync(directory).filter((name) => name.endsWith('.json'))
          : [];
        assert.deepEqual(
          files,
          [],
          'stale continuation turn must not be durably retained',
        );
        assert.equal(h.rawFetch.mock.calls.length, 1);
      } else if (control === 'sdk-body-retirement-failure') {
        const request = ownedRequest();
        const pending = returning
          .sync(h.f.context(request), initial.group.groupId, command)
          .then(
            (value) => ({ kind: 'returned' as const, value }),
            (error: unknown) => ({ kind: 'refused' as const, error }),
          );
        operations.push(pending);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            refusal,
            pending.then((result) => {
              throw new Error('caller settled before actual SDK refusal', {
                cause: result.kind === 'refused' ? result.error : undefined,
              });
            }),
          ]);
          assert.ok(bodyReader);
          assert.ok(refusedWires.size > 0);
          assert.equal(request.signal.aborted, false);
          const observed = await Promise.race([
            pending.then((result) => ({ kind: 'settled' as const, result })),
            new Promise<{ kind: 'pending' }>((resolve) => {
              timer = setTimeout(() => resolve({ kind: 'pending' }), 5000);
            }),
          ]);
          assert.equal(
            observed.kind,
            'settled',
            'known SDK cleanup failure must settle the caller before the body reader is released',
          );
          if (observed.kind === 'settled') {
            assert.equal(observed.result.kind, 'refused');
            if (observed.result.kind === 'refused')
              assert.ok(
                observed.result.error instanceof
                  DelegationRoundsTransactionUncertainError,
              );
          }
          releaseFault?.mockRestore();
          releaseFault = undefined;
          syncBuiltinESMExports();
          const writer = await HomeWriterOwner.forHome(h.f.home);
          await writer.settlePendingCleanup();
          const entrant = await writer.acquire();
          await entrant.release();
          await assert.rejects(runtimeOwner.shutdown(), {
            code: 'runtime_publication_pending',
          });
          assert.throws(
            () => acquireStationHomeMaintenanceLease(h.f.home),
            StationHomeActiveError,
          );
        } finally {
          if (timer) clearTimeout(timer);
          releaseFault?.mockRestore();
          releaseFault = undefined;
          syncBuiltinESMExports();
          bodyReader?.releaseLock();
          bodyReader = undefined;
          await runtimeOwner.shutdown();
          await pending;
        }
        assert.equal(
          h.rawFetch.mock.calls.length,
          2,
          'cleanup retry cannot issue another provider call',
        );
      } else {
        const result = await (async () => {
          const writer = await HomeWriterOwner.forHome(h.f.home);
          const probe = await prepareFileMutationOwner(
            join(h.f.home, 'security', '.home-writer.mutation'),
          );
          const checkHeld = async () => {
            const attempt = probe.tryAcquire();
            if (attempt.kind === 'acquired') await attempt.lease.release();
            assert.equal(
              attempt.kind,
              'busy',
              'continuation owns physical home through store return',
            );
            assert.throws(() => writer.runSynchronous(() => undefined), {
              name: 'HomeWriterUnavailableError',
              reason: 'busy',
            });
          };
          let bodies = 0,
            returns = 0,
            authorityReads = 0;
          const retiredBindings: Array<() => void> = [];
          const authorityStore =
            StationDelegationPersistence.prototype.roundsAuthorityStore;
          const authorityObserver = vi
            .spyOn(
              StationDelegationPersistence.prototype,
              'roundsAuthorityStore',
            )
            .mockImplementation(function (
              this: StationDelegationPersistence,
              ...args
            ) {
              const actual = authorityStore.apply(this, args);
              return {
                ...actual,
                transact: async (id, body) => {
                  const scope = args[2];
                  assert.ok(
                    scope,
                    'continuation authority requires exact home lease',
                  );
                  scope.owner.runWithLease(scope.lease, () => undefined);
                  retiredBindings.push(() =>
                    scope.owner.runWithLease(scope.lease, () => undefined),
                  );
                  authorityReads++;
                  return actual.transact(id, body);
                },
              };
            });
          const roundsStore =
            StationDelegationPersistence.prototype.roundsStore;
          const observer = vi
            .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
            .mockImplementation(function (
              this: StationDelegationPersistence,
              ...args
            ) {
              const actual = roundsStore.apply(this, args);
              return {
                ...actual,
                transact: async (id, body) => {
                  const value = await actual.transact(id, async (journal) => {
                    const next = await body(journal);
                    await checkHeld();
                    const scope = args[2];
                    assert.ok(
                      scope,
                      'continuation group requires exact home lease',
                    );
                    scope.owner.runWithLease(scope.lease, () => undefined);
                    retiredBindings.push(() =>
                      scope.owner.runWithLease(scope.lease, () => undefined),
                    );
                    bodies++;
                    return next;
                  });
                  await checkHeld();
                  returns++;
                  return value;
                },
              };
            });
          ownedCleanup.push(
            () => observer.mockRestore(),
            () => authorityObserver.mockRestore(),
            () => probe.close(),
          );
          verifyTransactions = () => {
            assert.ok(bodies > 0);
            assert.ok(authorityReads > 0);
            assert.equal(returns, bodies);
            for (const late of retiredBindings)
              assert.throws(late, {
                name: 'HomeWriterUnavailableError',
                reason: 'borrow-unavailable',
              });
          };
          const value = await returning.sync(
            h.f.context(requestFor(h, 'POST')),
            initial.group.groupId,
            command,
          );
          assert.ok(bodies > 0);
          assert.equal(returns, bodies);
          const released = probe.tryAcquire();
          assert.equal(released.kind, 'acquired');
          if (released.kind === 'acquired') await released.lease.release();
          writer.runSynchronous(() => undefined);
          return value;
        })();

        assert.equal(result.replayed, false);
        const terminalReference =
          result.group.contextSyncs?.[0].attempts?.[0].terminal;
        assert.ok(terminalReference);
        const terminalRecord = JSON.parse(
          readFileSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-observations-v1',
              `${terminalReference.id}.json`,
            ),
            'utf8',
          ),
        );
        const witness = reportTerminalWitnessSchema.parse(
          terminalRecord.observation.witness,
        );
        assert.equal(
          verifyReportTerminalWitness(witness, h.f.environment),
          true,
        );
        assert.equal(witness.data.terminal.sessionId, member.taskId);
        assert.notEqual(
          witness.data.terminal.clientTurnId,
          member.clientTurnId,
        );
        assert.equal(
          witness.data.terminal.turnId,
          terminalRecord.observation.turnId,
        );
        assert.equal(h.rawFetch.mock.calls.length, 2);
        assert.equal(starts.mock.calls.length, 1);
        assert.equal(relay.mock.calls.length, 0);
        assert.deepEqual(
          reservedStationSessionRecipient(
            orchestration.captureReservedStationSession(member.taskId, {
              userId: scope.principalId,
            }),
            scope,
          ),
          original,
        );
        const turns = eventStore
          .listEvents(member.taskId)
          .filter((e) => e.payload.method === 'turn.completed');
        assert.equal(turns.length, 2);
        assert.notEqual(turns[0].payload.turnId, turns[1].payload.turnId);

        const replay = await returning.sync(
          h.f.context(requestFor(h, 'POST')),
          initial.group.groupId,
          command,
        );
        assert.equal(replay.replayed, true);
        assert.equal(h.rawFetch.mock.calls.length, 2);
        await assert.rejects(
          returning.sync(
            h.f.context(requestFor(h, 'POST')),
            initial.group.groupId,
            { ...command, text: 'Changed intent cannot replay.' },
          ),
        );
        assert.equal(h.rawFetch.mock.calls.length, 2);
        const run = await loadRun('retained-report-run', h.f.repo);
        const route = run.state.transitions.find(
          (entry: { type?: string }) => entry.type === 'route_back',
        );
        assert.ok(route);
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        let rejectRaw!: (reason: unknown) => void;
        const raw = new Promise<Response>((_resolve, reject) => {
          rejectRaw = reject;
        });
        h.rawFetch.mockImplementationOnce(async (_url, options) => {
          enter();
          const stop = () =>
            rejectRaw(
              options?.signal?.reason ?? Error('controlled report aborted'),
            );
          options?.signal?.addEventListener('abort', stop, { once: true });
          try {
            return await raw;
          } finally {
            options?.signal?.removeEventListener('abort', stop);
          }
        });
        const dispatches = vi.spyOn(orchestration, 'dispatchWithReceipt');
        const paidCommand = {
          operationKey: 'paid-cancel',
          expectedRevision: result.group.revision,
          seatId: member.seatId,
          flowHead: flowRunHead(run.state),
          syncOperationKey: command.operationKey,
          previousInvocationId: member.attempts[0].invocationId,
          retryRef: flowTransitionRef(route),
        };
        let loadedLate!: () => void, releaseLate!: () => void;
        const lateLoaded = new Promise<void>((resolve) => {
          loadedLate = resolve;
        });
        const lateGate = new Promise<void>((resolve) => {
          releaseLate = resolve;
        });
        releaseGates.push(releaseLate);
        const lateRequest = ownedRequest();
        const loadIntent =
          StationReportGroupCustody.prototype.loadIntentForMutation;
        const lateLoad = vi
          .spyOn(StationReportGroupCustody.prototype, 'loadIntentForMutation')
          .mockImplementation(async function (
            this: StationReportGroupCustody,
            ...args
          ) {
            const state = await loadIntent.apply(this, args);
            if (args[0].req.raw === lateRequest) {
              loadedLate();
              await lateGate;
            }
            return state;
          });
        const lateReplay = returning
          .report(h.f.context(lateRequest), initial.group.groupId, paidCommand)
          .then(
            (value) => ({ kind: 'replayed' as const, value }),
            (error: unknown) => ({ kind: 'refused' as const, error }),
          );
        operations.push(lateReplay);
        await lateLoaded;
        let preparedCount = 0,
          bothPrepared!: () => void,
          releaseFirst!: () => void,
          releaseSecond!: () => void;
        const prepared = new Promise<void>((resolve) => {
          bothPrepared = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const secondGate = new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
        releaseGates.push(releaseFirst, releaseSecond);
        const primaryRequest = ownedRequest();
        const secondRequest = ownedRequest();
        const prepareReport =
          StationReportRetainedTurns.prototype.prepareReport;
        const prepareBarrier = vi
          .spyOn(StationReportRetainedTurns.prototype, 'prepareReport')
          .mockImplementation(async function (
            this: StationReportRetainedTurns,
            ...args
          ) {
            const turn = await prepareReport.apply(this, args);
            const ordinal = ++preparedCount;
            if (ordinal === 2) bothPrepared();
            await (args[0].req.raw === primaryRequest ? firstGate : secondGate);
            return turn;
          });
        let primaryFailure: unknown;
        const pending = returning
          .report(
            h.f.context(primaryRequest),
            initial.group.groupId,
            paidCommand,
          )
          .then(
            () => 'returned' as const,
            (error: unknown) => {
              primaryFailure = error;
              return 'refused' as const;
            },
          );
        const preparedReplay = returning
          .report(
            h.f.context(secondRequest),
            initial.group.groupId,
            paidCommand,
          )
          .then(
            (value) => ({ kind: 'replayed' as const, value }),
            (error: unknown) => ({ kind: 'refused' as const, error }),
          );
        operations.push(pending, preparedReplay);

        await Promise.race([
          prepared,
          pending.then(() => {
            throw new Error('primary report settled before both preparations', {
              cause: primaryFailure,
            });
          }),
          preparedReplay.then((value) => {
            throw new Error('second report settled before both preparations', {
              cause: value.kind === 'refused' ? value.error : undefined,
            });
          }),
        ]);
        releaseFirst();

        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error('primary report settled before raw entry', {
              cause: primaryFailure,
            });
          }),
        ]);
        const providerHome = await HomeWriterOwner.forHome(h.f.home);
        const providerLease = await providerHome.acquire();
        await providerLease.release();
        releaseLate();
        releaseSecond();

        const replays = await Promise.all([lateReplay, preparedReplay]);
        lateLoad.mockRestore();
        prepareBarrier.mockRestore();
        const paidTurn = eventStore
          .listEvents(member.taskId)
          .filter((event) => event.payload.method === 'turn.started')
          .at(-1)?.payload;
        assert.ok(paidTurn?.method === 'turn.started');
        assert.notEqual(paidTurn.turnId, turns[0].payload.turnId);
        const active = await returning.get(
          h.f.context(requestFor(h, 'GET')),
          initial.group.groupId,
        );
        assert.ok(active);

        const cancellationCommand = {
          operationKey: 'cancel-paid',
          expectedRevision: active.revision,
        };
        let unownedInterruptGuards = 0;
        if (control === 'interrupt-contention-before-guard') {
          const probe = await prepareFileMutationOwner(
            join(h.f.home, 'security', '.home-writer.mutation'),
          );
          ownedCleanup.push(() => probe.close());
          const dispatch = OrchestrationService.prototype.dispatchWithReceipt;
          dispatches.mockImplementation((command, context, internal) => {
            if (command.type !== 'interruptTurn')
              return dispatch.call(orchestration, command, context, internal);
            const requestCurrent = context?.requestCurrent;
            assert.ok(requestCurrent);
            return dispatch.call(
              orchestration,
              command,
              {
                ...context,
                requestCurrent: () => {
                  const entrant = probe.tryAcquire();
                  if (entrant.kind !== 'acquired') return requestCurrent();
                  unownedInterruptGuards++;
                  try {
                    return requestCurrent();
                  } finally {
                    assert.equal(entrant.lease.tryRelease(), 'released');
                  }
                },
              },
              internal,
            );
          });
        }
        let interruptEntered!: () => void;
        let releaseInterrupt!: () => void;
        const enteredInterrupt = new Promise<void>((resolve) => {
          interruptEntered = resolve;
        });
        const interruptReply = new Promise<void>((resolve) => {
          releaseInterrupt = resolve;
        });
        let recordSettled!: (value: {
          acknowledged: boolean;
          error?: unknown;
        }) => void;
        const recorded = new Promise<{
          acknowledged: boolean;
          error?: unknown;
        }>((resolve) => {
          recordSettled = resolve;
        });
        if (control === 'interrupt-target-ended') {
          const record =
            StationDelegationPersistence.prototype.recordReportInterrupt;
          const observer = vi
            .spyOn(
              StationDelegationPersistence.prototype,
              'recordReportInterrupt',
            )
            .mockImplementation(async function (
              this: StationDelegationPersistence,
              ...args
            ) {
              try {
                const result = await record.apply(this, args);
                recordSettled({
                  acknowledged: result.record.acknowledgement !== null,
                });
                return result;
              } catch (error) {
                recordSettled({ acknowledged: false, error });
                throw error;
              }
            });
          ownedCleanup.push(() => observer.mockRestore());
        }
        if (heldInterrupt) {
          const interrupt = StationAgentAdapter.prototype.interruptTurn;
          adapterInterrupts.mockImplementation(async (...args) => {
            if (control === 'interrupt-target-ended') {
              const result = await interrupt.apply(adapter, args);
              interruptEntered();
              await interruptReply;
              return result;
            }
            interruptEntered();
            await interruptReply;
            return interrupt.apply(adapter, args);
          });
          releaseGates.push(releaseInterrupt);
        }
        const cancel = () =>
          returning.cancel(
            h.f.context(requestFor(h, 'POST')),
            initial.group.groupId,
            cancellationCommand,
          );
        const cancellation = cancel().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        operations.push(cancellation);
        if (heldInterrupt) {
          await Promise.race([
            enteredInterrupt,
            cancellation.then((value) => {
              throw new Error(
                'cancellation settled before held adapter entry',
                { cause: value.ok ? undefined : value.error },
              );
            }),
          ]);
          const home = await HomeWriterOwner.forHome(h.f.home);
          const entrant = await home.acquire();
          await entrant.release();
          if (control === 'interrupt-target-ended') {
            const result = await recorded;
            if (!result.acknowledged)
              throw new Error(
                'ended target was not acknowledged before held reply release',
                { cause: result.error },
              );
            const replay = await cancel();
            assert.equal(replay.cancellation, 'requested');
            assert.equal(adapterInterrupts.mock.calls.length, 1);
          }
          await assert.rejects(runtimeOwner.shutdown(), {
            code: 'runtime_publication_pending',
          });
          assert.throws(
            () => acquireStationHomeMaintenanceLease(h.f.home),
            StationHomeActiveError,
          );
          assert.equal(adapterInterrupts.mock.calls.length, 1);
          releaseInterrupt();
        }
        const firstCancellation = await cancellation;
        if (control === 'interrupt-contention-before-guard') {
          const retry = await cancel().then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          const retained =
            await h.custodyOwners.persistence.readReportInterrupt(
              initial.group.groupId,
              member.seatId,
              () => undefined,
            );
          assert.deepEqual(
            {
              unownedGuards: unownedInterruptGuards,
              first: firstCancellation.ok
                ? firstCancellation.value.cancellation
                : 'refused',
              retry: retry.ok ? retry.value.cancellation : 'refused',
              adapterCalls: adapterInterrupts.mock.calls.length,
              intent: retained !== null,
              acknowledged:
                retained?.acknowledgement !== null &&
                retained?.acknowledgement !== undefined,
            },
            {
              unownedGuards: 0,
              first: 'requested',
              retry: 'requested',
              adapterCalls: 1,
              intent: true,
              acknowledged: true,
            },
            'interrupt contention must not leave an unacknowledged replay trap',
          );
        }
        if (!firstCancellation.ok) throw firstCancellation.error;
        const cancelled = firstCancellation.value;
        assert.equal(cancelled.cancellation, 'requested');
        if (control === 'interrupt-target-ended') {
          const retained =
            await h.custodyOwners.persistence.readReportInterrupt(
              initial.group.groupId,
              member.seatId,
              () => undefined,
            );
          assert.equal(
            retained?.acknowledgement?.outcome,
            'termination-unconfirmed',
          );
          assert.equal(adapterInterrupts.mock.calls.length, 1);
          assert.equal(adapterStops.mock.calls.length, 0);
        }

        if (control === 'interrupt-response-held') {
          const retained =
            await h.custodyOwners.persistence.readReportInterrupt(
              initial.group.groupId,
              member.seatId,
              () => undefined,
            );
          assert.equal(retained?.acknowledgement?.outcome, 'forced');
          assert.throws(() =>
            orchestration.captureReservedStationSession(member.taskId, {
              userId: scope.principalId,
            }),
          );
        }
        assert.equal(await pending, 'refused');
        const interrupts = dispatches.mock.calls
          .map(([request]) => request)
          .filter((request) => request.type === 'interruptTurn');
        assert.equal(interrupts.length, 1);
        assert.equal(interrupts[0].threadId, member.taskId);
        assert.equal(interrupts[0].turnId, paidTurn.turnId);
        assert.equal(h.rawFetch.mock.calls.length, 3);
        assert.equal(starts.mock.calls.length, 1);
        const held = await returning.get(
          h.f.context(requestFor(h, 'GET')),
          initial.group.groupId,
        );
        assert.ok(held?.accounting && held.accounting.unsettledInvocations > 0);
        for (const entry of replays) {
          if (entry.kind === 'refused')
            throw new Error('retained report replay was refused', {
              cause: entry.error,
            });
          assert.equal(entry.value.replayed, true);
          assert.equal(
            entry.value.invocationId,
            active.members[0].attempts.at(-1)?.invocationId,
          );
        }
        verifyTransactions();
      }
    } catch (error) {
      bodyFailure = error;
    }
    operationAbort.abort(Error('controlled continuation test finished'));
    for (const release of releaseGates) release();
    await Promise.allSettled(operations);
    const failures: unknown[] = [];
    if (bodyFailure !== undefined) failures.push(bodyFailure);
    for (const cleanup of [
      ...ownedCleanup,
      () => orchestration.shutdown(),
      () => eventStore.close(),
      () => runtimeOwner.shutdown(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Continuation assertion and cleanup failed',
      );
  },
  300000,
);
